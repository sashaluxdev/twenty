# ADR 0015 — TODAY() staleness: self-healing widget + truthful heartbeat

- Status: Accepted
- Date: 2026-07-04

## Context

TODAY() values (ADR 0012) refresh only on record events or the hourly
sweep. If the worker/sweep dies, values go stale silently and
indefinitely — nothing in the UI distinguishes stale from current, and
midnight-UTC rollover (9am JST) makes "stale all morning" a likely user
report. Complication: `lastEvaluatedAt` is written only when a value
CHANGES (audit M3 write-avoidance), so it means "last change", not "last
evaluation" — a naive staleness check on it would false-positive on any
healthy formula whose value legitimately never changes.

## Decision

- **Staleness is scoped to TODAY-using formulas only.** New engine walker
  `usesToday(node)` in `dependencies.ts` (same family as dependency
  extraction); the widget parses expressions client-side (the engine
  already ships in the front bundle).
- **Truthful heartbeat, bounded cost**: `recordEvaluationHeartbeat` gains
  a caller-supplied `expressionUsesToday` flag (the recompute path
  already holds the parsed AST — no re-parse). On a no-op outcome where
  the flag is set AND stored `lastEvaluatedAt` is older than 1h, it
  writes `lastEvaluatedAt` alone. Ceiling: one extra definition write per
  hour per TODAY-formula (sweep cadence). M3 write-avoidance intact
  everywhere else, so for TODAY formulas `lastEvaluatedAt` now truthfully
  means "last evaluation".
- **Widget rule** (record-page Formula tab): enabled + usesToday +
  `lastEvaluatedAt` older than 2.5h (≥2 missed sweeps; core's
  sync-staleness threshold of 30min scaled from a minutes-cadence
  pipeline to our hourly one) →
  - muted warning note `Computed about 3 hours ago` — format replicates
    core's `beautifyPastDateRelativeToNow` idiom (date-fns
    `formatDistanceToNow` with addSuffix + includeSeconds; "now" <30s;
    lowercase; "about" on hour-scale) via a local, unit-tested
    `formatRelativePast()` (the sandbox cannot import twenty-front);
    orange per core's Status color convention;
  - **self-heal**: trigger `recomputeForRecord` for the viewed record,
    throttled 60s per widget (the layout-convergence throttle pattern).
    This runs in the FRONT runtime — a dead worker no longer means stale
    values on any record someone views.
- The FormulaDefinition editor page always shows the relative
  `lastEvaluatedAt` (observability, not only when stale).

## Consequences

- Staleness now fixes itself wherever humans look and is visible where
  they don't; records nobody opens still wait for the sweep — accepted
  (same convergence contract as ADR 0004).
- One deliberate write-avoidance carve-out, flagged per-formula and
  rate-limited to the sweep cadence.
- The 2.5h threshold assumes the hourly sweep stays hourly; if the sweep
  cadence changes, this constant must follow it.
