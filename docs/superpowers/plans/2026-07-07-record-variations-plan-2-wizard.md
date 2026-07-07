# Record Variations — Plan 2: Per-Object Opt-In Wizard + Config Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Specificity calibration:** this plan is written for an **opus-level orchestrator with opus/sonnet implementers**, not for transcription-tier models. Novel or subtle logic (validation rules, lifecycle semantics, the relation-creation mutation) is given as complete code. Pattern-following code (declarative view/nav/layout files, UI scaffolding) is specified by exact interface + a named precedent file to mirror — the implementer reads the precedent and adapts it. Every task still names exact files, exports, and test cases; "adapt the precedent" never licenses changing a specified contract.

**Goal:** Build the per-object opt-in flow for record variations: a `VariationConfig` admin surface (nav + index view + record-page editor), a setup wizard that provisions the self-referencing `primaryRecord` relation field and places the (stub) variation widget tab, plus save-time validation and the trash/destroy/restore lifecycle. After this plan, a user can enable variations on any object and Plan 1's dormant sync engine comes alive.

**Architecture:** Mirrors the FormulaDefinition opt-in machinery one-for-one: `defineView`/`defineNavigationMenuItem`/`definePageLayout` for the admin surface, an editor front component that role-branches between "wizard" and "status panel" on the config record's completeness, a `MetadataApiClient.createOneField` call with `relationCreationPayload` (the one genuinely new mutation — creating a RELATION pair), the `ensure-formula-tab` runtime tab-placement pattern, and a `handle-formula-change`-style validation trigger with a bookkeeping-fields recursion guard.

**Tech Stack:** TypeScript, `twenty-sdk`/`twenty-client-sdk` (deploy-time app framework + remote-DOM front components), vitest.

**Root package for every file in this plan:** `packages/twenty-apps/community/formula-field/`. All paths relative to it unless stated otherwise.

**Depends on (all merged to main as of 2026-07-07):** Plan 1's sync engine — `src/objects/variation-config.object.ts` (`VARIATION_CONFIG_FIELDS`, `VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER`), `src/logic-functions/lib/variation-types.ts` (`VariationConfigRecord`), `src/logic-functions/lib/variation-config-repository.ts` (`loadAllEnabledVariationConfigs`, `findVariationConfigByTargetObject`, `updateVariationConfigBookkeeping`), `src/logic-functions/lib/variation-sync.ts` (`sweepVariationConfig`, and its dispatchers), `src/logic-functions/lib/syncable-fields.ts` (`computeSyncableFields`), `src/logic-functions/lib/metadata-objects.ts` (`loadAllObjectsWithFields`, now cached 60s per workspace, with the `__setFakeObjectsWithFieldsForTests` seam and a global vitest cache-clear hook in `vitest.setup.ts`).

## Global Constraints

- No `any` type (test-file store-introspection casts matching existing test style are tolerated). Named exports only. No abbreviations. Short `//` comments explaining WHY, never JSDoc.
- This package uses **vitest**: `npx vitest run [path]` from the package dir. Full suite baseline at plan start: **589 tests / 38 files, all green** — every task ends ≥ that, all green.
- Lint: `npx oxlint -c .oxlintrc.json .` from the package dir. Do NOT use `yarn lint`, `nx lint`, or `tsc --noEmit` — all three are known-broken/non-viable for this package in this environment (workspace-boundary error / unregistered nx project / stale-dist TS6305 artifact). oxlint + vitest are the only gates.
- Every paginated GraphQL connection read loops `after`/`hasNextPage` to completion.
- Generate NOTHING random at runtime in deploy-time definition files — universal identifiers are the hardcoded literals assigned in this plan (pre-generated via `crypto.randomUUID()`; `uuidgen` does not exist in this environment).
- **Metadata-API facts this plan relies on (verified against twenty-server source 2026-07-07; re-verify only if a call fails unexpectedly):**
  - `RelationType.MANY_TO_ONE === 'MANY_TO_ONE'` (twenty-shared `src/types/RelationType.ts`).
  - `createOneField` with `type: 'RELATION'` + `relationCreationPayload` creates a **pair**: the source MANY_TO_ONE field (our `primaryRecord`, join column auto-named `primaryRecordId`) and an inverse ONE_TO_MANY collection field on the target object. `targetFieldLabel`/`targetFieldIcon` in the payload describe the INVERSE field; its API name is derived from the label via `computeMetadataNameFromLabel` (slugify → camelCase), so label `'Variations'` → name `variations`.
  - Self-referencing relations (source object === target object) go through the identical server code path with no special-casing (`generateMorphOrRelationFlatFieldMetadataPair` has no source==target check) — both fields land on the same object.
  - `updateOneField` with `{ isActive: false }` on the MANY_TO_ONE side **auto-cascades `isActive` to the inverse field** (server constant `...RELATION_EDITABLE_PROPERTIES_ON_SIBLING...` = `['isActive']`) — lifecycle code must NOT separately deactivate the inverse.
  - Fields created via `createOneField` are stamped with the workspace custom application, not this app — provenance is only our own `createdRelationField` boolean (same reason `FormulaDefinition.createdField` exists).
  - The wizard's `createOneField` runs under the USER token (front-component host bridge) gated by the user's own DATA_MODEL permission; the app role needs no new grants for it. Server-side lifecycle mutations (`updateOneField` isActive) run under the app token and are covered by the existing role's `canUpdateAllSettings` (see `src/roles/default-role.ts`'s scope-analysis comment — do not modify the role).
