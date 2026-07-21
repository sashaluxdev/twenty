# Formula Widget Load-Time Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the formula-field widget's cloud tab-open time by removing per-mount rework (host probes, formula scans, refresh sweeps) and collapsing the mount request waterfall, per the 2026-07-17 diagnosis.

**Architecture:** Twenty unmounts inactive record-page tabs, so every tab open is a cold mount. All app-side fixes follow one principle: state that must survive a remount (caches, throttles) moves from per-mount `useRef`s to module-global state (the `metadata-objects.ts` precedent), and the mount waterfall drops redundant sequential legs. One behavioral change (mount-triggered full recompute sweeps) gets an ADR.

**Tech Stack:** TypeScript, React front components (twenty-sdk sandbox), vitest, oxlint. App dir: `packages/twenty-apps/community/formula-field` — all paths below are relative to it; run all commands from it.

## Global Constraints

- Files under `src/logic-functions/` must NOT import `twenty-shared` (oxlint rule; duck-type instead).
- Named exports only; types over interfaces; no enums; camelCase; SCREAMING_SNAKE_CASE constants.
- Comments: short `//` lines, explain WHY; no JSDoc blocks.
- Never modify committed ADR content in `docs/adr/` — new decisions get a new ADR.
- Test command: `npx vitest run <path>` (single file) or `npm run test` (full suite, ~900 tests, must stay green).
- Lint: `npm run lint`. Current app version: `0.1.8` (bumped in Task 7 only).
- Commit style: `fix(formula-field): …` / `docs(formula-field): …`, one commit per task.

## Task dependency map (for tightly scoped dispatch)

- Task 1 (with-retry) — independent.
- Task 2 (formula-scan cache) — independent.
- Task 3 (resolveWidgetRole config param) — independent, but touches `variation-widget.tsx`; run BEFORE Task 4.
- Task 4 (host-resolution cache) — touches `variation-widget.tsx` + `formula-editor.tsx`; run AFTER Task 3.
- Task 5 (refresh containment + ADR 0023) — touches `formula-editor.tsx`; run AFTER Task 4.
- Task 6 (trashed-probe throttle) — touches `formula-editor.tsx`; run AFTER Task 5.
- Task 7 (finalize/verify/deploy-local) — LAST.

## Explicitly out of scope (platform-side; upstream `twentyhq/twenty` issues, not this plan)

- No `Cache-Control`/`ETag` on `GET /rest/front-components/:id` (1MB bundle re-download per open).
- Fresh Web Worker per widget mount (no reuse per checksum).
- Server unzips the full SDK archive on every `/rest/sdk-client/*` request.
- `loadActiveOverridesGroupedByRecord`'s whole-object override scan stays as-is (it runs in parallel with the other legs; scoping it requires serializing behind the variation-ids fetch — worse at this workspace's scale; YAGNI).

---

### Task 1: `with-retry` — retryable signal hides in `subCode`

The platform wraps throttle errors as `extensions.code = 'BAD_USER_INPUT'` with the real signal in `extensions.subCode` (`graphql-errors.util.ts` in twenty-server). The current `code ?? subCode` never falls through because `code` is always set, so `LIMIT_REACHED` is never retried.

**Files:**
- Modify: `src/logic-functions/lib/with-retry.ts:23-40`
- Test (create): `src/logic-functions/lib/__tests__/with-retry.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `withRetry<T>(operation, options)` unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';

import { withRetry } from 'src/logic-functions/lib/with-retry';

const noSleep = async () => {};

// Real platform shape: code is always BAD_USER_INPUT, signal lives in subCode.
const limitReachedError = () =>
  Object.assign(new Error('limit'), {
    errors: [
      { extensions: { code: 'BAD_USER_INPUT', subCode: 'LIMIT_REACHED' } },
    ],
  });

describe('withRetry', () => {
  it('retries when the retryable signal is in subCode', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(limitReachedError())
      .mockResolvedValueOnce('ok');

    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable graphql errors', async () => {
    const operation = vi.fn().mockRejectedValue(
      Object.assign(new Error('nope'), {
        errors: [
          { extensions: { code: 'BAD_USER_INPUT', subCode: 'INVALID_INPUT' } },
        ],
      }),
    );

    await expect(withRetry(operation, { sleep: noSleep })).rejects.toThrow(
      'nope',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts', async () => {
    const operation = vi.fn().mockRejectedValue(limitReachedError());

    await expect(
      withRetry(operation, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toThrow('limit');
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/logic-functions/lib/__tests__/with-retry.spec.ts`
Expected: FAIL — first test gets `operation` called 1 time (error not classified retryable).

