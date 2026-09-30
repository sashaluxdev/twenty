# ADR 0032: Port the timeline cleanup classifier to the typed timeline-activity contract

**Status: IMPLEMENTED (2026-09-09) on `feat/formula-field-timeline-cleanup-schema` -- NOT yet deployed to cloud, cloud retro purge NOT run.** This is a repair, not a new
feature: an external platform schema change silently broke ADR 0020/0022's cleanup
classifier, and this ADR ports the same classifier logic onto the platform's
replacement contract. Entry points unchanged from ADR 0022:
`src/logic-functions/lib/timeline-cleanup.ts` (`cleanupFormulaTimelineNoise`),
`src/logic-functions/timeline-cleanup.ts` (10-minute cron),
`scripts/retro-purge-timeline.ts` (historical purge).

## Context

Platform commit `2f27360df3` (2026-08-23, PR #24620 "Make timeline activity types a
generic application contract") turned `timelineActivity` types into a first-class,
app-declarable contract shared by standard objects, custom objects, messages,
calendar events, notes and tasks alike. Two consequences for this app:

- `timelineActivity.name` -- the column ADR 0020's classifier filtered and
  parsed (`<object>.updated`) -- no longer exists on the entity
  (`timeline-activity.workspace-entity.ts:19-53`).
- Every row now carries `timelineActivityTypeId` (a workspace-local UUID FK) plus
  `timelineActivityTypeSnapshot` (a RAW_JSON blob captured at write time, holding
  `name`, `action` and the type's stable `universalIdentifier` -- a durable
  historical record even if the type is later renamed). The standard
  `recordUpdated` type's `universalIdentifier` is
  `20202020-0d1a-4f0e-8a55-1c0a2f0a2c02`
  (`standard-timeline-activity-type-definitions.constant.ts:51-52`); exactly one
  such row is seeded per workspace, enforced by a `(name, applicationId,
  workspaceId)` unique index (`timeline-activity-type.entity.ts:35-38`) -- so the
  *id* is workspace-local but the *universalIdentifier* is a stable constant
  every workspace agrees on.

ADR 0020's cron queried `timelineActivities` with `filter: { name: { in: [...] } }`.
That query has thrown `"Object timelineActivity doesn't have any name field"` on
every one of its 10-minute runs since 2026-08-23. This was not swallowed into a
quiet, zero-count run: `execute` (`dynamic-client.ts`) throws on a GraphQL
`errors[]` response, `withRetry` (`with-retry.ts`) treats a schema error as
non-retryable and rethrows on the first attempt, and nothing in
`cleanupFormulaTimelineNoise` or the cron wrapper catches it -- so every
10-minute invocation failed outright, with a thrown error, for 17 days. The
break was silent only in the sense that nobody was watching cron invocation
failures; there was no monitoring on this cron to surface a thrown error, so it
went unnoticed until this session's dev dry-run surfaced the stack trace
directly.

Live cloud audit (2026-09-09, read-only workspace GraphQL, no writes):

| Signal | Count | Notes |
| --- | --- | --- |
| Live `timelineActivity` rows (total) | 104,406 | 0 soft-deleted |
| ...with no `workspaceMember` (API/system actor) | 93,197 | the candidate pool the cron reads from |
| `formulaDefinition`-target rows, trailing 30d | 4,571 | ~350/48h; diff keys `lastEvaluatedAt`/`lastValue` -- ADR 0022's F1/F3 bookkeeping noise, uncleaned since 08-23 |
| `person`-target rows, 2026-09-07 03:00-21:00 UTC | ~64,500 | `messageLinked`/`calendarEventLinked` by System -- email/calendar sync, **not** this app (no person formulas exist) |

The large `person` spike is a reminder of scope, not a regression to fix: most of
the live table is platform sync noise this app was never meant to touch. The
actual backlog this ADR exists to clear is the `formulaDefinition`/`variationConfig`
bookkeeping stream ADR 0022 quieted and this break re-opened -- roughly 350 rows
per 48h, compounding since 2026-08-23.

Cloud's record API (reads and writes alike; /metadata is not counted) is
rate-limited to 100 requests/60s per workspace, shared by every API key in it,
and in practice the Supabase webhook echo makes each write cost ~2 requests.
That shapes the script throttle design in Decision below.

## Decision

**Resolve the type id once per run, memoized.** `resolveRecordUpdatedTypeId`
queries metadata's argument-less `timelineActivityTypes { id universalIdentifier
isActive }`, matches on `universalIdentifier`, and caches the verdict -- including
a `null` verdict -- for 60s per workspace (`workspaceCacheKey()`), with an
injectable `options.metadataClient` seam mirroring `find-fields.ts`. The lookup
runs strictly *after* the existing `model.size === 0` early return, so a
workspace with no formula definitions still costs zero requests, and the 60s TTL
means every production 10-minute cron run pays exactly one metadata request (the
memo only helps back-to-back runs in the same process, e.g. a dry-run
immediately followed by a wet run).

**If the type id cannot be resolved, the run does not query `timelineActivities`
at all.** No safe candidate filter exists without it, so querying the (large)
table would mean scanning unfiltered and falling back to in-process
classification alone -- see the rejected alternative below for why that is unsafe.
Zero counts are returned and a warning is logged at the call site (not inside the
resolver, so a run served by the memoized `null` verdict still warns every time -- otherwise the failure mode that hid the `name` break for 17 days would recur:
silence dressed as an empty result).

**Server-side filter** now reads:

```
{
  timelineActivityTypeId: { eq: <resolved id> },
  or: [{ target<Object>Id: { is: NOT_NULL } }, ... one per managed object],
  workspaceMemberId: { is: NULL },
  happensAt: { gte: <lookback start> },
}
```

(`timeline-cleanup.ts:744-761`.) Top-level keys AND together; `or` is a
bracketed group ANDed with its siblings, so it narrows candidates to rows
belonging to a managed object without widening anything else. `target<Object>Id`
is an ordinary nullable FK join column (`timeline-activity.workspace-entity.ts`
declares one per standard object plus `targetCustom` for custom ones) and is
filterable with `is: NOT_NULL` the same way `deletedAt` already was;
`timelineActivityTypeId` is a plain UUID scalar, filterable with `eq`. None of
this is new filter machinery -- it is the same shape the existing
`workspaceMemberId`/`happensAt` keys already used, extended by one more AND'd
key and one `or` group.

**Mandatory in-process gate.** `isRecordUpdatedRow` re-checks each returned
row's own `timelineActivityTypeSnapshot.universalIdentifier` against the same
constant the server filter used to select it (`timeline-cleanup.ts:154-160`).
Belt and braces: a stale/wrong id, a metadata race, or a future widening of the
server filter can still not reach the classifier's delete/strip paths, because
the in-process gate is a second, independent check on the same fact.

Rationale for the gate rather than trusting the server filter alone: routed
timeline rows -- `taskUpdated`, `noteUpdated`, `messageLinked`,
`calendarEventLinked` -- are parented on the *linked* record via the same
`target<Object>Id` columns this filter narrows on, and a routed type's diff can
carry a key name that collides with a managed object's bookkeeping/formula key
(e.g. a `taskUpdated` row's diff happening to include a key spelled the same as
a managed field). If the type id were ever unresolved and the code fell back to
the bare `or` filter without the `timelineActivityTypeId` AND, a busy workspace
could have up to `PAGE_SIZE * MAX_PAGES` = 2,000 routed sync rows fill the page
budget per run, reporting `truncated: true` forever without ever reaching a
genuine app-managed row. The chosen design instead skips the run entirely when
the id is unresolved (see above) -- a bounded zero-count failure, not an
unbounded, permanently-truncated one.

**Row → object resolution now comes from the parent column, not `name`.**
`objectFromParentColumns` reads the one `target<Object>Id` column that is
non-null for a given row (`timeline-cleanup.ts:162-184`). Zero populated columns
(an unmanaged object, or a routed type whose target isn't in the managed set)
or more than one populated column (an ambiguous mapping) both resolve to `null`,
which `processRow` treats as KEEP -- same fail-safe posture ADR 0020 established,
now load-bearing on a column that used to be secondary (only the variation
branch read it before this port; now every row's object identity comes from it).

**Silent-zero tripwire.** A run that scans zero rows while the managed-object
model is non-empty now logs a warning. This is the one place ADR 0020/0022 had
no equivalent: nothing previously distinguished "genuinely quiet" from
"can't see anything" for the main scan (only the type-id resolution above had
no analogous signal until this ADR). It does not fully close the gap by itself
(see Consequences), and it covers a different failure mode than the `name`
break: a well-formed query whose filter matches nothing (an unresolved or
wrong type id), not a query that errors outright. A throwing query never
reaches this check at all -- `counts.scanned` is never computed, and the error
propagates straight out of the run -- so this warn would NOT have caught the
`name` break. What would have is monitoring the cron's own invocation
failures, which is not yet in place (see Not in scope).

**Dry-run.** `cleanupFormulaTimelineNoise(client, { dryRun: true })` runs the
identical read and classification path and shares the exact verdict computation
with the wet path (a pure `planStrip` helper returns `kept`/`deleted`/`stripped`
before either branch decides whether to mutate), skipping only the two mutation
call sites. Reported counts are "would apply", since a dry run cannot observe a
mutation failure the way a wet run does (a write that still fails after its
retries is counted as `failed`, never as `kept`).

**Retro-purge runnable, gated on `--yes`.** `scripts/retro-purge-timeline.ts`
now takes `[--dry-run] [--lookback-days N] [--rate N] [--yes]` (`--rate`: the
transport's requests per minute, whole number 1-95, default 90); any unrecognized argument
exits 1 with usage (so a mistyped flag can never silently start writing); wet
mode without `--yes` exits 2 after printing what it would have done. This is a
**behavior change**: `yarn retro-purge <remote>` used to write directly and now
requires `--yes`. `scripts/lib/remote-client.ts` centralizes remote config
loading (`loadRemote`) and a throttled fetch transport
(`createThrottledFetchTransport`, 90 requests/60s sliding window by default --
below cloud's 100/60s workspace limit, leaving room for the workspace's other
API clients). On a GraphQL error whose message starts `Rate limit exceeded` or
`Limit reached` (case-insensitive, anchored), or on HTTP 429, the transport
sleeps 60s and retries, up to 5 consecutive
times, then returns the payload as-is so the caller's own handling applies -- this is the *only* rate-limit protection in these scripts, because `execute` in
`dynamic-client.ts` drops GraphQL `extensions` before `withRetry` sees them, so
`withRetry` never recognizes the `RATE_LIMITED` code -- and `with-retry.ts`
does not list `RATE_LIMITED` either (a pre-existing defect, deferred -- see
Not in scope). A dry run is exactly one pass and cannot page
past `maxPages` (50 pages × 100 rows): nothing is deleted, so a second pass
would re-scan the identical rows.

### Alternatives rejected

- **`timelineActivityTypeSnapshot: { like: '%recordUpdated%' }`** -- the snapshot
  is a JSON blob; matching it as text depends on how the server serializes
  jsonb to a `like`-comparable string (key order, whitespace, escaping), none
  of which is a documented guarantee. The `timelineActivityTypeId` scalar `eq`
  filter is exact and stable; there is no reason to depend on jsonb text
  rendering when an indexed UUID equality filter does the same job precisely.
- **A snapshot-only in-process gate, no `timelineActivityTypeId` filter at the
  server.** This would mean fetching every row in the lookback window
  unfiltered by type and classifying client-side. As the rationale above
  spells out, routed/creation rows (task/note/message/calendar-event activity,
  plus ordinary `recordCreated` rows) share the exact `target<Object>Id`
  columns this filter narrows on; without the type-id AND, those rows would
  compete for the same fixed page budget as genuine app noise and could starve
  it on a busy workspace.
- **Fixing `withRetry` to see GraphQL `extensions.code`** so a `RATE_LIMITED`
  code is recognized directly (which also means adding `RATE_LIMITED` to its
  retryable codes), instead of relying solely on the transport's
  own throttle. Correct fix, but pre-existing and orthogonal to this port
  (`execute`'s extensions-dropping is unrelated to the `name` → typed-contract
  migration); deferred, tracked in Not in scope.

## Consequences

- **The metadata type-id request bypasses the script transport, harmlessly.**
  `resolveRecordUpdatedTypeId` goes through the SDK's `MetadataApiClient`
  directly, not through `createThrottledFetchTransport`; /metadata requests
  are not counted by the rate limiter, so it needs no headroom in the window.
- **`scripts/audit-strict-gate.ts` did not merely move onto the same helpers
  with behavior unchanged.** Before this branch it threw `"CoreApiClient was
  not generated"` in this workspace, so this port also makes it runnable
  again for the first time, and newly throttles its core reads through the
  same 90-requests/60s transport; its per-formula metadata reads bypass that
  window but are not rate-limited.
