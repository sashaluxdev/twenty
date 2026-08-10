# v0.4.0 — Create-Time Override Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship formula-field v0.4.0: five deferred fixes (Phase 0), the create-time override lock Feature A′ (Phases 1–2), the quiet empty-expression state Feature B (Phase 3), and docs/version finalize (Phase 4).

**Architecture:** A new immutable `allowOverride` BOOLEAN on FormulaDefinition (manifest-declared `isUIEditable: false`) drives: wizard-created value fields born `isUIEditable: false`, override detection skipped, pins ignored, outside writes reverted through the existing Case 1 recompute lane, and locked targets excluded from the variation syncable set. Feature B ports the definition editor's `awaitingExpression` guard to the record-tab rows via an extracted pure helper.

**Tech Stack:** Twenty Apps SDK app (TypeScript, genql-style dynamic client, styled-components archetypes in `ui.tsx`). Tests: Vitest + in-repo `FakeClient` (NO Jest, NO React render tests — the house pattern extracts logic into `lib/` functions and tests those).

**Spec:** `docs/superpowers/specs/2026-08-07-v040-build-and-roadmap-design.md` (repo root `docs/`). Open items resolved by this plan: §9.3 → align variation lane to the formula lane (diff fallback + vacuous-true on empty); §9.4 → new wizard step "5 · Overrides"; §9.5 → both halves (inert cosmetic fields AND a no-targetField early return).

## Global Constraints

- **App root:** `packages/twenty-apps/community/formula-field`. Every path below is relative to it unless it starts with `docs/superpowers`.
- **Test invocation (verified — `yarn vitest run` from the app root FAILS, the app is not a yarn workspace):** from the REPO root, `node_modules/.bin/vitest run --root packages/twenty-apps/community/formula-field [file]`. Baseline **67 files / 1209 passing tests**; the suite must be green at every commit. Lint from the app root: `npx oxlint -c .oxlintrc.json .`.
- **Front-lane verification:** the app has NO typecheck script, and oxlint runs with `categories.correctness: "off"` and no react plugin — every task touching a `.tsx` file MUST also run `npx tsc --noEmit` from the app root; lint alone catches neither type errors nor stale hook deps.
- **Every read of `allowOverride` uses `?? true`** — null/absent (legacy rows, unwidened selections) means "overrides allowed". Server-side filter for locked rows is `allowOverride: { eq: false }` (BooleanFilter is `{eq, is}` only; `eq` never matches null — correct here since locked rows always carry an explicit `false`).
- **`allowOverride` universalIdentifier is fixed:** `436befd0-e824-4d85-a79f-2b02460c43e3`. Do not regenerate.
- **House event convention:** absent/empty `updatedFields` ⇒ treat as affected (recompute is write-avoidant). Do not "fix" this.
- Code style: named exports, no `any`, no enums, `isDefined()`-style helpers from twenty-shared where applicable, comments ONLY as short `//` "why" lines matching the density of the surrounding code. Imports use absolute `src/...` specifiers (house style).
- Commits: conventional-commit style, one per task, **no signatures/footers/co-author lines**.
- **Do not** touch `updateOneField` behavior, stored `lastError` semantics, or save-validation — all explicitly out of scope per spec §3/§10.

## File Structure

**Created:**
- `src/front-components/lib/row-status.ts` — pure row-status resolver + shared awaiting-hint string (Feature B)
- `src/front-components/lib/__tests__/row-status.spec.ts`
- `src/objects/__tests__/formula-definition-object.spec.ts` — manifest-shape assertions (A′-I2)
- `docs/adr/0028-create-time-override-lock.md`

**Modified (server lane):** `src/logic-functions/lib/recompute.ts`, `handle-record-update.ts`, `handle-formula-change.ts`, `handle-variation-config-change.ts`, `src/logic-functions/on-variation-config-updated.ts`, `override-repository.ts`, `formula-repository.ts`, `syncable-fields.ts`, `types.ts`, `src/objects/formula-definition.object.ts`

**Modified (front lane):** `src/front-components/lib/formula-setup-wizard.tsx`, `src/front-components/formula-editor.tsx`, `src/front-components/formula-definition-editor.tsx`

**Modified (tests/docs):** `src/logic-functions/lib/__tests__/handlers.spec.ts`, `handle-variation-config-change.spec.ts`, `syncable-fields.spec.ts`, `override-repository-active-fields.spec.ts`, `package.json`, `README.md`, `context.md` (app root — NOT `docs/context.md`)

---

## Phase 0 — deferred-fix sweep

### Task 1: Blank-target skip in override detection (item 0.3)

Sequenced first: it edits the same skip block Feature A′ extends (Task 6).

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts:367-370` (add `export`)
- Modify: `src/logic-functions/lib/handle-record-update.ts:276-282` (skip block)
- Test: `src/logic-functions/lib/__tests__/handlers.spec.ts`

**Interfaces:**
- Produces: `export const blankTargetTypeError = (formula: FormulaDefinitionRecord): string | null` from `recompute.ts` (function already exists module-private at :367; only the `export` keyword is new).

**Context:** `computeFormulaValueForRecord` (recompute.ts:486) lacks the blank-target guard its siblings `recomputeForRecord` (:902) and `recomputeAllRecords` (:1013) have, and `targetFieldKind('')` falls through to `'NUMBER'` (value-io.ts:44-48). So a human edit on a definition whose `targetFieldType` is blank computes a junk-kind "fresh" value and pins a junk override. Fix home (per spec §4 item 0.3): the per-definition skip block in the detection loop.

- [ ] **Step 1: Write the failing test** — in `handlers.spec.ts`, inside `describe('handleRecordUpdate (event-driven recompute)')` (line 933; its `beforeEach` seeds definition `f1` targeting `formulaScore` — use a distinct field so `f1` stays disengaged):

```ts
it('does not pin an override when targetFieldType is blank (item 0.3)', async () => {
  client.seed('formulaDefinition', [
    {
      id: 'f-blank',
      targetObject: 'opportunity',
      targetField: 'blankScore',
      targetFieldType: '',
      expression: 'formulaInputA + 1',
      enabled: true,
    },
  ]);
  client.seed('opportunity', [{ id: 'o1', formulaInputA: 2, blankScore: 999 }]);

  await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', formulaInputA: 2, blankScore: 999 },
    updatedFields: ['blankScore'],
    actorWorkspaceMemberId: 'member-1',
  });

  expect(
    client.mutationSelections.some(
      (selection) => 'createFormulaOverride' in selection,
    ),
  ).toBe(false);
  expect(client.writes).toHaveLength(0);
});
```

(If `client.seed` on `formulaDefinition` replaces rather than appends the `beforeEach` rows, the test still holds — check FakeClient's `seed` and adjust the mutation-key assertion to however override creates actually appear in `mutationSelections`; the FakeClient header comment documents the mutation shape.)

- [ ] **Step 2: Run it, verify it fails** — `yarn vitest run src/logic-functions/lib/__tests__/handlers.spec.ts` → the new test FAILS (an override create IS issued today).

- [ ] **Step 3: Implement** — in `recompute.ts:367` add `export` before `const blankTargetTypeError`. In `handle-record-update.ts`, extend the existing import from `src/logic-functions/lib/recompute` with `blankTargetTypeError`, and append to the skip block (after the `gateErrorByFormulaId.has(formula.id)` skip at :281):

```ts
      // Blank targetFieldType: kinds are unknowable ('' reads as NUMBER), so a
      // human edit must never pin a junk-kind override (F2's event-path sibling).
      if (blankTargetTypeError(formula) !== null) continue;