- [ ] **Step 3: Fix `isRetryable`**

Replace lines 26-35 of `src/logic-functions/lib/with-retry.ts` (the `if (Array.isArray(...))` block) with:

```ts
  if (Array.isArray(candidate?.errors)) {
    for (const graphqlError of candidate.errors) {
      // The platform wraps throttle errors as code BAD_USER_INPUT with the
      // real signal in subCode — check BOTH, not code-with-subCode-fallback
      // (code is always set, so `code ?? subCode` never reached subCode).
      const { code, subCode } = graphqlError?.extensions ?? {};
      if (code && RETRYABLE_CODES.has(code)) {
        return true;
      }
      if (subCode && RETRYABLE_CODES.has(subCode)) {
        return true;
      }
    }
    return false;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/logic-functions/lib/__tests__/with-retry.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + commit**

Run: `npm run test && npm run lint`
Expected: all green.

```bash
git add src/logic-functions/lib/with-retry.ts src/logic-functions/lib/__tests__/with-retry.spec.ts
git commit -m "fix(formula-field): retry on subCode — platform nests LIMIT_REACHED under BAD_USER_INPUT"
```

---

### Task 2: Cached enabled-formulas loader

`computeSyncableFields` (in `src/logic-functions/lib/syncable-fields.ts`) calls `loadAllEnabledFormulas(client)` — a fully paginated, uncached scan of every enabled FormulaDefinition — on every widget open and every variation-sync event. Give it the same 60s workspace-keyed TTL + in-flight-dedup treatment `loadAllObjectsWithFields` already has in `metadata-objects.ts:49-178`. 60s staleness for the syncable-field set matches the metadata cache's documented posture.

**Files:**
- Modify: `src/logic-functions/lib/formula-repository.ts` (append after `loadAllEnabledFormulas`, line 85)
- Modify: `src/logic-functions/lib/syncable-fields.ts` (swap the `loadAllEnabledFormulas(client)` call → `loadAllEnabledFormulasCached(client)`, update import)
- Test (create): `src/logic-functions/lib/__tests__/formula-repository-cache.spec.ts`

**Interfaces:**
- Consumes: `workspaceCacheKey()` from `src/logic-functions/lib/metadata-objects` (exported, line 66); `loadEnabledFormulas(client)` (same file, line 34).
- Produces: `loadAllEnabledFormulasCached(client: FormulaClient): Promise<FormulaDefinitionRecord[]>`, `invalidateEnabledFormulasCache(): void`, `__clearEnabledFormulasCacheForTests(): void` — all named exports of `formula-repository.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __clearEnabledFormulasCacheForTests,
  invalidateEnabledFormulasCache,
  loadAllEnabledFormulasCached,
} from 'src/logic-functions/lib/formula-repository';
import { type FormulaClient } from 'src/logic-functions/lib/types';

