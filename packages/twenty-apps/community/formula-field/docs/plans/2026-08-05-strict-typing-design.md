# Strict kind typing — design

Date: 2026-08-05. Status: approved by user (interactive brainstorm, eight decisions locked).
Supersedes: ADR 0026 decisions B2 (eager date-coercion of text content) and B6 (silent cross-kind
comparison flip), plus the lazy numeric coercion B3 preserved in arithmetic. Will become ADR 0027
when the implementation arc completes, per the 0026 precedent.

## Context

Live verification of v0.2.0 (2026-08-04, `verification-reports/T6-verdict.md`) surfaced two deltas
the user rejected as design: B6/H2 (a DATE value or date-shaped text compared `=` against a text
literal silently returns false, with no save-time signal) and, underlying it, B2 (the engine treats
date-shaped-and-valid TEXT content as a date in every context). The user ruling: the engine should
never treat date-shaped text as a date; comparisons must be strictly kind-matched; cloud deploy of
the v0.2.0 line is held until this ships so the deployed semantics are the intended ones.

ADR 0026's Not-done section pre-named the starting point ("kind-aware field resolution"). This
design goes further than that escape hatch: during the brainstorm the user chose full strictness
across the whole language, not just comparisons.

## Decisions

### D1 — Kind lattice

Five kinds, assigned statically to every AST node:

| Kind | Sources |
|---|---|
| number | NUMBER and CURRENCY fields, numeric literals, arithmetic results, SUM, NUMBER() |
| date | DATE fields, TODAY(), DATE("YYYY-MM-DD") |
| datetime | DATE_TIME fields |
| text | TEXT and SELECT fields, string literals, `&` results, TEXT() |
| boolean | BOOLEAN fields, comparison results, AND/OR/NOT, ISBLANK |

date and datetime are distinct kinds; comparing them to each other is a mismatch. CURRENCY keeps
its current numeric resolution (no semantic change; the implementation plan pins the exact unit).

### D2 — One rule: kinds must match the operation

- `=` / `!=`: both sides the same kind. Any kind may participate (boolean = boolean is legal).
- Ordering (`<`, `<=`, `>`, `>=`): both sides the same kind, and only number, date, or datetime.
  Text and boolean ordering is rejected.
- Arithmetic (`+ - * /`, unary minus) and SUM: number operands only.
- `&`: text operands only.
- Condition positions (IF and IFS conditions, AND/OR/NOT operands): boolean only. Truthiness
  coercion is removed; `IF(numField, …)` must be written `IF(numField != 0, …)`. SWITCH's subject
  is not a condition — it may be any kind, and its case values must match it (next bullet).
- Branch unification: IF/IFS result branches, SWITCH result branches, and IFBLANK's two arguments
  must share one kind, so every expression has a single inferable result kind. SWITCH case values
  must match the subject's kind.
- Output gate: the expression's inferred kind must match the target field's kind at save. A
  Text-format formula must infer text (use TEXT() to emit numbers); a numeric target must infer
  number; and so on.
- Kleene three-valued null logic (ADR 0017/0018) is untouched. Null propagation happens within the
  kind rules; ISBLANK still accepts any kind and returns boolean.

### D3 — Explicit casts are the only crossings

- `NUMBER(text)` — parses numeric text to a number; non-numeric content is a per-record eval error.
- `TEXT(value)` — canonical rendering: numbers as plain decimal, dates as `YYYY-MM-DD`, datetimes
  as ISO 8601, booleans as `true`/`false`. No formatting arguments in this arc.
- `DATE("YYYY-MM-DD")` — fixed-date literal only. The argument must be a literal string, validated
  at save (an invalid or non-literal argument is a save error). It is not a general text→date cast.

### D4 — Zero shape-sniffing, anywhere

Date-shaped or numeric-shaped text is just text: in comparisons, in `&`, in mirrors, everywhere.
`coercion.ts` loses its date-shape detection entirely. TEXT mirrors copy verbatim, always — the
B2/B5 rewrite-in-place of stored date-shaped mirror values is gone.

### D5 — Enforcement architecture