```

- [ ] **Step 4: Run tests** — same file green, then `yarn vitest run src/logic-functions/lib/__tests__/recompute.spec.ts` (export change is behavior-neutral).

- [ ] **Step 5: Commit** — `fix(formula-field): skip override detection for blank-target definitions`

---

### Task 2: Variation-config lane — platform-managed guard, `before` threading, empty-`updatedFields` alignment (item 0.1)

**Files:**
- Modify: `src/logic-functions/lib/handle-formula-change.ts:41-47` area (add `export` ×2)
- Modify: `src/logic-functions/lib/handle-variation-config-change.ts:14-47`
- Modify: `src/logic-functions/on-variation-config-updated.ts:14-29`
- Test: `src/logic-functions/lib/__tests__/handle-variation-config-change.spec.ts`

**Interfaces:**
- Consumes/Produces: `export const resolveChangedFields` and `export const PLATFORM_MANAGED_FIELDS` from `handle-formula-change.ts` (both already exist module-private; `resolveChangedFields(updatedFields, before, after)` is called at handle-formula-change.ts:111 — export as-is, do not change its signature).
- Produces: `HandleVariationConfigChangeArgs` gains `before?: VariationConfigRecord | null | undefined`.

**Context:** The variation lane's `BOOKKEEPING_FIELDS` (handle-variation-config-change.ts:14-19) omits `position`/`updatedAt`/`createdAt`/`createdBy`/`searchVector`, so every platform drag-reorder runs full validation (same defect class as F3). It also has no `before` row-image fallback, and its empty-`updatedFields` semantics diverge from the formula lane. **§9.3 ruling (this plan):** align to the formula lane — `changedFields = resolveChangedFields(updatedFields, before, after)`; defined-but-empty ⇒ vacuous-true ⇒ skip (a platform event that names zero changed fields is a no-op write); `undefined` with no `before` still falls through to validation (unchanged safety).

- [ ] **Step 1: Write the failing tests** — in `handle-variation-config-change.spec.ts` (reuse that file's existing fixture shape for VariationConfig rows — read its top before writing):

```ts
it('ignores a platform position write (item 0.1)', async () => {
  const client = new FakeClient();
  const result = await handleVariationConfigChange({
    client,
    after: { id: 'vc1', targetObject: 'company' } as VariationConfigRecord,
    updatedFields: ['position'],
  });
  expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
  expect(client.mutations).toBe(0);
});

it('falls back to a before/after diff when updatedFields is missing', async () => {
  const client = new FakeClient();
  const result = await handleVariationConfigChange({
    client,
    after: { id: 'vc1', targetObject: 'company', position: 2 } as VariationConfigRecord,
    before: { id: 'vc1', targetObject: 'company', position: 1 } as VariationConfigRecord,
    updatedFields: undefined,
  });
  expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
  expect(client.mutations).toBe(0);
});
```

- [ ] **Step 2: Run, verify both fail** — `yarn vitest run src/logic-functions/lib/__tests__/handle-variation-config-change.spec.ts` (today: `position` is not ignorable, and there is no `before` arg — the second test should fail to compile or fail at runtime).

- [ ] **Step 3: Implement**
  1. `handle-formula-change.ts`: add `export` to `PLATFORM_MANAGED_FIELDS` (:41) and to `resolveChangedFields`.
  2. `handle-variation-config-change.ts`: import both; add `before` to `HandleVariationConfigChangeArgs`; replace the direct `isPureBookkeepingUpdate(updatedFields)` call with:

```ts
  // Aligned with the formula lane (spec §9.3): platform row images fill in when
  // the event names no fields; a defined-but-empty list is a no-op write.
  const changedFields = resolveChangedFields(updatedFields, before, after);
  if (isPureBookkeepingUpdate(changedFields)) {
    return { handled: false, reason: 'bookkeeping-only' };
  }
```

  and align the local `isPureBookkeepingUpdate` (:21-26) to the formula lane's shape:

```ts
const isPureBookkeepingUpdate = (
  updatedFields: string[] | undefined,
): boolean => {
  if (!updatedFields) {
    return false;
  }
  return updatedFields.every(
    (field) =>
      BOOKKEEPING_FIELDS.has(field) || PLATFORM_MANAGED_FIELDS.has(field),
  );
};
```

  3. `on-variation-config-updated.ts`: destructure `before` alongside `after, updatedFields` from `payload.properties` and pass it through (cast the same way `after` is cast).
  4. Consistency: the later branch at `handle-variation-config-change.ts:52-59` re-reads raw `updatedFields` — switch it to the new `changedFields` so both guards see the same view of the event.

- [ ] **Step 4: Run tests** — that spec file green, plus `yarn vitest run src/logic-functions/lib/__tests__/handlers.spec.ts` (the exports must not disturb the formula lane).

- [ ] **Step 5: Commit** — `fix(formula-field): ignore platform-managed writes in the variation-config lane`

---

### Task 3: Definition-lane inert fields + draft early-return + Date note (items 0.2, 0.5, §9.5)

**Files:**
- Modify: `src/logic-functions/lib/handle-formula-change.ts`
- Test: `src/logic-functions/lib/__tests__/handlers.spec.ts`

**Interfaces:**
- Produces: module-private `INERT_FIELDS: Set<string>` in `handle-formula-change.ts`, initially `['name', 'description']` (Task 5 appends `'allowOverride'`). `isIgnorableField` must consult it.

**Context:** Each description tick from the definition editor (800ms debounce, formula-definition-editor.tsx:313-330) currently costs full validation + `recomputeAllRecords`. And every wizard draft write (`persistDraft` fires per selection click, formula-setup-wizard.tsx:187-200) runs `validateFormula` on an empty expression, a disable+lastError bookkeeping write, and a workspace-wide `refreshFormulaStatuses` (:183-202). **§9.5 ruling (this plan): do both halves.** Note there is NO name-field debounce in the definition editor (name is wizard-only) — `name` joins the set for wizard label ticks and API renames.

- [ ] **Step 1: Write the failing tests** — in `handlers.spec.ts` inside `describe('handleFormulaChange (save-time validation)')` (line 29):

```ts
it('treats a description-only update as inert (item 0.2)', async () => {
  const def: FormulaDefinitionRecord = {
    id: 'f1',
    targetObject: 'opportunity',
    targetField: 'formulaScore',
    targetFieldType: 'NUMBER',
    expression: 'formulaInputA + 1',
    enabled: true,
  };
  client.seed('formulaDefinition', [def]);

  const result = await handleFormulaChange({
    client,
    after: { ...def, description: 'now with prose' },
    updatedFields: ['description'],
  });

  expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
  expect(client.mutations).toBe(0);
  expect(client.writes).toHaveLength(0);
});

it('disables and skips wizard drafts that have no targetField yet (spec §9.5)', async () => {
  client.seed('formulaDefinition', [
    { id: 'draft-1', targetObject: 'company', targetField: '', expression: '', enabled: true },
  ]);

  const result = await handleFormulaChange({
    client,
    after: { id: 'draft-1', targetObject: 'company', targetField: '', expression: '', enabled: true },
    updatedFields: ['targetObject'],
  });

  expect(result).toEqual({ handled: false, reason: 'no-target-field' });
  // Exactly one write — enabled:false, keeping the draft out of the sweep's
  // enabled set. No lastError junk, no validation queries, no status refresh.
  expect(client.queries).toBe(0);
  expect(client.mutations).toBe(1);
  expect(client.get('formulaDefinition', 'draft-1')).toMatchObject({
    enabled: false,
  });
  expect(client.get('formulaDefinition', 'draft-1')!.lastError ?? '').toBe('');
});

