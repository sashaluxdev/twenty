# Record Variations — Plan 3: Dual-Role Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Specificity calibration:** written for an **opus-level orchestrator** — novel logic (role resolution, name numbering, re-sync semantics, label policy) is specified as complete code or exact contracts; UI scaffolding is specified by interface + named precedent. "Adapt the precedent" never licenses changing a specified contract.

**Goal:** Replace Plan 2's stub `variation-widget.tsx` with the full dual-role record-page widget: on a primary it creates and lists variations; on a variation it shows the primary link (or frozen state), the diverged-field list, and per-field re-sync. This is the last build phase — after it, the feature is end-to-end usable.

**Architecture:** One front component, role-branched on the current record's relation pointer (formula-definition-editor's wizard/editor branch is the structural precedent). All record I/O rides `createDynamicCoreClient()` (runtime-created fields are outside the genql type map — every precedent widget call site carries this comment). All sync/override behavior REUSES Plan 1's engine functions directly — front components already import from `src/logic-functions/lib` (`formula-editor.tsx` imports and runs `recomputeForRecord` client-side; same pattern). Pure logic lives in a testable lib module; the `.tsx` stays thin.

**Tech Stack:** TypeScript, `twenty-sdk`/`twenty-client-sdk`, vitest.

**Root package:** `packages/twenty-apps/community/formula-field/`. All paths relative.

