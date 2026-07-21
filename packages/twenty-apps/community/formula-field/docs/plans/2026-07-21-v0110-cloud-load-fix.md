# v0.1.10 Cloud Widget Load Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the formula-field variation widget's cloud tab-open time from ~5–7s toward ~2.5–3s by shrinking the bundle 46% and reducing the app-side sequential request chain from 5 legs to 3 (2 on remount).

**Architecture:** Four independent app-side changes to the variation widget's load path, informed by the live-cloud measurements in `2026-07-21-cloud-widget-load-evidence.md` and the design discovery (session 706bff9b): (1) drop the `twenty-shared/types` barrel import that drags full zod into the bundle; (2) prefetch the object-independent metadata catalog at t0 so it leaves the critical path; (3) make the host-resolution probes also read the role pointer so the separate pointer query disappears; (4) persist the enabled-config scan in IndexedDB (origin-scoped, survives the per-mount worker teardown) with stale-while-revalidate. Platform-side fixes (bundle Cache-Control, react-dom externalization, execution-context object name) are deliberately OUT of scope — they are upstream work tracked in `docs/upstream/`.

**Tech Stack:** Twenty Apps SDK front component (React in a dedicated Web Worker), vitest, twenty-sdk CLI build.

## Global Constraints

- App dir: `packages/twenty-apps/community/formula-field`. All commands below run from there unless stated.
- Tests are **vitest**, run with `npm test` from the app dir (NOT jest, NOT nx). Single file: `npm test -- src/front-components/lib/__tests__/variation-widget-data.spec.ts`.
- Build: `node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev:build` from the app dir; output lands in `.twenty/output/`.
- **Cloud deploys are a HUMAN step, never done by this plan** (SDK version must match the hosted platform line — see project memory). Local deploy target is remote `dev` (`-r dev`); NEVER create a remote named `local`.
- Anything touching the cloud instance is read-only; this plan touches cloud not at all.
- Code style: `//` comments explaining WHY, named exports, kebab-case files, no new deps. Match the file's existing idiom (the widget's probe callbacks already use `(response: any)` — keep consistent with surrounding code).
- The 4s in-mount poll (`POLL_INTERVAL_MS`) re-runs `load()`; every change must stay correct under repeated invocation.
- Baseline numbers to beat (cloud, 2026-07-21): first open ≈ 8 sequential ~300ms legs + ~2s bundle; app-side share = 5 legs. Bundle 588,084 bytes.

---

### Task 1: Re-source `AppPath` off the `twenty-shared/types` barrel (bundle 588KB → ~300KB)

The `import { AppPath } from 'twenty-shared/types'` on line 2 of `variation-widget.tsx` pulls the whole barrel, whose module init imports full zod (with all 48 locales), class-validator, and uuid — 53.8% of the bundle. `twenty-sdk/front-component` (already imported on line 4) re-exports the same `AppPath` enum without that baggage (`node_modules/twenty-sdk/dist/front-component/index.d.ts:3` declares it; formula-editor.tsx proves the module tree-shakes to ~44KB of zod residue with zero locales).

**Files:**
- Modify: `src/front-components/variation-widget.tsx:1-4`

**Interfaces:**
- Consumes: `AppPath.RecordShowPage` (used once, `variation-widget.tsx:254`, `navigate(AppPath.RecordShowPage, …)`).
- Produces: nothing new — behavior must be byte-identical at runtime.

- [ ] **Step 1: Record the baseline bundle size and route string**

```bash
node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev:build
stat -c%s .twenty/output/src/front-components/variation-widget.mjs
grep -c "object/:objectNameSingular/:objectRecordId" .twenty/output/src/front-components/variation-widget.mjs
```

Expected: size ≈ 588084; grep count ≥ 1 (the RecordShowPage route string is present).

- [ ] **Step 2: Swap the import**

In `src/front-components/variation-widget.tsx`, change lines 2–4 from:

```tsx
import { AppPath } from 'twenty-shared/types';
import { defineFrontComponent } from 'twenty-sdk/define';
import { enqueueSnackbar, navigate, useRecordId } from 'twenty-sdk/front-component';
```

to:

```tsx
import { defineFrontComponent } from 'twenty-sdk/define';
// AppPath comes from the SDK re-export, NOT twenty-shared/types: that barrel's
// module init drags full zod (incl. 48 locales) + class-validator into the
// bundle — 54% of the widget's 588KB (measured 2026-07-21, see the v0.1.10
// evidence doc). Same enum, no baggage.
import { AppPath, enqueueSnackbar, navigate, useRecordId } from 'twenty-sdk/front-component';
```

- [ ] **Step 3: Run the test suite**

```bash
npm test
```

Expected: all tests pass (import swap has no behavioral surface).

- [ ] **Step 4: Rebuild and verify size + route string survived**

```bash
node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev:build
stat -c%s .twenty/output/src/front-components/variation-widget.mjs
grep -c "object/:objectNameSingular/:objectRecordId" .twenty/output/src/front-components/variation-widget.mjs
grep -c "zod" .twenty/output/src/front-components/variation-widget.mjs || true
```

Expected: size ≤ ~330,000 bytes (target ~300KB; FAIL the task if > 400,000 — the barrel is still being pulled, find what else imports `twenty-shared/types`); route-string grep count unchanged from Step 1 (proves `AppPath.RecordShowPage` resolves to the same route).

- [ ] **Step 5: Commit**

```bash
git add src/front-components/variation-widget.tsx
git commit -m "perf(formula-field): source AppPath from twenty-sdk, dropping zod from the widget bundle (588KB -> ~300KB)"
```

---

### Task 2: Prefetch the metadata catalog at t0 (removes leg A4 from the critical path)

`loadVariationList` awaits `resolveLabelField` → `loadAllObjectsWithFields()` (variation-widget-data.ts:321) strictly after the probes and pointer resolution — a full sequential leg. But `loadAllObjectsWithFields()` takes no arguments, is object-independent, has a 60s workspace TTL cache AND in-flight dedup (`metadata-objects.ts:148-178`), so firing it at the very top of `load()` warms the cache concurrently with the config scan; the later callers dedupe onto the same fetch.

**Files:**
- Modify: `src/front-components/lib/variation-widget-data.ts` (add `prefetchMetadataCatalog`)
- Modify: `src/front-components/variation-widget.tsx:102-110` (call it)
- Test: `src/front-components/lib/__tests__/variation-widget-data.spec.ts`

**Interfaces:**
- Consumes: `loadAllObjectsWithFields()` from `src/logic-functions/lib/metadata-objects` (no-arg, already imported in variation-widget-data.ts:2).
- Produces: `export const prefetchMetadataCatalog: () => void` — fire-and-forget, never throws, never rejects unhandled.

- [ ] **Step 1: Write the failing test**

Append to `src/front-components/lib/__tests__/variation-widget-data.spec.ts` (follow the file's existing describe/import style):

```ts
describe('prefetchMetadataCatalog', () => {
  it('should kick loadAllObjectsWithFields without awaiting it', () => {
    // The fake-objects seam makes loadAllObjectsWithFields resolve instantly
    // and observably: seed it, call prefetch, and confirm no throw + void return.
    setFakeObjectsForTests([]);
    expect(prefetchMetadataCatalog()).toBeUndefined();
    setFakeObjectsForTests(null);
  });

  it('should swallow a rejecting catalog fetch instead of surfacing an unhandled rejection', async () => {
    // With no fake seam and no transport, the underlying fetch will reject in
    // the test environment — prefetch must absorb that.
    setFakeObjectsForTests(null);
    expect(() => prefetchMetadataCatalog()).not.toThrow();
    // Drain microtasks so an unhandled rejection would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
```

Add `prefetchMetadataCatalog` to the spec's import from `variation-widget-data`, and `setFakeObjectsForTests` to its import from `metadata-objects` (check the spec's existing imports first — the seam may already be imported).

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm test -- src/front-components/lib/__tests__/variation-widget-data.spec.ts
```

Expected: FAIL — `prefetchMetadataCatalog` is not exported.

- [ ] **Step 3: Implement**

In `src/front-components/lib/variation-widget-data.ts`, after the imports block:

```ts
// ADR 0024: the metadata catalog is object-independent and its loader dedupes
// in-flight callers, so the widget fires it at t0 — concurrent with the config
// scan — instead of paying it as a sequential leg after host resolution
// (~300ms on cloud). Fire-and-forget: the real consumers (resolveLabelField,
// computeSyncableFields) still await their own call and surface any failure;
// this reference just must not become an unhandled rejection.
export const prefetchMetadataCatalog = (): void => {
  void loadAllObjectsWithFields().catch(() => {});
};
```

In `src/front-components/variation-widget.tsx`, first line inside the `try` of `load()` (before `loadAllEnabledVariationConfigs`):

```ts
      prefetchMetadataCatalog();