it('a later draft tick on the now-disabled draft costs nothing', async () => {
  // Pins pre-existing behavior: once disabled, the disabled guard exits before
  // the early return, so the disable write above happens exactly once.
  client.seed('formulaDefinition', [
    { id: 'draft-1', targetObject: 'company', targetField: '', expression: '', enabled: false },
  ]);

  const result = await handleFormulaChange({
    client,
    after: { id: 'draft-1', targetObject: 'opportunity', targetField: '', expression: '', enabled: false },
    updatedFields: ['targetObject'],
  });

  expect(result).toEqual({ handled: false, reason: 'disabled' });
  expect(client.mutations).toBe(0);
  expect(client.queries).toBe(0);
});
```

- [ ] **Step 2: Run, verify both fail** — first returns a validation result and writes bookkeeping; second runs validation (queries > 0).

- [ ] **Step 3: Implement** — in `handle-formula-change.ts`:
  1. Below `PLATFORM_MANAGED_FIELDS` (:47):

```ts
// Cosmetic/immutable definition fields the engine never reads: renames and
// description edits must not trigger validation or recompute (item 0.2).
const INERT_FIELDS = new Set(['name', 'description']);
```

  2. Extend `isIgnorableField` with `|| INERT_FIELDS.has(field)`.
  3. After the disabled guard (:139-141), before any client loads. CRITICAL (review finding 2): a bare early return would leave abandoned drafts `enabled: true` forever (`enabled` defaults true, and today's validation is what disables them) — `loadAllEnabledFormulas` would then feed them to the hourly sweep, whose `blankTargetTypeError` guard does NOT cover `targetField: ''`, buying a full target-object scan per abandoned draft per hour. So the early return must ALSO drop the flag, write-avoidantly:

```ts
  // Wizard drafts have no targetField until finalizeCreation: nothing is
  // validatable yet, and validating would disable the draft with lastError
  // junk plus a workspace-wide status refresh on every draft tick (item 0.2 /
  // A'-M1). The draft still must not stay in the enabled set — the hourly
  // sweep would full-scan its target object otherwise. No status refresh
  // needed: a definition without a targetField cannot be anyone's dependency.
  if ((after.targetField ?? '') === '') {
    if (after.enabled !== false) {
      await updateFormulaBookkeeping(client, after.id, { enabled: false });
    }
    return { handled: false, reason: 'no-target-field' };
  }
```

  (`updateFormulaBookkeeping` is already imported in this file — it powers the invalid branch at :195. The disable write's own echo event exits at the disabled-bookkeeping guard: enabled-only change on a disabled row.)

  4. Item 0.5, comment only, at the `deepJsonEqual` diff call (~:85):

```ts
  // deepJsonEqual compares JSON shapes; event payloads arrive JSON-serialized,
  // so Date instances never reach it — a live Date here would diff wrongly.
```

- [ ] **Step 4: Run tests** — `yarn vitest run src/logic-functions/lib/__tests__/handlers.spec.ts` green, then the full suite `yarn test` (the early return could mask cases other specs rely on — e.g. `validateFormula`'s own `targetField is required` rejection path; if a test asserted that post-save rejection, it now must go through `save-validation.ts` directly, and the assertion belongs there).

- [ ] **Step 5: Commit** — `perf(formula-field): inert cosmetic fields and draft early-return in the definition lane`

---

### Task 4: Override re-pin churn normalization (item 0.4)

**Files:**
- Modify: `src/logic-functions/lib/override-repository.ts:203-222`
- Test: `src/logic-functions/lib/__tests__/override-repository-active-fields.spec.ts`

**Context:** The existing-row compare uses strict `!==` on `overrideValueText`, but a TEXT column round-trips SQL NULL as `''` on some read paths — a stored `''` vs computed `null` forces one redundant write per re-pin (bounded, cannot loop). Normalize like F4 did for the heartbeat (`formula-repository.ts:354-355` has the precedent shape).

- [ ] **Step 1: Write the failing test** — construct the 5th argument with the same slot helper `handle-record-update.ts:396` uses (`overrideSlotForKind` — check its export location and the slot's field names in `override-repository.ts` before writing; adjust the literal below to the real slot shape):

```ts
it('does not rewrite an identical pin whose text slot round-tripped as empty string (item 0.4)', async () => {
  const client = new FakeClient();
  // findOverride matches ONLY on the deterministic name key
  // (override-repository.ts:27-31) — omit it and the CREATE branch runs.
  client.seed('formulaOverride', [
    {
      id: 'ov1',
      name: 'opportunity.formulaScore#o1',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      recordId: 'o1',
      overrideValue: 5,
      overrideValueText: '',
      active: true,
    },
  ]);

  await upsertOverride(
    client,
    'opportunity',
    'formulaScore',
    'o1',
    overrideSlotForKind('NUMBER', 5),
  );

  expect(client.mutations).toBe(0);
});
```

- [ ] **Step 2: Run, verify it fails** — today the `''` vs `null` mismatch forces an `updateFormulaOverride` mutation.

- [ ] **Step 3: Implement** — in `override-repository.ts`, add a local helper above the upsert and use it on both sides of the compare AND in the written data:

```ts
// TEXT round-trips SQL NULL as '' on some read paths; both mean "no text".
const normalizedText = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : value;
```

```ts
    const nextValueText = normalizedText(overrideValueText);
    if (
      existing.overrideValue !== overrideValue ||
      normalizedText(existing.overrideValueText) !== nextValueText ||
      existing.active !== true
    ) {
      // ... existing withRetry(...) with data: { overrideValue, overrideValueText: nextValueText, active: true }
    }
```

- [ ] **Step 4: Run tests** — that spec file plus `yarn vitest run src/logic-functions/lib/__tests__/handlers.spec.ts` and the variation-sync specs (`variation-sync-divergence.spec.ts` calls into the same upsert).

- [ ] **Step 5: Commit** — `fix(formula-field): normalize text slot compare on override re-pin`

---

## Phase 1 — Feature A′ server lane

### Task 5: `allowOverride` data model + server projections + manifest test

**Files:**
- Modify: `src/objects/formula-definition.object.ts` (FORMULA_DEFINITION_FIELDS map at :12-33; field entries array — insert after the `enabled` entry at :120-128)
- Modify: `src/logic-functions/lib/types.ts` (`FormulaDefinitionRecord`)
- Modify: `src/logic-functions/lib/formula-repository.ts:13-31` (`FORMULA_FIELDS`)
- Modify: `src/logic-functions/lib/handle-formula-change.ts` (`INERT_FIELDS` from Task 3)
- Create: `src/objects/__tests__/formula-definition-object.spec.ts`
- Test: also `src/logic-functions/lib/__tests__/handlers.spec.ts` (projection contents)

**Interfaces:**
- Produces: `FormulaDefinitionRecord.allowOverride?: boolean | null` — every later task reads it with `?? true`.
- Produces: `allowOverride` selected by every `FORMULA_FIELDS`-based load (so `handle-record-update` and `syncable-fields` see it without further changes).

- [ ] **Step 1: Write the failing tests**

New `src/objects/__tests__/formula-definition-object.spec.ts` — the module's manifest is a DEFAULT export (the SDK's `defineObject` returns a validation result; the entries live under `.config.fields`):

```ts
import { describe, expect, it } from 'vitest';

import formulaDefinitionObject, {
  FORMULA_DEFINITION_FIELDS,
} from 'src/objects/formula-definition.object';

describe('allowOverride manifest declaration (A-prime I2)', () => {
  it('is BOOLEAN, defaults true, and is not UI-editable', () => {
    const field = formulaDefinitionObject.config.fields.find(
      (candidate) => candidate.name === 'allowOverride',
    );
    expect(field).toMatchObject({
      universalIdentifier: FORMULA_DEFINITION_FIELDS.allowOverride,
      name: 'allowOverride',
      defaultValue: true,
      isUIEditable: false,
    });
    expect(FORMULA_DEFINITION_FIELDS.allowOverride).toBe(
      '436befd0-e824-4d85-a79f-2b02460c43e3',
    );
  });
});
```

In `handlers.spec.ts` (projection CONTENTS, not just values — spec §2.3.4):

```ts
it('selects allowOverride on definition loads (projection contents)', async () => {
  const client = new FakeClient();
  await loadEnabledFormulas(client);
  const selection = client.querySelections.find(
    (candidate) => 'formulaDefinitions' in candidate,
  );
  expect(selection.formulaDefinitions.edges.node.allowOverride).toBe(true);
});
```

(`loadEnabledFormulas` is exported from `src/logic-functions/lib/formula-repository`; if `querySelections` nests differently, mirror how an existing selection-assertion test reads it — `scan-selection.spec.ts` is the precedent.)

Also in `handlers.spec.ts` (spec §2.3: a wizard write of the flag must not trigger validation or recompute):

```ts
it('treats an allowOverride-only update as inert (spec §2.3)', async () => {
  const def: FormulaDefinitionRecord = {
    id: 'f1',
    targetObject: 'opportunity',
    targetField: 'formulaScore',
    targetFieldType: 'NUMBER',
    expression: 'formulaInputA + 1',
    enabled: true,
  };
  client.seed('formulaDefinition', [def]);

  const result = await handleFormulaChange({
    client,
    after: { ...def, allowOverride: false },
    updatedFields: ['allowOverride'],
  });

  expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
  expect(client.mutations).toBe(0);
});
```

- [ ] **Step 2: Run, verify both fail.**

- [ ] **Step 3: Implement**
  1. `FORMULA_DEFINITION_FIELDS`: add `allowOverride: '436befd0-e824-4d85-a79f-2b02460c43e3',` after the `enabled` line.
  2. Field entry, inserted directly after the `enabled` entry:

```ts
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.allowOverride,
      type: FieldType.BOOLEAN,
      name: 'allowOverride',
      label: 'Allow overrides',
      description:
        'Create-time choice (ADR 0028): when false, the value field was ' +
        'created view-only and manual overrides are never honored. ' +
        'Permanent — the platform cannot make a field editable after creation.',
      icon: 'IconLock',
      defaultValue: true,
      isUIEditable: false,
    },
