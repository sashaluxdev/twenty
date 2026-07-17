# ADR 0023: Contain mount-triggered recompute sweeps

## Status
Accepted (2026-07-17). Deviates from ADR 0015's "honest refresh" — flagged for user review.

## Context
ADR 0015 made both editor widgets run recomputeAllRecords ("the honest
refresh") whenever a stale, enabled, TODAY()-using definition was visible,
throttled to 60s via caller-held state. Two facts broke this in practice:
(1) Twenty unmounts inactive record-page tabs, so the caller-held useRef
throttle state reset on every tab open — the "60s" throttle fired per open;
(2) recomputeAllRecords is a sequential whole-object sweep of per-record
queries running fire-and-forget in the browser, unabortable, competing with
the widget's own load waterfall. The 2026-07-17 load-time diagnosis measured
this as a continuous multi-req/s browser query flood.

## Decision
- Throttle/in-flight state moves to module-global (sharedRecordRefreshState /
  sharedSweepRefreshState), surviving remounts — the 60s gate now holds.
- The record-page formula-editor recomputes ONLY the viewed record
  (sweepAllRecords: false). The stale note may persist until the hourly cron
  sweep or a definition-page visit — that is honest too: the sweep IS stale.
- The definition page keeps the full sweep (one definition, admin surface,
  advances lastEvaluatedAt) but passes shouldContinue so unmount stops it at
  the next record boundary.

## Consequences
Viewing a record can no longer trigger hundreds of background queries; the
cron sweep (ADR 0012/0020) is the sole whole-object converger outside the
definition page. If the cron is dead, staleness surfaces as the existing
passive note rather than being silently patched by record views.