- **The in-process gate is mandatory, not optional insurance** -- it is the
  second half of a two-layer check (server filter + snapshot re-check), not a
  redundant belt-and-braces that could safely be dropped. See the routed-rows
  rationale above.
- **The silent-zero warn fires on every quiet run**, which at the 10-minute
  cron cadence is roughly 144 warnings/day even when the workspace is
  perfectly healthy and there is simply nothing to clean in a given window.
  Known follow-up, not fixed here: fold the warn into periodic counts, or only
  warn after N consecutive zero-scan runs.
- **Caveat carried forward, not closed by this ADR:** a non-routed,
  application- or override-defined `updated`-style timelineActivityType on a
  managed object -- one that does not carry the standard `recordUpdated`
  universalIdentifier -- would produce rows invisible to this sweep, because
  neither the server filter nor the in-process gate would ever select them.
  The scanned-0 warn is the only tripwire, and it only fires when a run scans
  *zero* rows total; a workspace where some objects are visible to the sweep
  and one is invisible stays quiet. Closing this fully would need a
  per-object scanned count, which is out of scope here (noted in the Task 1
  report as a pre-existing limitation of the `name`-based version too, now
  restated against the typed contract).
- **Status is NOT deployed; filter semantics ARE live-verified on dev
  (2026-09-09).** After the `dev` remote's API key was refreshed and the app
  installed on the local workspace (`dev --once -r dev`, a fresh install with
  zero definitions), `retro-purge-timeline.ts dev --dry-run` ran end to end
  and exited 3 (no managed objects). A scratch probe then sent the exact cron
  filter -- top-level AND, the `or` bracketed group, `target<Object>Id`
  `is: NOT_NULL`, `timelineActivityTypeId` `eq`, `workspaceMemberId` NULL --
  against the local server: no GraphQL errors, and it matched exactly the one
  `recordUpdated` row produced by updating a seed company (`employees`), with
  the snapshot's `universalIdentifier` equal to the constant and the join
  column populated. The 14,252 seeded rows are all `recordCreated`, so a fresh
  workspace legitimately has zero candidates. A second pass then seeded real
  noise (a `company.formulaProbe` NUMBER field + an enabled `employees * 2`
  definition; recompute fired in the worker on its own): 23 API-authored
  `recordUpdated` rows. `dev --dry-run` reported deleted 13 / stripped 1 /
  kept 9; `dev --yes` applied exactly that; `deletedAt IS NOT NULL` = 13; the
  negative control (an `employees`-only diff) stayed live; the mixed row was
  stripped to `employees,updatedBy`. Sixteen more noise rows were then left
  for the app's own 10-minute cron, which purged exactly those 16 unattended.
  Cloud was never contacted.