```

  3. `types.ts`, after `enabled`:

```ts
  // Create-time override lock (ADR 0028): false = value field born view-only,
  // overrides never honored. Immutable after creation; null (legacy rows and
  // unwidened selections) must read as true (`?? true`) everywhere.
  allowOverride?: boolean | null;
```

  4. `FORMULA_FIELDS` (formula-repository.ts): add `allowOverride: true,` after `enabled: true,`.
  5. `INERT_FIELDS` (handle-formula-change.ts): add `'allowOverride'` with trailing note in the set's comment: immutable after create; the definition lane never reacts to it (spec §2.3).

- [ ] **Step 4: Run tests** — both new tests green; `yarn test` full suite (the manifest gained a field — `app-install` integration config is NOT run here, but object-shape specs like `fx-status-field.spec.ts` might assert field counts; fix any that hardcode the field list).

- [ ] **Step 5: Commit** — `feat(formula-field): allowOverride flag on FormulaDefinition`

---

### Task 6: Detection skip + respect-fork guard for locked definitions

**Files:**
- Modify: `src/logic-functions/lib/handle-record-update.ts` (skip block :276-282 area; respect fork :448)
- Test: `src/logic-functions/lib/__tests__/handlers.spec.ts`

**Interfaces:**
- Consumes: `formula.allowOverride` (Task 5). No new exports.

- [ ] **Step 1: Write the failing tests** — in the `handleRecordUpdate` describe:

```ts
it('locked definition: a human edit does not pin an override (engine lane)', async () => {
  client.seed('formulaDefinition', [
    {
      id: 'f-locked',
      targetObject: 'opportunity',
      targetField: 'lockedScore',
      targetFieldType: 'NUMBER',
      expression: 'formulaInputA + 1',
      enabled: true,
      allowOverride: false,
    },
  ]);
  client.seed('opportunity', [{ id: 'o1', formulaInputA: 2, lockedScore: 999 }]);

  await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', formulaInputA: 2, lockedScore: 999 },
    updatedFields: ['lockedScore'],
    actorWorkspaceMemberId: 'member-1',
  });

  expect(
    client.mutationSelections.some((s) => 'createFormulaOverride' in s),
  ).toBe(false);
});

it('locked definition: a human edit does not pin an override (mirror lane)', async () => {
  // Mirror = bare same-record field ref onto a non-engine kind (fixture shape
  // from mirror-target.spec.ts's mirrorFormula helper).
  client.setFieldKinds('opportunity', {
    sourceField: 'SELECT',
    mirrorField: 'SELECT',
  });
  client.seed('formulaDefinition', [
    {
      id: 'f-mirror',
      targetObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'SELECT',
      expression: 'sourceField',
      enabled: true,
      allowOverride: false,
    },
  ]);
  client.seed('opportunity', [{ id: 'o1', sourceField: 'A', mirrorField: 'B' }]);

  await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', sourceField: 'A', mirrorField: 'B' },
    updatedFields: ['mirrorField'],
    actorWorkspaceMemberId: 'member-1',
  });

  expect(
    client.mutationSelections.some((s) => 'createFormulaOverride' in s),
  ).toBe(false);
});

it('locked definition: an active rogue pin is ignored on recompute', async () => {
  client.seed('formulaDefinition', [
    {
      id: 'f-locked',
      targetObject: 'opportunity',
      targetField: 'lockedScore',
      targetFieldType: 'NUMBER',
      expression: 'formulaInputA + 1',
      enabled: true,
      allowOverride: false,
    },
  ]);
  client.seed('formulaOverride', [
    {
      id: 'ov1',
      name: 'opportunity.lockedScore#o1',
      targetObject: 'opportunity',
      targetField: 'lockedScore',
      recordId: 'o1',
      overrideValue: 999,
      active: true,
    },
  ]);
  client.seed('opportunity', [{ id: 'o1', formulaInputA: 2, lockedScore: 999 }]);

  await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', formulaInputA: 2, lockedScore: 999 },
    updatedFields: ['formulaInputA'],
    actorWorkspaceMemberId: 'member-1',
  });

  expect(client.get('opportunity', 'o1')!.lockedScore).toBe(3);
});

it('legacy rows (allowOverride unset) still honor pins', async () => {
  // beforeEach's f1 has no allowOverride key — seed an active pin on
  // formulaScore for o1, update formulaInputA, and assert formulaScore keeps
  // the pinned value (the ?? true read).
  client.seed('formulaOverride', [
    {
      id: 'ov1',
      name: 'opportunity.formulaScore#o1',
      targetObject: 'opportunity',
      targetField: 'formulaScore',
      recordId: 'o1',
      overrideValue: 999,
      active: true,
    },
  ]);
  client.seed('opportunity', [
    { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 999 },
  ]);

  await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 999 },
    updatedFields: ['formulaInputA'],
    actorWorkspaceMemberId: 'member-1',
  });

  expect(client.get('opportunity', 'o1')!.formulaScore).toBe(999);
});
```

- [ ] **Step 2: Run, verify the three concrete tests fail** (engine-lane no-pin, rogue-pin-ignored, legacy is expected to PASS already — it documents the `?? true` contract and guards Step 3's edit).

- [ ] **Step 3: Implement** — two edits in `handle-record-update.ts`:
  1. Skip block (after Task 1's blank-target line):

```ts
      // Locked at creation: a locked definition never turns edits into
      // overrides, in either the engine or the mirror lane (ADR 0028).
      if (formula.allowOverride === false) continue;
```

  2. Respect fork (single-record Case 1 path) — short-circuit the LOOKUP, not just the honor: `findOverride` runs at :442 before the fork, and a locked definition can never honor what it finds, so skipping the query is a per-event saving (efficiency review finding 10a):

```ts
      // Locked definitions never honor pins, so don't pay the lookup (§5).
      const override = (formula.allowOverride ?? true)
        ? await findOverride(
            client,
            formula.targetObject ?? '',
            formula.targetField ?? '',
            recordId,
          )
        : null;
      if (override?.active) {
```

- [ ] **Step 4: Run tests** — `handlers.spec.ts` green; also `mirror-target.spec.ts`, `date-target.spec.ts`, `currency-target.spec.ts`, `integer-target.spec.ts` (they exercise the same fork).

- [ ] **Step 5: Commit** — `feat(formula-field): locked definitions skip override detection and ignore pins`

---

### Task 7: Event-driven revert of outside writes to locked fields (A′-C1)

**Files:**
- Modify: `src/logic-functions/lib/handle-record-update.ts` (predicate :181-189; Case 1 entry :428-431)
- Test: `src/logic-functions/lib/__tests__/handlers.spec.ts`

**Context:** The `eventAffectedFormulas` predicate is actor-gated (`actorWorkspaceMemberId && updatedFields && …`), so a memberless API write touching only a locked value field would leave the definition OUT of the pre-pass: no kinds in `eventFieldKindsByObject` and no entry in `gateErrorByFormulaId` (compiled entries are built for ALL loaded formulas at :151-159 before the predicate, so only the kinds/gate half is at stake). Also, Case 1's entry condition (`sameRecordAffected(dependencies.sameRecordFields, updatedFields)`) is false for a write touching only the target field (a formula's target is never its own dependency). Fix per spec §2.3.3: an actor-INDEPENDENT predicate branch for locked definitions plus a widened Case 1 entry — the revert then reuses the Case 1 body verbatim, and the pre-existing gate/OFFLINE/cycle skips at :401-424 protect it (verified: `gateErrorByFormulaId.has → continue` at :417-419 runs before Case 1).

**Interfaces:**
- Consumes: `formula.allowOverride` (Task 5), skip-block behavior (Tasks 1, 6).

- [ ] **Step 1: Write the failing tests**

```ts
it('locked definition: a memberless outside write to the value field reverts (A-prime C1)', async () => {
  client.seed('formulaDefinition', [
    {
      id: 'f-locked',
      targetObject: 'opportunity',
      targetField: 'lockedScore',
      targetFieldType: 'NUMBER',
      expression: 'formulaInputA + 1',
      enabled: true,
      allowOverride: false,
    },
  ]);
  client.seed('opportunity', [{ id: 'o1', formulaInputA: 2, lockedScore: 777 }]);

  const outcomes = await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', formulaInputA: 2, lockedScore: 777 },
    updatedFields: ['lockedScore'],
    // no actorWorkspaceMemberId: an API/integration write
  });

  expect(client.get('opportunity', 'o1')!.lockedScore).toBe(3);
  expect(outcomes.some((outcome) => outcome.changed)).toBe(true);
});

