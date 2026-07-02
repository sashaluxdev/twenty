# ADR 0004 — Event triggers + cron sweep + no-op write suppression

- Status: Accepted
- Date: 2026-07-02

## Context

The value field must converge to the formula result whenever any input changes.
Database-event triggers give low latency; but events can be missed (deploys,
errors, downtime) and a formula's own write to the value field re-fires the
update event, risking an infinite recompute storm.

## Decision

Three cooperating mechanisms:

1. **Database-event triggers** (`databaseEventTriggerSettings`, e.g.
   `opportunity.updated`, `company.updated`): on a record change, consult the
   persisted dependency index on each enabled FormulaDefinition and recompute
   only the formulas whose inputs actually changed. The event payload carries
   `{ updatedFields, diff, before, after }`, so same-record inputs are read from
   `after` without a refetch.
2. **Cron sweep** (`cronTriggerSettings`, hourly): re-evaluate every enabled
   formula. This is the correctness backstop that repairs any value staled by a
   missed event. Event trigger = latency; sweep = eventual correctness.
3. **No-op write suppression**: recompute is idempotent and write-avoidant — if
   the freshly computed value equals the current stored value, the mutation is
   skipped. This is also the **recursion guard**: our own write sets
   `value = X`; the re-fired event recomputes `X`; `X === X` → no write → the
   cascade terminates. A runtime max-evaluation-depth guard is the second line of
   defence.

## Consequences

- No self-triggering storm: the fixed-point check stops the cascade after one
  convergent write. Integration tests assert there is no runaway loop.
- Cross-object recompute: when a referenced record changes, formulas that read it
  (via `[object:id:field]`) are recomputed. Because a formula applies to all
  records of its target object, a change to a referenced record recomputes the
  target field on all target records (paginated). Expensive but correct; the
  cron sweep bounds drift.
- Per-object triggers are static (`eventName` is fixed per logic function). The
  app ships triggers for the demo objects (opportunity, company); adding another
  target object means adding a trigger file or relying on the cron sweep.
  Documented as a limitation.
- All recompute paths (event, cron, cross-object) skip records with an ACTIVE
  manual override (ADR 0006), and record a lastValue/lastEvaluatedAt/lastError
  heartbeat on the FormulaDefinition after evaluating (bookkeeping writes, so they
  are excluded from the self-trigger guard).
