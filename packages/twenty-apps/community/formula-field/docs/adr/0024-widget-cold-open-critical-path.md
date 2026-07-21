# ADR 0024: Widget cold-open critical path (v0.1.10)

## Status
Accepted (2026-07-21).

## Context
v0.1.9 (ADR 0023) shipped six load-time fixes, but the user reported cloud
tab-open was still ~5–7s. The 2026-07-17 diagnosis had assumed the local
in-mount caches would help; live measurement on the hosted instance on
2026-07-21 (`docs/plans/2026-07-21-cloud-widget-load-evidence.md`, curl
against the hosted instance, read-only) showed why they didn't:

- **Every request pays a ~300ms floor** (edge/origin RTT, eu-central-1 origin
  vs a client near Tokyo; regular outliers at ~0.75–0.8s). Local dev pays
  ~10ms per request, which is why this class of problem is invisible locally.
- **The 588,084-byte widget bundle is uncacheable by construction**: the
  `/rest/front-components/:id` JSON response is `cache-control: private,
  no-store`, and its presigned S3 URL is freshly signed on every call
  (unique signature, 900s expiry) even though the request already carries a
  content-addressing `?checksum`. Measured 1.79–2.06s per download.
- **Confirmed request chain**: first open pays 8 sequential ~300ms-floor legs
  plus the bundle download; remount pays 6. Of those, 5 (first open) / 5
  (remount) are app-owned; the rest (bundle fetch, sdk-client blob fetch,
  `FindOneFrontComponent`) are platform-owned.
- v0.1.9's three caches (host-resolution, metadata TTL, formula-scan) are all
  module-global inside the front-component's own JS. They never helped
  first-paint because **the platform tears down and recreates the widget's
  Web Worker on every mount** (`FrontComponentWorkerEffect.tsx`), which
  reloads the bundle into a fresh module graph — every module-global starts
  cold on every tab open. ADR 0023 mistakenly claimed its throttle/cache
  state would "survive remounts"; the 2026-07-17 arc's own live verify later
  found host-probe queries re-firing on every reopen and traced it to exactly
  this worker-teardown mechanism. That correction stands: nothing kept in a
  worker-global variable survives a remount. It is precisely why Task 4 below
  reaches for a channel that survives worker teardown — the origin-scoped
  IndexedDB store — instead of another module-global cache.

This ADR covers the four app-side fixes v0.1.10 makes to the widget's
cold-open critical path, and the platform-side items it deliberately leaves
alone.

## Decision

**1. `AppPath` re-sourced off the `twenty-shared/types` barrel.**
`variation-widget.tsx` imported `AppPath` from `twenty-shared/types`, whose
module init pulls in full zod (48 locales) and class-validator — 54% of the
588KB bundle for a single enum re-export. `twenty-sdk/front-component`
re-exports the same `AppPath` enum without that baggage. Bundle:
587,950 → 311,477 bytes (47% smaller). Behavior is byte-identical — same
route enum, same call site.

**2. `prefetchMetadataCatalog()` fires at t0.**
The object-independent metadata catalog (`loadAllObjectsWithFields()`, 60s
workspace TTL + in-flight dedup) used to be awaited strictly after host
resolution, as a sequential leg. It's now kicked fire-and-forget as the first
statement inside `load()`'s `try`, so it runs concurrently with the
config scan; later real callers (`resolveLabelField`, syncable-fields) still
await their own call and land on an already-warm (or in-flight, deduped)
cache. Removes one ~300ms leg from the critical path on every open.

**3. Host-resolution probes carry the role pointer.**
The probe that finds which candidate object hosts a record used to select
only `id`; `resolveWidgetRole` then re-read the same record moments later for
its relation pointer — a full sequential leg to re-fetch a record the probe
had just touched. Each probe now also selects its own candidate's pointer
field (`buildPointerFieldByCandidate` — first config per `targetObject` wins,
mirroring the same tie-break rule the widget already uses to pick
`hostConfig`), and passes the result to `resolveWidgetRole` as a 5th,
optional `prefetchedPointer` argument: **provided** skips the pointer query
entirely; **`undefined`** queries exactly as before. The cached-host path
(`getCachedHostObject` hit) and every poll tick after the first still pass
`undefined` — only the cold, first-probe path benefits.

**4. IndexedDB stale-while-revalidate cache for the enabled-config scan.**
Per the Context correction above, a worker-global cache cannot survive a
remount — but the widget's worker is a same-origin dedicated Web Worker, and
IndexedDB is origin-scoped, on-disk storage that *does* survive worker
teardown and tab reopen. `loadEnabledConfigsCached` (`lib/idb-cache.ts`)
wraps `loadAllEnabledVariationConfigs` with a KV store keyed
`configs:${workspaceCacheKey()}`, 5-minute TTL: a fresh disk hit returns
immediately (paints without awaiting the network) and kicks a background
revalidate; a miss or stale hit awaits the network exactly like today, with
errors surfacing unchanged. Entirely feature-detected — `typeof indexedDB ===
'undefined'` (server logic-function runtime, test env, or a locked-down
worker) makes every helper resolve null / no-op, so the widget's behavior on
such a host is identical to v0.1.9. Whether the real front-component worker
actually exposes `indexedDB` was unconfirmed at design time; **it does** —
confirmed live during this task's verify (see Consequences), so this win is
real, not inert.

## Non-decisions (upstream, tracked in `docs/upstream/`)