- **Runbook**, in order: confirm the `cloud` remote in `~/.twenty/config.json`
  carries a workspace API key (`apiKey`), not only CLI OAuth tokens --
  `loadRemote` (`scripts/lib/remote-client.ts`) exits 1 when it is missing;
  mint one in Settings > API & Webhooks and register it with `twenty
  remote:add --as cloud --url <cloud url> --api-key <key>` if missing → deploy
  the app (`app:publish --private -r cloud`, then `app:install -r cloud`) →
  `npx tsx scripts/retro-purge-timeline.ts cloud --dry-run --rate 30` → review
  the printed counts → `npx tsx scripts/retro-purge-timeline.ts cloud --yes
  --rate 30`, re-run while it exits 4. The
  cloud retro purge was dropped at the user's request on 2026-08-10 (the
  untracked scratch script was deleted; the committed
  `scripts/retro-purge-timeline.ts` stayed); this ADR revives that committed
  script as the vehicle for the post-2026-08-23 backlog, to run only on the
  user's explicit go -- none of the steps above are authorized to run
  themselves.
- **Exit codes** (`scripts/retro-purge-timeline.ts`): 1 for bad/unrecognized
  arguments, 2 for wet mode (no `--dry-run`) without `--yes`, 3 when a pass
  scans 0 rows (nothing to purge, or the candidate filter cannot see
  anything -- see the printed warning for which), 4 when at least one
  delete/strip mutation failed after its retries (those rows are still live;
  re-running is safe, the purge is soft-delete-only and restartable).
