# Formula-field widget tab-open network trace (v0.1.9 / current main)

Scope: user clicks the record page's **Variations** tab → the formula-field
`variation-widget` front component renders. "Server floor" = each API request pays
~300ms on the hosted cloud, so only **sequential** legs that hit the API server
(`/graphql`, `/rest/front-components`, `/rest/sdk-client`) drive latency. Static
front-origin assets (lazy React chunk, worker script) are browser-cached and not
counted in the floor total (noted separately).

Common case traced: the record is a **PRIMARY** record (no primary pointer) — the
default "Variations" list + Create button. The variation-record branch is noted
at the end (same leg count, plus a post-paint effect).

---

## Ordered legs

### HOST side (platform, runs on the main thread)

Pre-leg (static, not floor): `FrontComponentWidgetRenderer` lazy-imports
`FrontComponentRenderer` (`FrontComponentWidgetRenderer.tsx:24`) — one Vite chunk
fetch, browser-cached after first use. Gates H1.

- **Leg H1 — `FindOneFrontComponent` GraphQL query.**
  `FrontComponentRenderer.tsx:67` `useQuery(FindOneFrontComponentDocument,{id})`.
  Default fetchPolicy = **cache-first** (no policy set). Returns
  `applicationTokenPair`, `builtComponentChecksum`, `usesSdkClient`,
  `applicationId`, `applicationVariables`.
  Depends-on: nothing (entry gate). Sequential.
  Remount: served from Apollo cache → **0 network**.

- **Leg H2 — SDK client core + metadata module fetch.** (only when `usesSdkClient`)
  `SdkClientBlobUrlsEffect.tsx:31` → `fetchSdkClientBlobUrls.ts:30`
  `Promise.allSettled([fetch core, fetch metadata])` against
  `/rest/sdk-client/:applicationId/{core,metadata}` (`getSdkClientUrls.ts:3`).
  Two requests run **in parallel** = 1 sequential leg (the slower of the two).
  Depends-on: H1 (needs `applicationId` + access token). Sequential gate:
  `FrontComponentRendererWithSdkClient.tsx:46` renders the worker host **only when
  `sdkClientState.status==='loaded'`**, so H2 blocks worker creation on first open.
  State lives in a jotai atomFamily keyed by `applicationId` (session-scoped).
  Remount: status already `'loaded'` → effect early-returns
  (`SdkClientBlobUrlsEffect.tsx:22`) → **0 network**, worker mounts immediately.
  Server side: `SdkClientController` downloads the archive and **unzips it fresh
  every request** (`sdk-client-archive.service.ts:99-113`) — no extraction cache;
  `flatApplicationMaps` lookup is workspace-cached. Only paid twice/session anyway.

- **Leg H3 — front-component bundle fetch (inside the worker).**
  Worker created at `FrontComponentWorkerEffect.tsx:74` (`createRemoteWorker`,
  static worker script — not floor), then `thread.imports.render(...)` at
  `FrontComponentWorkerEffect.tsx:123`. Inside the worker,
  `remote-worker.ts:123` `fetchComponentSource(renderContext.componentUrl)` GETs
  `/rest/front-components/:id?checksum=…` (`getFrontComponentUrl.ts:11`), with an
  `Authorization` bearer header. `FrontComponentController.getBuiltJs`
  (`front-component.controller.ts:48`) returns a **302 redirect to a freshly
  signed S3 presigned URL** (`front-component.service.ts:328-338`); browser follows
  it (2nd hop to S3).
  Depends-on: H1 (componentUrl+checksum+token) and, on first open, H2 (worker only
  mounts after sdk loaded). Sequential.
  Remount: **still fetched** (fresh worker, see below) — but gated only by H1
  (cache) so it fires immediately as the first floor leg.

### APP side (inside the Web Worker — `VariationWidget.load()`)

All go through `createDynamicCoreClient()` → raw POST `/graphql` (server floor
each). `dynamic-client.ts` / `metadata-objects.ts` client constructors do **no**
network on instantiation.

