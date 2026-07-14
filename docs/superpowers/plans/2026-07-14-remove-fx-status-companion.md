# Remove FX Status Companion Field, Replace With Status Snackbar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the per-formula "FX Status" sibling SELECT field (the `<targetField>FxStatus` chip) from the formula-field app and replace it with a snackbar notification fired by the record-page Formulas widget, plus a sweep-based cleanup that removes companions already created on deployed workspaces.

**Architecture:** The OFFLINE/UPSTREAM *detection* (FormulaDefinition `status`/`statusReason`, computed by `refreshFormulaStatuses`) is untouched — only the sibling-field *presentation* layer is removed. A new pure helper decides which snackbars to fire per widget load (once per status transition, not per poll); the hourly sweep gains an idempotent cleanup pass that deactivates + hard-deletes surviving companion fields. Legacy tolerance paths (lifecycle destroy/restore, delete-completely, timeline-cleanup) keep their companion handling because companions exist in deployed workspaces until cleanup converges.

**Tech Stack:** Twenty Apps SDK (`twenty-sdk` 2.19.0, `twenty-client-sdk` 2.18.0), React remote-dom front components, vitest, oxlint. App root: `packages/twenty-apps/community/formula-field/`.

## Global Constraints

- All paths below are relative to `packages/twenty-apps/community/formula-field/` unless prefixed with `packages/`.
- Run all commands from the app root: `cd /home/sasha_shin/twenty/packages/twenty-apps/community/formula-field`.
- Test: `yarn vitest run <path>` (single file) / `yarn vitest run` (all). Lint: `yarn lint`. Typecheck: `npx tsc -p tsconfig.json --noEmit`.
- Snackbar copy must be EXACTLY as specified in Task 2 (message strings, variants `error`/`warning`, dedupeKey `formula-status-<definitionId>`).
- `companionFieldName` (`` `${targetField}FxStatus` ``) stays exported from `src/logic-functions/lib/fx-status-field.ts` — cleanup, delete-completely, lifecycle, and timeline-cleanup still use it.
- Do NOT modify `src/logic-functions/lib/handle-definition-lifecycle.ts`, `src/front-components/lib/delete-definition-completely.ts`, or `src/logic-functions/lib/timeline-cleanup.ts` (and their specs) except where a task explicitly says so — their companion handling is deliberate legacy tolerance.
- Never delete or deactivate a field unless its name is exactly `companionFieldName(targetField)` for a `targetField` taken from a FormulaDefinition record (live or trashed).
- No `package.json` version bump — versions are bumped in the deploy commit by convention.
- Repo style: named exports only, types over interfaces, `//` comments explaining WHY, no abbreviations. Follow the app's existing injected-fake test style (see `delete-definition-completely.spec.ts` / `fake-client.ts`) — no module mocking where injection works.
- Commit after each task; prefix `refactor(formula-field):`, `feat(formula-field):`, or `docs(formula-field):` as appropriate.

---

### Task 1: Stop creating, syncing, and layout-converging FX Status companions

**Files:**
- Modify: `src/logic-functions/lib/fx-status-field.ts`
- Modify: `src/logic-functions/lib/formula-status.ts`
- Modify: `src/front-components/lib/formula-setup-wizard.tsx`
- Modify: `src/front-components/formula-editor.tsx`
- Modify: `src/front-components/formula-definition-editor.tsx`
- Test: `src/logic-functions/lib/__tests__/fx-status-field.spec.ts` (update)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `src/logic-functions/lib/fx-status-field.ts` retains EXACTLY these exports (Task 3 depends on the first two): `companionFieldName(targetField: string): string`, `loadObjectFieldIndex(): Promise<Map<string, ObjectFieldIndex>>`, `type FieldInfo = { id: string; isActive: boolean }`, `type ObjectFieldIndex = { objectMetadataId: string; fields: Map<string, FieldInfo> }`, `ensureFieldLayoutVisibility`, `convergeTrashedDefinitionLayout`, `resetLayoutConvergenceThrottle`, `getLayoutConvergenceKeys`.

- [ ] **Step 1: Prune `src/logic-functions/lib/fx-status-field.ts`**