- **Known limits of the wet loop.** Each pass rescans from the first row
  with at most 50 pages (5,000 rows), so stripped and kept rows (K) pile up
  at the front of the window; passes converge only while K is well under
  5,000 (measured K on 2026-09-30: ~505). Follow-up: an unbounded page count
  for wet runs. Exit 3 can also come from a transient type-id lookup failure,
  not only from nothing being left to purge.

## Not in scope (backlog)

- Monitor/alert on cron invocation failures for timeline-cleanup -- this is
  the actual tripwire the `name` break needed; nothing watches whether the
  10-minute cron's own invocations are throwing, so a repeat of the same
  failure mode (a query that errors on every run, not one that quietly finds
  nothing) would again go unnoticed.
- Live server verification of the four filter semantics claims above -- one
  `dev` API-key refresh away, and worth doing before trusting the cloud purge.
- Actually running the cloud retro purge -- mechanism ready, not yet executed.
- Fixing `withRetry`/`execute` to see GraphQL `extensions.code` so rate-limit
  detection does not depend solely on the script transport's own sliding
  window -- pre-existing, deferred. The platform's code is `RATE_LIMITED`,
  which `with-retry.ts` does not list, so that fix must add it.
- Quieting the scanned-0 warn's per-cron-cycle noise on an otherwise healthy
  workspace (fold into counts, or gate on consecutive zero runs).
- A per-object "scanned 0 for object X" signal, to close the residual
  invisible-type-on-one-object caveat above.
- Retire this ADR's mechanism (and ADR 0020/0022's) together if the platform
  ever ships field-level or type-level audit exclusion for app writes -- the
  same standing caveat those ADRs established, now covering the typed-contract
  port as well.