- **Config lifecycle semantics (from the design doc, deliberate):** disable (`enabled: false`) → sync stops, relation field + values + overrides all stay. Trash → same as disable with zero handler code (the repository's default-filter excludes soft-deleted rows, so a trashed config drops out of the enabled set automatically — document this, don't build it). Destroy → deactivate the relation field ONLY if `createdRelationField === true` (cascade handles the inverse); **override rows are left in place** — this deliberately DIFFERS from `handleDefinitionDestroyed` (which deletes its override rows), because variation overrides share the `(object, field, record)` key space with potential future formulas, making surgical deletion unsafe (design doc "shared-target" caution). Restore-after-trash → fields were never touched; run one immediate `sweepVariationConfig` to converge values staled in the trash. Restore-after-destroy → reactivate the relation field if `createdRelationField`.
- **UUID assignments for this plan** (each used exactly once; spares at the end of this doc):

| Identifier | UUID |
|---|---|
| `VARIATION_CONFIG_VIEW_UNIVERSAL_IDENTIFIER` | `16884c29-2eeb-4616-8c6d-7fb3cd1ab75a` |
| view field: name | `60c8decf-f5a7-405c-9190-6b99223bf68f` |
| view field: targetObject | `ce6ade56-7ac6-41fc-a322-cfa73ca5696f` |
| view field: relationFieldName | `d9bf6542-0f19-44c4-8343-6ae352f3d911` |
| view field: enabled | `94228900-2510-4131-8ab7-1ca649424117` |
| view field: lastSyncedAt | `851c81ed-cb56-48cc-9ec5-d3281b55a7fb` |
| view field: lastError | `5fcb7c6a-bda2-4df8-82f2-cc6becdb666f` |
| navigation menu item | `be297c91-f59f-4a7b-9c36-95054f9a5d82` |
| page layout | `5e79852a-de12-4343-a5a9-cd389f09aa71` |
| page layout tab | `e9f31df6-a854-4170-a424-268d016b3ca6` |
| page layout widget | `7ee4b6be-40c5-4d9c-b345-35af2ba36945` |
| `VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER` (front component) | `171d0c3a-f1dc-4005-909e-d94d5fda377b` |
| `VARIATION_WIDGET_UNIVERSAL_IDENTIFIER` (front component, stub here, filled by Plan 3) | `b23b3354-0b79-4c6e-83c4-0adb05d86e1a` |
| logic fn: on-variation-config-created | `e6fc9bab-a0d3-4cfa-9dd5-104977b38afb` |
| logic fn: on-variation-config-updated | `a7e1ae01-88ed-451a-b635-f6dea328b1ed` |
| logic fn: on-variation-config-destroyed | `0a703f52-97df-4063-a996-ea20539aaee0` |
| logic fn: on-variation-config-restored | `81411c2b-80e5-4dfb-b725-70adccf9e0bf` |

---

### Task 1: VariationConfig admin surface (index view + nav item)

**Files:**
- Create: `src/views/variation-config.view.ts`
- Create: `src/navigation-menu-items/variation-config.navigation-menu-item.ts`