Delete these declarations entirely: `setFieldActive` (lines ~55-63), `bulkWriteCompanion` (~236-277), `syncCompanionStatusField` (~283-308), `convergeFormulaFieldLayout` (~325-368, including its doc comment). Keep everything listed under Produces above.

In `convergeTrashedDefinitionLayout`:
- Delete the two live-key clear lines and their comment (nothing writes `:true`/`:false` throttle keys anymore):
```ts
  // Drop the live-converge throttles for this field so a restore -> re-delete
  // (or delete -> restore) round trip within the TTL re-converges both ways.
  layoutConvergedAt.delete(`${objectNameSingular}.${targetField}:true`);
  layoutConvergedAt.delete(`${objectNameSingular}.${targetField}:false`);
```
- Delete the companion lookup and companion hide block:
```ts
    const companion = objectIndex.fields.get(companionFieldName(targetField));
```
and
```ts
    if (companion?.isActive) {
      await ensureFieldLayoutVisibility({
        objectMetadataId: objectIndex.objectMetadataId,
        fieldMetadataId: companion.id,
        visible: false,
      });
    }
```
- Update its doc comment: it now hides only the value field of a trashed definition (drop "AND its FX-Status companion").

Remove now-unused imports: `pluralize` (from `recompute`), `withRetry`, and the `FormulaClient`/`FormulaDefinitionRecord` types — they were used only by the deleted functions. Keep `MetadataApiClient` and `loadAllObjectsWithFields`.

Replace the file header comment (lines ~11-19) with:
```ts
// Layout plumbing for wizard-created formula value fields. Historically this
// module also owned the per-record "FX Status" companion SELECT field; ADR
// 0021 removed that in favor of a status snackbar, so what remains is the
// viewField convergence used to hide a TRASHED definition's value field, plus
// companionFieldName — still needed by the legacy-tolerance paths (lifecycle,
// delete-completely, timeline-cleanup) and the companion cleanup sweep.
```

- [ ] **Step 2: Stop companion sync in `src/logic-functions/lib/formula-status.ts`**

- Change the import at lines ~9-12 to drop `syncCompanionStatusField` and `loadObjectFieldIndex` entirely (delete the whole import from `fx-status-field` — nothing else in this file uses it).
- Delete line ~219: `const objectFieldIndex = await loadObjectFieldIndex();`
- Delete the companion sync block at ~242-251 (the comment starting "Companion sync runs on every refresh" and the whole `await syncCompanionStatusField(...)` call).
- Update the doc comment above `refreshFormulaStatuses` (~198-200): drop "and syncs the per-record FX Status companion fields", e.g.:
```ts
// Recomputes and persists every enabled formula's operational status.
// Write-avoidant; safe to call after any lifecycle event
// (delete/restore/save) and from the sweep.
```

- [ ] **Step 3: Remove companion creation from `src/front-components/lib/formula-setup-wizard.tsx`**

