# ADR 0016 — SUM() variadic function with all-null → null

- Status: Accepted
- Date: 2026-07-07

## Context

Formulas frequently need to total several inputs — `amount + tax + shipping` —
and writing that as a chain of `+` operators has a sharp edge under the engine's
null-propagation policy (ADR 0003): a single null operand nulls the ENTIRE
expression. So `a + b + c` renders blank the moment any one of `a`, `b`, `c` is
empty, even when the other two hold real values. A dedicated aggregate that
tolerates missing inputs is the natural fix, and it mirrors the reserved-word
function shape already established by `IF` (ADR 0010) and `TODAY()` (ADR 0012),
so it costs no new grammar machinery — still no general call node, so the
whitelist-safety guarantee (ADR 0002) is untouched.

## Decision

- **Function-call form**: `SUM(expr1, ..., exprN)` — one or more arguments,
  keyword case-insensitive. The parser recognizes the identifier `sum` followed
  by `(` as static dispatch to a dedicated `SumNode`; zero arguments (`SUM()`)
  is a `PARSE_ERROR`. `sum` becomes a reserved word exactly like `if` / `today`:
  a bare same-record field named `sum` is no longer expressible (dotted paths
  like `sum.x` and cross-refs `[obj:id:sum]` are unaffected, since the check is
  on the bare lexeme only). An accepted cost, consistent with ADR 0010/0012.
- **Value-context arguments**: each argument parses through `parseExpression`,
  so a comparison (`SUM(a > b)`) or a string literal (`SUM("x")`) inside an
  argument hits the same condition-only rejection it hits anywhere outside an
  IF condition's top level. No new rule — the existing value-context grammar
  gives this for free.
- **Null policy — all-null yields null (deliberate deviation from Excel)**:
  evaluation is EAGER over every argument (never lazy — unlike IF, there is no
  untaken branch to skip), so an error in any argument (e.g. `DIVISION_BY_ZERO`)
  always propagates. A null argument is SKIPPED, not treated as 0, so
  `SUM(a, b, c)` totals whichever of the three currently hold a value. When
  EVERY argument is null the result is **null, not 0** — the same principle as
  ADR 0003/0010: an empty set of inputs is "no data", which must render blank,
  never silently materialize as a computed 0. (Excel's `SUM()` of blanks is 0;
  we diverge because a formula field's blank vs. 0 distinction is load-bearing
  for the whole write/convergence/override stack — a 0 would be a real written
  value, a null clears the field.)
- **Eager dependencies**: dependency extraction unions the references of ALL
  arguments (mirroring IF's eager extraction across both branches), because a
  change to any argument can change the sum. `usesToday` likewise ORs across
  all arguments so a `TODAY()` buried in any operand keeps the formula's
  staleness detection (ADR 0015) correct.
- **DoS bounds unchanged**: the SUM frame counts against the existing
  `MAX_PARSE_DEPTH` (parse) and each argument recurses under the existing
  eval-depth guard, so nested SUMs are bounded the same way nested IFs and
  parentheses are. No new limits.

## Consequences

- **The write/convergence/override stack is untouched.** `SUM` produces a
  `number | null`, so nothing outside `src/engine/` changes structurally.
- **`SUM(field)` is not a mirror.** Mirror detection keys off
  `bareReferenceOf`, which returns non-null only for a bare `field` / `crossref`
  node; a `SumNode` yields null, so `SUM(status)` onto a non-engine-family field
  is correctly rejected as "not a plain field reference" rather than mis-classed
  as a mirror. No change needed in save-validation or the front-end validator.
- **Blank-tolerant totals.** `SUM(a, b, c)` renders a partial total when some
  inputs are empty, where `a + b + c` would render blank — the motivating win.
  An all-empty `SUM` still renders blank, so the field never flips to a
  fabricated 0.
- **Editor autocomplete** offers `SUM(` alongside `IF(` and `TODAY()` in
  `formula-field-input.tsx`'s static function-suggestion list.