const pageResponse = {
  formulaDefinitions: {
    edges: [
      { node: { id: 'def-1', targetObject: 'company', targetField: 'score' } },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

const clientWithSpy = () => {
  const query = vi.fn().mockResolvedValue(pageResponse);
  return {
    client: { query, mutation: vi.fn() } as unknown as FormulaClient,
    query,
  };
};

afterEach(() => __clearEnabledFormulasCacheForTests());

describe('loadAllEnabledFormulasCached', () => {
  it('serves the second call from cache within the TTL', async () => {
    const { client, query } = clientWithSpy();
    await loadAllEnabledFormulasCached(client);
    await loadAllEnabledFormulasCached(client);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold-cache callers into one fetch', async () => {
    const { client, query } = clientWithSpy();
    await Promise.all([
      loadAllEnabledFormulasCached(client),
      loadAllEnabledFormulasCached(client),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidation', async () => {
    const { client, query } = clientWithSpy();
    await loadAllEnabledFormulasCached(client);
    invalidateEnabledFormulasCache();
    await loadAllEnabledFormulasCached(client);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected pull', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(pageResponse);
    const client = { query, mutation: vi.fn() } as unknown as FormulaClient;

    await expect(loadAllEnabledFormulasCached(client)).rejects.toThrow('boom');
    await expect(loadAllEnabledFormulasCached(client)).resolves.toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/logic-functions/lib/__tests__/formula-repository-cache.spec.ts`
Expected: FAIL — `loadAllEnabledFormulasCached` is not exported.

- [ ] **Step 3: Implement the cached loader**

Append to `src/logic-functions/lib/formula-repository.ts` (after line 85), and add `import { workspaceCacheKey } from 'src/logic-functions/lib/metadata-objects';` to the imports:

```ts
// Same posture as metadata-objects.ts's catalog cache: computeSyncableFields
// re-scans EVERY enabled definition on every widget open and every
// variation-sync event. 60s staleness for the syncable-field set is the
// documented, deliberate trade-off there — mirror it, including the in-flight
// dedup so N cold-cache callers share one paginated fetch.
const ENABLED_FORMULAS_TTL_MS = 60_000;

type EnabledFormulasCacheEntry = {
  formulas: FormulaDefinitionRecord[];
  loadedAt: number;
};
const enabledFormulasCacheByWorkspace = new Map<
  string,
  EnabledFormulasCacheEntry
>();
const enabledFormulasInFlightByWorkspace = new Map<
  string,
  Promise<FormulaDefinitionRecord[]>
>();

export const invalidateEnabledFormulasCache = (): void => {
  enabledFormulasCacheByWorkspace.delete(workspaceCacheKey());
};

export const __clearEnabledFormulasCacheForTests = (): void => {
  enabledFormulasCacheByWorkspace.clear();
  enabledFormulasInFlightByWorkspace.clear();
};

export const loadAllEnabledFormulasCached = async (
  client: FormulaClient,
): Promise<FormulaDefinitionRecord[]> => {
  const cacheKey = workspaceCacheKey();
  const cached = enabledFormulasCacheByWorkspace.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < ENABLED_FORMULAS_TTL_MS) {
    return cached.formulas;
  }

  const inFlight = enabledFormulasInFlightByWorkspace.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    const formulas = await loadEnabledFormulas(client);
    // Cache only on success — a rejected pull leaves nothing behind, so the
    // next caller retries reality instead of a poisoned entry.
    enabledFormulasCacheByWorkspace.set(cacheKey, {
      formulas,
      loadedAt: Date.now(),
    });
    return formulas;
  })();
  enabledFormulasInFlightByWorkspace.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    enabledFormulasInFlightByWorkspace.delete(cacheKey);
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/logic-functions/lib/__tests__/formula-repository-cache.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Switch `computeSyncableFields` to the cached loader**

In `src/logic-functions/lib/syncable-fields.ts`: change the import of `loadAllEnabledFormulas` from `formula-repository` to `loadAllEnabledFormulasCached`, and replace the call `loadAllEnabledFormulas(client)` (inside `computeSyncableFields`, ~line 50) with `loadAllEnabledFormulasCached(client)`. Do not change anything else in the function.

- [ ] **Step 6: Full suite + commit**

Run: `npm run test && npm run lint`
Expected: all green. If any existing `syncable-fields` spec asserts query counts, it may now need `__clearEnabledFormulasCacheForTests()` in its `afterEach` — add the import and hook rather than weakening assertions.

```bash
git add src/logic-functions/lib/formula-repository.ts src/logic-functions/lib/syncable-fields.ts src/logic-functions/lib/__tests__/formula-repository-cache.spec.ts
git commit -m "perf(formula-field): 60s workspace-keyed cache for enabled-formula scans"
```

---

### Task 3: `resolveWidgetRole` stops re-querying the config it already has

`variation-widget.tsx`'s `load()` fetches all enabled configs, then `resolveWidgetRole` (`variation-widget-data.ts:97-156`) immediately re-queries the same config via `findVariationConfigByTargetObject` — one redundant sequential round trip on the first-paint critical path. Pass the config in.

**Files:**
- Modify: `src/front-components/lib/variation-widget-data.ts:97-105`
- Modify: `src/front-components/variation-widget.tsx:101-165` (the `load` callback)
- Test: `src/front-components/lib/__tests__/variation-widget-data.spec.ts` (update existing `resolveWidgetRole` tests)

**Interfaces:**
- Consumes: `VariationConfigRecord` (existing type), `loadAllEnabledVariationConfigs(client)` from `src/logic-functions/lib/variation-config-repository` (line 18).
- Produces: NEW signature — `resolveWidgetRole(client: FormulaClient, objectName: string, recordId: string, config: VariationConfigRecord | null): Promise<WidgetRole>`. Task 4 builds on the widget's restructured `load()`.

- [ ] **Step 1: Update the existing spec to the new signature (failing first)**

In `src/front-components/lib/__tests__/variation-widget-data.spec.ts`, for every `resolveWidgetRole(client, object, recordId)` call: add a fourth argument — a config literal matching what the old mock returned for the `variationConfigs(first: 1, …)` query, e.g.:

```ts
const config = {
  id: 'cfg-1',
  targetObject: 'company',
  relationFieldName: 'primaryRecord',
  enabled: true,
} as VariationConfigRecord;

const role = await resolveWidgetRole(client, 'company', 'rec-1', config);
```

Delete the `variationConfigs` first-response stanzas from those tests' mock-client query queues (the pointer-read response becomes the FIRST mocked response). Add one new test:

```ts
it('returns hidden without querying when no config is passed', async () => {
  const query = vi.fn();
  const client = { query, mutation: vi.fn() } as unknown as FormulaClient;

  const role = await resolveWidgetRole(client, 'company', 'rec-1', null);

  expect(role).toEqual({ kind: 'hidden' });
  expect(query).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run src/front-components/lib/__tests__/variation-widget-data.spec.ts`
Expected: FAIL — signature mismatch / mock queue misalignment.

- [ ] **Step 3: Change `resolveWidgetRole`**

Replace lines 97-105 of `src/front-components/lib/variation-widget-data.ts`:

```ts
export const resolveWidgetRole = async (
  client: FormulaClient,
  objectName: string,
  recordId: string,
  // The caller's load() already scanned all enabled configs — re-querying the
  // same config here was a redundant sequential leg on the first-paint path.
  config: VariationConfigRecord | null,
): Promise<WidgetRole> => {
  if (!config || config.enabled !== true) {
    return { kind: 'hidden' };
  }
```

Remove the now-unused `findVariationConfigByTargetObject` import if nothing else in the file uses it.

- [ ] **Step 4: Restructure `variation-widget.tsx` `load()`**

Replace lines 106-165 of `src/front-components/variation-widget.tsx` (inside `try`, up to and including the `setLoading(false)` after `setVariations`) with:

```ts
      // One enabled-config scan serves both host resolution (first pass) and
      // the role decision below — resolveWidgetRole no longer re-queries it.
      const configs = await loadAllEnabledVariationConfigs(client);

      if (!resolvedHost.current && recordId) {
        const candidates = Array.from(
          new Set(configs.map((config) => config.targetObject).filter(Boolean)),
        ) as string[];
        // Probe every candidate object for this record id. A candidate error
        // only matters when NO candidate resolves: if any resolves we proceed
        // with it and ignore the others; if none resolves but a probe threw,
        // that is a read failure to surface — not a silent "record isn't here".
        const probes = await Promise.allSettled(
          candidates.map((candidate) =>
            client
              .query({
                [candidate]: {
                  __args: { filter: { id: { eq: recordId } } },
                  id: true,
                },
              })
              .then((response: any) => (response?.[candidate] ? candidate : null)),
          ),
        );
        const resolved = probes.find(
          (probe): probe is PromiseFulfilledResult<string> =>
            probe.status === 'fulfilled' && probe.value !== null,
        );
        if (resolved) {
          resolvedHost.current = resolved.value;
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
      const host = resolvedHost.current;

      if (!host || !recordId) {
        setHiddenReason(recordId ? await resolveHiddenReason(client, recordId) : 'no-config');
        setRole({ kind: 'hidden' });
        setVariations([]);
        setLoadError('');
        setLoading(false);
        return;
      }

      const hostConfig =
        configs.find((config) => config.targetObject === host) ?? null;
      const nextRole = await resolveWidgetRole(client, host, recordId, hostConfig);
      setRole(nextRole);
      setVariations(
        nextRole.kind === 'primary'
          ? await loadVariationList(client, nextRole.config, recordId)
          : [],
      );
      setLoadError('');
      setLoading(false);
```

(Only real changes vs current: the config scan moved above the `if (!resolvedHost.current…)` guard, and `hostConfig` is found locally and passed to `resolveWidgetRole`. The probe block and hidden path are verbatim from the current file.)

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/front-components/lib/__tests__/variation-widget-data.spec.ts && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/front-components/lib/variation-widget-data.ts src/front-components/variation-widget.tsx src/front-components/lib/__tests__/variation-widget-data.spec.ts
git commit -m "perf(formula-field): drop redundant config re-query from resolveWidgetRole critical path"
```

---

### Task 4: Cross-mount host-resolution cache

Both widgets resolve "which object owns this record id" via N parallel probe queries, cached in a per-mount `useRef` (`variation-widget.tsx:99`, `formula-editor.tsx:219`) — so every tab open re-probes. A record id's owning object never changes: cache positive resolutions module-globally.

**Files:**
- Create: `src/front-components/lib/host-resolution-cache.ts`
- Modify: `src/front-components/variation-widget.tsx` (seed `resolvedHost` from cache; write on resolve)
- Modify: `src/front-components/formula-editor.tsx:336-356` (same)
- Test (create): `src/front-components/lib/__tests__/host-resolution-cache.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `getCachedHostObject(recordId: string): string | null`, `cacheHostObject(recordId: string, objectName: string): void`, `__clearHostResolutionCacheForTests(): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from 'vitest';

import {
  __clearHostResolutionCacheForTests,
  cacheHostObject,
  getCachedHostObject,
} from 'src/front-components/lib/host-resolution-cache';

afterEach(() => __clearHostResolutionCacheForTests());

describe('host-resolution-cache', () => {
  it('returns null for an unknown record id', () => {
    expect(getCachedHostObject('rec-1')).toBeNull();
  });

  it('returns the cached object after a write', () => {
    cacheHostObject('rec-1', 'company');
    expect(getCachedHostObject('rec-1')).toBe('company');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/front-components/lib/__tests__/host-resolution-cache.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module**

`src/front-components/lib/host-resolution-cache.ts`:

```ts
// A record id's owning object never changes for the record's lifetime, so
// positive resolutions are safe to cache for the whole session — this is what
// lets a re-mounted widget skip the N-parallel probe queries on every tab
// open (Twenty unmounts inactive tabs, so per-mount refs reset each time).
// Negative results are NOT cached: "no object claims this id" can become true
// a moment later (e.g. a just-enabled config), so misses must keep probing.
const MAX_ENTRIES = 1000;
const hostByRecordId = new Map<string, string>();

export const getCachedHostObject = (recordId: string): string | null =>
  hostByRecordId.get(recordId) ?? null;

export const cacheHostObject = (
  recordId: string,
  objectName: string,
): void => {
  // Crude bound: a session visiting >1000 records just restarts the cache.
  if (hostByRecordId.size >= MAX_ENTRIES) {
    hostByRecordId.clear();
  }
  hostByRecordId.set(recordId, objectName);
};

export const __clearHostResolutionCacheForTests = (): void => {
  hostByRecordId.clear();
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/front-components/lib/__tests__/host-resolution-cache.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `variation-widget.tsx`**

Add import `import { cacheHostObject, getCachedHostObject } from 'src/front-components/lib/host-resolution-cache';`. In `load()` (as restructured by Task 3), directly under `const configs = await loadAllEnabledVariationConfigs(client);` insert:

```ts
      if (!resolvedHost.current && recordId) {
        resolvedHost.current = getCachedHostObject(recordId);
      }
```

and inside the probe block change the resolution write:

```ts
        if (resolved) {
          resolvedHost.current = resolved.value;
          cacheHostObject(recordId, resolved.value);
        } else {
```

- [ ] **Step 6: Wire into `formula-editor.tsx`**

Same import. At line 338 (`if (!resolvedHost.current && recordId) {` — the probe block), insert the cache seed immediately BEFORE that `if`:

```ts
    if (!resolvedHost.current && recordId) {
      resolvedHost.current = getCachedHostObject(recordId);
    }
```

and replace line 355 (`resolvedHost.current = probes.find(Boolean) ?? null;`) with:

```ts
      const resolvedCandidate = probes.find(Boolean) ?? null;
      resolvedHost.current = resolvedCandidate;
      if (resolvedCandidate) {
        cacheHostObject(recordId, resolvedCandidate);
      }
```

- [ ] **Step 7: Full suite + commit**

Run: `npm run test && npm run lint`
Expected: all green.

```bash
git add src/front-components/lib/host-resolution-cache.ts src/front-components/lib/__tests__/host-resolution-cache.spec.ts src/front-components/variation-widget.tsx src/front-components/formula-editor.tsx
git commit -m "perf(formula-field): cache host-object resolution across widget remounts"
```

---

### Task 5: Contain refresh-on-view sweeps (ADR 0023)

Three defects in `refreshStaleTodayFormulas` (`src/front-components/lib/refresh-stale-formulas.ts`): (1) its 60s throttle lives in per-mount `useRef`s, so every tab open resets it; (2) the record-page widget triggers `recomputeAllRecords` — a sequential whole-object sweep of hundreds of browser-side queries — as a side effect of *viewing a record*; (3) the sweep is fire-and-forget with no way to stop on unmount. This task: module-global throttle state, record-page becomes per-record-only, definition page keeps the full sweep but abortable. **Behavioral deviation from ADR 0015's "honest refresh" — documented as ADR 0023; flag it to the user at review.**

**Files:**
- Modify: `src/front-components/lib/refresh-stale-formulas.ts`
- Modify: `src/logic-functions/lib/recompute.ts` (`recomputeAllRecords`, lines ~645-750)
- Modify: `src/front-components/formula-editor.tsx:220-229, 515-526` (and all other `refreshStateRef` reads — grep the file)
- Modify: `src/front-components/formula-definition-editor.tsx:358-367, 439-452`
- Test: `src/front-components/lib/__tests__/refresh-stale-formulas.spec.ts` (update + extend), `src/logic-functions/lib/__tests__/recompute.spec.ts` (extend)
- Create: `docs/adr/0023-contain-mount-triggered-recompute-sweeps.md`

**Interfaces:**
- Consumes: existing `RefreshThrottleState`, `recomputeAllRecords`, `recomputeForRecord`.
- Produces:
  - `RefreshStaleOptions` gains required `sweepAllRecords: boolean` and optional `shouldContinue?: () => boolean`.
  - New named exports from `refresh-stale-formulas.ts`: `sharedRecordRefreshState: RefreshThrottleState`, `sharedSweepRefreshState: RefreshThrottleState`, `__resetSharedRefreshStatesForTests(): void`.
  - `recomputeAllRecords(client, formula, options?: { shouldContinue?: () => boolean })` — third param NEW, optional, default `{}`; return type unchanged.

- [ ] **Step 1: Extend the spec (failing first)**

In `src/front-components/lib/__tests__/refresh-stale-formulas.spec.ts`: add `sweepAllRecords: true` to every existing `refreshStaleTodayFormulas({...})` call (they assert the sweep runs). Import the new exports. Add:

```ts
  it('skips the full sweep when sweepAllRecords is false but still fixes the viewed record', async () => {
    const recomputeForRecordFn = vi.fn().mockResolvedValue(undefined);
    const recomputeAllRecordsFn = vi.fn().mockResolvedValue([]);

    const refreshed = await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [def()],
      now,
      state: idleState(),
      recordId: 'rec-1',
      sweepAllRecords: false,
      recomputeForRecordFn,
      recomputeAllRecordsFn,
    });

    expect(recomputeForRecordFn).toHaveBeenCalledTimes(1);
    expect(recomputeAllRecordsFn).not.toHaveBeenCalled();
    expect(refreshed).toEqual(['def-1']);
  });

  it('threads shouldContinue through to the sweep', async () => {
    const shouldContinue = () => false;
    const recomputeAllRecordsFn = vi.fn().mockResolvedValue([]);

    await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [def()],
      now,
      state: idleState(),
      sweepAllRecords: true,
      shouldContinue,
      recomputeAllRecordsFn,
    });

    expect(recomputeAllRecordsFn).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ id: 'def-1' }),
      { shouldContinue },
    );
  });

  it('throttles across two callers sharing the module-global state', async () => {
    __resetSharedRefreshStatesForTests();
    const recomputeAllRecordsFn = vi.fn().mockResolvedValue([]);
    const base = {
      client: fakeClient,
      definitions: [def()],
      state: sharedSweepRefreshState,
      sweepAllRecords: true,
      recomputeAllRecordsFn,
    };

    await refreshStaleTodayFormulas({ ...base, now });
    // A second "mount" 1s later — previously a fresh useRef, now shared state.
    await refreshStaleTodayFormulas({ ...base, now: now + 1_000 });

    expect(recomputeAllRecordsFn).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run src/front-components/lib/__tests__/refresh-stale-formulas.spec.ts`
Expected: FAIL — unknown option/exports.

- [ ] **Step 3: Implement in `refresh-stale-formulas.ts`**

Add after the `RefreshThrottleState` type (line 32):

```ts
// Module-global throttle states. The per-mount useRef versions reset on every
// tab open (Twenty unmounts inactive tabs), which defeated the 60s throttle —
// every open re-triggered refresh work (ADR 0023). One state per surface:
// record-page editors (per-record recompute) and the definition page (full
// sweep) throttle independently, but each throttles across ALL of its mounts.
export const sharedRecordRefreshState: RefreshThrottleState = {
  lastRefreshAt: 0,
  inFlight: false,
};
export const sharedSweepRefreshState: RefreshThrottleState = {
  lastRefreshAt: 0,
  inFlight: false,
};
export const __resetSharedRefreshStatesForTests = (): void => {
  sharedRecordRefreshState.lastRefreshAt = 0;
  sharedRecordRefreshState.inFlight = false;
  sharedSweepRefreshState.lastRefreshAt = 0;
  sharedSweepRefreshState.inFlight = false;
};
```

Add to `RefreshStaleOptions` (after `recordId?: string;`):

```ts
  // Whether to run the full recomputeAllRecords sweep after the per-record
  // fix. The record-page widget passes false: a whole-object sweep triggered
  // by merely viewing a record was the browser-side query-flood source
  // (ADR 0023). The definition page passes true — it is the admin surface for
  // exactly one definition, and the sweep is what advances lastEvaluatedAt.
  sweepAllRecords: boolean;
  // Polled between records by recomputeAllRecords; lets the initiating widget
  // stop a sweep on unmount instead of orphaning it.
  shouldContinue?: () => boolean;
```

In the function body, destructure `sweepAllRecords` and `shouldContinue`, and replace the per-definition block (lines 99-107):

```ts
        if (recordId) {
          await recomputeForRecordFn({
            client,
            formula: definition,
            targetRecordId: recordId,
          });
        }
        if (sweepAllRecords) {
          await recomputeAllRecordsFn(client, definition, { shouldContinue });
        }
        refreshedIds.push(definition.id);
```

Rewrite the stale file-header comment (lines 11-19) to describe the split (per-record on record pages, full sweep only on the definition page, cron sweep as the converger — cite ADR 0023).

- [ ] **Step 4: Add `shouldContinue` to `recomputeAllRecords`**

In `src/logic-functions/lib/recompute.ts`, extend the signature (line ~645):

```ts
export type RecomputeAllRecordsOptions = {
  // Polled between records; return false to stop the sweep early (e.g. the
  // initiating widget unmounted). Already-processed records keep their
  // writes — the sweep is idempotent, the cron sweep finishes the rest.
  shouldContinue?: () => boolean;
};
```

Add `options: RecomputeAllRecordsOptions = {}` as the third parameter. Insert this guard at the TOP of the outer pagination `for (;;)` loop body AND at the top of the inner `for (const edge of edges)` loop body (returning/breaking with the function's existing accumulator/return shape — match whatever the surrounding code returns):

```ts
    if (options.shouldContinue && !options.shouldContinue()) {
      break;
    }
```

Extend `src/logic-functions/lib/__tests__/recompute.spec.ts` with one test using the file's existing `recomputeAllRecords` fixture pattern: run a sweep over ≥2 records with `shouldContinue` returning `true` once then `false`, and assert fewer per-record queries/writes happened than record count (adapt the exact assertion to the fixture's existing counting style).

- [ ] **Step 5: Update the two call sites**

`formula-editor.tsx`: delete the `refreshStateRef` declaration (lines 223-226); import `sharedRecordRefreshState` from `refresh-stale-formulas`; in the `load()` call site (line 515-526) pass `state: sharedRecordRefreshState,` and add `sweepAllRecords: false,`. Grep the file for remaining `refreshStateRef` reads (the "Refreshing formula…" row note, ~line 911) and replace `refreshStateRef.current.inFlight` with `sharedRecordRefreshState.inFlight`.

`formula-definition-editor.tsx`: delete its `refreshStateRef` (lines 360-363); import `sharedSweepRefreshState`; add a mounted flag near the other refs:

```ts
  // Lets the fire-and-forget sweep stop at the next record boundary after
  // this widget unmounts (ADR 0023) instead of running to completion orphaned.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
```

and update its `refreshStaleTodayFormulas` call (lines 439-452): `state: sharedSweepRefreshState,` `sweepAllRecords: true,` `shouldContinue: () => mountedRef.current,`. Replace any `refreshStateRef.current.inFlight` reads with `sharedSweepRefreshState.inFlight`.

- [ ] **Step 6: Write ADR 0023**

Create `docs/adr/0023-contain-mount-triggered-recompute-sweeps.md` (follow the numbering/format of `docs/adr/0022-*.md`):

```markdown
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
```

- [ ] **Step 7: Run all tests + verify pass**

Run: `npx vitest run src/front-components/lib/__tests__/refresh-stale-formulas.spec.ts src/logic-functions/lib/__tests__/recompute.spec.ts && npm run test && npm run lint`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/front-components/lib/refresh-stale-formulas.ts src/logic-functions/lib/recompute.ts src/front-components/formula-editor.tsx src/front-components/formula-definition-editor.tsx src/front-components/lib/__tests__/refresh-stale-formulas.spec.ts src/logic-functions/lib/__tests__/recompute.spec.ts docs/adr/0023-contain-mount-triggered-recompute-sweeps.md
git commit -m "fix(formula-field): ADR 0023 — cross-mount refresh throttle; record pages stop triggering full sweeps"
```

---

### Task 6: Trashed-probe throttle survives remounts

`trashedProbeAtRef` (`formula-editor.tsx:234`) is a per-mount `useRef(0)`, so the "60s gate" on the trashed-definition probe (line 396) fires on every tab open. Move it to module scope.

**Files:**
- Modify: `src/front-components/formula-editor.tsx:230-234, 396-397`

**Interfaces:** none (module-private state).

- [ ] **Step 1: Make the edit**

Delete the `trashedProbeAtRef` declaration (lines 230-234, including its comment). Add at module scope, above the component (near the file's other module-level constants):

```ts
// Cross-mount throttle for the trashed-definition probe. A useRef reset on
// every tab open (fresh mount), firing the loadTrashedFormulas scan each
// time; module state survives remounts so the 60s gate actually holds.
let lastTrashedProbeAt = 0;
```

In `load()` replace the gate (lines 396-397):

```ts
    if (host && Date.now() - lastTrashedProbeAt >= 60_000) {
      lastTrashedProbeAt = Date.now();
```

- [ ] **Step 2: Verify**

Run: `npm run test && npm run lint`
Expected: all green (no dedicated component test exists for this file; the suite + lint guard regressions).

- [ ] **Step 3: Commit**

```bash
git add src/front-components/formula-editor.tsx
git commit -m "fix(formula-field): trashed-def probe throttle survives tab remounts"
```

---

### Task 7: Finalize — version, context, verify end-to-end, redeploy local

**Files:**
- Modify: `package.json` (version `0.1.8` → `0.1.9`)
- Modify: `context.md` (append arc entry)

- [ ] **Step 1: Bump version + context entry**

Set `"version": "0.1.9"` in `package.json`. Append to `context.md`'s log section (match its existing entry style): a dated 2026-07-17 entry summarizing this arc — with-retry subCode fix, enabled-formula cache, resolveWidgetRole config param, host-resolution cache, ADR 0023 sweep containment, trashed-probe throttle — and note the platform-side items (bundle caching, worker reuse, SDK-archive unzip) remain upstream issues.

- [ ] **Step 2: Full local verification**

Run: `npm run test && npm run lint`
Expected: full suite green (~900+ tests), lint clean.

- [ ] **Step 3: Redeploy to LOCAL workspace and verify live**

The local workspace serves bundles built 2026-06-09…07-03 (pre-v0.1.6, 4s poll — this alone floods locally). With the dev stack running (`yarn start` at repo root): reinstall the app to the local remote via the app's documented CLI flow (`npm run twenty -- app:install`, auth on `/metadata`, local server `:3000` — see the `twenty-apps-sdk-local-dev` workflow in context.md/README).

Then verify with the browser (Playwright MCP or manually), on a Companies record with variations (e.g. Stripe):
1. Open the Variations tab; content renders.
2. Idle 60s with the tab open: `/graphql` request rate must be ~1 cycle per 30s (POLL_INTERVAL_MS), NOT continuous.
3. Switch to Timeline and back to Variations: the reopen must NOT re-fire the host-probe queries (host cache) and must NOT trigger a recompute burst.

- [ ] **Step 4: Commit + wrap up**

```bash
git add package.json context.md
git commit -m "chore(formula-field): v0.1.9 — widget load-time arc (ADR 0023)"
```

Cloud deploy is a HUMAN step (SDK version must match the hosted platform line) — do not run it from this plan; hand off to the user.

---

## Self-review notes

- Diagnosis coverage: with-retry subCode → Task 1; uncached formula scans → Task 2; redundant config re-query → Task 3; per-mount host probes → Task 4; sweep flood + throttle resets → Task 5; trashed-probe refire → Task 6; stale local deploy → Task 7. Platform-side items explicitly out of scope (top).
- Known judgment call needing user attention at review: Task 5 removes the record-page full sweep (deviates from ADR 0015) — ADR 0023 documents it; surface it when reviewing that task.
- Line numbers reference the 2026-07-17 state of `main` (08fd9ede99); re-anchor by content if drifted.