- Delete the `FX_STATUS_OPTIONS` constant and its comment (lines ~59-77).
- Delete the `existingCompanion` lookup (~line 486) and the `resumable` flag; simplify the collision logic to:
```tsx
  const fieldName = useMemo(() => deriveFieldName(label), [label]);
  const existingField = selectedObject?.fields.get(fieldName);
  const collision = Boolean(fieldName && existingField);
```
- Grep the file for every remaining use of `resumable` and `existingCompanion` (`grep -n "resumable\|existingCompanion" src/front-components/lib/formula-setup-wizard.tsx`). `resumable` gates an "adopt the interrupted pair" path (UI copy and/or skipping value-field creation to reuse `existingField`). Remove those branches so ANY existing field with the derived name takes the existing collision path (error message telling the user the name is taken). This is a deliberate, accepted UX change: without the companion there is no reliable provenance signal to distinguish an interrupted attempt from a user's own field, so adoption is no longer safe. Do NOT "adopt" based on `existingField` alone.
- Replace `finalizeCreation` (~lines 611-714) with this (note: `metadataClient` and `valueFieldId` params are gone — they served only the companion):
```tsx
  // Shared tail for both create paths: add the record-page tab, then write the
  // finished definition (format-specific `data`) and notify. The value field
  // itself is created by the caller (format vs mirror shapes differ).
  const finalizeCreation = useCallback(
    async ({ definitionData }: { definitionData: Record<string, unknown> }) => {
      if (!selectedObject) return;

      // Give the target object a record-page "Formulas" tab (idempotent).
      // Best-effort: a layout failure must not block the formula itself.
      try {
        await ensureFormulaTabOnObject(selectedObject.id);
      } catch {
        // The formula still works; the tab can be added on a later create.
      }

      const coreClient = new CoreApiClient();
      await coreClient.mutation({
        updateFormulaDefinition: {
          __args: { id: draft.id, data: definitionData },
          id: true,
        },
      });

      // Runtime-created fields/tabs propagate to already-open tabs only over
      // live SSE; there is no app-side metadata-invalidation API. Nudge the user
      // to refresh if the new field does not show up. Best-effort: the host may
      // not expose the snackbar bridge.
      try {
        await enqueueSnackbar({
          message:
            'Formula field created. If it does not appear in views or tabs, ' +
            'refresh the page.',
          variant: 'info',
          dedupeKey: 'formula-field-created',
        });
      } catch {
        // No host snackbar — the expression editor also shows an inline note.
      }
      onCreated();
    },
    [selectedObject, draft.id, onCreated],
  );
```
- Update BOTH `finalizeCreation` call sites (the format and mirror create paths): stop passing `metadataClient` and `valueFieldId`; the callers still create the value field themselves with their own `MetadataApiClient`.
- Remove the `ensureFieldLayoutVisibility` import (line ~7) if the wizard no longer uses it anywhere (verify with grep before removing). Keep `MetadataApiClient` if callers still use it.
- Verify: `grep -n "FxStatus\|FX_STATUS\|companion\|resumable" src/front-components/lib/formula-setup-wizard.tsx` returns nothing.

- [ ] **Step 4: Drop the live-chip convergence from both widgets**

`src/front-components/formula-editor.tsx`:
- In the import from `src/logic-functions/lib/fx-status-field` (~lines 59-62), keep only `convergeTrashedDefinitionLayout`.
- Delete the converge loop inside `load()` (~lines 366-374):
```tsx
    // Converge chip visibility/position in the record-page layout (throttled;
    // must run client-side — view mutations reject the app's server token).
    for (const definition of defs) {
      convergeFormulaFieldLayout({
        objectNameSingular: definition.targetObject,
        targetField: definition.targetField,
        statusVisible: definition.status !== '',
      });
    }
```
- Leave the trashed-definition side-channel (~lines 376-415) untouched.