**Depends on:** Plans 1–2 merged. Key existing contracts this plan consumes (verify nothing has drifted before Task 1 — one read of `variation-sync.ts`'s export list suffices):
- `findVariationConfigByTargetObject(client, targetObject)` → `VariationConfigRecord | null` (filters `targetObject`, enabled NOT filtered — check `.enabled` yourself).
- `computeSyncableFields(client, targetObject, relationFieldName)` → `SyncableFieldInfo[] = { name, kind }[]`.
- `loadVariationRecordIds(client, targetObject, relationFieldName, primaryRecordId)` → `string[]` (paginated).
- `syncOneVariation(client, targetObject, primaryRecord, variationId, fieldsToConsider)` → `SyncOutcome` — accepts an arbitrary fields subset: passing ONE field is the per-field re-sync primitive.
- `fetchPrimaryRecordInclTrashed(client, targetObject, primaryRecordId, fields, selectionOverrides, relationFieldName)` → `{ record, frozen }` — the freeze-state read (plural connection + `deletedAt: {}` filter).
- `loadActiveOverrideFieldsForRecord(client, targetObject, recordId)` → `Set<string>`; `deactivateOverride(client, targetObject, targetField, recordId)` → `boolean` (`lib/override-repository.ts`).
- `selectionEntryForMirrorKind(kind)` (`lib/mirror-kinds.ts`); `deriveRecordDisplayLabel` (`lib/formula-field-formats.ts`); `labelFieldSelection`-style composite handling precedent (`formula-setup-wizard.tsx`).
- `VARIATION_WIDGET_UNIVERSAL_IDENTIFIER` (`lib/front-component-ids.ts`, Plan 2) — the stub's identifier is PERMANENT; this plan changes only the component's internals, never the identifier or registration shape.
- The `*.created` wildcard handler (`handleVariationRecordCreated`, Plan 1) performs the initial sync server-side — the widget's create path does NOT sync client-side (design decision: one sync path, no duplication).

## Global Constraints

- No `any` (existing test-style casts tolerated). Named exports only. Short `//` WHY comments.
- vitest: `npx vitest run [path]` from the package dir. Baseline at plan start: whatever Plan 2 left (≥589 + Plan 2's tests), all green; every task ends ≥ baseline, green.
- Lint: `npx oxlint -c .oxlintrc.json .` ONLY (yarn lint / nx lint / tsc --noEmit are all known-broken for this package in this environment).
- Every paginated connection read loops to completion.
- The widget renders NOTHING (return `null` after the loading state) on objects with no enabled config, and on the app's own objects — it may be placed on layouts where the feature was later disabled; it must degrade to invisible, never to an error card.
- **Do not add new role grants.** Widget mutations (create variation, field writes during re-sync) run under the USER token via the host bridge; server-side sync stays on the app token. If a mutation is denied for a user, surface the error text in the widget — do not touch `default-role.ts`.
- Poll-refresh cadence: 4s `setInterval` on the widget's `load()`, matching `formula-definition-editor.tsx`. Action handlers do optimistic local state + `setTimeout(load, 1000)`, matching `toggleOverride`.

---

### Task 1: Widget pure logic (`variation-widget-data.ts`)

**Files:**
- Create: `src/front-components/lib/variation-widget-data.ts`
- Test: `src/front-components/lib/__tests__/variation-widget-data.spec.ts`

**Interfaces:**
- Consumes: the Plan 1 engine exports listed above, `FormulaClient` (`lib/types.ts`), `FakeClient` + `setObjectsWithFields` (tests).
- Produces (exact contracts Task 2/3 consume):

```typescript
export type WidgetRole =
  | { kind: 'hidden' }                               // no enabled config for this object
  | { kind: 'primary'; config: VariationConfigRecord }
  | {
      kind: 'variation';
      config: VariationConfigRecord;
      primaryRecordId: string;
      frozen: boolean;                               // primary trashed or destroyed
      primaryLabel: string | null;                   // null when frozen-destroyed or label underivable
    };

// One call resolving everything the shell needs: config lookup, fresh pointer
// read (never trusted from any cached prop — same rule as the dispatchers),
// and for variations a deletedAt-inclusive primary fetch that also yields the
// label. Label fields: resolve the object's label-identifier field name+kind
// from loadAllObjectsWithFields; TEXT selects true, FULL_NAME selects
// {firstName,lastName}, any other kind -> no label (null), matching the
// wizard's labelFieldSelection policy.
export const resolveWidgetRole = async (
  client: FormulaClient,
  objectName: string,
  recordId: string,
): Promise<WidgetRole>;

export type VariationListEntry = {
  id: string;
  label: string | null;
  divergedCount: number;
};

// Primary view data: every variation id (paginated), its display label, and
// its diverged-field count = active override fields ∩ current syncable set.
// Overrides are loaded in ONE paginated query per call (filter targetObject +
// active), grouped client-side by recordId — not one query per variation.
export const loadVariationList = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  primaryRecordId: string,
): Promise<VariationListEntry[]>;

export type DivergedField = { name: string; kind: string };

// Variation view data: active overrides for this record ∩ syncable set,
// as {name, kind} so the re-sync action knows the field's selection shape.
export const loadDivergedFields = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  variationRecordId: string,
): Promise<DivergedField[]>;

// "<primary label> (variation)" with numbering on collision: scans the
// existing variations' labels for the exact base and "(variation N)" suffixes,
// returns base for the first, "(variation 2)", "(variation 3)"… after.
// Pure string logic — fully unit-tested.
export const nextVariationLabel = (
  primaryLabel: string,
  existingLabels: (string | null)[],
): string;

// The label WRITE policy for creating a variation, by label-field kind:
//   TEXT      -> { [labelField]: nextVariationLabel(...) }
//   FULL_NAME -> { [labelField]: { firstName: primary.firstName,
//                  lastName: `${primary.lastName} (variation)` } } (numbering
//                  applied to lastName via nextVariationLabel on the lastName)
//   other/unknown -> {} (create without a name; server default applies)
// Documented consequence: non-TEXT/FULL_NAME label objects get unnamed
// variations — acceptable v1, noted in the design doc's spirit ("numbered on
// collision" is only meaningful where we can write a label at all).
export const buildVariationLabelData = (
  labelField: { name: string; kind: string } | null,
  primaryRecord: Record<string, unknown>,
  existingLabels: (string | null)[],
): Record<string, unknown>;

// Re-sync one diverged field: deactivate the override (keep its value —
// existing toggle-OFF semantic), then copy the primary's current value via
// syncOneVariation scoped to exactly this field. Returns the SyncOutcome, or
// {frozen:true} when the primary is gone (no write, override left ACTIVE —
// deactivating without a copy would silently hand the field to nothing).
export const resyncDivergedField = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  variationRecordId: string,
  field: DivergedField,
): Promise<SyncOutcome | { frozen: true }>;
```

Implementation notes (binding):
- `resolveWidgetRole`: `findVariationConfigByTargetObject` → null or `enabled !== true` → `hidden`. Fresh pointer read via a one-field dynamic query (`{ [objectName]: { __args: {filter:{id:{eq}}}, id, [pointerField]: true } }`). Non-null pointer → `fetchPrimaryRecordInclTrashed` selecting the label field (kind-aware) → derive `frozen` + `primaryLabel` (label null when `record` is null).
- `resyncDivergedField`: fetch the primary via `fetchPrimaryRecordInclTrashed` selecting ONLY this field (`selectionEntryForMirrorKind(field.kind)`); if frozen → return `{ frozen: true }` WITHOUT touching the override; else `deactivateOverride` then `syncOneVariation(client, targetObject, primary, variationRecordId, [field])`. Order matters: deactivate first, else `syncOneVariation` skips the field as overridden. If the sync then errors, the override stays deactivated and the hourly sweep converges the field — acceptable, comment it.
- `nextVariationLabel` collision scan: base = `${primaryLabel} (variation)`; taken labels matching `^${base}$` or `^${primaryLabel} \(variation (\d+)\)$` (escape the primary label for regex); next N = max(taken)+1 with plain base counting as 1.

- [ ] **Step 1: Failing tests.** Fixture: company object (label TEXT field `name`, NUMBER `employees`, RELATION `primaryRecord`) via `setObjectsWithFields` + seeded `variationConfig` + records. Cases: role hidden (no config / disabled config); role primary (null pointer); role variation with live primary + label; role variation frozen-trashed (deletedAt set — label still derivable from the trashed record); role variation frozen-destroyed (primary absent — label null); `loadVariationList` (two variations, one with 2 active overrides + 1 inactive + 1 override on a non-syncable field → divergedCount 2; assert ONE formulaOverrides query via `client.querySelections` count filtering); `loadDivergedFields` (intersection + kinds correct); `nextVariationLabel` (first, second, gap-tolerant max, regex-hostile primary label like `Acme (test)`); `buildVariationLabelData` for TEXT / FULL_NAME / unknown-kind label; `resyncDivergedField` happy path (override deactivated + value copied), frozen path (override untouched, zero writes).
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN + full suite + oxlint.**
- [ ] **Step 5: Commit** — `feat(record-variations): widget data layer`

---

### Task 2: Record-link capability probe (timeboxed decision step)

**Files:** none created — this is a 15-minute investigation whose OUTPUT is a decision recorded in the Task 3/4 dispatches.

The primary view lists variations and the variation view shows its primary; ideally these are navigable links. Front components run in a remote-DOM sandbox; `useRecordId` and `enqueueSnackbar` are the only host-bridge APIs used so far. Determine, in this order, and stop at the first hit:
1. `grep -rn "navigate\|openRecord\|useNavigate\|href" packages/twenty-sdk/src/sdk/front-component/` — does the SDK expose navigation?
2. If not: does the sandbox render a plain `<a href="/object/{nameSingular}/{id}">` that the host intercepts? Check any anchor usage in existing front components (grep `href` in `src/front-components/`).
3. If neither is provable within the timebox: the fallback IS the decision — render labels as plain text plus a "Copy link" `SecondaryButton` that copies `${window.location.origin}/object/{nameSingular}/{id}`... but `window.location` may not exist in the sandbox either — if not, copy just the record id, with a `HintText` naming the object. Never guess an anchor works: an unclickable dead link is worse than honest text.

- [ ] **Step 1:** Run the probes; record the chosen mechanism (one sentence + evidence) in the orchestrator ledger and pass it verbatim into Tasks 3–4's dispatches.

---

### Task 3: Primary role UI (list + create)

**Files:**
- Modify: `src/front-components/variation-widget.tsx` (replace stub internals; identifier/registration untouched)

**Interfaces:**
- Consumes: Task 1's data layer, Task 2's link decision, UI kit (`WidgetRoot`, `SectionTitle`, `PrimaryButton`, `SecondaryButton`, `MutedText`, `HintText`, `ErrText`, `RowDivider`), `createDynamicCoreClient`, `capitalize` — note: `capitalize` is module-private in both `recompute.ts` and `variation-sync.ts`; write a local one-liner (third copy is fine; a shared export is a gratuitous cross-module edit).
- Produces: the widget shell (`load()` + 4s poll + role switch) with the primary branch complete; the variation branch renders a `MutedText` placeholder that Task 4 replaces.

Behavior (binding):
- Shell: `useRecordId()`; host object name — **the widget must know which object it is mounted on**; `useRecordId` gives only the id. Resolve it the way `formula-editor.tsx` resolves its host object (read that file's `load()`; it derives the host from context available to the component — mirror exactly whatever it does; if it turns out to fetch/infer, reuse that inference verbatim). Then `resolveWidgetRole`; `hidden` → `return null`.
- Primary branch: header `SectionTitle` "Variations"; `loadVariationList` rows — label (or `MutedText` "(unnamed)"), diverged count as `n diverged` `MutedText` when n>0, link/copy affordance per Task 2. Empty list → `HintText` "No variations yet."
- Create button: fetch the primary's label-relevant fields (label field kind-aware) + existing labels (already in hand from `loadVariationList`), then ONE dynamic-client mutation:

```tsx
// Initial field sync happens SERVER-side via the *.created trigger
// (handleVariationRecordCreated) — creating with just the pointer + label is
// deliberately the whole client-side job.
await client.mutation({
  [`create${capitalize(objectName)}`]: {
    __args: {
      data: {
        [`${config.relationFieldName}Id`]: recordId,
        ...buildVariationLabelData(labelField, primaryRecord, existingLabels),
      },
    },
    id: true,
  },
});
```

  then optimistic busy state + `setTimeout(load, 1000)`. Surface mutation errors via `ErrText` (permission-denied included — see Global Constraints).
- The create button is HIDDEN (not disabled) when the widget's role is `variation` — enforced by the branch itself; additionally the server-side single-level guard (Plan 1) backstops API races. No client-side re-check needed beyond the role branch; comment that the branch IS the creation guard from the design doc.

- [ ] **Step 1: Implement.** No component-level spec (app convention); all logic already tested in Task 1.
- [ ] **Step 2: Full suite + oxlint.** **Step 3: Commit** — `feat(record-variations): widget primary role — list and create`

---

### Task 4: Variation role UI (primary link, frozen state, diverged list, re-sync)

**Files:**
- Modify: `src/front-components/variation-widget.tsx`

**Interfaces:**
- Consumes: Task 1's `loadDivergedFields`/`resyncDivergedField`, `WidgetRole['variation']` fields, `BannerWarning`/`BannerDanger` from the UI kit, Task 2's link decision.

Behavior (binding):
- Header: "Variation of <primaryLabel|'(unnamed)'>" + link/copy affordance. When `frozen`: a `BannerWarning` — `'The primary record is deleted. Fields are frozen at their last synced values; restoring the primary resumes sync automatically.'` (trashed and destroyed render the SAME banner — freeze semantics don't distinguish, per Plan 1).
- Diverged list: `loadDivergedFields` rows — field name + a per-row `SecondaryButton` "Re-sync". Empty → `HintText` `'All fields follow the primary. Edit any field on this record to diverge it.'` (that IS the feature — design doc's closing note; keep this copy).
- Re-sync click: busy state on that row → `resyncDivergedField` → `{frozen:true}` → show the frozen banner state via `load()` refresh (the role will re-resolve as frozen) and an `ErrText` `'Primary is deleted — cannot re-sync.'`; success → `setTimeout(load, 1000)`. A row-level error string renders under the row, not as a global banner.
- While `frozen`, re-sync buttons render disabled with a title tooltip (`'Primary deleted'`) — consistent with the ban on writes while frozen.

- [ ] **Step 1: Implement** (replacing Task 3's placeholder branch).
- [ ] **Step 2: Full suite + oxlint.** **Step 3: Commit** — `feat(record-variations): widget variation role — diverged fields and re-sync`

---

## Verification & handoff

- [ ] Full package suite green (baseline + Task 1's tests), oxlint clean.
- [ ] Confirm the stub-era placement still resolves: `ensureVariationTabOnObject` used the universal identifier, which is unchanged — configs created during the Plan-2-only window need NO retrofit (the tab's `frontComponentId` pointed at the runtime component whose bundle just changed). State this check's result explicitly in the final report.
- [ ] Live E2E belongs to Plan 4 — do not block this plan's completion on a dev instance.

## Self-Review

- **Spec coverage** (design doc "Widget (dual-role)" → tasks): primary role button+list (Task 3); create path via `create<Object>` + pointer + collision-numbered name, initial sync server-side (Tasks 1, 3); variation role primary-link/frozen/diverged/re-sync (Tasks 1, 4); role detection via dynamic-client pointer read (Task 1); unconfigured objects render nothing (Global Constraints + Task 1 `hidden`); native-grid badges impossible → widget is the sole surface (unchanged constraint, no work).
- **Type consistency:** `WidgetRole`/`VariationListEntry`/`DivergedField` defined once (Task 1) and consumed by name in Tasks 3–4; `resyncDivergedField` returns Plan 1's `SyncOutcome` union — no parallel outcome type.
- **Open risks flagged, not hidden:** host-object-name resolution (Task 3 defers to the formula-editor precedent — if that precedent turns out to hardcode or require config, STOP and escalate rather than inventing a mechanism); record links (Task 2 timeboxed probe with honest fallback).
