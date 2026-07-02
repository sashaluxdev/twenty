# ADR 0003 — Null propagation, divide-by-zero as error, coercion rules

- Status: Accepted
- Date: 2026-07-02

## Context

Referenced fields can be empty (null), of non-numeric types, or produce
undefined behaviour (division by zero). The behaviour must be predictable,
documented, and tested rather than implicit.

## Decision

- **Unknown variable** (resolver returns `undefined`, i.e. the field does not
  exist on the object): hard `UNKNOWN_VARIABLE` error. This is almost always a
  typo in the formula and should fail loudly.
- **Null value** (resolver returns `null`, i.e. the field exists but is empty):
  **null propagates**. Any sub-expression touching a null yields null, and the
  whole formula result becomes null, which the engine writes as `null` to the
  value field (clearing it). We deliberately do **not** coalesce null to 0 —
  that would silently mask missing inputs and make "empty" indistinguishable
  from "computed as 0."
- **Division / modulo by zero**: `DIVISION_BY_ZERO` error. The engine records it
  on `lastError` and leaves the current value unchanged (a transient bad state
  should not destroy the last good value).
- **Non-finite result** (`Infinity`, `NaN`): `NON_NUMERIC_VALUE` error.
- **Type coercion at resolution time** (in the recompute engine, not the
  interpreter): NUMBER / NUMERIC → the number; CURRENCY → its `amountMicros`
  when referenced bare, or address the sub-field explicitly via
  `amount.amountMicros`; BOOLEAN → 1 / 0; any other type → treated as an
  unresolved/`NON_NUMERIC_VALUE` case. CURRENCY is micros (×1e6), so
  `amount.amountMicros / 1000000` yields the major-unit amount.

## Consequences

- "Empty input" surfaces as an empty value field, not a misleading 0.
- Errors never silently corrupt data: on error the last good value is retained
  and the reason is visible on `FormulaDefinition.lastError` and in the front
  component.
- The interpreter stays pure: it only knows number / null / undefined. All
  type-specific coercion lives in the resolver the recompute engine supplies, so
  coercion rules can evolve without touching the interpreter.