`src/front-components/formula-definition-editor.tsx`:
- Delete the import at line ~25 (`convergeFormulaFieldLayout` — the file's only import from `fx-status-field`).
- Inside `load()` (~lines 369-376), delete ONLY the converge statement and its two-line comment; the enclosing `if (current?.targetObject && current?.targetField) {` block and the `refreshStaleTodayFormulas({...})` call inside it MUST stay:
```tsx
      // Converge chip visibility/position in the target object's record-page
      // layout (throttled; view mutations require this user-token context).
      convergeFormulaFieldLayout({
        objectNameSingular: current.targetObject,
        targetField: current.targetField,
        statusVisible: current.status !== '',
      });
```

- [ ] **Step 5: Update `src/logic-functions/lib/__tests__/fx-status-field.spec.ts`**

- The `describe('ensureFieldLayoutVisibility')` block is untouched.
- In `describe('convergeTrashedDefinitionLayout')`:
  - `'hides the value field and its companion when their viewField rows exist'` → rename to `'hides the value field when its viewField row exists'` and drop the companion fixture/assertions (the fake index no longer needs a `<field>FxStatus` entry; assert only the value field's viewField update).
  - `'is throttled per object.field:trashed key and clears the live-converge keys'` → the live-key clearing is gone; reduce the test to the throttle assertion only (second call within TTL makes no metadata calls) and rename to `'is throttled per object.field:trashed key'`. Remove assertions on `getLayoutConvergenceKeys()` containing/absent `:true`/`:false` keys.
  - `'is un-throttled by a live convergence, which clears the trashed key (delete -> restore round trip)'` → DELETE this test (`convergeFormulaFieldLayout` no longer exists).
  - `'does not create a viewField row...'` and `'skips inactive fields...'` → keep, dropping any companion fixtures/assertions they carry.
- Remove any imports of `convergeFormulaFieldLayout` / `syncCompanionStatusField` from the spec.

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `yarn vitest run src/logic-functions/lib/__tests__/fx-status-field.spec.ts src/logic-functions/lib/__tests__/formula-status.spec.ts src/logic-functions/lib/__tests__/handle-definition-lifecycle.spec.ts src/front-components/lib/__tests__/delete-definition-completely.spec.ts`
Expected: PASS (formula-status, lifecycle, and delete-completely specs pass unmodified).
Run: `npx tsc -p tsconfig.json --noEmit` — expected: no errors.
Run: `yarn lint` — expected: clean.
Then run the full suite once: `yarn vitest run` — expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A packages/twenty-apps/community/formula-field/src
git commit -m "refactor(formula-field): stop creating/syncing FX Status companion fields"
```

---

### Task 2: Status snackbar in the record-page Formulas widget

**Files:**
- Create: `src/front-components/lib/status-toast.ts`
- Test: `src/front-components/lib/__tests__/status-toast.spec.ts`
- Modify: `src/front-components/formula-editor.tsx`

**Interfaces:**
- Consumes: the widget's `Definition` rows in `formula-editor.tsx` `load()` — objects with `id`, `name`, `targetField`, `status`, `statusReason` (all strings); `enqueueSnackbar` from `twenty-sdk/front-component` (`{ message, variant: 'error'|'success'|'info'|'warning', dedupeKey? } → Promise<void>`, THROWS synchronously when the host bridge is absent).
- Produces: `computeStatusToasts(definitions: ToastableDefinition[], notified: Map<string, string>): StatusToast[]` — nothing downstream consumes it beyond this task.

- [ ] **Step 1: Write the failing tests**

Create `src/front-components/lib/__tests__/status-toast.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';

import { computeStatusToasts } from 'src/front-components/lib/status-toast';

const definition = (overrides: Record<string, string> = {}) => ({
  id: 'def-1',
  name: 'Score',
  targetField: 'score',
  status: 'OFFLINE',
  statusReason: 'company.revenue is deactivated',
  ...overrides,
});

describe('computeStatusToasts', () => {
  it('emits an error toast with the reason for a newly OFFLINE formula', () => {
    const toasts = computeStatusToasts([definition()], new Map());
    expect(toasts).toEqual([
      {
        message:
          'Formula "Score" is offline — company.revenue is deactivated. ' +
          'Check the Formulas tab for details.',
        variant: 'error',
        dedupeKey: 'formula-status-def-1',
      },
    ]);
  });

  it('emits a warning toast for a newly UPSTREAM formula', () => {
    const toasts = computeStatusToasts(
      [definition({ status: 'UPSTREAM', statusReason: 'score is broken' })],
      new Map(),
    );
    expect(toasts).toEqual([
      {
        message:
          'Formula "Score" has an upstream break — score is broken. ' +
          'Check the Formulas tab for details.',
        variant: 'warning',
        dedupeKey: 'formula-status-def-1',
      },
    ]);
  });

  it('falls back to the target field name and a generic reason when empty', () => {
    const toasts = computeStatusToasts(
      [definition({ name: '', statusReason: '' })],
      new Map(),
    );
    expect(toasts[0].message).toBe(
      'Formula "score" is offline — an input field is gone. ' +
        'Check the Formulas tab for details.',
    );
  });

  it('does not re-toast an unchanged status on the next pass', () => {
    const notified = new Map<string, string>();
    expect(computeStatusToasts([definition()], notified)).toHaveLength(1);
    expect(computeStatusToasts([definition()], notified)).toHaveLength(0);
  });

  it('re-toasts when the status changes OFFLINE -> UPSTREAM', () => {
    const notified = new Map<string, string>();
    computeStatusToasts([definition()], notified);
    const toasts = computeStatusToasts(
      [definition({ status: 'UPSTREAM' })],
      notified,
    );
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('warning');
  });

  it('re-toasts a formula that healed and then broke again', () => {
    const notified = new Map<string, string>();
    computeStatusToasts([definition()], notified);
    // Healed pass: no toast, bookkeeping cleared.
    expect(computeStatusToasts([definition({ status: '' })], notified))
      .toHaveLength(0);
    expect(computeStatusToasts([definition()], notified)).toHaveLength(1);
  });

  it('emits nothing for healthy definitions', () => {
    const notified = new Map<string, string>();
    expect(computeStatusToasts([definition({ status: '' })], notified))
      .toHaveLength(0);
    expect(notified.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run src/front-components/lib/__tests__/status-toast.spec.ts`
Expected: FAIL — cannot resolve `src/front-components/lib/status-toast`.

- [ ] **Step 3: Implement `src/front-components/lib/status-toast.ts`**

```ts
export type ToastableDefinition = {
  id: string;
  name: string;
  targetField: string;
  status: string;
  statusReason: string;
};

export type StatusToast = {
  message: string;
  variant: 'error' | 'warning';
  dedupeKey: string;
};

// Decides which status snackbars to fire for one widget load pass. The FX
// Status companion chip is gone (ADR 0021): a broken formula announces itself
// with a snackbar pointing at the Formulas tab instead. `notified` maps
// definition id -> the status already toasted this widget session and is
// MUTATED in place: a formula toasts when it first appears broken and again
// on every status CHANGE (OFFLINE <-> UPSTREAM, heal -> re-break) — never on
// an unchanged status, so the widget's poll loop stays quiet.
export const computeStatusToasts = (
  definitions: ToastableDefinition[],
  notified: Map<string, string>,
): StatusToast[] => {
  const toasts: StatusToast[] = [];
  const broken = new Set<string>();

  for (const definition of definitions) {
    const status = definition.status;
    if (status !== 'OFFLINE' && status !== 'UPSTREAM') continue;
    broken.add(definition.id);
    if (notified.get(definition.id) === status) continue;
    notified.set(definition.id, status);

    const label = definition.name || definition.targetField;
    toasts.push(
      status === 'OFFLINE'
        ? {
            message:
              `Formula "${label}" is offline — ` +
              `${definition.statusReason || 'an input field is gone'}. ` +
              'Check the Formulas tab for details.',
            variant: 'error',
            dedupeKey: `formula-status-${definition.id}`,
          }
        : {
            message:
              `Formula "${label}" has an upstream break — ` +
              `${
                definition.statusReason ||
                'a formula earlier in the chain is broken'
              }. ` +
              'Check the Formulas tab for details.',
            variant: 'warning',
            dedupeKey: `formula-status-${definition.id}`,
          },
    );
  }

  // Formulas that healed (or disappeared) leave the map so a later re-break
  // toasts again.
  for (const id of Array.from(notified.keys())) {
    if (!broken.has(id)) notified.delete(id);
  }

  return toasts;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run src/front-components/lib/__tests__/status-toast.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire into `src/front-components/formula-editor.tsx`**

- Change line 5 to `import { enqueueSnackbar, useRecordId } from 'twenty-sdk/front-component';`
- Add import: `import { computeStatusToasts } from 'src/front-components/lib/status-toast';`
- Add a ref next to the other refs (~line 235): 
```tsx
  // Per-definition "already toasted this status" bookkeeping for the status
  // snackbars — a ref (same pattern as refreshStateRef) so it survives polls
  // without re-rendering.
  const statusToastsRef = useRef(new Map<string, string>());
```
- Inside `load()`, immediately after the `if (!draggingRef.current) {...}` block that sets `definitions` (~line 364), where the old converge loop used to be, add:
```tsx
    // A broken formula announces itself with a snackbar (ADR 0021 — replaces
    // the FX Status companion chip). Fires on mount and on status transitions
    // only; best-effort — the host may not expose the snackbar bridge, and
    // enqueueSnackbar throws synchronously when it doesn't.
    try {
      for (const toast of computeStatusToasts(defs, statusToastsRef.current)) {
        void enqueueSnackbar(toast).catch(() => {});
      }
    } catch {
      // No host snackbar — the Formulas tab banners still show the status.
    }
```
Note `defs` (host-object definitions), NOT `allDefs` — the widget must only announce formulas on the object whose record page is open.

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `yarn vitest run` — expected: PASS.
Run: `npx tsc -p tsconfig.json --noEmit` — expected: no errors.
Run: `yarn lint` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add -A packages/twenty-apps/community/formula-field/src
git commit -m "feat(formula-field): snackbar notification for offline/upstream formulas"
```

---

### Task 3: Sweep-based cleanup of existing companion fields

**Files:**
- Create: `src/logic-functions/lib/fx-status-cleanup.ts`
- Test: `src/logic-functions/lib/__tests__/fx-status-cleanup.spec.ts`
- Modify: `src/logic-functions/formula-sweep.ts`

**Interfaces:**
- Consumes: `companionFieldName`, `loadObjectFieldIndex`, `type ObjectFieldIndex` from `src/logic-functions/lib/fx-status-field` (post-Task-1 exports); `loadTrashedFormulas` from `src/logic-functions/lib/formula-repository` (`(client, objectName?) => Promise<TrashedFormulaRecord[]>`, rows carry `targetObject`/`targetField`); `withRetry` from `src/logic-functions/lib/with-retry`; `FormulaClient` type; `MetadataApiClient` from `twenty-client-sdk/metadata`.
- Produces: `cleanupCompanionFields(client: FormulaClient, deps?: {...}): Promise<CompanionCleanupResult>` where `CompanionCleanupResult = { companions: number; deactivated: number; deleted: number; failed: number }`.

- [ ] **Step 1: Write the failing tests**

Create `src/logic-functions/lib/__tests__/fx-status-cleanup.spec.ts`. Follow the injected-fake style of `delete-definition-completely.spec.ts` (plain fake objects, no module mocking) — the deps parameter exists exactly so these tests need no `vi.mock`. Build:
- a fake core client whose `query` answers the `formulaDefinitions` selection with configurable edges (`{ node: { targetObject, targetField } }`) and answers `loadTrashedFormulas`'s query shape with configurable trashed rows (look at `loadTrashedFormulas` in `src/logic-functions/lib/formula-repository.ts` first and reuse/extend the existing `fake-client.ts` helpers if they fit);
- a fake `loadIndex` returning a hand-built `Map<string, ObjectFieldIndex>`;
- a fake metadata client recording `mutation` selections, optionally throwing on chosen calls.

Test cases (write them all with real assertions on the recorded mutations):
```ts
describe('cleanupCompanionFields', () => {
  it('deactivates then hard-deletes an active companion and counts it', ...);
  // index has companyScoreFxStatus active on company; expect updateOneField
  // {isActive:false} then deleteOneField for its id; result
  // {companions:1, deactivated:1, deleted:1, failed:0}

  it('deletes an already-inactive companion without a deactivate call', ...);
  // isActive:false in index -> only deleteOneField; deactivated:0, deleted:1

  it('is a no-op when the companion field no longer exists', ...);
  // definitions exist but index has no <field>FxStatus entry -> zero
  // mutations, companions:0

  it('cleans companions of TRASHED definitions too', ...);
  // live defs empty, one trashed row -> its companion is deleted

  it('never touches fields other than <targetField>FxStatus', ...);
  // index also carries the value field and an unrelated userNotesFxStatus
  // (no definition targets userNotes) -> neither is mutated

  it('isolates a per-field failure and keeps processing', ...);
  // two companions, deleteOneField throws for the first -> second still
  // deleted; result failed:1, deleted:1

  it('makes no metadata calls when there are no definitions', ...);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run src/logic-functions/lib/__tests__/fx-status-cleanup.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/logic-functions/lib/fx-status-cleanup.ts`**

```ts
import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { loadTrashedFormulas } from 'src/logic-functions/lib/formula-repository';
import {
  companionFieldName,
  loadObjectFieldIndex,
  type ObjectFieldIndex,
} from 'src/logic-functions/lib/fx-status-field';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

export type CompanionCleanupResult = {
  companions: number;
  deactivated: number;
  deleted: number;
  failed: number;
};

type MetadataMutationClient = { mutation: (selection: any) => Promise<any> };

// Removal of the legacy per-record "FX Status" companion fields (ADR 0021
// replaced the chip with a snackbar; the wizard no longer creates them, but
// previously-deployed workspaces still carry one per formula). Enumerates
// every definition — live (any enabled state) AND trashed, since a trashed
// definition's field pair stays active — and, for each <targetField>FxStatus
// field that still exists on its target object, deactivates it (dropping its
// viewField rows) and hard-deletes it. Values are derived state, so nothing
// user-authored is lost. Runs from the hourly sweep: idempotent (once the
// fields are gone the pass finds nothing), and each field is wrapped in its
// own try/catch so a permission or transport failure leaves that field for
// the next sweep instead of halting the pass.
export const cleanupCompanionFields = async (
  client: FormulaClient,
  deps?: {
    loadIndex?: () => Promise<Map<string, ObjectFieldIndex>>;
    metadataClient?: MetadataMutationClient;
  },
): Promise<CompanionCleanupResult> => {
  const loadIndex = deps?.loadIndex ?? loadObjectFieldIndex;

  // object nameSingular -> companion field names owned by some definition.
  const companionsByObject = new Map<string, Set<string>>();
  const add = (targetObject?: string | null, targetField?: string | null) => {
    if (!targetObject || !targetField) return;
    const names = companionsByObject.get(targetObject) ?? new Set<string>();
    names.add(companionFieldName(targetField));
    companionsByObject.set(targetObject, names);
  };

  const response = await withRetry(() =>
    client.query({
      formulaDefinitions: {
        __args: { first: 200 },
        edges: { node: { targetObject: true, targetField: true } },
      },
    }),
  );
  for (const edge of response?.formulaDefinitions?.edges ?? []) {
    add(edge?.node?.targetObject, edge?.node?.targetField);
  }
  for (const trashed of await loadTrashedFormulas(client)) {
    add(trashed.targetObject, trashed.targetField);
  }

  const result: CompanionCleanupResult = {
    companions: 0,
    deactivated: 0,
    deleted: 0,
    failed: 0,
  };
  if (companionsByObject.size === 0) return result;

  const index = await loadIndex();
  const metadata = deps?.metadataClient ?? new MetadataApiClient();

  for (const [objectName, names] of companionsByObject) {
    const objectIndex = index.get(objectName);
    if (!objectIndex) continue;
    for (const name of names) {
      const field = objectIndex.fields.get(name);
      if (!field) continue;
      result.companions += 1;
      try {
        // Deactivate first so the column leaves every view cleanly (same
        // order as delete-definition-completely).
        if (field.isActive) {
          await metadata.mutation({
            updateOneField: {
              __args: { input: { id: field.id, update: { isActive: false } } },
              id: true,
            },
          });
          result.deactivated += 1;
        }
        await metadata.mutation({
          deleteOneField: {
            __args: { input: { id: field.id } },
            id: true,
          },
        });
        result.deleted += 1;
      } catch {
        // Left for the next sweep; a deactivated-but-not-deleted companion is
        // already out of every view.
        result.failed += 1;
      }
    }
  }

  return result;
};
```
(If `loadTrashedFormulas` requires a different call shape than `(client)`, adapt to its actual signature — read it first.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run src/logic-functions/lib/__tests__/fx-status-cleanup.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `src/logic-functions/formula-sweep.ts`**

- Add import: `import { cleanupCompanionFields } from 'src/logic-functions/lib/fx-status-cleanup';`
- After the `const statusResult = await refreshFormulaStatuses(client);` line, add:
```ts
  // Legacy FX Status companion removal (ADR 0021) — no-op once converged.
  const companionCleanup = await cleanupCompanionFields(client);
```
- Add `companionCleanup,` to the returned object.
- Update the stale half of the comment above `refreshFormulaStatuses` (it says "converges companions too" — it no longer does).

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `yarn vitest run` — expected: PASS.
Run: `npx tsc -p tsconfig.json --noEmit` — expected: no errors.
Run: `yarn lint` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add -A packages/twenty-apps/community/formula-field/src
git commit -m "feat(formula-field): sweep cleanup deletes legacy FX Status companion fields"
```

---

### Task 4: Documentation

**Files:**
- Create: `docs/adr/0021-replace-fx-status-companion-with-snackbar.md`
- Modify: `docs/adr/README.md` (index), `docs/adr/0009-definition-lifecycle-and-operational-status.md` (append amendment), `README.md`, `context.md`

**Interfaces:** none — prose only. Do NOT modify any code in this task.

- [ ] **Step 1: Write ADR 0021**

Match the existing ADR format (read `docs/adr/0009-...md` and `docs/adr/0020-...md` for the house style). Content to cover (write real prose, dated 2026-07-14):
- **Context:** the FX Status companion SELECT (`<targetField>FxStatus`, ADR 0009) cluttered the record-page Fields card — one extra system field per formula — and needed constant layout convergence (viewField group/position/visibility) plus per-record value syncing.
- **Decision:** (1) the wizard no longer creates companions (with the side effect that the "adopt an interrupted pair" resume path is gone — an existing field with the derived name is now always a collision); (2) `refreshFormulaStatuses` no longer syncs chip values; (3) the record-page Formulas widget fires an `enqueueSnackbar` toast on mount/status-transition instead ("Formula "X" is offline — <reason>. Check the Formulas tab for details.", `error` for OFFLINE / `warning` for UPSTREAM, dedupeKey per definition); (4) the hourly sweep deactivates + hard-deletes surviving companions on deployed workspaces (idempotent, per-field failure isolation, values are derived so nothing user-authored is lost).
- **Consequences / risks:** passive signal now requires a record page of the affected object to be opened (widget mount) — no signal from list views; on already-deployed workspaces stale chips can linger up to ~1 hour until the sweep's cleanup pass runs; if `deleteOneField` is ever denied to the app token, companions stay deactivated (out of all views) and retry next sweep; lifecycle/delete-completely/timeline-cleanup keep companion handling as legacy tolerance until real-world installs converge.
- **What stays:** OFFLINE/UPSTREAM detection (`status`/`statusReason` on FormulaDefinition), the in-widget banners, `companionFieldName`.

- [ ] **Step 2: Update the other docs**

- `docs/adr/README.md`: add the 0021 index line; annotate the 0009 line with "(FX Status companion superseded by 0021)".
- `docs/adr/0009-...md`: APPEND a short "Superseded in part (2026-07-14)" section pointing at 0021 — never rewrite existing ADR body text.
- `README.md`: rewrite the FX Status mentions — feature bullet (~line 52), architecture diagram box (~line 357), the "FX Status companions + layout convergence" subsection (~400-407), Limitations (~417), and the "FX Status chips written but not visible" operational situation (~493-496) — to describe the snackbar behavior and the sweep cleanup instead.
- `context.md`: add a dated entry to the current-status section summarizing the arc (companion removed, snackbar added, sweep cleanup, resume-path removal); do not delete the historical "FX Status chip rendering — RESOLVED" section (history stays), but add a one-line pointer that ADR 0021 removed the chip.

- [ ] **Step 3: Verify and commit**

Verify: `grep -rn "FX Status" README.md | grep -v -i "snackbar\|removed\|legacy\|0021\|superseded"` — review any hits; remaining ones must be historical references only.
```bash
git add packages/twenty-apps/community/formula-field/docs packages/twenty-apps/community/formula-field/README.md packages/twenty-apps/community/formula-field/context.md
git commit -m "docs(formula-field): ADR 0021 — FX Status companion replaced by status snackbar"
```

---

## Out of Scope

- Version bump + cloud deploy (done in a separate deploy commit by convention; note the SDK-version-match requirement for cloud deploys).
- Live end-to-end verification against a running server (offer after the branch review).
- Any signal surface outside the record page (e.g. list views) — the widget is the only mount point the app has.
