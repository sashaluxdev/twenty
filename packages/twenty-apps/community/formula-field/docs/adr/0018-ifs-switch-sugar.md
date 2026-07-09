# ADR 0018: IFS and SWITCH as parser-level sugar

**Status: IMPLEMENTED (design approved 2026-07-09).**
Depends on ADR 0017 (boolean condition functions) landing first — not for any
technical coupling, but so each PR has a clean test story. Implemented
immediately after 0017: IFS/SWITCH are pure parser sugar desugaring into nested
IfNodes, with a single parser-internal NullNode as the only AST addition; the
evaluator, dependency walker, `usesToday`, `walkStringComparisons`, and save-time
validation needed no IFS/SWITCH-specific logic beyond the trivial NullNode case.

## Context

Nested-IF ladders are among the most common real formulas in a CRM:

- map a select field to a number:
  `IF(stage = "lead", 1, IF(stage = "qualified", 2, IF(stage = "won", 3, 0)))`
- score by range:
  `IF(score >= 90, 5, IF(score >= 70, 4, IF(score >= 50, 3, 0)))`

Both are unreadable past two rungs. Excel/Airtable users expect `IFS` and
`SWITCH` for exactly these shapes.

## Decision

Add two reserved-word functions, implemented **entirely in the parser** as
desugaring into nested `IfNode`s. No evaluator semantics, no dependency-walk
cases, no cycle-detection changes; the only AST addition is a trivial
parser-internal NullNode (see "Parser mechanics").

### IFS

```
IFS(cond1, value1, cond2, value2, ..., [default])
```

- Arguments: 1+ (condition, value) pairs, optional trailing default.
  Arity: N ≥ 2; N even → no default, N odd → last arg is the default.
- Desugars to `IF(cond1, value1, IF(cond2, value2, ... default))`.
- No default and no rung matches → **null (blank)**, NOT an error (diverges
  from Excel's #N/A deliberately — consistent with the engine's null
  philosophy). Desugar therefore uses a null-producing else for the innermost
  IF when no default is given (see "Desugar target" below).
- Conditions use the full condition grammar, including ADR 0017's
  AND/OR/NOT/ISBLANK — each rung's condition parses via `parseCondition`,
  each value via `parseExpression`.

### SWITCH

```
SWITCH(expr, key1, value1, key2, value2, ..., [default])
```

- Arguments: an expression, then 1+ (key, value) pairs, optional trailing
  default. Arity: N ≥ 3; even N → last arg is the default, odd N → no default.
- Desugars to `IF(expr = key1, value1, IF(expr = key2, value2, ... default))`.
- `expr` and each `key` parse as **comparison operands**
  (`parseConditionOperand`): numeric expressions, or string literals — so
  `SWITCH(stage, "lead", 1, "qualified", 2, "won", 3, 0)` works today with
  ZERO relaxation of the string-literal rules (invariant 7 of ADR 0017: a
  string literal is legal as a direct `=`/`!=` operand, and desugaring
  produces exactly that shape). `expr` as a bare string literal is legal but
  pointless; keys may mix strings and numerics per-rung since each rung is an
  independent comparison.
- Values and the default parse via `parseExpression`.

## Semantics come free from the desugaring

This is the point of the design: the desugared AST *defines* the behavior,
and every property inherited from IF is the right one.

- **Short-circuit down the ladder**: later conditions live inside else
  branches, which are already lazy — rung k+1's condition is evaluated only
  when rungs 1..k were false. No new evaluation rule invented.
- **Strict null propagation composes**: a null condition at rung k nulls the
  ladder from rung k down (it is the condition of that nested IF); earlier
  matched rungs are unaffected because their branch was already taken. For
  SWITCH on a blank field, `expr = key1` is null at the FIRST rung → whole
  ladder null. Escape hatch as everywhere: `SWITCH(IFBLANK(x, 0), ...)` for
  numeric expr; for a blank text field, guard with
  `IF(ISBLANK(stage), fallback, SWITCH(stage, ...))`.
- **Dependencies, recompute triggers, cycle detection**: free — the persisted
  AST is nested IfNodes, which `dependencies.ts` already walks.
- **Save-time validation**: free, same reason.

### Recorded caveats (accepted trade-offs)

