# ADR 0017: Boolean condition functions — AND, OR, NOT, ISBLANK, IFBLANK

**Status: ACCEPTED (design approved 2026-07-09) — implementation not started.**
All open questions from the 2026-07-08 draft are resolved and recorded below.
A fresh session can implement from this document without re-exploration.
Companion: ADR 0018 (IFS/SWITCH parser sugar) is scoped to land immediately
after this one — see "Relationship to ADR 0018" at the end.

## Context

The formula engine (`src/engine/`) supports arithmetic, `IF(condition, then,
else)` (ADR 0010), `TODAY()` (ADR 0012), and variadic `SUM(...)` (ADR 0016).
Conditions today are limited to a single comparison (`a > b`, `x = "won"`) or a
numeric truthiness check. Users cannot express compound logic ("stage is won
AND amount > 1000"), test for empty fields, or substitute a fallback for a
blank value. This ADR adds four condition-context functions — `AND(...)`,
`OR(...)`, `NOT(...)`, `ISBLANK(...)` — and one value-context function,
`IFBLANK(value, fallback)`.

## Engine architecture facts (verified 2026-07-08, all still true at HEAD e52591c)

These are the invariants the design must preserve:

1. **Booleans never enter the public value domain.** `evaluate()` returns
   `number | null`. Comparisons are *transient* nodes legal only at the top
   level of IF's first argument (`parseCondition` in `parser.ts` is the single
   entry point). `evaluateConditionTruth` in `evaluator.ts` returns
   `boolean | null` internally and is only called from the `if` case.
2. **No general call node.** IF/TODAY/SUM are *reserved words*
   (case-insensitive), dispatched statically in `parsePrimary` when a FIELD
   token's path matches and the next token is LPAREN. Bare fields named
   `if`/`today`/`sum` are inexpressible; dotted paths (`sum.x`) still work.
3. **Null propagation (ADR 0003).** A `null` operand nulls any arithmetic
   result; a null condition (or null in a comparison operand) nulls the whole
   IF. SUM is the one exception: it *skips* nulls, all-null → null.
4. **Errors always surface in evaluated code.** IF branches are lazy (untaken
   branch never runs); IF's condition and all SUM args are always evaluated,
   so DIVISION_BY_ZERO etc. inside them always fire.
5. **Tokenizer is a strict whitelist** (`tokenizer.ts`). Identifiers, numbers,
   `+ - * / % ( ) ,`, comparison ops, `"strings"`, `[crossrefs]`. A lone `!`
   is rejected ("only valid as part of !="). No new characters are needed for
   this feature — all five new names are plain identifiers.
6. **Depth guards**: `MAX_PARSE_DEPTH = 200` via `enter()`/`leave()` in the
   parser (IF and SUM frames each count); `DEFAULT_MAX_DEPTH = 64` in the
   evaluator via the `depth` parameter.
7. **String literals** are legal ONLY as a direct `=`/`!=` operand inside a
   condition (`parseConditionOperand` consumes them before `parsePrimary`,
   which always rejects them). String-mode comparison uses the optional
   `resolveRaw: RawVariableResolver` from `EvaluateOptions`; a non-string raw
   value resolves to null → null-propagates.
8. **Dependency extraction** (`dependencies.ts`) walks the AST with an
   exhaustive switch; every node type must be handled (field → root segment
   into `sameRecordFields`, crossref → `crossRecordRefs`). Persisted on
   FormulaDefinition at save time; drives recompute triggers and cycle
   detection (`cycle-detection.ts` consumes the dependency output, so it
   normally needs no changes when a new node type reads fields through the
   existing field/crossref nodes).
9. **Editor autocomplete**: `FUNCTION_SUGGESTIONS` in
   `src/front-components/lib/formula-field-input.tsx` (line ~34) lists TODAY
   and SUM with `insertText`. New functions must be added there (ADR 0007
   covers the editor UX rules).

One additional fact verified 2026-07-09 (drove the ISBLANK decision):

10. **`coerceToNumber` (`src/logic-functions/lib/coercion.ts`) throws
    `NON_NUMERIC_VALUE` for every non-numeric string — including the empty
    string** (`raw.trim() !== ''` guards the string branch, so `""` falls
    through to the throw). Twenty stores `""`, not null, for an empty TEXT
    field. Consequence: a numeric-only ISBLANK would hard-error on ALL text
    fields, empty or not — the primary CRM use case ("is this email blank?")
    would never work. `buildRawResolver` (`recompute.ts`) already returns
    `string | null` ("null for anything non-string"), which is exactly the
    primitive the raw-first design below needs; no resolver changes required.

## Decision

Add five reserved-word functions.

