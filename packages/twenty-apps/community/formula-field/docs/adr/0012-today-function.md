# ADR 0012 — TODAY() as an injected, caller-supplied value

- Status: Accepted
- Date: 2026-07-04

## Context

Item #5 of the build pipeline: formulas need a way to reference "the current
date" so a condition like `IF(startDate > TODAY() + 100, 1, 0)` is expressible.
Dates are plain numbers in this engine (ADR 0011, epoch-days), so "the current
date" just needs to resolve to a number — the hard part is *where that number
comes from* without breaking the engine's purity guarantee.

`src/engine/` is explicitly documented as I/O-free: "no eval, and no dynamic
code path" and, per the evaluator, no ambient state. Reading `Date.now()`
directly inside the evaluator would make `evaluate()` return a different
result for the identical `(ast, resolver)` pair depending on when it runs —
non-deterministic and untestable without mocking the system clock, which is
exactly the kind of hidden dependency the rest of the engine goes out of its
way to avoid (see how field/cross-record reads are *always* routed through the
caller-supplied `VariableResolver` rather than the engine reaching for data
itself).

## Decision

- **`TODAY()` is a reserved, nullary function** — same shape as `IF` (ADR
  0010): the parser recognizes the identifier `today` (case-insensitive)
  followed by `(`, requires an empty argument list, and produces a dedicated
  `TodayNode`. Bare `today` (no parens) is a `PARSE_ERROR` naming it a reserved
  word, mirroring `IF`'s bare-identifier rejection; dotted paths (`today.x`)
  are unaffected since the check is on the bare lexeme only.
- **The current date is a caller-supplied input, not an engine-internal
  clock read.** `evaluate()` gains an `EvaluateOptions.todayEpochDay: number`.
  Evaluating a `TodayNode` returns `options.todayEpochDay` verbatim; if the AST
  contains a `today` node and the option is omitted, evaluation throws
  `FormulaError('UNKNOWN_VARIABLE', ...)` (same failure mode as an unresolved
  field — a clear, typed error rather than silently defaulting to some
  ambient value). This keeps the evaluator a pure function of its arguments:
  same `(ast, resolve, options)` in, same result out, fully unit-testable with
  an arbitrary fixed date.
- **Exactly one production call site reads the system clock**:
  `computeFormulaValueForRecord` in `recompute.ts` (the only place
  `evaluate()` is invoked outside tests). It computes
  `Math.floor(Date.now() / MS_PER_DAY)` once per evaluation — a whole UTC
  epoch-day, consistent with how a DATE value is represented (ADR 0011) — via
  a new `date-serial.ts` export, `currentEpochDay()`, and passes it as
  `todayEpochDay`. `date-serial.ts` is already the single conversion
  chokepoint between epoch-days and wall-clock time, so the one ambient clock
  read belongs there, not duplicated at call sites.
- **No new dependency-tracking or recompute-trigger machinery.** `TodayNode`
  is a dependency-extraction no-op (like `NumberNode`) — it names no field, so
  it cannot participate in cycle detection or per-record event triggers.
  Freshness instead rides entirely on the existing hourly convergence sweep
  (ADR 0004): `formula-sweep` unconditionally re-evaluates every enabled
  formula regardless of whether any tracked dependency changed, so a
  `TODAY()`-based formula's day boundary is caught within at most an hour of
  midnight UTC — no new cron trigger, no "does this formula use TODAY()" flag
  needed anywhere.
- **Truncated to a whole day, no `NOW()`.** Only the calendar date is exposed
  (matching Excel's `TODAY()`, not `NOW()`), because the only motivating use
  case (item #5) is date-only comparisons like `startDate > TODAY() + 100`.
  Nothing in the design prevents adding a fractional-time `NOW()` later via the
  identical mechanism (another reserved nullary function fed by an
  `EvaluateOptions.nowEpochDay`) if a future need requires time-of-day
  precision; out of scope here.

## Consequences

- **The engine stays pure and 100% unit-testable**: every engine test fixes
  `todayEpochDay` explicitly, so `TODAY()`-dependent assertions are
  deterministic and never flake against the real calendar date.
- **`TODAY()` formulas are eventually consistent, not instantly reactive.**
  A record's computed value that depends on `TODAY()` only updates on its own
  event triggers (same-record/cross-record field changes) or the hourly sweep
  — not the instant midnight UTC ticks over. This is the same convergence
  latency the sweep already exists to bound (ADR 0004); no regression, just a
  new source of "staleness" it now also covers.
- **`today` becomes a reserved word**, like `if`: a bare same-record field
  literally named `today` is no longer expressible (dotted paths still are).
  No existing installs have such a field; accepted cost, consistent with
  ADR 0010's precedent.
- **Editor autocomplete** offers `TODAY()` alongside `IF(` in
  `formula-field-input.tsx`'s static function-suggestion list.
