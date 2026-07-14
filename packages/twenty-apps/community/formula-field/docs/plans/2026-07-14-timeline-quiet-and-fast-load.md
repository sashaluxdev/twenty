# Timeline Quiet + Fast Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Remove formula-app-generated noise rows from record Timelines via post-hoc cleanup (soft-delete / diff-strip), and (2) make the app's front components load fast by collapsing the N+1 metadata storm, batching per-variation label reads, parallelizing load waterfalls, and calming the 4s poll.

**Architecture:** Timeline: Twenty's timeline diff excludes no field flags and the SDK exposes no audit switch (verified), but `timelineActivity` IS mutable via the workspace GraphQL API and the app role already holds read/update/softDelete-all. A new cron logic-function (every 10 min) queries recent `timelineActivities` rows with `workspaceMemberId = NULL`, soft-deletes rows whose diff touches only app-managed fields, and strips app-managed keys from mixed rows. Timeline rows are written by an async queue job (no `.created` trigger fires for them — verified), so sweep-style cleanup is the only mechanism. Perf: all metadata reads route through the existing 60s-cached `loadAllObjectsWithFields` (extended with label/options + in-flight dedup), variation labels ride the existing variation-ids query, independent reads run in `Promise.all`, and the four widgets poll at 30s instead of 4s.

**Tech Stack:** Twenty Apps SDK (twenty-sdk), React front components (worker-sandboxed), raw-GraphQL `FormulaClient` (`createDynamicCoreClient`), vitest + `FakeClient`, oxlint.

## Global Constraints

- Work directly on `main` (established pattern for this app; every prior arc committed to main).
- App dir: `packages/twenty-apps/community/formula-field/`. All paths below relative to it unless prefixed `packages/`.
- Test baseline: **843 tests / 49 files green** via `cd /home/sasha_shin/twenty/packages/twenty-apps/community/formula-field && npx vitest run`. Never end a task with fewer passing tests.
- Lint: `cd /home/sasha_shin/twenty/packages/twenty-apps/community/formula-field && npx oxlint` must report 0 errors / 0 warnings.
- Style: named exports only; types over interfaces; no new `any` except in the dynamic-GraphQL edge-mapping idiom the surrounding file already uses (`(edge: any)`); short-form `//` comments explaining WHY; kebab-case filenames.
- Do NOT bump the app version in `package.json` and do NOT deploy — cloud deploy is a separate user-gated step after the arc completes.
- Never edit `src/front-components/lib/front-component-ids.ts` or any existing `universalIdentifier`.
- Timeline cleanup must be **fail-safe toward keeping rows**: any row whose diff is missing, unparsable, or empty is KEPT. Only rows positively identified as all-app-managed are deleted. Deletes are soft (`deleteTimelineActivity`), never `destroy*` (the role has `canDestroyAllObjectRecords: false`).
- Human-authored rows are untouchable: every cleanup query filters `workspaceMemberId` IS NULL (rows with a workspace member are never even fetched).
- New cron logic-function universalIdentifier (fixed, use verbatim): `9b7e5c14-2a6f-4d38-b1c9-e07a4f6d8321`.
- The commit message prefix convention is `feat(formula-field):` / `fix(formula-field):` / `perf(formula-field):` / `docs(formula-field):` / `test(formula-field):`.