**Four condition-context functions**, legal only in condition context (IF's
first argument, and recursively inside each other's condition arguments):

- `AND(cond1, ..., condN)` — variadic, **N ≥ 2** (resolved: 1-arg AND is
  almost certainly a user mistake; PARSE_ERROR "AND requires at least 2
  arguments").
- `OR(cond1, ..., condN)` — same arity rule as AND.
- `NOT(cond)` — exactly 1 argument.
- `ISBLANK(expr)` — exactly 1 argument (field, crossref, or arithmetic
  expression); true iff the argument is blank per the raw-first rules below.

**One value-context function**, legal anywhere a number is (dispatched in
`parsePrimary` like SUM/TODAY):

- `IFBLANK(value, fallback)` — exactly 2 arguments. Returns `value` unless it
  evaluates to null, else returns `fallback` (which may itself be null). Both
  arguments are always evaluated (SUM precedent — errors always fire). This is
  the sanctioned escape hatch that makes strict null propagation liveable:
  `AND(stage = "won", IFBLANK(amount, 0) > 1000)` reads as "treat blank amount
  as 0", and `revenue + IFBLANK(upsell, 0)` fixes the most common
  null-propagation complaint in plain arithmetic.

Syntax is function-style, not infix (`a > 1 AND b < 2` is NOT supported).
Rationale: infix boolean operators would require precedence decisions
(AND vs OR binding), invite chained-comparison ambiguity the parser
deliberately rejects, and break the existing "reserved word + static
dispatch" pattern. Function syntax matches Excel/Airtable user expectations
and reuses the IF/SUM parsing machinery wholesale.

Deliberately excluded (scope discipline): `XOR` (no CRM use case),
`ISNOTBLANK` (= `NOT(ISBLANK(x))`), `TRUE()`/`FALSE()` literals (would leak
booleans into the value domain), variadic `COALESCE` (compatible later
extension of IFBLANK if demand appears), `MIN`/`MAX` (useful but pure numeric
aggregation — own small ADR), `IFS`/`SWITCH` (ADR 0018).

### Grammar extension

```
condition     := boolFunction | conditionExpr
boolFunction  := AND '(' condition (',' condition)+ ')'
               | OR  '(' condition (',' condition)+ ')'
               | NOT '(' condition ')'
               | ISBLANK '(' expression ')'
conditionExpr := (existing) expression (compareOp expression)? with string operands
primary       := (existing alternatives)
               | IFBLANK '(' expression ',' expression ')'
```

`parseCondition` gains a dispatch at its top: if the next token is a FIELD
whose path is (case-insensitively) `and`/`or`/`not`/`isblank` followed by
LPAREN, parse the corresponding function; each AND/OR/NOT argument recurses
into `parseCondition` (so nesting like `AND(OR(a>1, b>2), NOT(c=0))` works);
ISBLANK's argument goes through `parseExpression` (value context). IFBLANK is
dispatched in `parsePrimary` exactly like SUM.

### New AST nodes (`ast.ts`)

```ts
export type AndNode = { type: 'and'; args: AstNode[] };       // args are condition nodes
export type OrNode = { type: 'or'; args: AstNode[] };
export type NotNode = { type: 'not'; operand: AstNode };      // operand is a condition node
export type IsBlankNode = { type: 'isblank'; operand: AstNode }; // operand is a VALUE node
export type IfBlankNode = { type: 'ifblank'; value: AstNode; fallback: AstNode }; // VALUE node
```

AndNode/OrNode/NotNode/IsBlankNode are *transient condition nodes* like
ComparisonNode: the parser only produces them inside condition context, so
they can never appear in a value slot. The evaluator's value switch gets
unreachable-guard cases for them (mirroring the existing `comparison` guard)
so hand-built ASTs fail loud. IfBlankNode is an ordinary value node (like
SumNode) — legal anywhere, including inside ISBLANK's operand
(`ISBLANK(IFBLANK(x, 0))` is legal and always false when fallback is 0).

### Semantics (resolved decisions)

**Null handling — RESOLVED: strict null propagation, no short-circuit.**
- AND/OR/NOT: evaluate ALL arguments via `evaluateConditionTruth`. If any
  argument's truth is `null`, the combinator's truth is `null` (which nulls
  the enclosing IF, per existing policy). Otherwise standard boolean logic.
- Rationale: consistent with ADR 0003 ("null in a comparison operand nulls
  the IF") and with SUM's evaluate-all-args error semantics. Kleene/SQL
  three-valued logic was considered and rejected: it creates a second,
  subtler null regime and makes error surfacing dependent on operand order.
- Null tolerance is always explicit and always expressible:
  - skip a condition when blank: `OR(ISBLANK(x), x > 10)`
  - fail a condition when blank: `AND(NOT(ISBLANK(x)), x > 10)`
  - substitute a value when blank: `IFBLANK(x, 0) > 10`
- No short-circuit: errors (division by zero, unknown field) in ANY argument
  always fire, matching SUM and matching "IF's condition is always evaluated".

**ISBLANK — the one deliberate exception to null propagation.** It *observes*
blankness instead of propagating null. ISBLANK never *returns* null for a
successfully evaluated argument; an UNKNOWN_VARIABLE or other error inside
the argument still throws (a typo'd field name is a formula bug, not a blank).

**ISBLANK blankness rules — RESOLVED: raw-first for bare fields.**
- **Bare field or crossref operand** (operand node is `field` or `crossref`):
  1. If `resolveRaw` is provided (it always is in production — `recompute.ts`
     passes `buildRawResolver`), consult it first. A **string** result means:
     blank ⇔ `trim() === ''` (whitespace-only counts as blank). A non-empty
     string → not blank — this makes `ISBLANK(email)` work on day one for
     TEXT/EMAIL/SELECT fields.
  2. If raw resolution returns null (the value is not a string, or the cross
     record is missing), fall back to the numeric resolver: null → blank,
     number → not blank, undefined → UNKNOWN_VARIABLE (unchanged). A missing
     linked record therefore reads as blank — consistent with the existing
     silent-null policy for missing cross records.
  3. If `resolveRaw` is absent (bare-engine unit tests), skip step 1 —
     numeric-only semantics.
  - Values that are neither strings nor numerically coercible (arrays, exotic
    composites) still throw NON_NUMERIC_VALUE from `coerceToNumber` — honest
    error, not a silent guess. Booleans coerce to 0/1 → never blank; a
    CURRENCY composite with null `amountMicros` → blank.
- **Compound operand** (anything else — `ISBLANK(a + b)`): evaluated normally
  in the numeric domain; internal null propagation making the result null
  counts as blank. That is coherent: "is this expression's value blank?".

**IFBLANK stays purely numeric — deliberate asymmetry with ISBLANK.** IFBLANK
returns a value, and the engine's value domain is `number | null`; a text
field inside IFBLANK goes through the numeric resolver and errors like any
other value-context reference. Only ISBLANK gets raw-awareness, because only
ISBLANK *observes* rather than *produces* values.

**Reserved words:** `and`, `or`, `not`, `isblank`, `ifblank` become reserved
case-insensitively. IFBLANK behaves exactly like SUM (value context,
`parsePrimary` dispatch). The four condition functions are only *meaningful*
in condition context but are reserved globally (reject bare-field use
everywhere) for consistency and forward-compat, with two distinct errors:
- In condition context without `(`: `'"AND" is a reserved word — expected AND(cond1, ..., condN)'`.
- In value context (parsePrimary): a dedicated message mirroring
  `comparisonOutsideConditionError`, e.g. `'AND(...) is only allowed inside
  an IF condition'` — this is the error users will actually hit while
  learning, e.g. writing `AND(a>1, b>2)` at the top level or `IF(x>1, NOT(y), 0)`.
Dotted paths (`and.total`, `not.x`, `ifblank.y`) remain legal field
references, exactly like `if.x` / `sum.x` today.

**Depth:** each of the five parse functions calls `enter()`/`leave()` (SUM
precedent) so deeply nested combinators are bounded by MAX_PARSE_DEPTH; the
evaluator passes `depth + 1` into each argument like SUM does.

**Dependencies:** `dependencies.ts` walk gains cases: and/or → walk all args;
not/isblank → walk operand; ifblank → walk value and fallback. ISBLANK's
operand IS a real dependency (recompute must fire when the observed field
changes from null to a value — and, with raw-first semantics, when a text
field changes between empty and non-empty). Cycle detection consumes
dependency output, so no separate change expected — verify with a test
(formula A = `IF(ISBLANK(b), 1, 2)` where b is a formula reading A must be
rejected as a cycle).

**No impact on:** tokenizer (no new characters), TODAY-staleness sweep
(ADR 0015 — none of these are time-dependent), Excel-serial-date handling
(ADR 0011), override slots (ADR 0006), lifecycle (ADR 0009). The
save-time validation path in the logic functions reuses `parse()` +
`extractDependencies()`, so it picks the feature up for free — verify, don't
assume (check `on-formula-definition-created.ts` / `-updated.ts`).

## Implementation checklist (ordered; TDD per repo convention)

The SUM commit (`b39f35185f feat(formula-field): SUM() variadic function
(ADR 0016)`) is the template — `git show b39f35185f --stat` lists the exact
file set a function addition touches.

1. `src/engine/ast.ts` — add AndNode/OrNode/NotNode/IsBlankNode/IfBlankNode
   + union; update the header comment (condition-node confinement story;
   IfBlankNode is a value node).
2. `src/engine/parser.ts` —
   - reserved-word rejection for the four condition names in `parsePrimary`
     (value context → dedicated condition-only error, like STRING handling);
   - IFBLANK dispatch in `parsePrimary` (copy `parseSum`'s shape; exactly-2
     arity error mirroring IF's "exactly 3 arguments" style);
   - dispatch at top of `parseCondition` (and inside AND/OR/NOT args via
     recursion into `parseCondition`);
   - `parseAnd`/`parseOr`/`parseNot`/`parseIsBlank` with arity errors
     (AND/OR: N ≥ 2), `enter()`/`leave()`, comparison-token error routing on
     bad closings (copy `parseSum`'s shape);
   - grammar comment block update.
3. `src/engine/evaluator.ts` —
   - extend `evaluateConditionTruth` with and/or/not/isblank cases (strict
     null propagation; evaluate ALL args);
   - ISBLANK raw-first logic for bare field/crossref operands (see semantics;
     needs access to `resolveRaw` from EvaluateOptions — already threaded for
     string comparisons);
   - `ifblank` case in `evaluateNode`'s value switch (evaluate both, return
     value ?? fallback);
   - unreachable guards for the four condition node types in the value
     switch; update header policy comment.
4. `src/engine/dependencies.ts` — walk cases for the five node types.
5. Tests (existing spec files in `src/engine/__tests__/`):
   - `parser.spec.ts`: happy paths, nesting, arity errors (incl. AND/OR with
     1 arg, IFBLANK with 1 or 3 args), reserved-word errors in value +
     condition contexts, dotted-path escape (`and.x`, `ifblank.y`),
     case-insensitivity, chained/malformed forms, depth bound.
   - `evaluator.spec.ts`: truth tables incl. null operands (strict
     propagation), ISBLANK on null/number/compound-null args, ISBLANK
     raw-first (empty string → blank, whitespace-only → blank, non-empty
     string → not blank, non-string raw → numeric fallback, no resolveRaw →
     numeric-only), IFBLANK (non-null passthrough, null → fallback, null
     fallback, both args evaluated → error propagation), error propagation
     from every arg position (no short-circuit), lazy IF branches still lazy
     around them.
   - `dependencies.spec.ts`: deps collected through all five nodes,
     ISBLANK/IFBLANK operand dependencies, cross-refs inside combinators.
   - `cycle-detection.spec.ts`: cycle through an ISBLANK edge rejected.
   - `fuzz.spec.ts`: add the five names to whatever generator vocabulary it
     uses (read it first — not inspected during planning).
6. `src/front-components/lib/formula-field-input.tsx` — five new
   `FUNCTION_SUGGESTIONS` entries (labels + `insertText: 'AND('` etc.);
   check `formula-editor.tsx` / `formula-definition-editor.tsx` for any
   help text or docs strings listing available functions (not inspected
   during planning — grep for 'SUM' there).
7. Editor round-trip check per ADR 0007 (autocomplete inserts, caret
   placement) — follow whatever ADR 0007 specifies for new functions.
8. README.md function reference (grep README for SUM/TODAY section) +
   `context.md` handoff update if that convention is still in use.
9. Run: `cd packages/twenty-apps/community/formula-field && npx vitest run`
   (unit), plus the integration config if logic-function behavior changed
   (it shouldn't). Lint per repo root commands.

## Relationship to ADR 0018

`IFS(...)` and `SWITCH(...)` land immediately after this ADR as **pure
parser-level sugar** desugaring into nested IfNodes (see ADR 0018). They were
deliberately split out: this ADR adds condition *primitives* (new node types,
new evaluator semantics); 0018 adds *sugar* with zero evaluator/dependency
surface. 0018 depends on nothing here except the reserved-word pattern, but
sequencing it second keeps each PR's test story clean. `ifs` and `switch`
are NOT reserved by this ADR — 0018 reserves them.

## Not inspected during planning (verify when implementing)

- `fuzz.spec.ts` internals; `cycle-detection.ts` internals (only its
  relationship to dependencies.ts inferred from comments/specs).
- The exact validation call sites in `logic-functions/on-formula-definition-*.ts`.
- README / editor help-text surfaces listing functions.
- Whether `formula-field-input.tsx` sorts or filters FUNCTION_SUGGESTIONS in
  a way that five more entries would crowd (ADR 0007 UX constraints).