```

Add `prefetchMetadataCatalog` to the existing `variation-widget-data` import list (lines 21–34).

- [ ] **Step 4: Run the tests**

```bash
npm test -- src/front-components/lib/__tests__/variation-widget-data.spec.ts && npm test
```

Expected: PASS (full suite too — the prefetch must not disturb existing FakeClient call-count assertions; if a test asserts exact metadata-fetch counts, the dedup/fake seam should keep counts unchanged — investigate rather than loosening assertions if one fails).

- [ ] **Step 5: Commit**

```bash
git add src/front-components/lib/variation-widget-data.ts src/front-components/variation-widget.tsx src/front-components/lib/__tests__/variation-widget-data.spec.ts
git commit -m "perf(formula-field): prefetch metadata catalog at widget t0, off the critical path"
```

---

### Task 3: Probes also read the role pointer (merges leg A3 into A2)

Today the probe queries select only `id` (`variation-widget.tsx:124-135`), then `resolveWidgetRole` re-reads the SAME record for its pointer field (`variation-widget-data.ts:111-119`) — one whole sequential leg to re-fetch a record touched milliseconds earlier. Each candidate's pointer field is derivable before probing: the config scan already returns `relationFieldName` + `targetObject` per config. The "fresh pointer read" rule (comment at variation-widget-data.ts:109) is preserved: the probe IS a fresh read in the same mount — the rule guards against stale cached *props*, not against a read made moments ago on this same code path.

**Files:**
- Modify: `src/front-components/lib/variation-widget-data.ts` (add `buildPointerFieldByCandidate`; extend `resolveWidgetRole`)
- Modify: `src/front-components/variation-widget.tsx:116-176` (probe selection + pass-through)
- Test: `src/front-components/lib/__tests__/variation-widget-data.spec.ts`

**Interfaces:**
- Consumes: `VariationConfigRecord` (has `targetObject`, `relationFieldName`), `relationFieldOf` (module-private, variation-widget-data.ts:27), existing `resolveWidgetRole(client, objectName, recordId, config)`.
- Produces:
  - `export const buildPointerFieldByCandidate: (configs: VariationConfigRecord[]) => Map<string, string>` — candidate targetObject → `${relationFieldName ?? 'primaryRecord'}Id`, **first config per targetObject wins** (must mirror the `configs.find(c => c.targetObject === host)` rule at variation-widget.tsx:168-169, so the probed field always matches the config `resolveWidgetRole` later receives).
  - `resolveWidgetRole(client, objectName, recordId, config, prefetchedPointer?: { primaryRecordId: string | null })` — when the 5th arg is **provided**, skip the pointer query and use its value; when **omitted** (`undefined`), query exactly as today.

- [ ] **Step 1: Write the failing tests**

Append to `variation-widget-data.spec.ts`, following its existing FakeClient patterns (read the file's existing `resolveWidgetRole` tests first and reuse their config/client fixtures):

```ts
describe('buildPointerFieldByCandidate', () => {
  it('should map each targetObject to its relation pointer field, defaulting to primaryRecordId', () => {
    const map = buildPointerFieldByCandidate([
      { id: 'c1', targetObject: 'listing', relationFieldName: 'parentListing', enabled: true } as VariationConfigRecord,
      { id: 'c2', targetObject: 'activity', relationFieldName: null, enabled: true } as VariationConfigRecord,
    ]);
    expect(map.get('listing')).toBe('parentListingId');
    expect(map.get('activity')).toBe('primaryRecordId');
  });

  it('should let the FIRST config win when two configs share a targetObject', () => {
    const map = buildPointerFieldByCandidate([
      { id: 'c1', targetObject: 'listing', relationFieldName: 'first', enabled: true } as VariationConfigRecord,
      { id: 'c2', targetObject: 'listing', relationFieldName: 'second', enabled: true } as VariationConfigRecord,
    ]);
    expect(map.get('listing')).toBe('firstId');
  });
});