it('locked definition: the revert resolves event kinds (A-prime C1 kinds)', async () => {
  // DATE regression: a kind-blind revert would read signedDate as text and
  // produce NON_NUMERIC_VALUE instead of a value. The event path resolves
  // kinds through the client, so seed setFieldKinds — NOT setObjectsWithFields,
  // which feeds the metadata catalog, not the kind path (date-target.spec.ts
  // precedent).
  client.setFieldKinds('company', { signedDate: 'DATE', renewDate: 'DATE' });
  client.seed('formulaDefinition', [
    {
      id: 'f-date-locked',
      targetObject: 'company',
      targetField: 'renewDate',
      targetFieldType: 'DATE',
      expression: 'signedDate + 30',
      enabled: true,
      allowOverride: false,
    },
  ]);
  client.seed('company', [
    { id: 'c1', signedDate: '2026-07-03', renewDate: '1999-01-01' },
  ]);

  await handleRecordUpdate({
    client,
    objectName: 'company',
    recordId: 'c1',
    after: { id: 'c1', signedDate: '2026-07-03', renewDate: '1999-01-01' },
    updatedFields: ['renewDate'],
  });

  // 2026-07-03 + 30 days, serialized back to the DATE scalar on write.
  expect(client.get('company', 'c1')!.renewDate).toBe('2026-08-02');
});

it('locked definition: a gate-failing revert declines to write (A-prime C1 gate)', async () => {
  // Kinds resolve through the client on the event path — setFieldKinds, NOT
  // setObjectsWithFields (that feeds the metadata catalog; the gate would see
  // empty kinds, infer `unknown`, and never fire — a vacuous test).
  client.setFieldKinds('opportunity', { textInput: 'TEXT', lockedScore: 'NUMBER' });
  client.seed('formulaDefinition', [
    {
      id: 'f-locked',
      targetObject: 'opportunity',
      targetField: 'lockedScore',
      targetFieldType: 'NUMBER',
      expression: 'textInput + 1',
      enabled: true,
      allowOverride: false,
    },
  ]);
  client.seed('opportunity', [{ id: 'o1', textInput: 'abc', lockedScore: 777 }]);

  await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', textInput: 'abc', lockedScore: 777 },
    updatedFields: ['lockedScore'],
  });

  expect(client.get('opportunity', 'o1')!.lockedScore).toBe(777);
  expect(client.writes).toHaveLength(0);
});

it('unlocked definition: a memberless write to the value field is left alone', async () => {
  client.seed('opportunity', [
    { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 777 },
  ]);

  await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', formulaInputA: 5, formulaInputB: 10, formulaScore: 777 },
    updatedFields: ['formulaScore'],
  });

  expect(client.get('opportunity', 'o1')!.formulaScore).toBe(777);
});

it('locked definition: the revert echo terminates (no write on its own event)', async () => {
  // The revert's write emits a memberless event naming the locked target; it
  // re-enters Case 1 once, finds the stored value already correct, and
  // write-avoids — the chain must stop here (accepted echo cost, ADR 0028).
  client.seed('formulaDefinition', [
    {
      id: 'f-locked',
      targetObject: 'opportunity',
      targetField: 'lockedScore',
      targetFieldType: 'NUMBER',
      expression: 'formulaInputA + 1',
      enabled: true,
      allowOverride: false,
    },
  ]);
  client.seed('opportunity', [{ id: 'o1', formulaInputA: 2, lockedScore: 3 }]);

  await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId: 'o1',
    after: { id: 'o1', formulaInputA: 2, lockedScore: 3 },
    updatedFields: ['lockedScore'],
  });

  expect(client.writes).toHaveLength(0);
});
```

- [ ] **Step 2: Run, verify** — revert test and kinds test FAIL (no write happens today); gate test, unlocked test, and echo test PASS already (they pin the safety envelope before the edit — they must STILL pass after Step 3, which is the point).

- [ ] **Step 3: Implement** — two edits in `handle-record-update.ts`:
  1. In the `eventAffectedFormulas` predicate, after the actor-gated branch (:189):

```ts
    // Locked definitions revert outside writes to their value field. No actor
    // gate: API/integration writes carry no member id, and skipping the
    // pre-pass here would leave the revert kind-blind and ungated (A'-C1).
    if (
      formula.allowOverride === false &&
      updatedFields &&
      updatedFields.length > 0 &&
      typeof formula.targetField === 'string' &&
      updatedFields.includes(formula.targetField)
    ) {
      return true;
    }
