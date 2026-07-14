# ADR 0020: Timeline noise cleanup via a 10-minute cron sweep

**Status: IMPLEMENTED (2026-07-14).** Entry point:
`src/logic-functions/timeline-cleanup.ts` (cron `*/10 * * * *`) wrapping the
`cleanupFormulaTimelineNoise` lib (`src/logic-functions/lib/timeline-cleanup.ts`).
Cleans up after the formula mirror stack (ADR 0006) and the record-variations
sync engine (ADR 0009 family + ADR 0019 relation mirroring). Decided 2026-07-14;
the user chose app-side cleanup over an upstream twenty-server PR.

## Context

The app's automated writes — a formula's recompute of its `targetField` (+ its
FxStatus companion), field-mirror passthroughs, and the variation engine's
primary→variation field copies — land through the ordinary record API. Every one
of them emits an `<object>.updated` timelineActivity row, so a record whose
formula recomputes on each upstream edit accumulates a flood of app-authored
"Updated Revenue" entries that bury the human history in its Timeline.

There is no server-side switch to suppress them:

- **The timeline diff builder has no field-flag filter.** `objectRecordChangedValues`
  (`packages/twenty-server/src/engine/core-modules/event-emitter/utils/object-record-changed-values.ts:112-120`)
  skips exactly `updatedAt`, `searchVector`, and relation-typed fields
  (`RELATION` / `MORPH_RELATION` / MANY_TO_ONE) — nothing else. There is no
  "this field is app-managed, don't audit it" flag it consults, so an
  app-written scalar always produces a diff entry.
- **The Apps SDK exposes no field/object audit-exclusion flag.** Neither
  `defineField` nor `defineObject` offers a "do not log to the timeline"
  attribute, so the app cannot opt its fields out at definition time.
- **An empty diff already produces zero rows, and same-key rows merge for 10
  minutes** (`packages/twenty-server/src/modules/timeline/repositories/timeline-activity.repository.ts:45-136`):
  an `updated` payload with an empty diff returns `[]` (no row), and a row whose
  `(recordId, name, workspaceMemberId)` matches one from the last 10 minutes is
  merged into it rather than inserted. This is why the cleanup can *strip* a
  managed key out of a mixed row (leaving the human keys) instead of only
  deleting whole rows — a fully-emptied diff simply is not a visible entry.
- **No `.created` trigger can catch these rows at birth.** Timeline rows are
  written by an async server-side queue job, not through the record API the app
  subscribes to, so no `timelineActivity.created` database event fires that the
  app could hook. Cleanup can only be *post-hoc*.
- **The app role already has the reach to clean up.** `timelineActivity` gets
  full CRUD resolvers despite `isSystem: true`, and the default role
  (`src/roles/default-role.ts`) already grants read / update / softDelete on all
  object records — so no new permission is needed, and `canDestroyAllObjectRecords`
  stays `false` (deletes are soft).

## Decision

**Sweep the app's own noise out of the Timeline on a frequent cron.** A logic
function `timeline-cleanup` runs every 10 minutes (`*/10 * * * *`) and calls
`cleanupFormulaTimelineNoise`, which:

- fetches only `<object>.updated` rows with `workspaceMemberId IS NULL` (app/API
  writes never carry a workspace member; human-authored rows are never even
  queried — the hard safety gate) within a bounded recent window;
- **soft-deletes** a row whose changed fields are *all* app-managed (formula
  target + companion, or variation-managed keys when the row's record is itself
  a variation) via `deleteTimelineActivity` — never `destroy*`;
- **strips** only the app-managed keys from a *mixed* row (an app key next to a
  human key), rewriting the diff so the human entry survives untouched;
- **fails safe toward keeping**: any row whose diff is missing, unparsable,
  empty, belongs to an object with no managed fields, or whose parent-record
  variation status is unresolvable, is left exactly as-is.

The 10-minute cadence matches the server's own 10-minute merge window, so a
burst of app writes to one record has typically already collapsed into a single
row by the time the sweep sees it. The entry file is a thin wrapper: build the
dynamic client, run the lib, spread the per-outcome counts back out for the cron
log. The mechanism is chosen over an upstream twenty-server audit-exclusion PR
because it ships entirely inside the app and needs no platform change.

## Consequences

- **Up to ~10 minutes of visible noise between runs.** App-authored rows are
  visible in a record's Timeline until the next sweep. This is accepted: the
  cadence bounds it, and pushing lower trades against sweep cost.
- **A null-member API integration that writes ONLY formula-managed fields would
  have its rows culled.** The `workspaceMemberId IS NULL` gate cannot distinguish
  the app's own writes from a third-party API key that happens to touch only a
  formula target/companion (or, on a variation record, only variation-managed
  keys). Such a row looks identical to app noise and is removed. Accepted: the
  managed fields are ones the app owns and continuously overwrites anyway, so an
  external integration authoring solely those is already fighting the app.
- **Soft deletes only.** Removed rows are recoverable and the role keeps
  `canDestroyAllObjectRecords: false`; a bad classification is reversible.
- **Retire the whole mechanism if the platform ships field-level audit
  exclusion.** The day twenty-server (or the SDK) lets a field opt out of the
  timeline diff at the source, this cron and its lib become dead weight and
  should be deleted — suppressing at birth is strictly better than sweeping
  after the fact.

## Not in scope (backlog)

- An upstream twenty-server PR adding a field-level audit-exclusion flag (the
  proper fix; deferred by user choice).
- Surfacing sweep counts / `truncated` beyond the cron's return value (e.g. a
  health record).
- Cloud deploy (user-gated; a separate step after this arc).