describe('resolveWidgetRole with prefetched pointer', () => {
  it('should return primary WITHOUT issuing a pointer query when prefetched pointer is null', async () => {
    // FakeClient configured to FAIL on any query — proving no query happens.
    const client = failingFakeClient();
    const role = await resolveWidgetRole(client, 'listing', 'rec-1', enabledConfig, {
      primaryRecordId: null,
    });
    expect(role.kind).toBe('primary');
  });

  it('should take the variation path from a prefetched non-null pointer', async () => {
    // Client only needs to serve the primary-record + label reads, NOT the
    // pointer read — reuse the existing variation-path fixture minus the
    // pointer-query stub.
    const client = variationPathClientWithoutPointerStub();
    const role = await resolveWidgetRole(client, 'listing', 'rec-1', enabledConfig, {
      primaryRecordId: 'primary-9',
    });
    expect(role.kind).toBe('variation');
  });

  it('should still query the pointer when no prefetched pointer is given', async () => {
    // Existing behavior — the current tests already cover this; keep them green.
  });
});
```

(The helper names `failingFakeClient` / `variationPathClientWithoutPointerStub` / `enabledConfig` stand for whatever the spec file's existing fixtures are called — reuse the real ones; do not build a parallel fixture system.)

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- src/front-components/lib/__tests__/variation-widget-data.spec.ts
```

Expected: FAIL — `buildPointerFieldByCandidate` not exported; `resolveWidgetRole` ignores the 5th argument.

- [ ] **Step 3: Implement the data layer**

In `variation-widget-data.ts`, after `relationFieldOf` (line 28):

```ts
// ADR 0024: each host-resolution probe also reads that candidate's role
// pointer, so resolveWidgetRole can skip its own pointer query on the cold
// first-paint path (one fewer ~300ms cloud leg). First config per targetObject
// wins — the SAME rule the widget uses to pick hostConfig, so the probed field
// always belongs to the config the role decision receives.
export const buildPointerFieldByCandidate = (
  configs: VariationConfigRecord[],
): Map<string, string> => {
  const pointerFieldByCandidate = new Map<string, string>();
  for (const config of configs) {
    const candidate = config.targetObject;
    if (!candidate || pointerFieldByCandidate.has(candidate)) {
      continue;
    }
    pointerFieldByCandidate.set(candidate, `${relationFieldOf(config)}Id`);
  }
  return pointerFieldByCandidate;
};
```

Extend `resolveWidgetRole` (signature at :94-101, pointer read at :109-125):

```ts
export const resolveWidgetRole = async (
  client: FormulaClient,
  objectName: string,
  recordId: string,
  // The caller's load() already scanned all enabled configs — re-querying the
  // same config here was a redundant sequential leg on the first-paint path.
  config: VariationConfigRecord | null,
  // When the caller's probe already read this record's pointer (same mount,
  // moments ago — a FRESH read, not a cached prop, so the echo-race rule
  // below is satisfied), it hands the value in and the query is skipped.
  prefetchedPointer?: { primaryRecordId: string | null },
): Promise<WidgetRole> => {
  if (!config || config.enabled !== true) {
    return { kind: 'hidden' };
  }

  const relationFieldName = relationFieldOf(config);
  const pointerField = `${relationFieldName}Id`;

  let primaryRecordId: string | null;
  if (prefetchedPointer !== undefined) {
    primaryRecordId = prefetchedPointer.primaryRecordId;
  } else {
    // Fresh one-field pointer read: a cached pointer prop is exactly the value
    // an echo-race could make stale, so re-read it before deciding the role.
    const pointerResponse = await withRetry(() =>
      client.query({
        [objectName]: {
          __args: { filter: { id: { eq: recordId } } },
          id: true,
          [pointerField]: true,
        },
      }),
    );
    const record = pointerResponse?.[objectName] as
      | Record<string, unknown>
      | null
      | undefined;
    primaryRecordId =
      (record?.[pointerField] as string | null | undefined) ?? null;
  }

  if (!primaryRecordId) {
    return { kind: 'primary', config };
  }
  // …rest of the function unchanged (label + fetchPrimaryRecordInclTrashed)…
```

- [ ] **Step 4: Implement the widget probe change**