- **Leg A1 — enabled VariationConfig scan.**
  `variation-widget.tsx:110` `loadAllEnabledVariationConfigs(client)` →
  `variation-config-repository.ts:26` paginated `variationConfigs` query (1 page
  typical). Serves both host-candidate list and the role config.
  Depends-on: H3 (bundle running). Sequential.

- **Leg A2 — host-resolution probes (N parallel).**
  `variation-widget.tsx:113` cache check `getCachedHostObject` — worker-local Map
  (`host-resolution-cache.ts:8`), **COLD on every fresh worker** → miss. Then
  `variation-widget.tsx:124` `Promise.allSettled(candidates.map(probe))` — one
  `{[obj]:{filter id}}` query **per distinct enabled targetObject**, all parallel =
  1 sequential leg.
  Depends-on: A1 (candidate list). Sequential.

- **Leg A3 — role pointer read.**
  `resolveWidgetRole` (`variation-widget-data.ts:111`) fresh one-field pointer read
  `{[obj]:{id, <relation>Id}}` via `withRetry`. Primary → returns `{primary}` with
  no further query. (Re-reads the SAME record A2's probe already touched.)
  Depends-on: A2 (resolved host). Sequential.

- **Leg A4 — metadata catalog pull.**
  `loadVariationList` → `resolveLabelField` (`variation-widget-data.ts:321`) →
  `loadAllObjectsWithFields` (`metadata-objects.ts:148`) → paginated `objects`
  query via `MetadataApiClient`. Worker-local 60s TTL cache + in-flight dedup, but
  **COLD on a fresh worker** → 1 fetch.
  Depends-on: A3. Sequential. (Must precede the labelled variation read — it shapes
  the selection: `variation-widget-data.ts:318` comment.)

- **Leg A5 — three reads in parallel.**
  `variation-widget-data.ts:323` `Promise.all([...])` = 1 sequential leg:
  - A5a `computeSyncableFields` (`syncable-fields.ts:42`): `loadAllObjectsWithFields`
    now **warm** from A4 (same-mount cache hit, 0 network) + `loadAllEnabledFormulasCached`
    (`formula-repository.ts` — worker-local 60s cache, **COLD** → 1 `formulaDefinitions` query).
  - A5b `loadActiveOverridesGroupedByRecord` (`variation-widget-data.ts:208`):
    1 paginated `formulaOverrides` query.
  - A5c `loadVariationRecordsWithLabels` (`variation-widget-data.ts:272`):
    1 paginated plural-object query (ids + label).
  Depends-on: A4. Sequential leg; renders the list on completion.

---

## Sequential-leg totals (server-floor requests only)

| Leg | First open | Remount / reopen |
|-----|-----------|------------------|
| H1 FindOneFrontComponent | 1 | 0 (Apollo cache-first) |
| H2 sdk-client core+metadata (∥) | 1 | 0 (jotai session state) |
| H3 front-component bundle | 1 | 1 (fresh worker, no cache) |
| A1 config scan | 1 | 1 |
| A2 host probes (∥) | 1 | 1 (worker-local cache cold) |
| A3 pointer read | 1 | 1 |
| A4 metadata pull | 1 | 1 |
| A5 [formula-scan ∥ overrides ∥ variations] | 1 | 1 |
| **TOTAL sequential legs** | **8** | **6** |

(Parallel fan-outs inside H2, A2, A5 add wall-clock width but not sequential depth.)

Variation-record branch: A3 finds a pointer → A4 `resolveLabelField` (metadata) →
A5 becomes a single `fetchPrimaryRecordInclTrashed` (`variation-sync.ts:544`) — same
5 app-side sequential legs (A1,A2,A3,A4,A5), so same 8/6 totals. A **separate**
post-paint effect (`variation-widget.tsx:197`) then runs `loadDivergedFields`
(`variation-widget-data.ts:359`): `computeSyncableFields` **then**
`loadActiveOverrideFieldsForRecord` — two **sequential** awaits (not batched) = +2
legs after first paint (not on the critical path to first paint).

---

## Top collapsible opportunities

1. **Pass the record's object into the execution context (kills A2, shrinks A1's role).**
   The widget only knows `recordId`; it rediscovers the object by scanning configs
   (A1) then probing every candidate (A2). The host page already knows
   `objectNameSingular`. Exposing it in `FrontComponentExecutionContext` removes the
   entire A2 probe leg (and lets A3 target the object directly). **Saves 1 leg every
   open.** Biggest structural win.