**Server facts the tasks rely on (verified in this repo, authoritative for cloud 2.19):**
- Timeline diff builder excludes only `updatedAt`, `searchVector`, and relation-typed fields — no field-flag check (`packages/twenty-server/src/engine/core-modules/event-emitter/utils/object-record-changed-values.ts:112-120`).
- An updated-event with an empty diff produces zero rows; consecutive same-`(recordId, name, workspaceMemberId)` rows within 10 min merge into one (`packages/twenty-server/src/modules/timeline/repositories/timeline-activity.repository.ts:45-136`).
- `timelineActivity` gets full CRUD resolvers despite `isSystem: true` (`workspace-resolver-builder.service.ts:15-27`); app role grants already cover read/update/softDelete (see `src/roles/default-role.ts`).
- Timeline row shape: `name` (e.g. `company.updated`), `properties` (JSON, `properties.diff` = map `fieldName → {before, after}`), `happensAt`, `workspaceMemberId` (null for app/API writes), and a per-object parent pointer column (see Task 2's discovery step).

---

### Task 1: Timeline cleanup core module (formula-managed fields)

**Files:**
- Create: `src/logic-functions/lib/timeline-cleanup.ts`
- Modify: `src/logic-functions/lib/fx-status-field.ts` (export `companionFieldName` if not already exported — check first; it is used at fx-status-field.ts:398 as `companionFieldName(definition.targetField)`)
- Test: `src/logic-functions/lib/__tests__/timeline-cleanup.spec.ts`
- Possibly modify: `src/logic-functions/lib/__tests__/fake-client.ts` (only if `timelineActivities` filtered queries need seeding support it lacks — extend minimally, matching its existing seed/query emulation style)

**Interfaces:**
- Consumes: `FormulaClient` type (`src/logic-functions/lib/types`), `withRetry` (same helper the repositories use — locate its import in `formula-repository.ts`), `companionFieldName` from `fx-status-field.ts`.
- Produces (Tasks 2 and 3 rely on these exact names):
  ```ts
  export type TimelineCleanupCounts = {
    scanned: number;
    deleted: number;
    stripped: number;
    kept: number;
    truncated: boolean; // true when MAX_PAGES cap was hit — log-visible, never silent
  };
  export const cleanupFormulaTimelineNoise = async (
    client: FormulaClient,
  ): Promise<TimelineCleanupCounts> => { ... };
  ```

**Behavioral spec:**

1. Load managed-field sets: query `formulaDefinitions` (`first: 200`, selecting `targetObject`, `targetField`) directly — ALL definitions regardless of `enabled` (a disabled formula's field is still app-owned; old rows must still be cleanable). Build `Map<objectNameSingular, Set<fieldName>>` containing each `targetField` **and** its companion `companionFieldName(targetField)`. Skip nodes with empty `targetObject`/`targetField` (wizard drafts). If the map is empty, return all-zero counts without querying timelineActivities.
2. Page through `timelineActivities` with filter: `name` in `[...objects].map(o => `${o}.updated`)`, `workspaceMemberId` IS NULL (reuse the exact FilterIs-enum inlining mechanism `loadTrashedFormulas` in `formula-repository.ts` uses for its `deletedAt` NOT_NULL filter — the raw serializer quotes strings, which breaks enums, and that file already solved it), `happensAt` gte `new Date(Date.now() - LOOKBACK_MS).toISOString()`. Constants: `LOOKBACK_MS = 48h`, `PAGE_SIZE = 100`, `MAX_PAGES = 20`. Select per node: `id`, `name`, `properties`, `happensAt`. If `MAX_PAGES` is hit with more pages remaining, set `truncated: true` (next cron run picks up the rest — already-deleted rows drop out of subsequent queries).
3. Per row, defensively extract the diff: `properties` may be an object or a JSON string — handle both; `diff = properties?.diff`. `keys = Object.keys(diff ?? {})`. If no keys → **keep** (fail-safe rule from Global Constraints).
4. Derive the object from the row name (strip the `.updated` suffix); look up its managed set. Then:
   - every key managed → soft-delete: `client.mutation({ deleteTimelineActivity: { __args: { id }, id: true } })` wrapped in `withRetry`; count `deleted`.
   - some keys managed → strip: build `newDiff` = diff minus managed keys, write `client.mutation({ updateTimelineActivity: { __args: { id, data: { properties: { ...parsedProperties, diff: newDiff } } }, id: true } })` (preserve all other `properties` subkeys verbatim); count `stripped`.
   - no keys managed → keep; count `kept`.
   - a per-row mutation failure must not abort the run: catch, count the row as `kept`, continue (same per-record fault-isolation posture as `recomputeAllRecords`).

**Test cases to implement (TDD — write each red first):**
- deletes a row whose diff keys are exactly one formula targetField.
- deletes a row whose diff covers a targetField AND its companion status field.
- keeps a row whose diff contains only human fields.
- strips only the managed keys from a mixed row, preserving other `properties` subkeys and the human keys' before/after payloads; asserts the update mutation was issued and no delete.
- keeps a row with empty/missing/unparsable `properties` (three cases; JSON-string `properties` also covered).
- never touches rows for objects with no formula definitions (query filter asserted via `client.querySelections`).
- returns zero counts and issues NO timelineActivities query when there are no definitions.
- respects MAX_PAGES: with >MAX_PAGES pages seeded, `truncated === true`.
- per-row mutation failure: first delete throws, second row still processed.

Use `FakeClient` (`src/logic-functions/lib/__tests__/fake-client.ts`): seed `formulaDefinition` and `timelineActivity` records like other objects; if its query emulation can't express the IS-NULL / in / gte filters, extend it minimally (it already emulates filtered connection queries for other specs) — prefer asserting the built filter via `querySelections` plus seeding pre-filtered data over building a full filter engine.

**Steps:**
- [ ] **Step 1:** Check whether `companionFieldName` is exported from `fx-status-field.ts`; export it if not (no behavior change). Run `npx vitest run src/logic-functions/lib/__tests__/fx-status-field.spec.ts` — green.
- [ ] **Step 2:** Write `timeline-cleanup.spec.ts` with the first three test cases. Run — expect FAIL (module not found).
- [ ] **Step 3:** Implement `timeline-cleanup.ts` to pass them. Run the spec — green.
- [ ] **Step 4:** Add the remaining test cases one group at a time (strip, fail-safe keeps, query-shape, truncation, fault isolation), implementing as you go. Spec green after each group.
- [ ] **Step 5:** Full suite `npx vitest run` (≥843 + new, all green) and `npx oxlint` (0/0).
- [ ] **Step 6:** Commit: `feat(formula-field): timeline cleanup core — soft-delete/strip app-noise timeline rows`

---

### Task 2: Variation-managed rows (extension of the cleanup classifier)

**Files:**
- Modify: `src/logic-functions/lib/timeline-cleanup.ts`
- Test: `src/logic-functions/lib/__tests__/timeline-cleanup.spec.ts` (extend)

**Interfaces:**
- Consumes: `loadAllEnabledVariationConfigs` (`variation-config-repository.ts`), `computeSyncableFields` (`syncable-fields.ts` — same call shape `syncOneVariation`/`loadVariationList` use: `(client, targetObject, relationFieldName)`), and the config's relation-field accessor (the server-side equivalent of `relationFieldOf(config)` — locate it in `variation-config-repository.ts`/`variation-sync.ts`; the front lib's `variation-widget-data.ts` has one but server code must not import front code).
- Produces: same public signature `cleanupFormulaTimelineNoise(client)`; classification now also handles variation-synced fields.

**Behavioral spec:**

Variation mirror writes (`syncVariationFieldsBatch`, `variation-sync.ts:266-338`) update ordinary user fields on variation records and are equally app-generated noise — but the same field names on a PRIMARY record can be changed by humans/integrations. So variation-managed keys are only deletable when the row's parent record is itself a variation (its config-relation FK points at a primary).

1. **Discovery sub-step (do this first, it shapes the query):** determine the timelineActivity column that identifies the parent record for a given object. Read `packages/twenty-server/src/modules/timeline/repositories/timeline-activity.repository.ts` (upsert path, ~lines 45-136) and `timeline-activity.workspace-entity.ts` — the entity has per-object typed columns (`targetCompanyId`, `targetOpportunityId`, …) plus generated ones for custom objects. Record in a code comment exactly which column the cleanup selects per object (pattern like `target${Capitalized}Id` for standard objects — verify, and verify the custom-object naming from the repository's insert code). If the parent column for some object can't be determined, variation-classification for that object degrades to **keep** (fail-safe).
2. Extend the managed model: per object, two sets — `formulaManaged` (Task 1) and `variationManaged` = union over enabled configs on that object of `computeSyncableFields(...)` names (these already include MANY_TO_ONE join columns per ADR 0019, which is what relation mirroring puts in the diff).
3. Classification per row becomes: let `keys` split into `formulaKeys`, `variationKeys`, `otherKeys`.
   - `otherKeys` nonempty → strip formula keys only if `formulaKeys` nonempty (as Task 1), never touch variation keys on such rows (a mixed human row is evidence of non-app authorship) → `stripped` or `kept`.
   - `otherKeys` empty and `variationKeys` empty → Task 1 behavior (delete).
   - `otherKeys` empty and `variationKeys` nonempty → fetch the parent record's config-relation FK (one query: parent id from the discovery column, select the join column of the config's relation field). FK non-null → the record is a variation → **delete**. FK null (it's a primary) or record/parent-column unresolvable → **keep** if `formulaKeys` empty, else strip just the `formulaKeys`.
   - Cache the per-record variation verdict within one run (`Map<recordId, boolean>`) so N rows for one record cost one lookup.

**Test cases (extend the spec, TDD):**
- deletes a variation record's row whose diff keys are all syncable fields (FK seeded non-null).
- keeps the identical row when the record is a primary (FK null).
- deletes a variation row whose diff mixes syncable fields and formula fields (both managed).
- keeps a variation-candidate row when the parent record read fails (fail-safe), still processing later rows.
- verdict caching: two rows for the same record → exactly one parent-record query (assert via `client.queries` delta or `querySelections`).
- no enabled variation configs → classification identical to Task 1 (regression guard: rerun a Task 1 delete case with configs absent).

**Steps:**
- [ ] **Step 1:** Discovery: read the two server files above; write the parent-column mapping comment + helper (`parentRecordIdSelectionFor(objectNameSingular)`), with a unit test pinning the standard-object pattern.
- [ ] **Step 2:** Write the variation test cases. Run — FAIL.
- [ ] **Step 3:** Implement the extended classifier. Spec green.
- [ ] **Step 4:** Full suite + oxlint (0/0).
- [ ] **Step 5:** Commit: `feat(formula-field): timeline cleanup covers variation mirror writes`

---

### Task 3: Cleanup cron logic-function + ADR

**Files:**
- Create: `src/logic-functions/timeline-cleanup.ts` (the logic-function entry; the lib module from Tasks 1-2 stays in `lib/`)
- Create: `docs/adr/0020-timeline-noise-cleanup.md`
- Modify: `docs/adr/README.md` or index file if one exists (match how ADR 0019 was indexed), `context.md` (one short block, matching its existing arc-note style)
- Test: `src/logic-functions/lib/__tests__/timeline-cleanup.spec.ts` (one handler-level test) — note the existing sweep specs (`variation-sweep.spec.ts`) for the pattern of testing a logic-function handler.

**Interfaces:**
- Consumes: `cleanupFormulaTimelineNoise` (Tasks 1-2), `createDynamicCoreClient`, `defineLogicFunction` from `twenty-sdk/define`.
- Produces: cron function `timeline-cleanup`, pattern `*/10 * * * *`.

**Implementation (complete, mirrors `variation-sweep.ts` exactly in structure):**

```ts
import { defineLogicFunction } from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { cleanupFormulaTimelineNoise } from 'src/logic-functions/lib/timeline-cleanup';

// Timeline rows for app writes are created by an async server-side queue job,
// so no database trigger can catch them at birth — a frequent sweep is the
// only cleanup mechanism (see ADR 0020). Rows already soft-deleted drop out
// of the query, so steady-state runs are cheap.
const handler = async (): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const counts = await cleanupFormulaTimelineNoise(client);
  return { ...counts };
};

export default defineLogicFunction({
  universalIdentifier: '9b7e5c14-2a6f-4d38-b1c9-e07a4f6d8321',
  name: 'timeline-cleanup',
  description:
    'Every 10 minutes, removes formula-app-generated noise rows from record Timelines.',
  timeoutSeconds: 120,
  handler,
  cronTriggerSettings: { pattern: '*/10 * * * *' },
});
```

**ADR 0020 content requirements:** context (timeline flood; server diff has no field-flag filter — cite `object-record-changed-values.ts:112-120`; SDK exposes no audit flag; `.created` trigger unavailable because rows are queue-job-inserted), decision (10-min cron sweep, soft-delete all-managed rows, strip mixed, fail-safe keep, IS-NULL member gate), consequences (up to ~10 min of visible noise between runs; other null-member API integrations writing ONLY formula-managed fields would be culled — accepted; retire the whole mechanism if the platform ever ships field-level audit exclusion).

**Steps:**
- [ ] **Step 1:** Write a handler-level test (seed one deletable row via FakeClient, call the handler's exported default's `handler`... follow `variation-sweep.spec.ts`'s established access pattern) — FAIL, then implement the logic-function file — green.
- [ ] **Step 2:** Write ADR 0020 + index entry + `context.md` block.
- [ ] **Step 3:** Full suite + oxlint (0/0).
- [ ] **Step 4:** Commit code: `feat(formula-field): 10-min timeline-cleanup cron`; commit docs separately: `docs(formula-field): ADR 0020 — timeline noise cleanup`.

---

### Task 4: Collapse the metadata N+1 (route useObjectFields through the shared cached catalog)

**Files:**
- Modify: `src/logic-functions/lib/metadata-objects.ts` (add `label`/`options` to the field selection + type; add in-flight dedup)
- Modify: `src/front-components/lib/formula-field-input.tsx` (rewrite `useObjectFields` internals; extract pure `deriveObjectFields`)
- Test: `src/logic-functions/lib/__tests__/metadata-objects.spec.ts` (extend), new `src/front-components/lib/__tests__/derive-object-fields.spec.ts`

**Interfaces:**
- `MetadataFieldInfo` (in `metadata-objects.ts` or `types.ts` — wherever it lives) gains **optional** members so no existing fixture breaks: `label?: string | null; options?: unknown;`. `loadAllObjectsWithFields()` signature unchanged; its GraphQL selection adds `label: true, options: true` inside `fieldsList`.
- New export from `formula-field-input.tsx` (pure, unit-testable without React):
  ```ts
  export const deriveObjectFields = (
    objects: MetadataObjectInfo[],
    targetObject: string | undefined,
  ): ObjectFields => { ... };
  ```
- `useObjectFields(targetObject)` keeps its exact signature and return type (`ObjectFields`) — all three call sites (`formula-field-input.tsx:413`, `formula-editor.tsx:259`, `formula-definition-editor.tsx:307-309`) stay untouched.

**Behavioral spec:**

1. `metadata-objects.ts`: add in-flight promise dedup keyed by `workspaceCacheKey()` — concurrent callers during a cold cache share ONE fetch (today, N formula rows mounting simultaneously each fire a full catalog pull). The in-flight entry is cleared on settle; a rejected pull is never cached (preserve the existing posture, including the test seams — `fakeObjectsForTests` short-circuits before dedup).
2. `deriveObjectFields(objects, targetObject)` reproduces the current mapping logic from the old hook body verbatim in behavior (see the old code at `formula-field-input.tsx:133-234`): find the object by `nameSingular`; active + non-system fields; `kindsByName` over ALL active fields (unfiltered by suggestibility — the pre-save kind check needs non-suggestible kinds); `fields` filtered by `SUGGESTIBLE_FIELD_TYPES`, mapping `options` arrays to `{value,label}` pairs, label falling back to name, sorted by label. Missing `label`/`options` on a `MetadataFieldInfo` (older fixtures) degrade gracefully (label←name, no options).
3. `useObjectFields` becomes a thin hook: `useEffect` calls `loadAllObjectsWithFields()` (60s cached + deduped) and `setState(deriveObjectFields(objects, targetObject))`, with the same cancelled-flag and same error posture (empty fields/kinds on failure). Net effect: N formula rows + the editor share one cached catalog pull per worker per 60s instead of N+1 uncached full pulls per mount.
4. Remove the now-unused direct `MetadataApiClient` usage from the hook (keep the import only if still used elsewhere in the file).

**Test cases:**
- `derive-object-fields.spec.ts`: suggestible filtering, isSystem/inactive exclusion, kindsByName includes non-suggestible kinds, options mapping, label fallback, unknown object → empty result. Build fixtures as plain `MetadataObjectInfo[]`.
- `metadata-objects.spec.ts` additions: concurrent `loadAllObjectsWithFields()` calls during cold cache perform exactly one query (the spec file already stubs `MetadataApiClient` somehow — follow its established mechanism); a rejected pull clears the in-flight slot so the next call retries; selection now includes `label`/`options` (assert on the built selection if the existing spec does so, else on mapped output).

**Steps:**
- [ ] **Step 1:** metadata-objects: write the dedup + label/options tests — FAIL — implement — green.
- [ ] **Step 2:** Write `derive-object-fields.spec.ts` — FAIL — extract/implement `deriveObjectFields` and rewire `useObjectFields` — green.
- [ ] **Step 3:** Full suite + oxlint (0/0). Also `npx tsc --noEmit -p tsconfig.json` if that's how this package typechecks (check `package.json` scripts; prior arcs reported tsc clean).
- [ ] **Step 4:** Commit: `perf(formula-field): share one cached metadata catalog across all widgets (kills N+1)`

---

### Task 5: Batch variation labels + parallelize the load waterfalls

**Files:**
- Modify: `src/front-components/lib/variation-widget-data.ts` (`loadVariationList`, `loadVariationRecordIds`, remove/absorb `fetchVariationLabel`)
- Modify: `src/front-components/formula-editor.tsx` (parallelize the record read + overrides read inside `load()`)
- Test: `src/front-components/lib/__tests__/variation-widget-data.spec.ts` (extend)

**Behavioral spec:**

1. `loadVariationList` (`variation-widget-data.ts:281-311`) currently issues one `fetchVariationLabel` query per variation, serially, every 4s tick. Restructure:
   - Resolve `resolveLabelField(targetObject)` FIRST (it's already cached via `loadAllObjectsWithFields`), then have `loadVariationRecordIds` (or a sibling that reuses its query) select the label field (with its composite sub-selection via `selectableLabelField`/`selectionEntryForMirrorKind` for FULL_NAME, exactly as `fetchVariationLabel` builds it) in the SAME paginated query that fetches the variation ids. One query total for ids+labels, M queries removed. The old comment ("labels can't ride that formulaOverrides read") stays true — labels ride the variation-ids read, not the overrides read.
   - Run the three independent loads — `computeSyncableFields`, `loadActiveOverridesGroupedByRecord`, and the ids+labels read — with `Promise.all` (label-field resolution must precede the ids+labels read; keep that one ordering).
   - When there is no selectable label field, the query selects ids only and every label is `null` (current behavior preserved).
   - Preserve `deriveRecordDisplayLabel` usage for label extraction per record.
2. `formula-editor.tsx` `load()` (`:280-517`): the host-record read (`:467`) and the `formulaOverrides` read (`:484`) are independent of each other (both need only `host`, `recordId`, `defs`) — run them in `Promise.all`. Do not reorder anything else; the defs→probe→(record ∥ overrides) chain and the fire-and-forget branches stay as they are.

**Test cases (extend `variation-widget-data.spec.ts`, following its existing fixture style):**
- `loadVariationList` with 3 variations issues exactly ONE records query (ids+labels combined) — assert query count delta.
- labels correctly extracted for a TEXT label field and a FULL_NAME label field (composite sub-selection in the built query asserted via the fake's recorded selections).
- no label field resolvable → entries have `label: null`, single ids-only query.
- diverged counts unchanged (regression: rerun/keep existing loadVariationList expectations green).

`formula-editor.tsx` has no unit-test harness (it's a worker-sandboxed component); the `Promise.all` change is covered by typecheck + lint + the fact that it's a pure control-flow transformation. State this in the task report rather than inventing a component test.

**Steps:**
- [ ] **Step 1:** Write the batched-label tests — FAIL.
- [ ] **Step 2:** Restructure `loadVariationList`/`loadVariationRecordIds` — green.
- [ ] **Step 3:** Apply the `Promise.all` edit in `formula-editor.tsx` `load()`.
- [ ] **Step 4:** Full suite + oxlint (0/0) + typecheck.
- [ ] **Step 5:** Commit: `perf(formula-field): batch variation labels into the ids read; parallelize editor record+overrides loads`

---

### Task 6: Calm the poll — 4s → 30s shared constant

**Files:**
- Create: `src/front-components/lib/poll-interval.ts`
- Modify: `src/front-components/formula-editor.tsx:521`, `src/front-components/variation-widget.tsx:192`, `src/front-components/formula-definition-editor.tsx:405`, `src/front-components/variation-config-editor.tsx:253` (the four `setInterval(load, 4000)` sites)

**Implementation (complete):**

`src/front-components/lib/poll-interval.ts`:
```ts
// One knob for every widget's background refresh. 4s (the original value)
// re-ran each widget's full multi-query load ~900×/hour per open tab and was
// the single biggest steady-state load amplifier; 30s keeps cross-user edits
// visibly fresh while cutting that by 7.5×. User-initiated actions refresh
// immediately via their own load() calls, not this timer.
export const POLL_INTERVAL_MS = 30_000;
```

Each of the four sites: `setInterval(load, 4000)` → `setInterval(load, POLL_INTERVAL_MS)` plus the import. Nothing else changes (initial `load()` on mount stays immediate; the `setTimeout(load, 1500)` post-refresh nudge in formula-editor stays).

**Steps:**
- [ ] **Step 1:** Create the constant, apply the four edits.
- [ ] **Step 2:** Full suite + oxlint (0/0) + typecheck (no unit test — a constant swap in untestable worker components; verification is grep: zero remaining `4000` poll literals in `src/front-components/`).
- [ ] **Step 3:** Commit: `perf(formula-field): widget poll interval 4s → 30s (shared constant)`

---

## Explicitly out of scope (decided, do not re-open)

- **Upstream twenty-server/SDK PR** (field-level audit exclusion / `isAuditLogged` manifest flag): user chose app-side cleanup only (2026-07-14).
- **Bundle trim of the record-page widgets:** research initially flagged the engine/recompute imports as viewer-unneeded, but they are load-bearing — refresh-on-view (ADR 0015) recomputes stale TODAY() formulas in the front runtime via `recomputeForRecord`, and pin/resync UI needs override-repository + sync code. Code-splitting is also platform-infeasible (esbuild `splitting: false`, blob-URL execution). No task.
- **Skeleton-paint / partial-render before load completes**, per-worker cache sharing, Preact: platform-inherent or marginal; not worth the risk this arc.
- App version bump + cloud deploy: separate user-gated step after final review.