In `variation-widget.tsx` `load()`: add a mount-scoped holder next to the probe block, extend each probe's selection with its own candidate's pointer field, and pass the captured pointer through. Replace lines 116-152's probe block with:

```ts
      let probedPointer: { primaryRecordId: string | null } | undefined;
      if (!resolvedHost.current && recordId) {
        const pointerFieldByCandidate = buildPointerFieldByCandidate(configs);
        const candidates = Array.from(
          new Set(configs.map((config) => config.targetObject).filter(Boolean)),
        ) as string[];
        // Probe every candidate object for this record id. A candidate error
        // only matters when NO candidate resolves: if any resolves we proceed
        // with it and ignore the others; if none resolves but a probe threw,
        // that is a read failure to surface — not a silent "record isn't here".
        // Each probe also selects ITS OWN config's pointer field (ADR 0024) so
        // the role decision below needs no second read of the same record.
        const probes = await Promise.allSettled(
          candidates.map((candidate) => {
            const pointerField =
              pointerFieldByCandidate.get(candidate) ?? 'primaryRecordId';
            return client
              .query({
                [candidate]: {
                  __args: { filter: { id: { eq: recordId } } },
                  id: true,
                  [pointerField]: true,
                },
              })
              .then((response: any) => {
                const record = response?.[candidate];
                return record
                  ? {
                      candidate,
                      primaryRecordId:
                        (record[pointerField] as string | null | undefined) ??
                        null,
                    }
                  : null;
              });
          }),
        );
        const resolved = probes.find(
          (
            probe,
          ): probe is PromiseFulfilledResult<{
            candidate: string;
            primaryRecordId: string | null;
          }> => probe.status === 'fulfilled' && probe.value !== null,
        );
        if (resolved) {
          resolvedHost.current = resolved.value.candidate;
          probedPointer = { primaryRecordId: resolved.value.primaryRecordId };
          cacheHostObject(recordId, resolved.value.candidate);
        } else {
          const rejection = probes.find(
            (probe): probe is PromiseRejectedResult => probe.status === 'rejected',
          );
          if (rejection) {
            throw rejection.reason;
          }
          resolvedHost.current = null;
        }
      }
```

And line 170 becomes:

```ts
      const nextRole = await resolveWidgetRole(client, host, recordId, hostConfig, probedPointer);
```

Note `probedPointer` stays `undefined` on the cached-host path (`getCachedHostObject` hit at :112-114) and on every poll tick after the first — those paths keep today's fresh pointer query. Add `buildPointerFieldByCandidate` to the widget's `variation-widget-data` import list.

- [ ] **Step 5: Run tests**

```bash
npm test -- src/front-components/lib/__tests__/variation-widget-data.spec.ts && npm test
```

Expected: PASS, full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/front-components/lib/variation-widget-data.ts src/front-components/variation-widget.tsx src/front-components/lib/__tests__/variation-widget-data.spec.ts
git commit -m "perf(formula-field): host probes carry the role pointer, dropping the separate pointer leg"
```

**Known risk (accepted, surface to reviewer):** a candidate whose configured relation field no longer exists on its object will now REJECT its probe (GraphQL validation) where the id-only probe succeeded. Non-owning candidates' rejections stay ignored when another candidate resolves (existing `Promise.allSettled` semantics); if the true host itself has a dangling relationFieldName, the widget surfaces a read error — arguably correct (the config is broken), but it is a behavior change worth a reviewer's eye.

---

### Task 4: IndexedDB cross-mount cache for the enabled-config scan (remount leg A1 → 0)

The platform terminates the worker on unmount, so all worker-global caches die per mount. But the widget's worker is a same-origin dedicated Web Worker: `indexedDB` is origin-scoped, on-disk, and survives worker teardown and tab reopen. Caching the enabled-config scan there (stale-while-revalidate, 5min TTL, keyed by workspace) makes remount first-paint skip the A1 network leg. **Feature-detected**: where `indexedDB` is missing (server-side logic-function runtime, test env, or a surprise in the remote-dom worker), every helper resolves null/no-ops and the widget behaves exactly as today — availability in the real worker gets confirmed during Task 5's live verify, not assumed.

**Files:**
- Create: `src/front-components/lib/idb-cache.ts`
- Create: `src/front-components/lib/__tests__/idb-cache.spec.ts`
- Modify: `src/front-components/variation-widget.tsx:110` (use the cached loader)

**Interfaces:**
- Consumes: `loadAllEnabledVariationConfigs(client)` from `src/logic-functions/lib/variation-config-repository`; `workspaceCacheKey()` from `src/logic-functions/lib/metadata-objects` (exported, :66); `VariationConfigRecord`, `FormulaClient` types.
- Produces:
  - `export const idbGet: <T>(key: string) => Promise<{ value: T; savedAt: number } | null>`
  - `export const idbSet: <T>(key: string, value: T) => Promise<void>` (best-effort, never throws)
  - `export const loadEnabledConfigsCached: (client: FormulaClient) => Promise<VariationConfigRecord[]>`

- [ ] **Step 1: Write the failing tests**

Create `src/front-components/lib/__tests__/idb-cache.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  idbGet,
  idbSet,
  loadEnabledConfigsCached,
} from 'src/front-components/lib/idb-cache';
import * as configRepository from 'src/logic-functions/lib/variation-config-repository';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';