```

  2. Case 1 entry (:428-431) — widen with a locked-target clause:

```ts
    // A locked target hit by an outside write recomputes even though the
    // target is never its own dependency — that recompute IS the revert.
    const lockedTargetTouched =
      formula.allowOverride === false &&
      typeof formula.targetField === 'string' &&
      (updatedFields?.includes(formula.targetField) ?? false);

    // Case 1: this object's own record changed and it feeds this formula.
    if (
      formula.targetObject === objectName &&
      (sameRecordAffected(dependencies.sameRecordFields, updatedFields) ||
        lockedTargetTouched)
    ) {
```

  Note: the Case 1 body passes `after` as `prefetchedRecord` for the engine lane — after an outside write, `after` carries corrupted target-field data but CORRECT dependency values, so the recompute reads true inputs and writes the computed value back. Do not add a new lane.

  Accepted echo cost (review finding 10b, document in ADR 0028): the revert's own write emits a memberless event whose `updatedFields` is the locked target, which re-enters this lane exactly once; the second recompute is prefetch-fed, finds the stored value correct, and write-avoids, so the chain stops (revert → echo compute → no write → no further event). Bounded CPU per outside write; partially offset by Task 6's skipped `findOverride` lookup.

- [ ] **Step 4: Run tests** — all four green plus the whole `handlers.spec.ts`; then `yarn test`.

- [ ] **Step 5: Commit** — `feat(formula-field): event-driven revert of outside writes to locked fields`

---

### Task 8: Variation syncable set excludes locked targets (§2.6)

**Files:**
- Modify: `src/logic-functions/lib/formula-repository.ts` (new cached loader beside `loadAllEnabledFormulasCached`)
- Modify: `src/logic-functions/lib/syncable-fields.ts:38-83` (`computeSyncableFields` swaps loaders)
- Test: `src/logic-functions/lib/__tests__/syncable-fields.spec.ts`

**Interfaces:**
- Produces: `loadAllEnabledFormulasCached` RENAMED in place to `loadSyncExclusionFormulasCached` (and `__clearEnabledFormulasCacheForTests` to `__clearSyncExclusionFormulasCacheForTests`), filter widened. Review-verified: `syncable-fields.ts:51` is the cache's ONLY production consumer, so no second cache is cloned; `loadEnabledFormulas` (uncached, used by recompute paths) stays untouched.

**Context:** `computeSyncableFields` excludes ENABLED-formula targets only (`loadAllEnabledFormulasCached` → server filter `enabled: { eq: true }`), so a freshly created locked definition — DISABLED until its first valid expression saves — leaves its target field syncable, and variation sync can pin it (`variation-sync.ts:245/:899` write ACTIVE rows in the shared override key space). Ruling (spec §2.6): locked targets leave the syncable set regardless of enabled state. Shape: **one widened query** (`or: [{enabled: {eq: true}}, {allowOverride: {eq: false}}]`) — applied by widening and renaming the existing cached loader IN PLACE (its only production consumer is `computeSyncableFields`). This is the only recurring cost Feature A′ adds (spec §5).

- [ ] **Step 1: Write the failing test** — in `syncable-fields.spec.ts` (mirror its existing `setObjectsWithFields` fixture). The rename touches the clear-helper import in the `afterEach` of BOTH `syncable-fields.spec.ts` AND `variation-sync-divergence.spec.ts` (:3/:30 — it drives `computeSyncableFields` and would leak the cache across tests otherwise):

```ts
it('excludes a locked target even while its definition is disabled (spec §2.6)', async () => {
  const client = new FakeClient();
  client.setObjectsWithFields([
    {
      id: 'obj-company',
      nameSingular: 'company',
      labelIdentifierFieldMetadataId: 'field-name',
      fields: [
        { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'field-locked', name: 'lockedTotal', type: 'NUMBER', isActive: true, isSystem: false },
        { id: 'field-emp', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
        { id: 'field-rel', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
      ],
    },
  ]);
  client.seed('formulaDefinition', [
    {
      id: 'f-locked',
      targetObject: 'company',
      targetField: 'lockedTotal',
      targetFieldType: 'NUMBER',
      expression: '',
      enabled: false,
      allowOverride: false,
    },
    // Tripwire for the filter shape AND the fake's `or` support: disabled and
    // unlocked must stay OUT of the exclusion set — if the widened filter (or
    // a fake that ignores `or`) returns everything, employees drops out of the
    // syncable set and this test fails.
    {
      id: 'f-disabled-unlocked',
      targetObject: 'company',
      targetField: 'employees',
      targetFieldType: 'NUMBER',
      expression: '',
      enabled: false,
    },
  ]);

  const fields = await computeSyncableFields(client, 'company', 'primaryRecord');

  expect(fields.map((field) => field.name)).not.toContain('lockedTotal');
  expect(fields.map((field) => field.name)).toContain('employees');
});
```

- [ ] **Step 2: Run, verify it fails** — `lockedTotal` is currently included (the definition is disabled).

- [ ] **Step 3: Implement**
  1. `formula-repository.ts`: RENAME `loadAllEnabledFormulasCached` → `loadSyncExclusionFormulasCached` and `__clearEnabledFormulasCacheForTests` → `__clearSyncExclusionFormulasCacheForTests` (same cache machinery — per-workspace key, TTL, in-flight dedup). Inside, stop delegating to `loadEnabledFormulas` (which recompute paths use unchanged) and run the same fetch shape with the widened filter:

```ts
  // Variation sync must ignore enabled-formula targets AND locked targets even
  // while the locked definition is disabled (§2.6 / ADR 0028): locked = fully
  // computed, no exceptions. Sync-exclusion is this cache's only consumer;
  // recompute paths use the uncached enabled-only loader.
  const filter = {
    or: [{ enabled: { eq: true } }, { allowOverride: { eq: false } }],
  };
```

  2. `syncable-fields.ts`: update the call at :51 to `loadSyncExclusionFormulasCached(client)` (import rename included). Nothing else changes — the `formulaTargetFields` set construction already unions target fields.
  3. REQUIRED (review finding 6): `fake-client.ts`'s `connection()` filter evaluation (:225-231) silently IGNORES a top-level `or` (every row matches — the test would pass even with a wrong filter). Extend it to evaluate `or: [...]` as any-subfilter-matches before relying on the Step 1 test. The `f-disabled-unlocked` seed is the tripwire proving both the fake and the filter are right.
  4. Update the renamed clear-helper import in `syncable-fields.spec.ts` and `variation-sync-divergence.spec.ts` `afterEach` hooks.

- [ ] **Step 4: Run tests** — `syncable-fields.spec.ts`, `formula-repository-cache.spec.ts`, and the `variation-sync-*.spec.ts` files.

- [ ] **Step 5: Commit** — `feat(formula-field): variation sync never tracks locked formula targets`

---

## Phase 2 — Feature A′ UI

No React render-test infra exists in this app (confirmed: zero `.spec.tsx`, zero @testing-library). Wizard/editor behavior in Tasks 9–11 is covered by the Phase 4 live-verify checklist; anything testable is extracted to `lib/` per house pattern.

### Task 9: Definition editor — project the flag, status line, wizard-draft plumbing

Sequenced FIRST in Phase 2 (review finding 3): `WizardDraft` is a closed seven-field type (`formula-setup-wizard.tsx:102-112`) whose only construction site is this editor's `draft={{…}}` literal (`formula-definition-editor.tsx:551-559`) — the wizard cannot hydrate a field the draft doesn't carry.

**Files:**
- Modify: `src/front-components/formula-definition-editor.tsx` (projection :394-412; normalizer :418-437; local definition type; draft literal :551-559; render at :676-678)
- Modify: `src/front-components/lib/formula-setup-wizard.tsx` (`WizardDraft` type :102-112 ONLY — no UI here)

**Interfaces:**
- Consumes: `allowOverride` field (Task 5); `MutedText` from `src/front-components/lib/ui` (already imported).
- Produces: editor `Definition.allowOverride: boolean` (normalized `?? true`); `WizardDraft.allowOverride: boolean` — Task 10 consumes `draft.allowOverride`.

- [ ] **Step 1: Widen the projection** — add `allowOverride: true,` to the node selection (:394-412), `allowOverride: edge.node.allowOverride ?? true,` to the normalizer (:418-437), and `allowOverride: boolean;` to the local definition type.

- [ ] **Step 2: Plumb the wizard draft** — add `allowOverride: boolean;` to `WizardDraft` (`formula-setup-wizard.tsx:102-112`) and `allowOverride: definition.allowOverride,` to the `draft={{…}}` literal (`formula-definition-editor.tsx:551-559`).

- [ ] **Step 3: Render the status line** — on the blank line between the field-settings ternary's close (`)}`, :676) and `<FormulaDescriptionEditor` (:678) — this placement is deliberate: mirrors get a provenance line INSTEAD of Field settings, so anything inside the ternary would be denied to mirrors (spec §2.4):

```tsx
      <MutedText as="div">
        {definition.allowOverride
          ? 'Overrides: allowed'
          : 'Overrides: locked at creation'}
      </MutedText>
```

No toggle — the value is immutable by platform constraint.

- [ ] **Step 4: Verify** — `npx tsc --noEmit` (app root), `npx oxlint -c .oxlintrc.json .`, unit suite still green.

- [ ] **Step 5: Commit** — `feat(formula-field): override lock status line and wizard draft plumbing`

---

### Task 10: Wizard — "Allow manual overrides" choice with permanence warning

**Files:**
- Modify: `src/front-components/lib/formula-setup-wizard.tsx`

**Interfaces:**
- Consumes: `draft.allowOverride: boolean` (Task 9 — already defaulted by the editor's normalizer, so legacy rows arrive as `true`); `ChoiceChip` (ui.tsx:197), `BannerWarning` (:234), `HintText` (:257), `StepTitle` (:285) from `src/front-components/lib/ui`. Do NOT reuse `ToggleTrack` — its colors are the override red/green and its `shouldForwardProp` only filters `on`.
- Produces: `createOneField` payloads carry `isUIEditable: allowOverride`; `finalizeCreation`'s `definitionData` carries `allowOverride`.

- [ ] **Step 1: Add state + persistence:**

```tsx
  const [allowOverride, setAllowOverride] = useState<boolean>(
    draft.allowOverride,
  );
```

```tsx
  const pickAllowOverride = useCallback(
    (next: boolean) => {
      setAllowOverride(next);
      persistDraft({ allowOverride: next });
    },
    [persistDraft],
  );
```

- [ ] **Step 2: Render the step** — a new top-level step AFTER `4 · Description` (~:1006 block) and BEFORE the create-actions block (~:1022), shown in both modes (mirrors get overrides too). §9.4 ruling: new step, no renumbering of existing steps. Use the standard step wrapper every other step uses (`<div style={layout.step}>` + `style={layout.stepTitle}`, see :981/:1005):

```tsx
      <div style={layout.step}>
        <StepTitle style={layout.stepTitle}>5 · Overrides</StepTitle>
        <div style={layout.formatRow}>
          <ChoiceChip
            selected={allowOverride}
            onMouseDown={() => pickAllowOverride(true)}
          >
            Allow manual overrides
            <HintText as="span"> a human edit pins that record's value</HintText>
          </ChoiceChip>
          <ChoiceChip
            selected={!allowOverride}
            onMouseDown={() => pickAllowOverride(false)}
          >
            Locked
            <HintText as="span"> always computed, permanent</HintText>
          </ChoiceChip>
        </div>
        {!allowOverride ? (
          <BannerWarning>
            Permanent: this setting cannot be changed after the field is
            created. Changing it later means deleting the formula and
            recreating the field — and a deactivated old field can still
            reserve the name.
          </BannerWarning>
        ) : null}
      </div>
```

- [ ] **Step 3: Wire the create payloads AND the hook deps** — at :664 (engine/format payload) and :756 (mirror payload) replace `isUIEditable: true,` with `isUIEditable: allowOverride,`. Add `allowOverride,` to BOTH `definitionData` objects passed to `finalizeCreation` (call sites :683-698 and :772-789). CRITICAL (review finding 9 — nothing catches this automatically): add `allowOverride` to the `useCallback` dependency arrays of BOTH `create` (:704-712) and `createMirror` (:795+), or the payloads capture a stale value.

- [ ] **Step 4: Verify** — `npx tsc --noEmit` (app root), `npx oxlint -c .oxlintrc.json .`, unit suite still green (no unit coverage exists for this file; the live checks land in Task 14).

- [ ] **Step 5: Commit** — `feat(formula-field): wizard create-time override choice with permanence warning`

---

### Task 11: Record-tab widget — project the flag, hide the Override toggle for locked rows

**Files:**
- Modify: `src/front-components/formula-editor.tsx` (projection :267-289; normalizer :291-313; local `Definition` type; override row :994-1012)

**Interfaces:**
- Consumes: `allowOverride` field (Task 5).
- Produces: `Definition.allowOverride: boolean` (normalized, `?? true`) — Task 12 renders rows from the same type.

- [ ] **Step 1: Widen the projection** — add `allowOverride: true,` to the `node` selection (:267-289), `allowOverride: edge.node.allowOverride ?? true,` to the normalizer (:296-313), and `allowOverride: boolean;` to the widget's local `Definition` type (search `type Definition` in the file).

- [ ] **Step 2: Hide the toggle** — wrap the override row block (:994-1012):

```tsx
          {definition.allowOverride ? (
            <div style={layout.overrideRow}>
              {/* existing OverrideToggle + hint content unchanged */}
            </div>
          ) : null}
```

No replacement copy — the lock is explained in the definition editor (Task 9); the record tab just loses the control (spec §2.4).

- [ ] **Step 3: Verify** — `npx tsc --noEmit` (app root), `npx oxlint -c .oxlintrc.json .`, unit suite still green.

- [ ] **Step 4: Commit** — `feat(formula-field): hide the per-record override toggle for locked definitions`

---

## Phase 3 — Feature B

### Task 12: Quiet awaiting hint on the record-page Formulas tab

**Files:**
- Create: `src/front-components/lib/row-status.ts`
- Create: `src/front-components/lib/__tests__/row-status.spec.ts`
- Modify: `src/front-components/formula-editor.tsx` (row render ~:831-840, :960-965, :1014-1018; imports)
- Modify: `src/front-components/formula-definition-editor.tsx` (:643 — swap the hardcoded hint string for the shared constant)

**Context:** Ground truth (spec §3): the definition editor guards the empty expression (`awaitingExpression = !definition.expression && !dirty`, formula-definition-editor.tsx:572-573) and shows a muted hint; the record tab live-validates the seeded empty draft and shows red `PARSE_ERROR: Unexpected end of expression`. The awaiting row DOES render on the record tab (the load filter :291-294 drops only empty `targetField`), which is why the "(formula disabled)" marker also needs suppressing. UI-only; `lastError` and save-validation untouched. Mirrors always carry a bare-ref expression, so the guard never fires for them (reviewer-verified non-issue).

**Interfaces:**
- Produces: from `row-status.ts` — `resolveRowStatus({expression, draft, liveError, lastError}): RowStatus` where `RowStatus = {kind:'awaiting'} | {kind:'error'; message: string} | {kind:'ok'}`, and `AWAITING_EXPRESSION_HINT: string`.

- [ ] **Step 1: Write the failing tests** — `src/front-components/lib/__tests__/row-status.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  AWAITING_EXPRESSION_HINT,
  resolveRowStatus,
} from 'src/front-components/lib/row-status';