- Save time: a static kind-inference walk over the AST inside `validateExpressionCore`
  (`src/logic-functions/lib/validation-core.ts`), driven by field metadata for references, literal
  type for literals, and a per-function signature table. Any mismatch fails the save with an error
  naming the node and the expected vs actual kind. Front and back share the gate for free, as they
  already share validation-core. Existing pattern branches (1b string-comparison check, 1d bare-ref
  guard) are subsumed where the inference walk covers them; orthogonal guards stay.
- Runtime: the resolver becomes kind-aware — it resolves each field strictly by its metadata kind,
  never by inspecting the value's shape. Evaluator kind checks remain as the backstop.
- The engine (`src/engine/`) stays kind-agnostic. Kind knowledge lives in the app layer, preserving
  the boundary ADR 0026 maintained.

### D6 — Legacy definitions: per-record eval error, one doctrine

Definitions saved before this redesign whose expressions violate the new rules are not migrated,
grandfathered, or auto-disabled. Recompute evaluates them, the evaluator backstop hits the
mismatch, and the standard per-record formula-error state is written (the T5 lone-literal demo
proved this path non-destructive). The moment the user opens the editor to fix such a definition,
the save gate explains exactly what is wrong. One semantics, no second engine.

## Consequences — visible deltas vs v0.2.0

- S1: B6/H2 reversed. `dateField = "2026-01-15"` no longer silently returns false — it is rejected
  at save (`dateField = DATE("2026-01-15")` is the sanctioned form). The silent flip class is gone.
- S2: B2/B5 rewrite reversed. TEXT mirrors never rewrite date-shaped stored values to serial
  renderings; first post-deploy pass leaves them verbatim.
- S3: Numeric-text arithmetic (`textField * 2` with content "42") now requires
  `NUMBER(textField) * 2`. Previously-working formulas relying on lazy numeric coercion error
  per-record until edited.
- S4: Lone-literal and non-boolean conditions (`IF("a", 1, 2)`, `IF(numField, …)`) go from
  accepted (runtime error / truthy) to save-rejected.
- S5: Non-text operands in `&` (v0.2.0 accepted `isActive & ""`) are save-rejected; write
  `TEXT(isActive) & ""`.
- S6: Cross-kind `=` (`42 = "42"`, `textFieldA = numFieldB`) goes from silent false (B1/B4) to
  save-rejected; legacy defs error per-record.
- S7: Three new functions in the language: NUMBER, TEXT, DATE.
- S8: date vs datetime comparisons, previously numerically comparable in principle, are rejected.

## Not done (named for future arcs)

- `DATE(textExpr)` as a general text→date cast.
- Formatting arguments to TEXT() (Excel-style format strings).
- Any truthiness escape hatch or lint-level "warn instead of reject" mode.
- Migration tooling for legacy definitions (the per-record error + editor explanation is the story).

## Testing

- Unit pins per rule in D2/D3: save-gate acceptance and rejection cases per operation, cast
  behaviors including cast runtime errors, branch unification, output gate per target kind.
- Existing specs pinning B2/B6 behavior (`coercion.spec.ts`, `evaluator.spec.ts`,
  `recompute.spec.ts`) are updated to pin the new semantics — these edits are the reversal made
  test-visible and must be called out in review.
- Legacy-doctrine test: an expression that predates the gate (injected below the save path)
  produces the standard per-record error and keeps converging.
- A short live verification pass (T3-style seed + observe) before cloud deploy, focused on: mirror
  verbatim behavior over date-shaped content, legacy-def error surfacing, and the save gate in the
  wizard editor.

## Versioning and sequencing

v0.3.0. Zero schema changes. After this ships and live-verifies, the held cloud deploy proceeds
(deploying v0.3.0 semantics directly — the v0.2.0 line never deploys alone, per user ruling).
Then: F1 empty-string investigation, then the SELECT output arc.

## Decision log (brainstorm, 2026-08-05)

1. Kind mismatch in comparisons → reject at save time.
2. Legacy mismatching definitions → per-record eval error (no grandfathering, no auto-disable).
3. Strictness scope → full strict everywhere (arithmetic and conditions included), not
   comparisons-only.
4. Casts shipping this arc → NUMBER(text) and TEXT(value); DATE stays literal-only.
5. Condition positions → boolean-kind only.
6. Architecture → static inference pass in validation-core; engine stays kind-agnostic.
7. `&` → text-kind only, casts explicit.
8. Design presented as a whole and approved.