The following remain platform-owned and are explicitly out of scope for this
app:

- **Bundle `Cache-Control`.** The `/rest/front-components/:id` bundle route
  serves `private, no-store` with a freshly-signed S3 redirect on every call,
  so the ~2s bundle download repeats on every mount even though the request
  already carries a content-addressing checksum. Issue draft:
  `docs/upstream/2026-07-21-front-component-bundle-caching-issue-draft.md`
  (not filed — needs user approval).
- **react-dom externalization.** Not something an individual app can opt
  into; a platform build-config change.
- **Execution-context object name.** The front-component execution context
  has no field naming the host record's object (`targetObjectNameSingular` is
  discarded before reaching the widget at
  `FrontComponentWidgetRenderer.tsx:39`). If the platform threaded it through,
  the widget could drop host-resolution probing (A2) entirely instead of
  merely shrinking it (Decision 3). Not fixed here — it requires a platform
  API surface, not an app-side workaround.

## Consequences

**Wins (app-owned, this arc):** bundle 588KB → 312,879 bytes measured (47%
smaller); first-open app-side sequential legs 5 → 3 (metadata pull and one
pointer leg removed from the chain); remount app-side sequential legs 5 → 2
with a working IndexedDB path, 3 without. The remaining ~1.5–2s per open
(bundle re-download + the two platform legs ahead of it) is upstream-owned
and tracked, not fixed here.

**Live verify confirmed IndexedDB works in the real front-component worker.**
Task 5's local live verify against the `dev` remote found the
`formula-field-widget-cache` IndexedDB database present and populated at the
`configs:global` key with the exact enabled-config list the widget scans —
proof positive that `indexedDB` is defined and functional in the worker (the
`idbSet` helper only writes when `typeof indexedDB !== 'undefined'`). On
reopen, host-resolution probes and the background config-scan revalidate
fired within the same ~90ms request window (same date-second, matching
duration bands) rather than the probes waiting on the config-scan response to
complete first — consistent with the cache-hit path resolving from disk
without awaiting the network. Local dev's near-zero RTT (~10ms, per the
2026-07-21 evidence doc) makes finer-grained blocking-vs-non-blocking timing
unobservable through the browser's network panel alone; the cloud win (a
whole ~300ms leg skipped on remount) is not something this local rig can
directly time, but the mechanism verified here is the same one that pays off
under cloud RTT.

**Accepted risk — Task 4 staleness.** A config toggled enabled/disabled can
paint one stale frame on a remount within the 5-minute TTL, self-healing at
the next background revalidate or the next 4s poll tick — at most one poll
tick of visible staleness. This matches the app's existing TTL posture
elsewhere (the 60s metadata/formula-scan caches carry the same kind of lag).

**Accepted risk — Task 4 schema is unversioned.** The stored entry's shape
(`{ value: VariationConfigRecord[]; savedAt: number }`) carries no schema
version, and the database itself is pinned at `indexedDB.open(DB_NAME, 1)`.
A future breaking change to `VariationConfigRecord`'s stored shape would need
to bump the DB name (or the `configs:` key prefix) or add a `schemaVersion`
field to the stored entry — otherwise an old on-disk entry from a prior
release deserializes straight into the new code for up to the 5-minute TTL
before self-healing on revalidate.

**Accepted risk — Task 3 dangling `relationFieldName`, full blast radius.**
Before this change, a stale/misconfigured `relationFieldName` was invisible
at probe time (the probe only selected `id`). Now each probe also selects its
candidate's pointer field, so a config whose configured relation field no
longer exists on its object causes that candidate's probe to **reject**
(GraphQL validation error) where it used to silently succeed. The full
blast radius, confirmed during task review:
- If a **non-owning** candidate's probe rejects but another candidate
  resolves the host, behavior is unchanged — `Promise.allSettled` already
  ignores rejections when a resolution exists.
- If the **true host's own** candidate has the dangling field, its probe
  rejects; if no other candidate resolves either, the widget now surfaces a
  **read error** where v0.1.9 stayed quiet (the widget would have rendered
  as if the record simply weren't a variation host).
- More generally: if a record resolves to **no candidate** at all while
  *any* candidate's probe rejected (not necessarily the true host — the code
  can't know which one is "true" without a successful resolution), the same
  error surfaces instead of the previous silent no-op.
This is a genuine behavior change, not merely a corner case of the true host
— it widens whenever any candidate config is broken, not only the record's
actual host. The plan accepts it: a config whose relation field doesn't
exist is itself a misconfiguration, and surfacing it (rather than silently
proceeding as if the record had no variations) is arguably more correct —
but it is a user-visible change from v0.1.9 and reviewers should treat any
new "read error" report on this widget as a first suspect for a dangling
`relationFieldName`, not necessarily a regression in this arc's own code.

**Honest caveat carried from ADR 0023.** ADR 0023 claimed its throttle/cache
state would "survive remounts" by moving it from a `useRef` to a
module-global variable; the 2026-07-17 arc's own live verify later found
host-probe queries re-firing on every tab reopen, and traced it to the
platform recreating the widget's Web Worker (and therefore its whole module
graph) on every mount. Module-global state does NOT survive a remount in
this platform — full stop. That correction is why Task 4 does not repeat the
mistake: it reaches for IndexedDB (an origin-scoped store outside the
worker's module graph) specifically because nothing kept inside the worker's
own JS survives teardown.