**Interfaces:**
- Consumes: `VARIATION_CONFIG_FIELDS`, `VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER` (existing, `src/objects/variation-config.object.ts`).
- Produces: `export const VARIATION_CONFIG_VIEW_UNIVERSAL_IDENTIFIER` (the nav item imports it; Task 6's live checks reference the nav label).

Pure declarative deploy-time files. Mirror `src/views/formula-definition.view.ts` and `src/navigation-menu-items/formula-definition.navigation-menu-item.ts` exactly in structure — read both first.

- [ ] **Step 1: Write the view.** `defineView` with: `universalIdentifier: VARIATION_CONFIG_VIEW_UNIVERSAL_IDENTIFIER = '16884c29-2eeb-4616-8c6d-7fb3cd1ab75a'`, `name: 'All variation configs'`, `objectUniversalIdentifier: VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER`, `icon: 'IconGitFork'`, `key: ViewKey.INDEX`, `position: 0`, and six columns in this order using the view-field UUIDs from the table above: `name` (size 180), `targetObject` (140), `relationFieldName` (150), `enabled` (90), `lastSyncedAt` (140), `lastError` (200). All `isVisible: true`, positions 0–5.
- [ ] **Step 2: Write the nav item.** `defineNavigationMenuItem` with `universalIdentifier: 'be297c91-f59f-4a7b-9c36-95054f9a5d82'`, `name: 'variation-configs'`, `icon: 'IconGitFork'`, `color: 'purple'`, `position: 1` (formula-definitions holds 0), `type: NavigationMenuItemType.VIEW`, `viewUniversalIdentifier: VARIATION_CONFIG_VIEW_UNIVERSAL_IDENTIFIER`. Keep the precedent's comment about every view needing a nav item.
- [ ] **Step 3: Lint** (`npx oxlint -c .oxlintrc.json .`) — clean. No spec files for `*.view.ts`/`*.navigation-menu-item.ts` (existing convention).
- [ ] **Step 4: Commit** — `feat(record-variations): VariationConfig index view and nav item`

---

### Task 2: Save-time validation + created/updated triggers

**Files:**
- Create: `src/logic-functions/lib/variation-config-validation.ts`
- Create: `src/logic-functions/lib/handle-variation-config-change.ts`
- Create: `src/logic-functions/on-variation-config-created.ts`
- Create: `src/logic-functions/on-variation-config-updated.ts`
- Test: `src/logic-functions/lib/__tests__/variation-config-validation.spec.ts`
- Test: `src/logic-functions/lib/__tests__/handle-variation-config-change.spec.ts`

**Interfaces:**
- Consumes: `VariationConfigRecord` (`lib/variation-types.ts`), `loadAllEnabledVariationConfigs`/`updateVariationConfigBookkeeping` (`lib/variation-config-repository.ts`), `computeSyncableFields` (`lib/syncable-fields.ts`), `loadAllObjectsWithFields` (`lib/metadata-objects.ts`), `isSafeGraphqlIdentifier` (`lib/identifier.ts`), `sweepVariationConfig` (`lib/variation-sync.ts`), `FormulaClient` (`lib/types.ts`), `FakeClient` + `setObjectsWithFields` seam (tests).
- Produces: `export type ConfigValidationResult = { valid: true } | { valid: false; error: string }`, `export const validateVariationConfig = async (client: FormulaClient, candidate: VariationConfigRecord, otherConfigs: VariationConfigRecord[]): Promise<ConfigValidationResult>` (in `variation-config-validation.ts`); `export const handleVariationConfigChange = async (args: { client: FormulaClient; after: VariationConfigRecord | null | undefined; updatedFields: string[] | undefined }): Promise<Record<string, unknown>>` (in `handle-variation-config-change.ts`). The two trigger files are thin wrappers (no spec, existing convention).

This is the `handle-formula-change.ts` pattern (read it first — the recursion guards are the load-bearing part) applied to `VariationConfig`. Write the validator and handler with this exact logic:

**`variation-config-validation.ts` (complete code):**

```typescript
import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import { computeSyncableFields } from 'src/logic-functions/lib/syncable-fields';
import { isSafeGraphqlIdentifier } from 'src/logic-functions/lib/identifier';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';

// Save-time validation for a VariationConfig, mirroring validateFormula's
// posture: reject with a clear error and let the caller disable the config,
// rather than letting a malformed config reach the sync engine's dynamically
// built GraphQL. Checks (design doc "Validation & edge cases"):
//   - targetObject present, a safe identifier, and actually exists in metadata
//   - name equals targetObject (the deterministic one-config-per-object key)
//   - relationFieldName present and a safe identifier
//   - no OTHER config (different id) already covers this object
//   - the object has at least one syncable field
// Deliberately NOT checked here: whether the relation field exists yet — a
// fresh wizard draft is validated before field creation; the wizard's own
// create path guarantees the field, and a broken API-created config surfaces
// through the sweep's lastError instead.

export type ConfigValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export const validateVariationConfig = async (
  client: FormulaClient,
  candidate: VariationConfigRecord,
  otherConfigs: VariationConfigRecord[],
): Promise<ConfigValidationResult> => {
  const targetObject = candidate.targetObject ?? '';
  const relationFieldName = candidate.relationFieldName ?? '';

  if (!targetObject) {
    return { valid: false, error: 'targetObject is required' };
  }
  if (!isSafeGraphqlIdentifier(targetObject)) {
    return {
      valid: false,
      error: `Invalid target object name "${targetObject}"`,
    };
  }
  if ((candidate.name ?? '') !== targetObject) {
    return {
      valid: false,
      error: `name must equal targetObject ("${targetObject}") — it is the one-config-per-object key`,
    };
  }
  if (!relationFieldName) {
    return { valid: false, error: 'relationFieldName is required' };
  }
  if (!isSafeGraphqlIdentifier(relationFieldName)) {
    return {
      valid: false,
      error: `Invalid relation field name "${relationFieldName}"`,
    };
  }
  const duplicate = otherConfigs.find(
    (config) =>
      config.id !== candidate.id && config.targetObject === targetObject,
  );
  if (duplicate) {
    return {
      valid: false,
      error: `A variation config for "${targetObject}" already exists`,
    };
  }
  const objects = await loadAllObjectsWithFields();
  if (!objects.some((object) => object.nameSingular === targetObject)) {
    return {
      valid: false,
      error: `Object "${targetObject}" does not exist`,
    };
  }
  const syncable = await computeSyncableFields(
    client,
    targetObject,
    relationFieldName,
  );
  if (syncable.length === 0) {
    return {
      valid: false,
      error: `Object "${targetObject}" has no syncable fields`,
    };
  }
  return { valid: true };
};
```

**`handle-variation-config-change.ts` (complete code):**

```typescript
import { validateVariationConfig } from 'src/logic-functions/lib/variation-config-validation';
import {
  loadAllEnabledVariationConfigs,
  updateVariationConfigBookkeeping,
} from 'src/logic-functions/lib/variation-config-repository';
import { sweepVariationConfig } from 'src/logic-functions/lib/variation-sync';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';

// Fields the app writes back as bookkeeping. An update touching only these is
// our own write — skip to avoid a validation/sweep loop (same guard as
// handle-formula-change.ts's BOOKKEEPING_FIELDS).
const BOOKKEEPING_FIELDS = new Set([
  'lastSyncedAt',
  'lastError',
  'status',
  'statusReason',
]);

const isPureBookkeepingUpdate = (
  updatedFields: string[] | undefined,
): boolean => {
  if (!updatedFields || updatedFields.length === 0) return false;
  return updatedFields.every((field) => BOOKKEEPING_FIELDS.has(field));
};

export type HandleVariationConfigChangeArgs = {
  client: FormulaClient;
  after: VariationConfigRecord | null | undefined;
  updatedFields: string[] | undefined;
};

// Runs after a VariationConfig is created or updated: validate, then either
// clear the error and converge immediately (one sweep of this config, so an
// enable/fix takes effect without waiting for the hour), or disable + record
// the error. Write-avoidant so the trigger does not re-fire itself.
export const handleVariationConfigChange = async ({
  client,
  after,
  updatedFields,
}: HandleVariationConfigChangeArgs): Promise<Record<string, unknown>> => {
  if (!after?.id) {
    return { handled: false };
  }
  if (isPureBookkeepingUpdate(updatedFields)) {
    return { handled: false, reason: 'bookkeeping-only' };
  }
  // Our own "disable on invalid" write sets { enabled: false, lastError }.
  // Skip it, or the now-excluded duplicate would seem to vanish and we would
  // wrongly re-validate clean (same second recursion guard as formulas).
  if (
    after.enabled === false &&
    updatedFields &&
    updatedFields.length > 0 &&
    updatedFields.every(
      (field) => BOOKKEEPING_FIELDS.has(field) || field === 'enabled',
    )
  ) {
    return { handled: false, reason: 'disabled-bookkeeping' };
  }
  // A disabled config is inert; only a human re-enable or a field edit flows on.
  if (after.enabled === false) {
    return { handled: false, reason: 'disabled' };
  }

  const existing = await loadAllEnabledVariationConfigs(client);
  const result = await validateVariationConfig(client, after, existing);

  if (!result.valid) {
    const needsWrite =
      after.enabled !== false || (after.lastError ?? '') !== result.error;
    if (needsWrite) {
      // enabled: false rides the same bookkeeping write; the recursion guards
      // above keep this from looping.
      await updateVariationConfigBookkeeping(client, after.id, {
        lastError: result.error,
      });
      await client.mutation({
        updateVariationConfig: {
          __args: { id: after.id, data: { enabled: false } },
          id: true,
        },
      });
    }
    return { handled: true, valid: false, error: result.error };
  }

  const clearError = (after.lastError ?? '') !== '';
  if (clearError) {
    await updateVariationConfigBookkeeping(client, after.id, { lastError: '' });
  }

  // Converge now instead of waiting for the hourly sweep — an enable or fix
  // should take effect immediately (formula precedent: recomputeAllRecords on
  // valid save).
  const sweep = await sweepVariationConfig(client, after);
  return { handled: true, valid: true, ...sweep };
};
```

Note the invalid-path write shape: `updateVariationConfigBookkeeping`'s `data` type does not include `enabled`, so the disable is a second, direct `updateVariationConfig` mutation (shown above). If during implementation you judge it cleaner to widen `updateVariationConfigBookkeeping`'s data type with `enabled?: boolean` instead, that is an acceptable deviation — pick one, keep both writes write-avoidant, and say which you chose in your report.

The two trigger files mirror `on-formula-definition-updated.ts` exactly (read it): `databaseEventTriggerSettings: { eventName: 'variationConfig.created' }` / `'variationConfig.updated'`, UUIDs from the table, `timeoutSeconds: 120` (the valid path runs a sweep — match `variation-sweep.ts`'s budget, not the 30s validation-only budget), handler builds `createDynamicCoreClient()` and delegates to `handleVariationConfigChange` with `after`/`updatedFields` from the payload.

- [ ] **Step 1: Write the failing validation tests.** `variation-config-validation.spec.ts` — seed via `client.setObjectsWithFields` (company with ≥1 syncable NUMBER/TEXT field + the label/relation fields, exactly like `variation-sync-*.spec.ts` fixtures). Cases: (1) valid config passes; (2) missing targetObject; (3) unsafe targetObject (`'bad name!'`); (4) `name !== targetObject`; (5) missing relationFieldName; (6) unsafe relationFieldName; (7) duplicate config for same object (different id) rejected, same id (self) passes; (8) nonexistent object; (9) object whose only fields are excluded kinds → "no syncable fields". Each asserts the exact `error` string prefix.
- [ ] **Step 2: Write the failing handler tests.** `handle-variation-config-change.spec.ts` — cases: (1) bookkeeping-only update → `{ handled: false, reason: 'bookkeeping-only' }`, zero mutations; (2) disabled + enabled/bookkeeping-only fields → `'disabled-bookkeeping'`; (3) disabled config, other field edited → `'disabled'`; (4) invalid config → disabled + lastError written, write-avoidant on repeat (run handler twice with same state, assert second run performs zero mutations); (5) valid config → lastError cleared when previously set, and `sweepVariationConfig` effects observed (seed one primary + one stale variation, assert the variation converged — this exercises the real sweep through FakeClient, not a mock).
- [ ] **Step 3: RED** — both spec files fail (modules not found).
- [ ] **Step 4: Implement** the two lib files (code above) and the two trigger files.
- [ ] **Step 5: GREEN** — focused specs pass; full suite ≥589 green; oxlint clean.
- [ ] **Step 6: Commit** — `feat(record-variations): config save validation and change triggers`

---

### Task 3: Destroy/restore lifecycle

**Files:**
- Create: `src/logic-functions/lib/handle-variation-config-lifecycle.ts`
- Create: `src/logic-functions/on-variation-config-destroyed.ts`
- Create: `src/logic-functions/on-variation-config-restored.ts`
- Test: `src/logic-functions/lib/__tests__/handle-variation-config-lifecycle.spec.ts`

**Interfaces:**
- Consumes: `findFields`, `MetadataQueryClient` (existing, exported from `lib/handle-definition-lifecycle.ts` — reuse, do not duplicate), `sweepVariationConfig` (`lib/variation-sync.ts`), `VariationConfigRecord`, `FormulaClient`.
- Produces: `export const handleVariationConfigDestroyed = async (client: FormulaClient, before: VariationConfigRecord, metadataClient?: MetadataQueryClient): Promise<Record<string, unknown>>`, `export const handleVariationConfigRestored = async (client: FormulaClient, after: VariationConfigRecord, metadataClient?: MetadataQueryClient): Promise<Record<string, unknown>>`.

Read `lib/handle-definition-lifecycle.ts` in full first — this task is its variation-shaped analogue with three deliberate differences: (a) NO override-row deletion on destroy (Global Constraints explain why — put that WHY comment in the code); (b) only ONE field to deactivate (the MANY_TO_ONE side; the server cascades `isActive` to the inverse — comment this, and do NOT look up or mutate the inverse); (c) restore additionally runs one immediate `sweepVariationConfig` to converge values staled in the trash.

Semantics to implement exactly:
- `handleVariationConfigDestroyed`: no-op (return `{ deactivated: [] }`) unless `before.createdRelationField === true` and `before.targetObject`/`before.relationFieldName` present. Otherwise `findFields(before.targetObject, [before.relationFieldName], metadataClient)`, and if the field exists and `isActive`, `updateOneField` `{ isActive: false }` (same `setFieldActive` shape as the precedent — private local copy is fine, it's 8 lines and the precedent's is private too, but accept an injected metadata client for testability like `findFields` does). Never delete the field or any data. Return `{ deactivated: [name] | [] }`.
- `handleVariationConfigRestored`: if `after.createdRelationField === true`, look up the relation field and reactivate it if inactive (restore-after-destroy heal). Then, if `after.enabled !== false`, run `sweepVariationConfig(client, after)` and include its counters in the return. (Restore-after-trash: field was never deactivated, the lookup finds it active, only the sweep runs.)

Trigger files mirror the formula ones (`on-formula-definition-destroyed.ts` / `-restored.ts` — read them): eventNames `variationConfig.destroyed` / `variationConfig.restored`, UUIDs from the table, guard on `before?.id` / `after?.id`, `timeoutSeconds: 120` for restored (it sweeps), 30 for destroyed. **No `variationConfig.deleted` trigger exists** — add a comment in the lifecycle lib explaining trash needs no handler (repository default-filter already excludes soft-deleted configs, so sync stops by construction).

- [ ] **Step 1: Write the failing tests.** Cases: (1) destroy with `createdRelationField: true` deactivates the field via the injected metadata client (assert the `updateOneField` selection shape: `input: { id, update: { isActive: false } }`) and does NOT touch `formulaOverride` rows (seed one override for the object; assert it survives with zero mutations against it); (2) destroy with `createdRelationField: false` → zero metadata mutations; (3) destroy when the field is already inactive → zero metadata mutations; (4) restore reactivates an inactive field and sweeps (seed primary + stale variation, assert convergence); (5) restore of a disabled config heals the field but does NOT sweep. For the injected metadata client, build a minimal in-test fake implementing `MetadataQueryClient` + a `mutation` recorder — model it on how `handle-definition-lifecycle.spec.ts` fakes metadata (read that spec first; if it stubs differently, follow its style).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN + full suite + oxlint.** 
- [ ] **Step 5: Commit** — `feat(record-variations): config destroy/restore lifecycle`

---

### Task 4: Variation tab placement + widget stub

**Files:**
- Create: `src/front-components/lib/ensure-variation-tab.ts`
- Create: `src/front-components/variation-widget.tsx` (stub)
- Create: `src/front-components/lib/front-component-ids.ts` — MODIFY instead if it already exists (it does: `FORMULA_EDITOR_UNIVERSAL_IDENTIFIER` lives there); add `VARIATION_WIDGET_UNIVERSAL_IDENTIFIER = 'b23b3354-0b79-4c6e-83c4-0adb05d86e1a'`.

**Interfaces:**
- Produces: `export const ensureVariationTabOnObject = async (objectMetadataId: string): Promise<EnsureVariationTabResult>` with `export type EnsureVariationTabResult = 'exists' | 'created' | 'no-record-page-layout' | 'front-component-not-found'`; the stub front component registered under `VARIATION_WIDGET_UNIVERSAL_IDENTIFIER` with `name: 'variation-widget'`.

`ensure-variation-tab.ts` is a near-copy of `src/front-components/lib/ensure-formula-tab.ts` (read it; it is ~90 lines) with: `TAB_TITLE = 'Variations'`, widget title `'Record variations'`, the widget's universal identifier constant, and the same result union/idempotency/grid shape (`position 1000`, `CANVAS`, 4x4 grid). Keep its header comment's caveat about the tab appearing only after a metadata-store refresh. Do not attempt to share code with ensure-formula-tab — a parameterized helper would couple two features' UX to one shape for ~60 duplicated lines; the app's convention is one file per tab concern (note this WHY in a comment if the duplication feels wrong).

The stub `variation-widget.tsx`: `defineFrontComponent({ universalIdentifier: VARIATION_WIDGET_UNIVERSAL_IDENTIFIER, name: 'variation-widget', description: 'Create and manage variations of this record.', component: VariationWidget })` where `VariationWidget` renders a single `WidgetRoot` (import from `src/front-components/lib/ui`) containing a `MutedText` line: `'Variations are enabled for this object. The management widget arrives with the next app update.'` — plus a `// Stub: Plan 3 replaces this component's internals; the universal identifier and registration are permanent.` comment. No state, no clients, no tests (matches thin-wrapper convention).

- [ ] **Step 1: Implement all three files.** No spec for the tab helper (ensure-formula-tab has none — it is I/O glue verified live).
- [ ] **Step 2: Full suite + oxlint** — green/clean.
- [ ] **Step 3: Commit** — `feat(record-variations): variation tab placement and widget stub`

---

### Task 5: Wizard pure logic (testable core)

**Files:**
- Create: `src/front-components/lib/variation-setup-logic.ts`
- Test: `src/front-components/lib/__tests__/variation-setup-logic.spec.ts`

**Interfaces:**
- Consumes: `MIRRORABLE_KINDS`, `ENGINE_FAMILY_KINDS` (`lib/mirror-kinds.ts`), `isSafeGraphqlIdentifier` (`lib/identifier.ts`).
- Produces (exact contracts Task 6's UI consumes):

```typescript
// The wizard's picked object, as loaded from the metadata API by the UI layer.
export type VariationTargetObject = {
  id: string;
  nameSingular: string;
  labelSingular: string;
  labelIdentifierFieldMetadataId: string | null;
  fields: { id: string; name: string; type: string; isActive: boolean; isSystem: boolean }[];
};

export type RelationFieldNameCheck =
  | { ok: true; resume: false }
  | { ok: true; resume: true; existingFieldId: string } // field exists AND is a RELATION → resume an interrupted wizard
  | { ok: false; error: string };

// The inverse collection field's fixed label and its server-derived API name.
// computeMetadataNameFromLabel('Variations') === 'variations' (simple ASCII
// word: slugify → camelCase is identity-lowercased) — hardcoded rather than
// imported so the front bundle does not pull twenty-shared/metadata; the spec
// asserts the pair stays consistent with that rule.
export const INVERSE_FIELD_LABEL = 'Variations';
export const INVERSE_FIELD_NAME = 'variations';

export const checkRelationFieldName = (
  name: string,
  targetObject: VariationTargetObject,
): RelationFieldNameCheck;

// Objects eligible for the picker: active, non-system, not app-owned, no
// existing config, and ≥1 syncable field (same kind test as
// computeSyncableFields, recomputed here client-side because the front
// component has the full field list in hand and must not call the
// logic-function-side loader).
export const eligibleTargetObjects = (
  objects: VariationTargetObject[],
  existingConfigTargetObjects: string[],
): VariationTargetObject[];

export const countSyncableFields = (
  object: VariationTargetObject,
  relationFieldName: string,
): number;
```

Behavior specification:
- `checkRelationFieldName`: empty → error `'Field name is required'`; fails `isSafeGraphqlIdentifier` → error naming the rule; equals `INVERSE_FIELD_NAME` → error (the pair would collide with itself); collides with an existing active field that is NOT a RELATION → error `'Field "<name>" already exists on <labelSingular>'`; collides with an existing active RELATION field → `{ ok: true, resume: true, existingFieldId }` (interrupted-wizard resume — the UI reuses the field instead of re-creating); also check `INVERSE_FIELD_NAME` against existing fields: if `variations` exists and is NOT a RELATION → error (the inverse side would collide); if it exists AND is a RELATION, treat as part of the same resume.
- `countSyncableFields`: replicate `computeSyncableFields`' exclusion chain against the in-hand field list — active, non-system, kind ∈ `MIRRORABLE_KINDS ∪ ENGINE_FAMILY_KINDS`, not the label-identifier field (by id match), not `relationFieldName`, not `INVERSE_FIELD_NAME`. (Formula-target exclusion is deliberately omitted client-side — it needs a formulas query; the server-side validator (Task 2) is authoritative and the count here is a UX gate only. Comment this.)
- `eligibleTargetObjects`: filter active/non-system, exclude `new Set(['formulaDefinition', 'formulaOverride', 'variationConfig'])` (mirror the wizard's `EXCLUDED_OBJECTS` idea plus our own objects), exclude objects whose `nameSingular` is in `existingConfigTargetObjects`, keep only `countSyncableFields(object, 'primaryRecord') > 0`, sort by `labelSingular`.

- [ ] **Step 1: Failing tests** covering: happy identifier; unsafe identifier; `variations` self-collision; non-RELATION collision; RELATION collision → resume with the field id; inverse-name non-RELATION collision; syncable count matrix (one object mixing NUMBER/TEXT/RELATION/ACTOR/system/inactive/label fields — assert the exact count); eligibility filter (app-owned excluded, already-configured excluded, zero-syncable excluded, sort order).
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN + full suite + oxlint.**
- [ ] **Step 5: Commit** — `feat(record-variations): wizard validation and eligibility logic`

---

### Task 6: The wizard + config editor UI

**Files:**
- Create: `src/front-components/variation-config-editor.tsx`
- Create: `src/front-components/lib/variation-setup-wizard.tsx`
- Create: `src/page-layouts/variation-config-page-layout.ts`

**Interfaces:**
- Consumes: everything from Task 5; `ensureVariationTabOnObject` (Task 4); `VARIATION_CONFIG_FIELDS`/`VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER`; UI kit from `src/front-components/lib/ui` (`WidgetRoot`, `StepTitle`, `ChoiceChip`, `PrimaryButton`, `TextInput`, `ErrText`, `OkText`, `HintText`, `MutedText`, `SectionTitle`, `BannerDanger`, `ToggleTrack`/`ToggleKnob`); `formatRelativePast` (`lib/format-relative-past.ts`); `useRecordId`, `enqueueSnackbar` (`twenty-sdk/front-component`); `CoreApiClient` (static VariationConfig CRUD), `MetadataApiClient` (createOneField + objects load), `defineFrontComponent` (`twenty-sdk/define`).
- Produces: `export const VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER = '171d0c3a-f1dc-4005-909e-d94d5fda377b'` + default `defineFrontComponent` export; the page layout registering it on VariationConfig's record page.

**Read first:** `src/front-components/formula-definition-editor.tsx` (role branching, `load()`+4s-poll, layout style object, `defineFrontComponent` tail) and `src/front-components/lib/formula-setup-wizard.tsx` (object picker via MetadataApiClient, `persistDraft` fire-and-forget, `finalizeCreation` structure, snackbar nudge, `existingField` resume). This task's UI is a structural sibling of those two — reuse their idioms wholesale. No component-level spec (the app has none for these; the testable core landed in Task 5).

**`variation-config-editor.tsx` — exact behavior:**
- `useRecordId()`; `load()` fetches all `variationConfigs` via `CoreApiClient` (static object — genql-safe), finds the current one; 4s poll like the formula editor.
- Role branch: config with `!targetObject || !relationFieldName` → render `VariationSetupWizard` with `draft={{ id, targetObject, relationFieldName }}` and `onCreated={load}`. Otherwise → status panel:
  - Rows: target object, relation field name, enabled state, `lastSyncedAt` via `formatRelativePast`, and a red `BannerDanger` with `lastError` when non-empty / `statusReason` when non-empty.
  - An enable/disable toggle (ToggleTrack/ToggleKnob, mirroring `OverrideToggle`'s shape in `formula-editor.tsx`) writing `updateVariationConfig { enabled }` via `CoreApiClient`, then `setTimeout(load, 1000)`.
  - A `HintText` note: disabling stops sync but keeps the relation field, values, and overrides; deleting the config from the index view behaves the same; only a permanent destroy deactivates the relation field.

**`variation-setup-wizard.tsx` — exact flow:**
1. On mount, load objects via `MetadataApiClient` using the SAME paginated `objects` query shape as the formula wizard's `loadObjects` (id, nameSingular, labelSingular, labelIdentifierFieldMetadataId, isActive, isSystem, fields with id/name/type/isActive/isSystem — options/settings NOT needed here), AND load existing configs via `CoreApiClient` (`variationConfigs` connection, `targetObject` only) — feed both into `eligibleTargetObjects`. Resume: if `draft.targetObject` is set, reselect it (even if now-ineligible-because-configured — its own config is this draft; pass `existingConfigTargetObjects` minus the draft's own targetObject).
2. Step 1 UI: object picker (`ChoiceChip` grid, formula-wizard style). Picking persists `{ name: nameSingular, targetObject: nameSingular }` to the config record via fire-and-forget `persistDraft` (CoreApiClient `updateVariationConfig`) — name is stamped here so the deterministic key is never user-managed.
3. Step 2 UI: relation-field-name `TextInput` defaulting `'primaryRecord'`, validated live with `checkRelationFieldName`; show `ErrText` on error, `OkText` "will resume with the existing field" on `resume: true`. Below it a `HintText`: creating adds TWO fields — `<name>` (link to the primary) and a `Variations` collection — plus a `MutedText` syncable-count line from `countSyncableFields`.
4. Create button (disabled while invalid/creating):

```tsx
// The one genuinely new mutation in this plan. relationCreationPayload's
// label/icon describe the INVERSE collection field the server creates on the
// same (self-referencing) object; its API name derives from the label
// ('Variations' -> 'variations', asserted in variation-setup-logic.spec).
const check = checkRelationFieldName(fieldName, selectedObject);
let relationFieldId =
  check.ok && check.resume ? check.existingFieldId : null;
if (!relationFieldId) {
  const created = await metadataClient.mutation({
    createOneField: {
      __args: {
        input: {
          field: {
            objectMetadataId: selectedObject.id,
            type: 'RELATION',
            name: fieldName,
            label: 'Primary record',
            description:
              'Points at the record this one is a variation of ' +
              '(Formula Field app — record variations).',
            icon: 'IconGitFork',
            isUIEditable: true,
            relationCreationPayload: {
              type: 'MANY_TO_ONE',
              targetObjectMetadataId: selectedObject.id,
              targetFieldLabel: INVERSE_FIELD_LABEL,
              targetFieldIcon: 'IconGitFork',
            },
          },
        },
      },
      id: true,
    },
  });
  relationFieldId = created?.createOneField?.id ?? null;
}
```

5. Then finalize (formula `finalizeCreation` structure): `updateVariationConfig` with `{ name: selectedObject.nameSingular, targetObject: selectedObject.nameSingular, relationFieldName: fieldName, createdRelationField: !check.resume, enabled: true }`; best-effort `try { await ensureVariationTabOnObject(selectedObject.id); } catch {}`; best-effort `enqueueSnackbar({ message: 'Variations enabled. If the new fields or tab do not appear, refresh the page.', variant: 'info', dedupeKey: 'variation-config-created' })`; `onCreated()`. Wrap the whole create path in try/catch → `setError(message)` like the formula wizard's `create()`. NOTE the `createdRelationField: !check.resume` subtlety: a resumed wizard that found a pre-existing relation field must NOT claim provenance over it (destroy would deactivate a field the app didn't create).
6. `persistDraft` after every pick so an interrupted wizard resumes (object pick persists immediately; field name persists on successful create only — resumability of the name adds a draft column we don't have; comment this limitation).

**`variation-config-page-layout.ts`:** mirror `formula-definition-page-layout.ts` verbatim in structure — layout UUID `5e79852a-de12-4343-a5a9-cd389f09aa71`, tab UUID `e9f31df6-a854-4170-a424-268d016b3ca6` (title `'Setup'`, icon `'IconGitFork'`, position 10, CANVAS), widget UUID `7ee4b6be-40c5-4d9c-b345-35af2ba36945` (title `'Variation config'`, FRONT_COMPONENT → `VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER`), `objectUniversalIdentifier: VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER`.

- [ ] **Step 1: Implement the three files.**
- [ ] **Step 2: Full suite + oxlint** — green/clean (no new specs; Task 5 covered the logic).
- [ ] **Step 3: Commit** — `feat(record-variations): opt-in wizard and config editor`

---

## Verification & handoff

- [ ] Full suite green (≥589 + this plan's new tests), oxlint clean, across the whole package.
- [ ] **Live smoke (requires a running dev instance + app deploy — see memory note `twenty-apps-sdk-local-dev` for the deploy workflow):** deploy; open the app; nav shows "Variation configs"; create a config → wizard renders → enable on Company with default `primaryRecord` → both fields appear on Company (after refresh), Variations tab present, config row shows enabled + no error; create a company variation via API (set `primaryRecordId`) → initial sync fires (Plan 1 engine). Editing a Company record propagates to its variation. If the dev instance is unavailable, mark this checklist deferred to Plan 4 — do not silently skip it.
- [ ] Update the memory/progress doc trail per session conventions; hand off to Plan 3.

## Self-Review

- **Spec coverage** (design doc → task): nav/index/editor (Tasks 1, 6); wizard incl. `relationCreationPayload` + `createdRelationField: true` + tab placement (Tasks 4, 5, 6); config save validation incl. all four design-doc checks (Task 2 — "relation field name … doesn't collide (unless resuming)" is enforced client-side in Task 5 where the field list is in hand; the server-side validator deliberately skips existence, documented in code); disable/trash/destroy/restore lifecycle incl. overrides-left-in-place (Task 3 + Global Constraints); IndexedDB refresh nudge (Task 6 snackbar).
- **Type consistency:** `VariationTargetObject` (Task 5) is produced by Task 6's metadata load and consumed by `checkRelationFieldName`/`countSyncableFields`/`eligibleTargetObjects`; `ConfigValidationResult`/`handleVariationConfigChange` names match between Task 2's code and its trigger files; the widget-stub universal identifier is the SAME constant Plan 3 will reuse (`front-component-ids.ts`).
- **Placeholder scan:** every step names exact files/values; the two "acceptable deviation" points (bookkeeping-write shape in Task 2; none other) are explicit decisions delegated with bounds, not gaps.

## Spare UUIDs (for Plan 3 / unforeseen needs — strike through when consumed)

`55851899-a4b5-4fda-825c-9e49aee50ded`, `926738d5-83f4-480c-9642-00a33bd3c2db`, `e38f3af0-2885-4806-b023-217bfd06f06d`, `e5b2085c-0f45-4da6-a3de-2002302fd9b4`, `9e4abf10-2860-48f6-94f2-412798432292`, `e1a3c345-62c8-48fd-a7c0-8d43e1355aad`, `e8049691-fb86-4166-93e7-5e7a4d1a6612`, `a8e55884-54d6-44a3-ad9a-7ae8074f6363`, `e5a06b4e-7c4d-4e43-86ea-128d615871ab`