const fakeClient = {} as FormulaClient;
const config = (id: string): VariationConfigRecord =>
  ({ id, targetObject: 'listing', enabled: true }) as VariationConfigRecord;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('idb kv (no indexedDB in this environment)', () => {
  it('should resolve null on get and not throw on set when indexedDB is unavailable', async () => {
    // vitest node env has no global indexedDB — the helpers must degrade.
    await expect(idbGet('k')).resolves.toBeNull();
    await expect(idbSet('k', { a: 1 })).resolves.toBeUndefined();
  });
});

describe('loadEnabledConfigsCached', () => {
  it('should fall through to the network scan when the cache misses', async () => {
    const scan = vi
      .spyOn(configRepository, 'loadAllEnabledVariationConfigs')
      .mockResolvedValue([config('c1')]);
    const result = await loadEnabledConfigsCached(fakeClient);
    expect(result).toEqual([config('c1')]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('should surface the network error on a cache miss (no swallowing)', async () => {
    vi.spyOn(configRepository, 'loadAllEnabledVariationConfigs').mockRejectedValue(
      new Error('boom'),
    );
    await expect(loadEnabledConfigsCached(fakeClient)).rejects.toThrow('boom');
  });
});
```

The fresh-hit + background-revalidate branch is exercised via a test seam `setIdbStoreForTests(store)` (defined in Step 3, mirroring the `setFakeObjectsForTests` pattern in metadata-objects.ts). The cache key is `configs:${workspaceCacheKey()}`:

```ts
import { setIdbStoreForTests } from 'src/front-components/lib/idb-cache';
import { workspaceCacheKey } from 'src/logic-functions/lib/metadata-objects';

describe('loadEnabledConfigsCached with a seeded store', () => {
  afterEach(() => setIdbStoreForTests(null));

  it('should serve a fresh hit from the store and revalidate in the background', async () => {
    const store = new Map<string, { value: unknown; savedAt: number }>();
    store.set(`configs:${workspaceCacheKey()}`, {
      value: [config('cached')],
      savedAt: Date.now(),
    });
    setIdbStoreForTests(store);
    const scan = vi
      .spyOn(configRepository, 'loadAllEnabledVariationConfigs')
      .mockResolvedValue([config('fresh')]);

    const result = await loadEnabledConfigsCached(fakeClient);

    expect(result).toEqual([config('cached')]); // paints from disk, no await on network
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain the background revalidate
    expect(scan).toHaveBeenCalledTimes(1);
    expect(store.get(`configs:${workspaceCacheKey()}`)?.value).toEqual([config('fresh')]);
  });

  it('should await the network when the stored entry is older than the TTL', async () => {
    const store = new Map<string, { value: unknown; savedAt: number }>();
    store.set(`configs:${workspaceCacheKey()}`, {
      value: [config('stale')],
      savedAt: Date.now() - 6 * 60 * 1000, // > 5min TTL
    });
    setIdbStoreForTests(store);
    vi.spyOn(configRepository, 'loadAllEnabledVariationConfigs').mockResolvedValue([
      config('fresh'),
    ]);

    await expect(loadEnabledConfigsCached(fakeClient)).resolves.toEqual([
      config('fresh'),
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- src/front-components/lib/__tests__/idb-cache.spec.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `idb-cache.ts`**

```ts
import { workspaceCacheKey } from 'src/logic-functions/lib/metadata-objects';
import { loadAllEnabledVariationConfigs } from 'src/logic-functions/lib/variation-config-repository';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';

// ADR 0024: the platform tears the worker down on every unmount, so worker-
// global caches never survive a tab reopen — but the worker is a same-origin
// dedicated Web Worker, and IndexedDB is origin-scoped and on-disk. This tiny
// KV lets the first paint of a REMOUNT serve the enabled-config scan from disk
// (stale-while-revalidate) instead of paying a ~300ms cloud leg. Everything is
// feature-detected and best-effort: no indexedDB (server logic-function
// runtime, tests, or a locked-down worker) means every call degrades to the
// plain network path.

const DB_NAME = 'formula-field-widget-cache';
const STORE_NAME = 'kv';
const CONFIGS_TTL_MS = 5 * 60 * 1000;

type StoredEntry = { value: unknown; savedAt: number };

let storeForTests: Map<string, StoredEntry> | null = null;
export const setIdbStoreForTests = (
  store: Map<string, StoredEntry> | null,
): void => {
  storeForTests = store;
};

const openDb = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

export const idbGet = async <T>(
  key: string,
): Promise<{ value: T; savedAt: number } | null> => {
  if (storeForTests) {
    return (storeForTests.get(key) as { value: T; savedAt: number }) ?? null;
  }
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db
        .transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(key);
      request.onsuccess = () =>
        resolve((request.result as { value: T; savedAt: number }) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      db.close();
    }
  });
};

export const idbSet = async <T>(key: string, value: T): Promise<void> => {
  if (storeForTests) {
    storeForTests.set(key, { value, savedAt: Date.now() });
    return;
  }
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction
        .objectStore(STORE_NAME)
        .put({ value, savedAt: Date.now() }, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    } finally {
      db.close();
    }
  });
};

const configsCacheKey = (): string => `configs:${workspaceCacheKey()}`;

// Stale-while-revalidate: a fresh disk hit paints immediately and refreshes in
// the background (the 4s poll then reads the refreshed entry — worst case one
// poll tick of staleness, matching the existing metadata TTL posture). A miss
// or stale hit awaits the network exactly like today, and network errors
// surface to load()'s existing error path.
export const loadEnabledConfigsCached = async (
  client: FormulaClient,
): Promise<VariationConfigRecord[]> => {
  const key = configsCacheKey();
  const hit = await idbGet<VariationConfigRecord[]>(key);
  if (hit && Date.now() - hit.savedAt < CONFIGS_TTL_MS) {
    void loadAllEnabledVariationConfigs(client)
      .then((fresh) => idbSet(key, fresh))
      .catch(() => {});
    return hit.value;
  }
  const fresh = await loadAllEnabledVariationConfigs(client);
  await idbSet(key, fresh);
  return fresh;
};
```

Now replace the placeholder seeded-store test from Step 1 with real assertions against `setIdbStoreForTests` (fresh hit → returns stored value, background scan called once and store rewritten after a microtask drain; stale hit (savedAt older than 5min) → awaits network).

- [ ] **Step 4: Wire into the widget**

`variation-widget.tsx:110` — change:

```ts
      const configs = await loadAllEnabledVariationConfigs(client);
```

to:

```ts
      const configs = await loadEnabledConfigsCached(client);
```

Swap the import accordingly (drop `loadAllEnabledVariationConfigs` from the widget's imports if now unused there; `idb-cache` exports the cached loader).

- [ ] **Step 5: Run tests**

```bash
npm test -- src/front-components/lib/__tests__/idb-cache.spec.ts && npm test
```

Expected: PASS, full suite green. `vi.spyOn(configRepository, …)` requires the repository module to be spy-able — if the build setup freezes module namespaces, switch the spy to a `vi.mock('src/logic-functions/lib/variation-config-repository')` at the top of the spec instead.

- [ ] **Step 6: Commit**

```bash
git add src/front-components/lib/idb-cache.ts src/front-components/lib/__tests__/idb-cache.spec.ts src/front-components/variation-widget.tsx
git commit -m "perf(formula-field): IndexedDB cross-mount cache for the enabled-config scan (ADR 0024)"
```

**Accepted staleness:** a just-toggled config can paint one stale frame for up to one poll tick (4s) after a remount within the 5min TTL; the background revalidate + poll self-heal it. A disabled config disappearing ~4-8s late is within the app's existing TTL posture (60s probe gates elsewhere).

---

### Task 5: ADR 0024, version bump, local deploy + live verify

**Files:**
- Create: `docs/adr/0024-widget-cold-open-critical-path.md`
- Modify: `package.json:3` (version 0.1.9 → 0.1.10)
- Modify: `context.md` (arc entry)

**Interfaces:** none — documentation + release mechanics.

- [ ] **Step 1: Write ADR 0024**

`docs/adr/0024-widget-cold-open-critical-path.md`, following the ADR style of 0023 (Status/Context/Decision/Consequences). Content requirements: cite the live-cloud measurements doc (`docs/plans/2026-07-21-cloud-widget-load-evidence.md` — ~300ms/leg floor, ~2s uncacheable bundle, 8-leg first open); record the four decisions (AppPath un-barreling; t0 metadata prefetch; probe-carried pointer; IndexedDB config cache with stale-while-revalidate) and the explicit NON-decisions (platform-side bundle caching / react-dom externalization / execution-context object name → upstream, see `docs/upstream/`); record the accepted staleness and dangling-relation-field risk from Tasks 3–4.

- [ ] **Step 2: Bump the version**

`package.json`: `"version": "0.1.10"`.

- [ ] **Step 3: Full test suite + build + lint-equivalent**

```bash
npm test
node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev:typecheck
node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev:build
stat -c%s .twenty/output/src/front-components/variation-widget.mjs
```

Expected: tests green, typecheck clean, bundle ≤ ~330KB.

- [ ] **Step 4: Local deploy to the dev remote**

```bash
node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs app:publish --private -r dev
node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs app:install -r dev
```

(Local dev stack must be running: `npx nx start twenty-server`, `npx nx run twenty-server:worker`, `npx nx start twenty-front` from repo root. Login tim@apple.dev / "Continue with Email" prefilled.)

- [ ] **Step 5: Live verify (Playwright against local)**

On a record page with the Variations tab: (a) tab opens and renders content; (b) network log for the open shows the config scan and metadata pull starting together, NO separate pointer-read query after the probes, and the A5 batch as before; (c) reopen the tab — with IndexedDB support present, the config scan does NOT hit the network before first paint (background revalidate may fire after); (d) no console errors; (e) confirm `typeof indexedDB` inside the worker is 'object' (temporary `console.log` or evaluate via the served page) — **if IndexedDB turns out unavailable in the worker, the widget must still work identically to v0.1.9 (feature-detection fallback), and the ADR gets a note that Task 4's win is inert pending a platform storage channel.**
(f) run the widget's existing behavior checks: create a variation, open a variation record, confirm the diverged-fields panel still loads.

- [ ] **Step 6: Update context.md and commit**

Append the arc entry to `context.md` (style: match the existing dated arc entries; cover: cloud re-diagnosis evidence doc, the four fixes, ADR 0024, verify results, cloud deploy NOT done — human step, SDK must match hosted line). Then:

```bash
git add docs/adr/0024-widget-cold-open-critical-path.md package.json context.md
git commit -m "chore(formula-field): v0.1.10 — cloud cold-open critical path (ADR 0024)"
```

**Cloud deploy is NOT part of this plan.** It happens only on explicit user approval, with the SDK-version-match procedure from context.md (scratch-dir npm twenty-sdk matching the hosted platform line). After any cloud deploy, re-run the curl measurements from the evidence doc to quantify the improvement.

---

## Expected outcome (against the 2026-07-21 baseline)

| Metric | v0.1.9 (measured/derived) | v0.1.10 (predicted) |
|---|---|---|
| Bundle | 588KB, ~2s/mount | ~300KB, ~1.1s/mount |
| App-side sequential legs, first open | 5 | 3 |
| App-side sequential legs, remount | 5 | 2 (with IndexedDB) / 3 (without) |
| Cloud first open (total) | ~5–6.5s | **~2.7–3.3s** |
| Cloud remount | ~4s | **~2–2.5s** |

The remaining ~1.5–2s is platform-owned (bundle re-download + H1/H2 on first open) — tracked by the upstream issue draft in `docs/upstream/`.