describe('resolveRowStatus', () => {
  it('awaiting beats live and stored errors on an untouched empty expression', () => {
    expect(
      resolveRowStatus({
        expression: '',
        draft: '',
        liveError: 'PARSE_ERROR: Unexpected end of expression',
        lastError: 'stale',
      }),
    ).toEqual({ kind: 'awaiting' });
  });

  it('typing resumes live validation unchanged', () => {
    expect(
      resolveRowStatus({
        expression: '',
        draft: '1 +',
        liveError: 'PARSE_ERROR: Unexpected end of expression',
        lastError: '',
      }),
    ).toEqual({
      kind: 'error',
      message: 'PARSE_ERROR: Unexpected end of expression',
    });
  });

  it('stored lastError still surfaces when live validation passes', () => {
    expect(
      resolveRowStatus({
        expression: 'a + 1',
        draft: 'a + 1',
        liveError: null,
        lastError: 'DIVISION_BY_ZERO',
      }),
    ).toEqual({ kind: 'error', message: 'DIVISION_BY_ZERO' });
  });

  it('a saved healthy formula reads ok (mirrors always have an expression)', () => {
    expect(
      resolveRowStatus({
        expression: '[company:x:name]',
        draft: '[company:x:name]',
        liveError: null,
        lastError: '',
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('exposes the exact hint string the definition editor shows', () => {
    expect(AWAITING_EXPRESSION_HINT).toBe(
      'Field created — write the formula expression and save to activate.',
    );
  });
});
```

- [ ] **Step 2: Run, verify it fails** (module does not exist).

- [ ] **Step 3: Implement the helper** — `src/front-components/lib/row-status.ts`:

```ts
export type RowStatus =
  | { kind: 'awaiting' }
  | { kind: 'error'; message: string }
  | { kind: 'ok' };

export const AWAITING_EXPRESSION_HINT =
  'Field created — write the formula expression and save to activate.';

// Feature B: an empty saved expression with an untouched draft is a fresh
// wizard field awaiting its formula, not a parse error. Same guard the
// definition editor applies (awaitingExpression).
export const resolveRowStatus = ({
  expression,
  draft,
  liveError,
  lastError,
}: {
  expression: string;
  draft: string;
  liveError: string | null;
  lastError: string;
}): RowStatus => {
  const dirty = draft !== expression;
  if (!expression && !dirty) {
    return { kind: 'awaiting' };
  }
  if (liveError) {
    return { kind: 'error', message: liveError };
  }
  if (lastError) {
    return { kind: 'error', message: lastError };
  }
  return { kind: 'ok' };
};
```

- [ ] **Step 4: Run the helper tests** — green.

- [ ] **Step 5: Wire the record tab** — in `formula-editor.tsx`:
  1. Add `HintText` to the `src/front-components/lib/ui` import (NOT currently imported there) and import `AWAITING_EXPRESSION_HINT, resolveRowStatus` from `src/front-components/lib/row-status`.
  2. After the existing `draft`/`dirty`/`liveError` computation (:831-840):

```tsx
      const rowStatus = resolveRowStatus({
        expression: definition.expression,
        draft,
        liveError,
        lastError: definition.lastError,
      });
```

  3. Suppress the disabled marker while awaiting (:962-964):

```tsx
            {!definition.enabled && rowStatus.kind !== 'awaiting' ? (
              <ErrText> (formula disabled)</ErrText>
            ) : null}
```

  4. Replace the error-line ternary (:1014-1018):

```tsx
          {rowStatus.kind === 'awaiting' ? (
            <HintText as="div">{AWAITING_EXPRESSION_HINT}</HintText>
          ) : rowStatus.kind === 'error' ? (
            <ErrText as="div" style={layout.error}>
              {rowStatus.message}
            </ErrText>
          ) : null}
```

  Leave the `liveError` variable and everything else that consumes it (save-button arming etc.) untouched.
  5. In `formula-definition-editor.tsx:642-644`, replace the hardcoded hint string with `{AWAITING_EXPRESSION_HINT}` (plus the import) so the two surfaces can never drift.

- [ ] **Step 6: Run** — `yarn test` full suite; `yarn lint`.

- [ ] **Step 7: Commit** — `feat(formula-field): quiet awaiting hint on the record-page formulas tab`

---

## Phase 4 — finalize

### Task 13: ADR 0028, README, context.md narrative catch-up

**Files:**
- Create: `docs/adr/0028-create-time-override-lock.md`
- Modify: `README.md` (feature list)
- Modify: `context.md` (app root; narrative tail ~:1174-1188, deploy line :925)

- [ ] **Step 1: Write ADR 0028** — follow the `NNNN-kebab-title.md` convention and the style of `docs/adr/0027-strict-kind-typing.md`. Required content (spec §2.5/§6):
  - **Context:** users wanted view-only formula fields; the platform wall — `createOneField` honors `isUIEditable` (`get-default-flat-field-metadata-from-create-field-input.util.ts:63-67`) but `updateOneField` whitelist-drops it (`sanitize-raw-update-field-input.ts:35-43`), so the choice is create-time-only; upstream filing offered and declined 2026-08-07.
  - **Decision:** `allowOverride` BOOLEAN on FormulaDefinition, default true, manifest-declared `isUIEditable: false` (permanence enforced, not asserted); wizard choice with permanence warning; server lane = detection skip + respect-fork guard + actor-independent event revert through Case 1; locked targets leave the variation syncable set regardless of enabled state ("off = fully computed, no exceptions").
  - **Accepted limitations (verbatim from spec §2.5):** permanent by platform constraint (escape hatch: delete + recreate); no retroactive lock (all 19 cloud definitions stay overrideable); API-created definitions with `allowOverride: false` against a pre-existing unlocked field get the behavioral skip only, no grey-out (API-only by construction — the wizard collision guard forbids that path); interrupted-wizard behavior unchanged; `isUIEditable` is UI-only — API writes land, then revert event-driven.
  - **Cost model (spec §5, refined by the plan review):** no new hot-path queries — the locked path actually SKIPS the per-event `findOverride` lookup; one widened query per variation-sync pass is the only recurring query cost; plus one bounded echo compute per outside write to a locked field (the revert's own event re-enters Case 1 once, finds the stored value correct, write-avoids, chain stops — termination is test-pinned).
  - **Upgrade path:** if the platform ever adds `isUIEditable` to `FLAT_FIELD_METADATA_EDITABLE_PROPERTIES`, the flag upgrades into a runtime toggle — that arc must inherit the round-1 review constraints catalogued in spec §7 (cite the spec file by path).

- [ ] **Step 2: README** — add the create-time override lock and the quiet awaiting hint to the feature list, one line each, matching the existing bullet style.

- [ ] **Step 3: context.md narrative catch-up** — the narrative records nothing after 2026-07-21. Append arc entries in the file's existing entry style:
  - **v0.1.11 / ADR 0025** (2026-07-24, deployed): budget-bounded recompute scans, `scanCursor` resume point.
  - **v0.3.0 / ADR 0026 + 0027** (2026-08-07, deployed to cloud): string values + `&` concatenation, strict kind typing, `description` field, `targetFieldSettings`.
  - **v0.4.0** (this build, local): Phase 0 sweep (items 0.1–0.5), create-time override lock (ADR 0028), quiet awaiting hint.
  - Correct the "Currently deployed to cloud: **v0.1.11**" line (:925) to **v0.3.0** (true today; v0.4.0 gets stamped at deploy time, not now).

- [ ] **Step 4: Commit** — `docs(formula-field): ADR 0028 create-time override lock + narrative catch-up`

---

### Task 14: Version bump, full verify, live checklist

**Files:**
- Modify: `package.json` (app root: `"version": "0.3.0"` → `"0.4.0"`)

- [ ] **Step 1: Bump** — `package.json` version to `0.4.0`.

- [ ] **Step 2: Full verify** — from the repo root: `node_modules/.bin/vitest run --root packages/twenty-apps/community/formula-field` (baseline 1209 + this plan's new tests, all green); from the app root: `npx oxlint -c .oxlintrc.json .` and `npx tsc --noEmit`. Paste the totals into the task report — no green claim without the run output (verification-before-completion).

- [ ] **Step 3: Live verify (local `dev` remote)** — deploy the app to the local platform per `context.md`'s deploy notes (app dir; `dev` remote at `http://127.0.0.1:3000`), then walk spec §8's checklist:
  1. Create a LOCKED formula field via the wizard → warning banner shows on "Locked"; after create, the cell is greyed/read-only in table AND record detail.
  2. The Formulas tab shows no Override toggle for the locked row; the definition editor shows "Overrides: locked at creation".
  3. Direct GraphQL write to the locked value field → reverts within seconds (this is also the live confirmation that the server APPLIED `isUIEditable: false` on create — the client transmitting the flag was never in doubt; the server honoring it was, spec §2.4 caveat).
  4. Create an UNLOCKED formula field → today's behavior end-to-end (edit pins an override; toggle present).
  5. Fresh wizard definition (expression not yet written) shows the awaiting hint — not PARSE_ERROR — on BOTH surfaces, and no "(formula disabled)" marker.
  6. Edit a definition's description → no target-object recompute fires (watch the worker/logs).
  7. Wizard resumability: pick "Locked", abandon the wizard, reopen → the choice is restored from the draft.

- [ ] **Step 4: Commit** — `chore(formula-field): v0.4.0`

**Cloud deploy is NOT part of this plan** — it happens only when the user directs, following spec §8's deploy gate (SDK-version match, strict-gate audit before/after, `app:publish --private -r cloud` then `app:install`, never `apply`/`dev`; expect nav items to un-folder).

---

## Deviations from the spec's test list (§8), by ruling of this plan

- "Wizard: OFF persists in draft / create payload carries the flags / warning renders" — the app has zero React render-test infra (no `.spec.tsx`, no @testing-library); these move to the Task 14 live checklist (items 1, 3, 7) instead of unit tests.
- "Projection-contents assertions on all five sites" — asserted in unit tests for the server sites (`FORMULA_FIELDS` via `querySelections`, manifest spec); the two front-widget projections have no test seam and are covered live (a missed front projection surfaces immediately: the toggle would stay visible / status line would read "allowed" for a locked row, checklist items 2).
- "Feature B render precedence" — covered at the extracted-helper level (`row-status.spec.ts`), the house pattern for front logic; the JSX wiring is checklist item 5.
- Spec §5 claimed the revert adds "zero" recurring work: the plan review surfaced a bounded echo — the revert's own write event re-enters the widened Case 1 once and write-avoids (termination pinned by a Task 7 test). Accepted and documented in ADR 0028; partially offset by the locked path now SKIPPING the per-event `findOverride` lookup (Task 6).
- Spec §9.5's draft early-return gains a one-time `enabled: false` write per draft (review finding 2): without it, abandoned drafts would stay in the sweep's enabled set and buy an hourly full-object scan each. Strictly cheaper than today's validation path (which wrote `enabled: false` + `lastError` + a workspace-wide status refresh).