2. **Merge A3 into A2.** The A2 probe already reads the record by id; have it also
   select `<relation>Id`, so the winning probe yields the pointer and A3
   disappears. **Saves 1 leg every open.** Purely app-side change.

3. **Cache-Control the bundle on its checksum (kills H3 on remount).** The URL
   already carries `?checksum=…` for exactly this, but `FrontComponentController`
   sets no `Cache-Control` and returns a fresh-signed 302 each call
   (`set-file-response-headers.utils.ts` sets only Content-Type/nosniff/disposition).
   Emitting `Cache-Control: public, immutable` (checksum makes the URL content-addressed)
   lets the browser reuse the bundle across mounts. **Saves 1 leg on remount.**

4. **Persist host-resolution + worker-local caches across mounts (kills A2, and cold
   A4/A5a re-fetches on remount).** `host-resolution-cache.ts`, the metadata 60s
   cache, and the formula-scan cache are all worker-module-global, but the worker is
   recreated per mount (see contradiction check), so every reopen pays them cold.
   Moving host-resolution into host-persisted state (or opportunity #1) removes A2 on
   remount; caching metadata/formulas in host state or the SDK layer would remove A4
   and the A5a formula-scan on remount. **Up to ~2–3 legs on remount.**

5. **Overlap H2 with worker start on first open.** The host blocks worker creation
   until sdk blobs load (`FrontComponentRendererWithSdkClient.tsx:46`), but the worker
   only needs the sdk URLs at `rewriteSdkImports`, *after* it fetches the bundle
   (`remote-worker.ts:128`). Starting the worker/bundle fetch in parallel with the sdk
   fetch would overlap H2 and H3. **Saves ~1 leg on first open.** Platform change.

6. **Fold A4 into the A5 batch.** A4 (metadata) is sequential before A5, but only
   A5c needs the label field; A5b (overrides) needs nothing beyond `targetObject` and
   could run concurrently with A4. Marginal (~fraction of a leg).

---

## Contradiction checks vs. the stated assumptions

- **"cache-and-network on the front-component query" — FALSE (favorably).** H1 is a
  plain `useQuery` with no `fetchPolicy` ⇒ Apollo default **cache-first**. On remount
  it serves from cache with **no** network and no revalidation — so the query is 0
  legs on reopen, not a cache-and-network double-fetch.
- **"checksum enables caching" — FALSE / "no bundle caching" — CONFIRMED.** The
  checksum is in the bundle URL but the controller sets no `Cache-Control` and 302s to
  a freshly-signed S3 URL each request, so HTTP caching is not engaged. The bundle is
  a real network leg on every mount. The checksum is currently just a URL discriminator,
  not a cache key.
- **"fresh worker per mount" — CONFIRMED.** `FrontComponentWorkerEffect.tsx:67-147`
  creates the worker in a `useEffect` and `worker.terminate()`s on cleanup; Twenty
  unmounts inactive tabs (`host-resolution-cache.ts:1-6` comment), so all worker-module
  caches (host-resolution, metadata 60s, formula-scan 60s) reset cold every reopen.
  The v0.1.9 caches therefore help only the in-mount 4s poll re-runs
  (`variation-widget.tsx:193`), **not** the first paint of any mount.
- **sdk-client archive extraction — NOT server-cached.** Each `/rest/sdk-client`
  request re-downloads and re-unzips the archive (`sdk-client-archive.service.ts:93-113`);
  only `flatApplicationMaps` is workspace-cached. Immaterial to leg count (2/session).
