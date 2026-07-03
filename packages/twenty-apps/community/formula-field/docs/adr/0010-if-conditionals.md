# ADR 0010 — IF conditionals with condition-confined transient comparisons

- Status: Accepted
- Date: 2026-07-03

## Context

Formulas need branching (`IF(condition, then, else)`), which requires comparison
operators — and comparisons naturally produce booleans. But the entire stack
downstream of the engine — value-field writes, no-op-write suppression,
convergence rounding, override detection by value comparison — is built on the
engine's public value domain being exactly `number | null` (ADR 0003, 0004,
0006). Letting a boolean become a formula *result* would ripple through
value-io, both convergence comparison sites, and the override detector. We also
need the grammar to stay whitelist-safe (ADR 0002: no call node that can express
code execution) and DoS-bounded.

## Decision

- **Function-call form**: `IF(condition, thenExpr, elseExpr)` — exactly 3
  arguments, keyword case-insensitive. The parser recognizes the identifier
  `if` followed by `(` as static dispatch to a dedicated `IfNode`; there is
  still no general call node, so the grammar still cannot express code
  execution. `if` becomes a reserved word: a bare same-record field named `if`
  is no longer expressible (dotted paths like `if.x` still are) — an accepted
  cost.
- **Comparisons are TRANSIENT**: `> < >= <= = !=` (with `==` accepted as an
  alias of `=`, normalized at tokenize time) are legal ONLY at the top level of
  IF's condition slot (`condition := expression (compareOp expression)?`). A
  comparison anywhere a value is expected — top level, inside arithmetic,
  inside a then/else branch, inside a parenthesised comparison operand — is a
  `PARSE_ERROR` with a message naming the condition-only rule. Chained
  comparisons (`a > b > c`) are a `PARSE_ERROR` (comparison is not
  associative). The evaluator computes comparison truth as an internal boolean
  that never escapes the module; the public `evaluate()` signature stays
  `number | null`.
- **Truthiness (Excel-style)**: a comparison yields true/false; a plain numeric
  condition is allowed, with 0 = false and nonzero (including negatives) =
  true.
- **Null policy (ADR 0003 consistency)**: a null condition, or null in either
  comparison operand, makes the ENTIRE IF result null. This deliberately
  deviates from Excel, where a blank cell compares as 0 — our policy is that an
  empty input never silently acts as a computed value.
- **Lazy evaluation, eager dependencies**: only the taken branch is evaluated
  (an error such as `DIVISION_BY_ZERO` in the untaken branch never fires; the
  condition is always evaluated). Dependency extraction, by contrast, collects
  references from the condition AND BOTH branches, because a change to any of
  them can change the result (or flip which branch is taken). Cycle detection
  consumes the extracted dependencies unchanged.
- **DoS bounds unchanged**: IF argument parsing counts against the existing
  `MAX_PARSE_DEPTH`, and IF evaluation against `MAX_EVAL_DEPTH`; arity errors
  (2 or 4+ arguments) are clean `PARSE_ERROR`s. No new limits.

## Consequences

- **The write/convergence/override stack is untouched.** Because a formula can
  never *be* a boolean, nothing outside `src/engine/` changes: value-io,
  convergence rounding, no-op suppression, and value-based override detection
  all keep comparing numbers.
- **Lazy-eval / eager-deps asymmetry**: a formula recomputes when a field read
  only by its *untaken* branch changes. The recompute produces the same value,
  and the no-op write suppression (ADR 0004) swallows it — the extra work is a
  wasted evaluation, never a write storm.
- **Cycle detection is conservative across branches**: `IF(c, a, b)` where `a`
  and `b` are formula targets edges to BOTH, so a "cycle" through a branch that
  is never taken at runtime is still rejected at save time. Consistent with the
  field-granular over-reporting bias of ADR 0005.
- **Equality is exact float equality** (`=` is `===` on numbers). Currency
  values are rounded micros before they reach the engine, so this is stable for
  the common cases; decimal artifacts (`0.1 + 0.2 != 0.3`) behave as in any
  float system.
- **Slightly wider tokenizer surface**: `= ! < > ,` are now accepted
  characters (two-char lookahead for `>= <= != ==`; a lone `!` is still
  rejected). The fuzz suite's forbidden-character set shrank accordingly and
  its valid-expression generator now emits IF/comparison forms.