1. **SWITCH duplicates `expr` per rung** (it appears in every comparison).
   Expressions are pure, so N-fold evaluation is semantically harmless;
   dependency extraction dedupes field names. A pathological expr
   (deep arithmetic) costs N evaluations — acceptable, document only.
2. **Depth guards bound ladder length.** Each rung adds one IF frame:
   MAX_PARSE_DEPTH = 200 at parse time, DEFAULT_MAX_DEPTH = 64 at eval time,
   so ladders cap out around ~60 rungs. Nobody writes a 60-rung formula by
   hand; document, don't engineer around.
3. **Runtime error messages speak in IF terms** (the real AST is nested IFs).
   Parse-time errors — arity, malformed args — DO say IFS/SWITCH, and those
   are the errors users actually hit while typing. Accepted; revisit only if
   user confusion shows up in practice.
4. **Round-tripping**: the engine has no formatter/pretty-printer (formulas
   are stored as source text), so desugaring is invisible — the editor always
   shows what the user typed. If a formatter is ever added, it would need
   rung-count heuristics to re-sugar; out of scope.

## Parser mechanics

- `ifs` and `switch` become reserved words, case-insensitive, dispatched in
  `parsePrimary` (they are VALUE context — a ladder produces a number), with
  dotted-path escape (`ifs.x`, `switch.total` stay legal fields) exactly like
  IF/SUM/IFBLANK.
- `parseIfs` / `parseSwitch` collect raw argument lists first (respecting the
  alternating condition/value or operand/value grammar per position), check
  arity with dedicated PARSE_ERROR messages ("IFS requires at least one
  condition/value pair", "SWITCH requires an expression and at least one
  key/value pair"), then fold right-to-left into nested IfNodes.
- **Desugar target for missing default — RESOLVED**: an IfNode needs an else
  branch, and no existing node type can produce null (verified 2026-07-09:
  ast.ts has number/string/field/crossref/unary/binary/comparison/if/today/
  sum only). Add a minimal `{ type: 'null' }` NullNode — evaluator returns
  null, dependencies: no-op — as the ONE deviation from "zero new nodes".
  It is parser-internal: no source syntax produces it except a default-less
  IFS/SWITCH desugar, so it adds no grammar surface.
- `enter()`/`leave()` per rung during parsing so the parse-depth guard sees
  the same frames the desugared AST implies.

## Implementation checklist (TDD per repo convention)

1. `src/engine/ast.ts` — NullNode; `src/engine/evaluator.ts` — trivial
   null case; `src/engine/dependencies.ts` — no-op case (exhaustive switch).
2. `src/engine/parser.ts` — reserved words, `parseIfs`/`parseSwitch`,
   right-fold desugar (NullNode else when no default), arity errors,
   grammar comment block.
3. Tests, all in existing spec files:
   - `parser.spec.ts`: desugar shape (assert AST equals hand-built nested
     IFs), arity errors (IFS with 0/1 args; SWITCH with 0/1/2 args),
     even/odd default detection for both, case-insensitivity, dotted-path
     escape, string keys legal / string in value slot still rejected,
     depth bound on long ladders.
   - `evaluator.spec.ts` (behavioral, through evaluate()): ladder
     short-circuit (division-by-zero in rung 2's condition NOT hit when rung
     1 matches — inherited laziness, test it explicitly), no-match-no-default
     → null, null expr in SWITCH → null, IFBLANK-wrapped expr recovers,
     string SWITCH via resolveRaw, range-ladder IFS.
   - `dependencies.spec.ts`: deps through a desugared ladder (should need no
     production change — the test documents that).
4. `FUNCTION_SUGGESTIONS` entries for IFS and SWITCH
   (`src/front-components/lib/formula-field-input.tsx`) + any help-text /
   README function reference (same surfaces as ADR 0017 step 6–8).
5. `npx vitest run` in the app dir; lint per repo root commands.

## Alternatives considered

- **Real IfsNode/SwitchNode AST types**: cleaner error messages at runtime,
  but buys new cases in evaluator, dependencies, fuzzer, and unreachable
  guards — all for behavior identical to the desugared form. Rejected.
- **IFS only** (SWITCH ≡ IFS with repeated `field =`): smaller, but gives up
  the most idiomatic form of the single most common CRM formula (select-field
  mapping). Both are cheap as sugar; take both.
- **Excel-compatible no-match error**: rejected; blank-on-no-match is
  consistent with the engine's null philosophy (ADR 0003).
