# Override Marker Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One app-managed, view-only TEXT field per target object (`fxOverrides`, label `Overrides`) whose per-record value lists the formula fields currently overridden on that record ("Deal Score, Tier"), blank when none.

**Architecture:** A pure marker-computation function feeds four write lanes — the record-event handler (gated on "this invocation upserted a pin, or the marker itself was edited"), the widget's override toggle, the definition lifecycle handlers (disable/trash/destroy), and an hourly sweep backstop with its own budget slice. Every write is diff-guarded through `textValuesConverged` (the ADR 0004/0030 recursion terminator). The field is created server-side when an object's first override-allowed definition is created (user amendment 2026-09-03; the sweep's ensure arm is the retry/migration path), so it can be positioned before any override exists.

**Tech Stack:** TypeScript, twenty-sdk app (logic functions + front components), vitest with the in-repo `FakeClient` fake, `MetadataApiClient` for field metadata.

**Spec:** `docs/superpowers/specs/2026-09-01-override-marker-field-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- All work happens in `packages/twenty-apps/community/formula-field/` on branch `feat/formula-field-override-marker`; run all commands from that app directory unless a path says otherwise.
- Marker identity, verbatim everywhere: API name `fxOverrides`, label `Overrides`, description `Formula fields currently overridden on this record. Managed by the Formula Field app.`, icon `IconPinned`, type TEXT, `isUIEditable: false` at creation (create-time-only flag, ADR 0028).
- Every marker comparison goes through `textValuesConverged` (`src/logic-functions/lib/value-io.ts:116`); a missing/`undefined` payload key is UNKNOWN (fetch), never assumed blank; `null` and `''` are the same blank.
- Never consult `actorWorkspaceMemberId` for any marker decision (ADR 0006: app writes inherit the actor).
- Definitions that count toward a marker: `enabled === true` AND `allowOverride !== false` AND `targetObject` matches; label is `name || targetField`; sort by `order` asc nulls-last then label; dedupe by `targetField` (first wins); join `", "`.
- Tests: vitest, `FakeClient` fixtures, assert write-avoidance via `client.mutations`/`client.writes` — no module mocks. Run with `yarn test` (or `yarn vitest run <file>` for one file). `client.writes` entries are `` `${object}:${id}:${field}=${JSON.stringify(value)}` `` — a string value is logged WITH quotes (`fxOverrides="Deal Score"`, blank is `fxOverrides=""`). `FakeClient` serves plural record connections generically for every seeded object (`pluralize(name)` keys), including `id: { in: [...] }` filters, `is: NOT_NULL` filters, and `update<Plural>` batch mutations — do NOT extend it for those.
- Metadata reads are best-effort everywhere: any helper touching `loadAllObjectsWithFields` or `MetadataApiClient` must degrade (return false/empty/'failed'), never throw out of a handler — this app's uniform posture.
- House style: `//` comments only for WHY, named exports, types over interfaces, no `any` in new code, no abbreviations (the `fx` prefix is this app's established convention, not an abbreviation violation).
- Commits: conventional style, no AI attribution/co-author trailers (CI rejects them).
- Version target v0.6.0; new ADR is 0031 (highest existing is 0030).

## Execution Policy (for the executing session)

- Orchestrate via superpowers:subagent-driven-development. Keep workflows SMALL: dispatch in waves, hard concurrency cap of **3 opus + 8 sonnet agents at any moment**. **Fable subagents are banned** — never dispatch one for any task, review, or search.
- Model assignment: implementers on sonnet (opus only where a task needs real design judgment — Tasks 6, 7, 8 qualify); task reviewers on sonnet for mechanical diffs, opus for Tasks 6, 7, 8; searches/excerpt-fetches on sonnet.
- Wave structure (parallelize only tasks with disjoint files):
  - Wave 1: Task 0 ∥ Task 1 ∥ Task 2 (Task 0 needs the dev stack and interactive probing — supervise it closely; it is a STOP gate for Tasks 5+).
  - Wave 2 (after 1+2): Task 3 ∥ Task 4.
  - Wave 3 (after Task 0 passes and Task 4): Task 5.
  - Wave 4: Tasks 6 → 7 → 8 strictly sequential (they share `marker-converge.ts` and the lifecycle files); Task 9 may run in parallel with 7/8 (front-only files) once Task 1 is merged and Task 0's P3 passed.
  - Wave 5: Task 10, then Task 11.
- Every task ends committed with its tests green before its reviewer runs; read each report before dispatching the next wave.

---

### Task 0: Platform probes (spike — results gate the rest of the plan)

**Files:**
- Create (TEMPORARY, never committed): `src/logic-functions/probe-marker-field.ts`
- No production changes.

**Interfaces:**
- Consumes: nothing.
- Produces: three verified facts recorded in `docs/superpowers/plans/2026-09-01-probe-results.md` (committed): P1 app-token `createOneField` works, P2 where the created field appears in the record page UI, P3 user-token record write to an `isUIEditable: false` field works.

This is the spec's §10. The dev stack must be running: `bash packages/twenty-utils/setup-dev-env.sh` then `yarn start` from the repo root (use the established background-agent pattern for the server shell). STOP conditions are listed at the end.

- [ ] **Step 1: Write the temporary probe logic function**

```ts
// src/logic-functions/probe-marker-field.ts — TEMPORARY probe, delete after Task 0.
import { defineLogicFunction } from 'twenty-sdk/define';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { findFields } from 'src/logic-functions/lib/handle-definition-lifecycle';

const handler = async (): Promise<Record<string, unknown>> => {
  const objectName = 'company';
  const { objectMetadataId, fields } = await findFields(objectName, ['fxOverrides']);
  if (!objectMetadataId) {
    return { probe: 'failed', reason: 'object metadata not found' };
  }
  if (fields.has('fxOverrides')) {
    return { probe: 'exists' };
  }
  const client = new MetadataApiClient();
  try {
    const response = await client.mutation({
      createOneField: {
        __args: {
          input: {
            field: {
              objectMetadataId,
              type: 'TEXT',
              name: 'fxOverrides',
              label: 'Overrides',
              description:
                'Formula fields currently overridden on this record. Managed by the Formula Field app.',
              icon: 'IconPinned',
              isUIEditable: false,
            },
          },
        },
        id: true,
        name: true,
      },
    });
    return { probe: 'created', id: response?.createOneField?.id ?? null };
  } catch (error) {
    return { probe: 'failed', reason: String(error) };
  }
};

export default defineLogicFunction({
  universalIdentifier: 'aaaaaaaa-0000-4000-8000-probe0marker',
  name: 'probe-marker-field',
  description: 'TEMPORARY: probes app-token createOneField for the marker arc.',
  timeoutSeconds: 30,
  handler,
  // Every 2 minutes while the probe runs.
  cronTriggerSettings: { pattern: '*/2 * * * *' },
});
```

Note: `universalIdentifier` must be a valid UUID — replace the literal above with a fresh `uuidgen` value (the one shown is a shape reminder, not valid).

- [ ] **Step 2: Deploy locally and observe P1**

Run: `yarn twenty dev --once` (local remote; if a remote flag is needed, pass `-r dev` — never the default remote).
Wait for the cron to fire (≤2 min), read the function's run result/logs.
Expected: `{ probe: 'created', id: '<uuid>' }`. A second firing returns `{ probe: 'exists' }` (idempotence).
**P1 result recorded.**

- [ ] **Step 3: Observe P2 — field visibility (playwright)**

Open the local app (localhost:3000, "Continue with Email", prefilled credentials). Navigate to any Company record page.
Check, in order: (a) is `Overrides` visible in the Fields card? (b) if not, is it in the hidden-fields ("show more") section, revealable by the user? (c) is it greyed/uneditable in the UI once visible?
Expected: (a) or (b) true, (c) true.
**P2 result recorded** (which of a/b, and c).

- [ ] **Step 4: Observe P3 — user-token write to the view-only field**

In the authenticated page context (playwright `browser_evaluate`), run a GraphQL mutation against the workspace API updating that company's `fxOverrides` to `'probe'` (mirror the widget's mutation shape: `updateCompany(id, data: { fxOverrides: "probe" })`). Use the page's own auth (Apollo token from the page context) — do not read credentials from disk.
Expected: mutation succeeds; the record shows `probe`.
Then reset the value to null the same way.
**P3 result recorded.**

- [ ] **Step 5: Clean up and record**

Delete `src/logic-functions/probe-marker-field.ts`, redeploy (`yarn twenty dev --once`) so the cron is gone. Delete the probe field via Settings → Data model (or leave it: Task 5's ensure treats an existing field as `exists`; deleting is cleaner for later live checks).
Write `docs/superpowers/plans/2026-09-01-probe-results.md` with the three results (one line each, dated).

```bash
git add docs/superpowers/plans/2026-09-01-probe-results.md
git commit -m "docs(formula-field): record marker-arc platform probe results"
```

**STOP conditions (return to the user, do not proceed):**
- P1 fails → spec §5.1 fallback (front-side creation) needs a user decision.
- P2 fails entirely (field reachable nowhere on the record page) → the feature's core promise is broken; user decision.
- P3 fails → the widget toggle lane (Task 9) needs a redesign; user decision.

---

### Task 1: Pure marker computation (`override-marker.ts`)

**Files:**
- Create: `src/logic-functions/lib/override-marker.ts`
- Test: `src/logic-functions/lib/__tests__/override-marker.spec.ts`

**Interfaces:**
- Consumes: `FormulaDefinitionRecord` from `src/logic-functions/lib/types` (Task 4 adds `order` to it — until then the field is absent; this task adds it, see Step 3 note).
- Produces:
  - `MARKER_FIELD_NAME = 'fxOverrides'`, `MARKER_FIELD_LABEL = 'Overrides'`, `MARKER_FIELD_DESCRIPTION` (the verbatim description), `MARKER_FIELD_ICON = 'IconPinned'` — all `export const`.
  - `computeMarkerValue(objectName: string, definitions: FormulaDefinitionRecord[], activeOverrideFields: ReadonlySet<string>): string` — pure; returns `''` for "no overrides".

- [ ] **Step 1: Write the failing tests**

```ts
// src/logic-functions/lib/__tests__/override-marker.spec.ts
import { describe, expect, it } from 'vitest';
import {
  computeMarkerValue,
  MARKER_FIELD_NAME,
} from 'src/logic-functions/lib/override-marker';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

const definition = (
  overrides: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'f1',
  name: 'Deal Score',
  targetObject: 'opportunity',
  targetField: 'dealScore',
  enabled: true,
  allowOverride: true,
  order: 1,
  ...overrides,
});

describe('computeMarkerValue', () => {
  it('lists the labels of active-pinned fields, joined by ", "', () => {
    const defs = [
      definition(),
      definition({ id: 'f2', name: 'Tier', targetField: 'tier', order: 2 }),
    ];
    expect(
      computeMarkerValue('opportunity', defs, new Set(['dealScore', 'tier'])),
    ).toBe('Deal Score, Tier');
  });

  it('returns empty string when nothing is pinned', () => {
    expect(computeMarkerValue('opportunity', [definition()], new Set())).toBe('');
  });

  it('sorts by order asc nulls-last, then label', () => {
    const defs = [
      definition({ id: 'a', name: 'Zeta', targetField: 'zeta', order: null }),
      definition({ id: 'b', name: 'Beta', targetField: 'beta', order: 5 }),
      definition({ id: 'c', name: 'Alpha', targetField: 'alpha', order: null }),
    ];
    expect(
      computeMarkerValue('opportunity', defs, new Set(['zeta', 'beta', 'alpha'])),
    ).toBe('Beta, Alpha, Zeta');
  });

  it('falls back to targetField when name is blank (app-wide label rule)', () => {
    const defs = [definition({ name: '' })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe(
      'dealScore',
    );
  });

  it('excludes locked definitions even when a stray pin exists (ADR 0028 D2)', () => {
    const defs = [definition({ allowOverride: false })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe('');
  });

  it('excludes disabled definitions (spec §4 step 1)', () => {
    const defs = [definition({ enabled: false })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe('');
  });

  it('treats legacy null allowOverride as allowed', () => {
    const defs = [definition({ allowOverride: null })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe(
      'Deal Score',
    );
  });

  it('ignores pins with no backing definition (variation-sync pins)', () => {
    expect(
      computeMarkerValue('opportunity', [definition()], new Set(['someSyncedField'])),
    ).toBe('');
  });

  it('ignores definitions for other objects', () => {
    const defs = [definition({ targetObject: 'company' })];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe('');
  });

  it('dedupes two definitions sharing a targetField (first in sort order wins)', () => {
    const defs = [
      definition({ id: 'f1', name: 'New Score', order: 1 }),
      definition({ id: 'f2', name: 'Old Score', order: 2 }),
    ];
    expect(computeMarkerValue('opportunity', defs, new Set(['dealScore']))).toBe(
      'New Score',
    );
  });

  it('exports the marker field name', () => {
    expect(MARKER_FIELD_NAME).toBe('fxOverrides');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run src/logic-functions/lib/__tests__/override-marker.spec.ts`
Expected: FAIL — module `override-marker` not found, and (if `order` is missing from the type) a type error on the fixture.

- [ ] **Step 3: Add `order` to `FormulaDefinitionRecord`**

In `src/logic-functions/lib/types.ts`, inside `FormulaDefinitionRecord` (after `allowOverride`):

```ts
  // Display position in the record-page Formulas tab; drives the marker's
  // deterministic label order (spec §4 step 4).
  order?: number | null;
```

(Verify the type lives in `types.ts` with `grep -n "FormulaDefinitionRecord = {" src/logic-functions/lib/`; if it is defined elsewhere, edit it there instead.)

- [ ] **Step 4: Implement `override-marker.ts`**

```ts
// src/logic-functions/lib/override-marker.ts
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

export const MARKER_FIELD_NAME = 'fxOverrides';
export const MARKER_FIELD_LABEL = 'Overrides';
export const MARKER_FIELD_DESCRIPTION =
  'Formula fields currently overridden on this record. Managed by the Formula Field app.';
export const MARKER_FIELD_ICON = 'IconPinned';

const definitionLabel = (definition: FormulaDefinitionRecord): string =>
  definition.name || definition.targetField || '';

// The record's expected "Overrides" value: labels of this object's enabled,
// override-allowed formula fields that currently hold an active pin, in the
// Formulas tab's display order. '' means "no overrides" (stored as SQL NULL).
export const computeMarkerValue = (
  objectName: string,
  definitions: FormulaDefinitionRecord[],
  activeOverrideFields: ReadonlySet<string>,
): string => {
  const eligible = definitions
    .filter((definition) => definition.targetObject === objectName)
    .filter((definition) => definition.enabled === true)
    .filter((definition) => definition.allowOverride !== false)
    .filter((definition) =>
      activeOverrideFields.has(definition.targetField ?? ''),
    )
    .sort((a, b) => {
      const orderA = a.order ?? Number.POSITIVE_INFINITY;
      const orderB = b.order ?? Number.POSITIVE_INFINITY;
      if (orderA !== orderB) return orderA - orderB;
      return definitionLabel(a).localeCompare(definitionLabel(b));
    });

  const seenFields = new Set<string>();
  const labels: string[] = [];
  for (const definition of eligible) {
    const field = definition.targetField ?? '';
    if (seenFields.has(field)) continue;
    seenFields.add(field);
    labels.push(definitionLabel(definition));
  }
  return labels.join(', ');
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn vitest run src/logic-functions/lib/__tests__/override-marker.spec.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/logic-functions/lib/override-marker.ts src/logic-functions/lib/__tests__/override-marker.spec.ts src/logic-functions/lib/types.ts
git commit -m "feat(formula-field): pure marker computation for the Overrides field"
```

---

### Task 2: Repository additions (`override-repository.ts`)

**Files:**
- Modify: `src/logic-functions/lib/override-repository.ts` (upsert return signal; new object-scoped loader)
- Test: `src/logic-functions/lib/__tests__/override-repository-marker.spec.ts` (new file)

**Interfaces:**
- Consumes: existing `findOverride`, `OVERRIDE_FIELDS`, `withRetry`, `OverrideRecord`, `OverrideValue`.
- Produces:
  - `upsertOverride(...): Promise<UpsertOverrideResult>` where `export type UpsertOverrideResult = 'created' | 'updated' | 'noop'` — same parameters as today (`client, targetObject, targetField, recordId, value`). Existing callers ignore the result and keep compiling.
  - `loadOverridesForObject(client: FormulaClient, targetObject: string, pageSize = 500): Promise<OverrideRecord[]>` — ALL pin rows for the object, **any** `active` state, paginated.

- [ ] **Step 1: Write the failing tests**

```ts
// src/logic-functions/lib/__tests__/override-repository-marker.spec.ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadOverridesForObject,
  upsertOverride,
} from 'src/logic-functions/lib/override-repository';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('upsertOverride result signal', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
  });

  it("returns 'created' for a new pin", async () => {
    const result = await upsertOverride(client, 'opportunity', 'dealScore', 'o1', {
      numeric: 42,
    });
    expect(result).toBe('created');
  });

  it("returns 'updated' when the pinned value changes", async () => {
    client.seed('formulaOverride', [
      {
        id: 'pin1',
        name: 'opportunity.dealScore#o1',
        targetObject: 'opportunity',
        targetField: 'dealScore',
        recordId: 'o1',
        overrideValue: 1,
        overrideValueText: null,
        active: true,
      },
    ]);
    const result = await upsertOverride(client, 'opportunity', 'dealScore', 'o1', {
      numeric: 2,
    });
    expect(result).toBe('updated');
  });

  it("returns 'noop' (and mutates nothing) when the pin is already correct", async () => {
    client.seed('formulaOverride', [
      {
        id: 'pin1',
        name: 'opportunity.dealScore#o1',
        targetObject: 'opportunity',
        targetField: 'dealScore',
        recordId: 'o1',
        overrideValue: 42,
        overrideValueText: null,
        active: true,
      },
    ]);
    const before = client.mutations;
    const result = await upsertOverride(client, 'opportunity', 'dealScore', 'o1', {
      numeric: 42,
    });
    expect(result).toBe('noop');
    expect(client.mutations).toBe(before);
  });
});

describe('loadOverridesForObject', () => {
  it('returns active AND inactive rows for the object, none for others', async () => {
    const client = new FakeClient();
    client.seed('formulaOverride', [
      {
        id: 'p1',
        name: 'opportunity.dealScore#o1',
        targetObject: 'opportunity',
        targetField: 'dealScore',
        recordId: 'o1',
        overrideValue: 1,
        overrideValueText: null,
        active: true,
      },
      {
        id: 'p2',
        name: 'opportunity.tier#o2',
        targetObject: 'opportunity',
        targetField: 'tier',
        recordId: 'o2',
        overrideValue: null,
        overrideValueText: '"GOLD"',
        active: false,
      },
      {
        id: 'p3',
        name: 'company.score#c1',
        targetObject: 'company',
        targetField: 'score',
        recordId: 'c1',
        overrideValue: 3,
        overrideValueText: null,
        active: true,
      },
    ]);
    const rows = await loadOverridesForObject(client, 'opportunity');
    expect(rows.map((row) => row.id).sort()).toEqual(['p1', 'p2']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run src/logic-functions/lib/__tests__/override-repository-marker.spec.ts`
Expected: FAIL — `loadOverridesForObject` not exported; result assertions get `undefined`.

- [ ] **Step 3: Implement**

In `upsertOverride` (`override-repository.ts:198-246`): change the return type to `Promise<UpsertOverrideResult>`, add the type export above the function, and return from the three exits — `'noop'` when the existing row needs no change (the current bare `return;` at line 226), `'updated'` after the `updateFormulaOverride` mutation, `'created'` after the `createFormulaOverride` mutation:

```ts
export type UpsertOverrideResult = 'created' | 'updated' | 'noop';
```

Add the loader after `loadActiveOverridesForRecord`, mirroring its pagination shape exactly, with the filter reduced to the object and no `active` clause:

```ts
// Every pin row for the object, active or not — deactivated rows persist and
// mark records that ever held a pin, which the marker sweep needs (spec §5.5).
export const loadOverridesForObject = async (
  client: FormulaClient,
  targetObject: string,
  pageSize = 500,
): Promise<OverrideRecord[]> => {
  const rows: OverrideRecord[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        formulaOverrides: {
          __args: {
            first: pageSize,
            filter: { targetObject: { eq: targetObject } },
            ...(after ? { after } : {}),
          },
          edges: { node: OVERRIDE_FIELDS },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.formulaOverrides;
    for (const edge of connection?.edges ?? []) {
      if (edge?.node?.targetField) rows.push(edge.node as OverrideRecord);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return rows;
};
```

- [ ] **Step 4: Run the new tests AND the full existing override suites**

Run: `yarn vitest run src/logic-functions/lib/__tests__/override-repository-marker.spec.ts src/logic-functions/lib/__tests__/override-repository-active-fields.spec.ts src/logic-functions/lib/__tests__/handlers.spec.ts`
Expected: all PASS (the return-type change is additive; callers ignore it today).

- [ ] **Step 5: Commit**

```bash
git add src/logic-functions/lib/override-repository.ts src/logic-functions/lib/__tests__/override-repository-marker.spec.ts
git commit -m "feat(formula-field): upsertOverride result signal and object-scoped pin loader"
```

---

### Task 3: Containment — syncable set, front replica, timeline cleanup

**Files:**
- Modify: `src/logic-functions/lib/syncable-fields.ts` (one filter line in `computeSyncableFields`, lines 60-66)
- Modify: `src/front-components/lib/variation-setup-logic.ts` (one filter line in `countSyncableFields`, lines 119-135)
- Modify: `src/logic-functions/lib/timeline-cleanup.ts` (one line in `loadFormulaManagedByObject`, lines 170-181)
- Test: extend the existing suites for each of the three (find them: `grep -rln "computeSyncableFields\|countSyncableFields\|loadFormulaManagedByObject" src/**/__tests__/`); if a function has no direct suite, add the case to the nearest consumer suite (e.g. `timeline-cleanup.spec.ts`).

**Interfaces:**
- Consumes: `MARKER_FIELD_NAME` from Task 1.
- Produces: no new exports; three behavioral guarantees the rest of the plan relies on: the marker is never syncable (server or front count) and marker keys classify as formula-managed in timeline cleanup.

- [ ] **Step 1: Write the failing tests**

Add to the suite covering `computeSyncableFields` (mirror its existing fixture style — it uses the `__setFakeObjectsWithFieldsForTests` seam from `metadata-objects.ts` plus a `FakeClient` for the formula exclusion list):

```ts
it('never treats the fxOverrides marker as syncable', async () => {
  // Fixture: one object 'opportunity' whose fields include a plain TEXT field
  // named 'fxOverrides' (isActive: true, isSystem: false, isUnique: false)
  // alongside one genuinely syncable TEXT field 'notes'. No formula targets it.
  const fields = await computeSyncableFields(client, 'opportunity', 'primaryLink');
  expect(fields.map((field) => field.name)).toContain('notes');
  expect(fields.map((field) => field.name)).not.toContain('fxOverrides');
});
```

Add to the suite covering `countSyncableFields` (pure function — build a `VariationTargetObject` literal):

```ts
it('excludes the fxOverrides marker from the syncable count', () => {
  const object = {
    id: 'obj1',
    nameSingular: 'opportunity',
    labelIdentifierFieldMetadataId: 'label-field',
    fields: [
      { id: 'a', name: 'notes', type: 'TEXT', isActive: true, isSystem: false },
      { id: 'b', name: 'fxOverrides', type: 'TEXT', isActive: true, isSystem: false },
    ],
  };
  expect(countSyncableFields(object, 'primaryLink')).toBe(1);
});
```

Add to the timeline-cleanup suite (mirror how it seeds a `formulaDefinition` and asserts key classification):

```ts
it('classifies the fxOverrides key as formula-managed for objects with definitions', async () => {
  // Seed one definition targeting opportunity.dealScore, then feed the
  // classifier a timeline diff whose keys are ['fxOverrides'] on an
  // opportunity row. Assert the row is treated as app-managed (deleted /
  // stripped), NOT kept as a human edit.
});
```

(Write the third test against the suite's real helper names — the classification lives around `timeline-cleanup.ts:422-433`; the suite already has fixtures exercising `formulaKeys` vs `otherKeys`. Copy the nearest existing case and swap the key for `fxOverrides`.)

- [ ] **Step 2: Run to verify the new cases fail**

Run: `yarn vitest run <the three suite files>`
Expected: the three new cases FAIL (marker currently syncable / counted / other-key), everything else PASS.

- [ ] **Step 3: Implement the three one-liners**

`syncable-fields.ts` — add after the `formulaTargetFields` filter (line 65):

```ts
import { MARKER_FIELD_NAME } from 'src/logic-functions/lib/override-marker';
...
    .filter((field) => !formulaTargetFields.has(field.name))
    // The app's own Overrides marker must never sync onto variations (spec §3).
    .filter((field) => field.name !== MARKER_FIELD_NAME)
```

`variation-setup-logic.ts` — same filter inside `countSyncableFields`, after the `INVERSE_FIELD_NAME` filter (line 128):

```ts
import { MARKER_FIELD_NAME } from 'src/logic-functions/lib/override-marker';
...
    .filter((field) => field.name !== MARKER_FIELD_NAME)
```

`timeline-cleanup.ts` — in `loadFormulaManagedByObject`'s per-edge loop (after line 179's `fields.add(companionFieldName(targetField));`):

```ts
    fields.add(MARKER_FIELD_NAME);
```

(plus the import). This registers the marker per object-with-definitions, which is the spec's accepted scope (§3's residue note covers definition-less objects).

- [ ] **Step 4: Run the three suites, verify PASS**

Run: `yarn vitest run <the three suite files>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logic-functions/lib/syncable-fields.ts src/front-components/lib/variation-setup-logic.ts src/logic-functions/lib/timeline-cleanup.ts <test files>
git commit -m "feat(formula-field): fence the fxOverrides marker out of sync and timeline noise"
```

---

### Task 4: `order` in server selections + shared convergence helper

**Files:**
- Modify: `src/logic-functions/lib/formula-repository.ts` (add `order: true` to `FORMULA_FIELDS`, lines 13-32)
- Create: `src/logic-functions/lib/marker-converge.ts`
- Test: `src/logic-functions/lib/__tests__/marker-converge.spec.ts`

**Interfaces:**
- Consumes: `computeMarkerValue`, `MARKER_FIELD_NAME` (Task 1); `loadOverridesForObject` (Task 2); `flushBatchedWrites`, `PendingWrite` from `src/logic-functions/lib/batch-write`; `textValuesConverged` from `value-io`; `loadEnabledFormulas` from `formula-repository`.
- Produces:
  - `markerFieldExistsOnObject(objectName: string): Promise<boolean>` — cached-catalog check via `loadAllObjectsWithFields`.
  - `convergeMarkersForRecords(args: { client: FormulaClient; objectName: string; recordIds: string[]; definitions: FormulaDefinitionRecord[]; pinRows: OverrideRecord[]; currentValues?: Map<string, string | null> }): Promise<{ written: number }>` — computes expected per record from `pinRows` (active only), reads current marker values for ids missing from `currentValues` (chunked `id in` record query), diff-guards, batches writes.
  - `convergeMarkersForColumn(client: FormulaClient, targetObject: string, targetField: string): Promise<{ written: number; records: number }>` — enumerates the column's pin rows (any state, via a paginated query mirroring `loadOverridesForObject` but with the `targetField` filter added), loads enabled definitions for the object, loads the object's full pin set, and delegates to `convergeMarkersForRecords`. Skips entirely (returns zeros) when `markerFieldExistsOnObject` is false.
  - (Task 6 later adds `convergeMarkerAfterEvent` to this same module, reusing this task's private `loadCurrentMarkerValues`.)

- [ ] **Step 1: Add `order: true` to `FORMULA_FIELDS`**

In `formula-repository.ts`, inside the `FORMULA_FIELDS` selection object (alongside `name: true`), add:

```ts
  order: true,
```

Run: `yarn vitest run src/logic-functions/lib/__tests__/` — expected: existing suites still PASS (an extra selected scalar; `FakeClient` returns whatever is seeded).

- [ ] **Step 2: Write the failing tests**

```ts
// src/logic-functions/lib/__tests__/marker-converge.spec.ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  convergeMarkersForColumn,
  convergeMarkersForRecords,
} from 'src/logic-functions/lib/marker-converge';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import { __setFakeObjectsWithFieldsForTests } from 'src/logic-functions/lib/metadata-objects';

const opportunityWithMarker = {
  id: 'obj-opportunity',
  nameSingular: 'opportunity',
  labelIdentifierFieldMetadataId: null,
  fields: [
    { id: 'fld-marker', name: 'fxOverrides', type: 'TEXT', isActive: true, isSystem: false },
    { id: 'fld-score', name: 'dealScore', type: 'NUMBER', isActive: true, isSystem: false },
  ],
};

const scoreDefinition = {
  id: 'f1',
  name: 'Deal Score',
  targetObject: 'opportunity',
  targetField: 'dealScore',
  targetFieldType: 'NUMBER',
  expression: 'a + 1',
  enabled: true,
  allowOverride: true,
  order: 1,
};

const activePin = {
  id: 'p1',
  name: 'opportunity.dealScore#o1',
  targetObject: 'opportunity',
  targetField: 'dealScore',
  recordId: 'o1',
  overrideValue: 42,
  overrideValueText: null,
  active: true,
};

describe('convergeMarkersForRecords', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
  });

  it('writes the expected marker when it differs', async () => {
    client.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);
    const result = await convergeMarkersForRecords({
      client,
      objectName: 'opportunity',
      recordIds: ['o1'],
      definitions: [scoreDefinition],
      pinRows: [activePin],
    });
    expect(result.written).toBe(1);
    expect(client.writes).toContain('opportunity:o1:fxOverrides="Deal Score"');
  });

  it('is a no-op when converged, including blank-vs-null (F3 guard)', async () => {
    client.seed('opportunity', [{ id: 'o1', fxOverrides: null }]);
    const result = await convergeMarkersForRecords({
      client,
      objectName: 'opportunity',
      recordIds: ['o1'],
      definitions: [scoreDefinition],
      pinRows: [{ ...activePin, active: false }],
    });
    expect(result.written).toBe(0);
    expect(client.writes).toHaveLength(0);
  });

  it('converges a stale marker back to blank when the pin is inactive', async () => {
    client.seed('opportunity', [{ id: 'o1', fxOverrides: 'Deal Score' }]);
    const result = await convergeMarkersForRecords({
      client,
      objectName: 'opportunity',
      recordIds: ['o1'],
      definitions: [scoreDefinition],
      pinRows: [{ ...activePin, active: false }],
    });
    expect(result.written).toBe(1);
    expect(client.writes).toContain('opportunity:o1:fxOverrides=""');
  });
});

describe('convergeMarkersForColumn', () => {
  it('skips everything when the object has no marker field', async () => {
    __setFakeObjectsWithFieldsForTests([
      { ...opportunityWithMarker, fields: opportunityWithMarker.fields.slice(1) },
    ]);
    const client = new FakeClient();
    client.seed('formulaOverride', [activePin]);
    const result = await convergeMarkersForColumn(client, 'opportunity', 'dealScore');
    expect(result).toEqual({ written: 0, records: 0 });
    expect(client.writes).toHaveLength(0);
  });

  it('converges every record that ever had a pin on the column', async () => {
    __setFakeObjectsWithFieldsForTests([opportunityWithMarker]);
    const client = new FakeClient();
    client.seed('formulaDefinition', [scoreDefinition]);
    client.seed('formulaOverride', [
      activePin,
      { ...activePin, id: 'p2', name: 'opportunity.dealScore#o2', recordId: 'o2', active: false },
    ]);
    client.seed('opportunity', [
      { id: 'o1', fxOverrides: null },
      { id: 'o2', fxOverrides: 'Deal Score' },
    ]);
    const result = await convergeMarkersForColumn(client, 'opportunity', 'dealScore');
    expect(result.records).toBe(2);
    expect(client.writes).toContain('opportunity:o1:fxOverrides="Deal Score"');
    expect(client.writes).toContain('opportunity:o2:fxOverrides=""');
  });
});
```

Fixture note: `__setFakeObjectsWithFieldsForTests` is the existing test seam in `metadata-objects.ts` (verify its exact export name with grep; existing suites use it). If the suite needs cleanup between files, mirror how existing suites reset it (an `afterEach(() => __setFakeObjectsWithFieldsForTests(null))` or equivalent).

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn vitest run src/logic-functions/lib/__tests__/marker-converge.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `marker-converge.ts`**

```ts
// src/logic-functions/lib/marker-converge.ts
import { flushBatchedWrites, type PendingWrite } from 'src/logic-functions/lib/batch-write';
import { loadEnabledFormulas } from 'src/logic-functions/lib/formula-repository';
import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import {
  computeMarkerValue,
  MARKER_FIELD_NAME,
} from 'src/logic-functions/lib/override-marker';
import {
  loadOverridesForObject,
  type OverrideRecord,
} from 'src/logic-functions/lib/override-repository';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { textValuesConverged } from 'src/logic-functions/lib/value-io';
import { withRetry } from 'src/logic-functions/lib/with-retry';

export const markerFieldExistsOnObject = async (
  objectName: string,
): Promise<boolean> => {
  // Metadata unavailable -> "no field" -> the marker step degrades to a no-op
  // and the sweep retries. Throwing here would abort the whole record handler.
  try {
    const objects = await loadAllObjectsWithFields();
    const object = objects.find(
      (candidate) => candidate.nameSingular === objectName,
    );
    return (
      object?.fields.some(
        (field) => field.name === MARKER_FIELD_NAME && field.isActive,
      ) ?? false
    );
  } catch {
    return false;
  }
};

const activeFieldSetByRecord = (
  pinRows: OverrideRecord[],
): Map<string, Set<string>> => {
  const byRecord = new Map<string, Set<string>>();
  for (const row of pinRows) {
    if (!row.active) continue;
    const fields = byRecord.get(row.recordId) ?? new Set<string>();
    fields.add(row.targetField);
    byRecord.set(row.recordId, fields);
  }
  return byRecord;
};

// Chunked read of current marker values. Mirrors the record-scan query shape
// recomputeAllRecords uses (a plural connection filtered by id) — verify the
// exact plural key against recompute.ts's record query and reuse its
// pluralization helper rather than hand-rolling one.
const loadCurrentMarkerValues = async (
  client: FormulaClient,
  objectName: string,
  recordIds: string[],
): Promise<Map<string, string | null>> => {
  const values = new Map<string, string | null>();
  const CHUNK = 100;
  for (let start = 0; start < recordIds.length; start += CHUNK) {
    const chunk = recordIds.slice(start, start + CHUNK);
    const response = await withRetry(() =>
      client.query({
        [pluralQueryKey(objectName)]: {
          __args: { first: CHUNK, filter: { id: { in: chunk } } },
          edges: { node: { id: true, [MARKER_FIELD_NAME]: true } },
        },
      }),
    );
    for (const edge of response?.[pluralQueryKey(objectName)]?.edges ?? []) {
      if (edge?.node?.id) {
        values.set(
          edge.node.id,
          (edge.node[MARKER_FIELD_NAME] as string | null | undefined) ?? null,
        );
      }
    }
  }
  return values;
};

export const convergeMarkersForRecords = async ({
  client,
  objectName,
  recordIds,
  definitions,
  pinRows,
  currentValues,
}: {
  client: FormulaClient;
  objectName: string;
  recordIds: string[];
  definitions: FormulaDefinitionRecord[];
  pinRows: OverrideRecord[];
  currentValues?: Map<string, string | null>;
}): Promise<{ written: number }> => {
  const uniqueIds = [...new Set(recordIds)];
  if (uniqueIds.length === 0) return { written: 0 };

  const known = currentValues ?? new Map<string, string | null>();
  const missing = uniqueIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    const fetched = await loadCurrentMarkerValues(client, objectName, missing);
    for (const [id, value] of fetched) known.set(id, value);
  }

  const activeByRecord = activeFieldSetByRecord(pinRows);
  const writes: PendingWrite[] = [];
  for (const recordId of uniqueIds) {
    // A record absent from `known` after the fetch no longer exists — skip.
    if (!known.has(recordId)) continue;
    const expected = computeMarkerValue(
      objectName,
      definitions,
      activeByRecord.get(recordId) ?? new Set<string>(),
    );
    if (!textValuesConverged(expected, known.get(recordId) ?? null)) {
      writes.push({ recordId, data: { [MARKER_FIELD_NAME]: expected } });
    }
  }
  if (writes.length > 0) {
    await flushBatchedWrites(client, objectName, writes);
  }
  return { written: writes.length };
};

export const convergeMarkersForColumn = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
): Promise<{ written: number; records: number }> => {
  if (!(await markerFieldExistsOnObject(targetObject))) {
    return { written: 0, records: 0 };
  }
  const objectPins = await loadOverridesForObject(client, targetObject);
  const columnRecordIds = objectPins
    .filter((row) => row.targetField === targetField)
    .map((row) => row.recordId);
  if (columnRecordIds.length === 0) return { written: 0, records: 0 };

  const definitions = await loadEnabledFormulas(client, targetObject);
  const { written } = await convergeMarkersForRecords({
    client,
    objectName: targetObject,
    recordIds: columnRecordIds,
    definitions,
    pinRows: objectPins,
    // Marker computation must see the record's WHOLE pin set, not just this
    // column's — hence objectPins, filtered only for the candidate ids.
  });
  return { written, records: new Set(columnRecordIds).size };
};
```

`pluralQueryKey` is just `pluralize` from `src/logic-functions/lib/plural.ts` (the canonical pluralizer, split into its own leaf module precisely to avoid cycles; `batch-write.ts:1` and `recompute.ts` already import it). Import it directly and delete the `pluralQueryKey` indirection, or alias it locally. Do NOT write a second pluralizer and do NOT add an export to `batch-write.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn vitest run src/logic-functions/lib/__tests__/marker-converge.spec.ts`
Expected: PASS. `FakeClient` serves plural record connections generically for every seeded object (`fake-client.ts:150-159` matches `pluralize(object) === key`), including `id: { in }` filters and `update<Plural>` batch mutations — no `FakeClient` extension is needed; do not modify the shared fake.

- [ ] **Step 6: Commit**

```bash
git add src/logic-functions/lib/marker-converge.ts src/logic-functions/lib/__tests__/marker-converge.spec.ts src/logic-functions/lib/formula-repository.ts
git commit -m "feat(formula-field): shared marker convergence helper and order selection"
```

---

### Task 5: Lazy field creation (`ensure-marker-field.ts`)

**Files:**
- Create: `src/logic-functions/lib/find-fields.ts` (pure lift of `findFields` + its types out of `handle-definition-lifecycle.ts`)
- Modify: `src/logic-functions/lib/handle-definition-lifecycle.ts` (delete the moved function, import from the new module) and every other importer of `findFields` (grep `from 'src/logic-functions/lib/handle-definition-lifecycle'` and retarget only the `findFields`/`FieldMetadataInfo`/`MetadataQueryClient` bindings)
- Create: `src/logic-functions/lib/ensure-marker-field.ts`
- Test: `src/logic-functions/lib/__tests__/ensure-marker-field.spec.ts`

**Interfaces:**
- Consumes: `MARKER_FIELD_NAME/LABEL/DESCRIPTION/ICON` from Task 1; `MetadataApiClient` from `twenty-client-sdk/metadata`.
- Produces: `findFields` (unchanged behavior, new home `find-fields.ts`); `ensureMarkerFieldExists(objectName: string, metadataClient?): Promise<'created' | 'exists' | 'failed'>`.
- WHY the lift: without it, Tasks 6+7 close an import cycle (`marker-converge.ts` → `ensure-marker-field.ts` → `handle-definition-lifecycle.ts` → `marker-converge.ts`) that lint will not catch and Vite may resolve to an `undefined` binding depending on test entry order. `find-fields.ts` must import nothing from the app beyond the SDK client and `types`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/logic-functions/lib/__tests__/ensure-marker-field.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { ensureMarkerFieldExists } from 'src/logic-functions/lib/ensure-marker-field';

// findFields takes an injectable metadata client ({ query, mutation }) —
// build a stub that answers the objects query, then capture the create call.
const metadataStub = (existingFieldNames: string[]) => {
  const mutation = vi.fn().mockResolvedValue({
    createOneField: { id: 'new-field', name: 'fxOverrides' },
  });
  const query = vi.fn().mockResolvedValue({
    objects: {
      edges: [
        {
          node: {
            id: 'obj-1',
            nameSingular: 'opportunity',
            fields: {
              edges: existingFieldNames.map((name, index) => ({
                node: { id: `fld-${index}`, name, isActive: true },
              })),
            },
          },
        },
      ],
    },
  });
  return { query, mutation };
};

describe('ensureMarkerFieldExists', () => {
  it('creates the field with the exact contract when missing', async () => {
    const stub = metadataStub(['dealScore']);
    const result = await ensureMarkerFieldExists('opportunity', stub);
    expect(result).toBe('created');
    const input = stub.mutation.mock.calls[0][0].createOneField.__args.input.field;
    expect(input).toMatchObject({
      objectMetadataId: 'obj-1',
      type: 'TEXT',
      name: 'fxOverrides',
      label: 'Overrides',
      icon: 'IconPinned',
      isUIEditable: false,
    });
  });

  it("returns 'exists' without mutating when the field is already there", async () => {
    const stub = metadataStub(['fxOverrides']);
    const result = await ensureMarkerFieldExists('opportunity', stub);
    expect(result).toBe('exists');
    expect(stub.mutation).not.toHaveBeenCalled();
  });

  it("returns 'failed' (never throws) when metadata is unavailable", async () => {
    const stub = metadataStub([]);
    stub.query.mockRejectedValue(new Error('metadata down'));
    await expect(ensureMarkerFieldExists('opportunity', stub)).resolves.toBe('failed');
  });

  it("returns 'failed' when the create mutation is rejected", async () => {
    const stub = metadataStub(['dealScore']);
    stub.mutation.mockRejectedValue(new Error('forbidden'));
    await expect(ensureMarkerFieldExists('opportunity', stub)).resolves.toBe('failed');
  });
});
```

(Type note: match the second parameter's type to `findFields`' `MetadataQueryClient` — grep its definition; if it is query-only, widen the ensure function's own parameter to a small local type with both `query` and `mutation`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run src/logic-functions/lib/__tests__/ensure-marker-field.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Lift `findFields`, then implement**

First the lift: move `findFields`, `FieldMetadataInfo`, and `MetadataQueryClient` verbatim from `handle-definition-lifecycle.ts:40-87` into new `src/logic-functions/lib/find-fields.ts` (with the `MetadataApiClient` import it needs); replace the originals in `handle-definition-lifecycle.ts` with an import from the new module; retarget other importers found by grep. Run `yarn test` — everything still green before proceeding (pure move).

```ts
// src/logic-functions/lib/ensure-marker-field.ts
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { findFields } from 'src/logic-functions/lib/find-fields';
import {
  MARKER_FIELD_DESCRIPTION,
  MARKER_FIELD_ICON,
  MARKER_FIELD_LABEL,
  MARKER_FIELD_NAME,
} from 'src/logic-functions/lib/override-marker';

type MarkerMetadataClient = {
  query: (selection: unknown) => Promise<unknown>;
  mutation: (selection: unknown) => Promise<unknown>;
};

export type EnsureMarkerFieldResult = 'created' | 'exists' | 'failed';

// Lazy, once-ever-per-object creation of the Overrides marker (spec §5.1).
// Uncached lookup first — mutations need live state, not the 60s catalog.
// isUIEditable is create-time-only (ADR 0028), so it must be in this input.
export const ensureMarkerFieldExists = async (
  objectName: string,
  metadataClient: MarkerMetadataClient = new MetadataApiClient(),
): Promise<EnsureMarkerFieldResult> => {
  try {
    const { objectMetadataId, fields } = await findFields(
      objectName,
      [MARKER_FIELD_NAME],
      metadataClient,
    );
    if (!objectMetadataId) return 'failed';
    if (fields.has(MARKER_FIELD_NAME)) return 'exists';
    await metadataClient.mutation({
      createOneField: {
        __args: {
          input: {
            field: {
              objectMetadataId,
              type: 'TEXT',
              name: MARKER_FIELD_NAME,
              label: MARKER_FIELD_LABEL,
              description: MARKER_FIELD_DESCRIPTION,
              icon: MARKER_FIELD_ICON,
              isUIEditable: false,
            },
          },
        },
        id: true,
        name: true,
      },
    });
    return 'created';
  } catch {
    return 'failed';
  }
};
```

Caveat: `findFields` swallows its own errors and returns an empty result — so the "metadata down" test exercises the `!objectMetadataId → 'failed'` path, which is the correct observable behavior either way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run src/logic-functions/lib/__tests__/ensure-marker-field.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logic-functions/lib/find-fields.ts src/logic-functions/lib/handle-definition-lifecycle.ts src/logic-functions/lib/ensure-marker-field.ts src/logic-functions/lib/__tests__/ensure-marker-field.spec.ts
git commit -m "feat(formula-field): lazy app-token creation of the Overrides marker field"
```

(Include any other files the `findFields` retargeting touched.)

---

### Task 6: Event lane (`handle-record-update.ts`)

**Files:**
- Modify: `src/logic-functions/lib/handle-record-update.ts` (track upsert results at both call sites, lines 392-398 and 456-462; append the marker step before the single `return outcomes;` at the end)
- Modify: `src/logic-functions/lib/marker-converge.ts` (add `convergeMarkerAfterEvent` — it lives with its Task 4 siblings and their private helpers)
- Test: `src/logic-functions/lib/__tests__/handle-record-update-marker.spec.ts` (new file; reuse `handlers.spec.ts`'s fixture idioms)

**Interfaces:**
- Consumes: `UpsertOverrideResult` (Task 2), `loadActiveOverridesForRecord` (existing), `computeMarkerValue`/`MARKER_FIELD_NAME` (Task 1), `markerFieldExistsOnObject` + `convergeMarkersForRecords`' inner pieces (Task 4), `textValuesConverged`, `flushBatchedWrites`. (Amended 2026-09-03: the event lane does NOT create the field — creation moved to definition creation, Task 7 — so Task 5's ensure helper is not consumed here.)
- Produces: no new exports; the behavioral contract of spec §5.2.

- [ ] **Step 1: Write the failing tests**

```ts
// src/logic-functions/lib/__tests__/handle-record-update-marker.spec.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import { __setFakeObjectsWithFieldsForTests } from 'src/logic-functions/lib/metadata-objects';

// One NUMBER formula on opportunity.dealScore, marker field present.
const seedBaseline = (client: FakeClient) => {
  client.seed('formulaDefinition', [
    {
      id: 'f1',
      name: 'Deal Score',
      targetObject: 'opportunity',
      targetField: 'dealScore',
      targetFieldType: 'NUMBER',
      expression: 'formulaInputA + 1',
      enabled: true,
      allowOverride: true,
      order: 1,
    },
  ]);
  __setFakeObjectsWithFieldsForTests([
    {
      id: 'obj-opportunity',
      nameSingular: 'opportunity',
      labelIdentifierFieldMetadataId: null,
      fields: [
        { id: 'a', name: 'fxOverrides', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'b', name: 'dealScore', type: 'NUMBER', isActive: true, isSystem: false },
        { id: 'c', name: 'formulaInputA', type: 'NUMBER', isActive: true, isSystem: false },
      ],
    },
  ]);
};

describe('handleRecordUpdate marker step', () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
    seedBaseline(client);
  });
  afterEach(() => __setFakeObjectsWithFieldsForTests(null));

  it('writes the marker when a human edit creates a pin', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: null },
    ]);
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: null },
      updatedFields: ['dealScore'],
      actorWorkspaceMemberId: 'member-1',
    });
    expect(client.writes).toContain('opportunity:o1:fxOverrides="Deal Score"');
  });

  it('does zero marker work on an app echo with an inherited actor (ADR 0006)', async () => {
    // Stored value equals the computed value -> no pin upserted -> gate skips.
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 2, fxOverrides: null },
    ]);
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 2, fxOverrides: null },
      updatedFields: ['dealScore'],
      actorWorkspaceMemberId: 'member-1',
    });
    expect(
      client.writes.filter((write) => write.includes('fxOverrides')),
    ).toHaveLength(0);
  });

  it('reverts a tampered marker (updatedFields contains the marker)', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 2, fxOverrides: 'HAND EDITED' },
    ]);
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 2, fxOverrides: 'HAND EDITED' },
      updatedFields: ['fxOverrides'],
      actorWorkspaceMemberId: 'member-1',
    });
    expect(client.writes).toContain('opportunity:o1:fxOverrides=""');
  });

  it('marker-write echo terminates: second invocation converges with zero writes', async () => {
    client.seed('formulaOverride', [
      {
        id: 'p1',
        name: 'opportunity.dealScore#o1',
        targetObject: 'opportunity',
        targetField: 'dealScore',
        recordId: 'o1',
        overrideValue: 99,
        overrideValueText: null,
        active: true,
      },
    ]);
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: 'Deal Score' },
    ]);
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: 'Deal Score' },
      updatedFields: ['fxOverrides'],
      actorWorkspaceMemberId: null,
    });
    expect(
      client.writes.filter((write) => write.includes('fxOverrides')),
    ).toHaveLength(0);
  });

  it('blank-over-blank never writes, including an after payload missing the marker key', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 99, fxOverrides: null },
    ]);
    // Human edit creates a pin, but `after` omits fxOverrides -> the step must
    // FETCH, see blank, and (pin now active) write once — then the echo, whose
    // payload also omits the key, must fetch and converge without writing.
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99 },
      updatedFields: ['dealScore'],
      actorWorkspaceMemberId: 'member-1',
    });
    const markerWrites = () =>
      client.writes.filter((write) => write.includes('fxOverrides'));
    expect(markerWrites()).toHaveLength(1);
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 99 },
      updatedFields: ['fxOverrides'],
      actorWorkspaceMemberId: null,
    });
    expect(markerWrites()).toHaveLength(1);
  });

  it('does zero marker work on an unrelated-field human edit', async () => {
    client.seed('opportunity', [
      { id: 'o1', formulaInputA: 1, dealScore: 2, notes: 'x', fxOverrides: null },
    ]);
    const before = client.queries;
    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', formulaInputA: 1, dealScore: 2, notes: 'x', fxOverrides: null },
      updatedFields: ['notes'],
      actorWorkspaceMemberId: 'member-1',
    });
    expect(
      client.querySelections.filter(
        (selection) => selection.formulaOverrides?.__args?.filter?.recordId,
      ),
    ).toHaveLength(0);
    void before;
  });
});
```

(Adjust fixture details to `FakeClient` reality as you go — e.g. whether the engine recompute needs `formulaInputA` seeded on the record for the pin-detection compute; `handlers.spec.ts:1077-1122` shows the working shape.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run src/logic-functions/lib/__tests__/handle-record-update-marker.spec.ts`
Expected: FAIL — no `fxOverrides` writes happen yet.

- [ ] **Step 3: Implement**

In `handle-record-update.ts`:

(a) Above the detection block (before line 327's `if`), declare:

```ts
  let pinChanged = false;
```

(b) At both upsert call sites (mirror lane line 392, engine lane line 456), capture the result:

```ts
        const upsertResult = await upsertOverride(
          client,
          objectName,
          field,
          recordId,
          overrideSlotForKind('raw', currentRaw), // engine site: overrideSlotForKind(targetKind, currentStored)
        );
        pinChanged = pinChanged || upsertResult !== 'noop';
```

(c) Immediately before the final `return outcomes;`, append the marker step:

```ts
  // Overrides marker (spec §5.2). Gate: pin state changed in THIS invocation,
  // or the marker itself was edited (tamper, or our own write's echo). Never
  // actor-based — app writes inherit the actor (ADR 0006).
  const markerTouched = updatedFields?.includes(MARKER_FIELD_NAME) ?? false;
  if (pinChanged || markerTouched) {
    try {
      await convergeMarkerAfterEvent({
        client,
        objectName,
        recordId,
        definitions: formulas,
        after,
      });
    } catch {
      // Best-effort: the marker must never fail the record handler; the
      // hourly sweep is its convergence backstop.
    }
  }

  return outcomes;
```

(d) `convergeMarkerAfterEvent` lives in `marker-converge.ts` (add it there in this task — it belongs with its siblings):

```ts
export const convergeMarkerAfterEvent = async ({
  client,
  objectName,
  recordId,
  definitions,
  after,
}: {
  client: FormulaClient;
  objectName: string;
  recordId: string;
  definitions: FormulaDefinitionRecord[];
  after: Record<string, unknown> | null | undefined;
}): Promise<void> => {
  // The field is created on definition creation (spec §5.1); a missing field
  // here means creation lags or the object only has locked definitions — skip.
  if (!(await markerFieldExistsOnObject(objectName))) return;

  const pins = await loadActiveOverridesForRecord(client, objectName, recordId);
  const expected = computeMarkerValue(
    objectName,
    definitions,
    new Set(pins.map((pin) => pin.targetField)),
  );

  // An absent payload key is UNKNOWN, never assumed blank — assuming blank
  // inverts the F3 loop in the non-blank cell (spec §5.2).
  const current =
    after && MARKER_FIELD_NAME in after
      ? ((after[MARKER_FIELD_NAME] as string | null | undefined) ?? null)
      : (await loadCurrentMarkerValues(client, objectName, [recordId])).get(
          recordId,
        ) ?? null;

  if (!textValuesConverged(expected, current)) {
    await flushBatchedWrites(client, objectName, [
      { recordId, data: { [MARKER_FIELD_NAME]: expected } },
    ]);
  }
};
```

(import for `loadActiveOverridesForRecord` added to `marker-converge.ts`; `handle-record-update.ts` imports `convergeMarkerAfterEvent` and `MARKER_FIELD_NAME` only).

- [ ] **Step 4: Run the new suite AND the full handlers suite**

Run: `yarn vitest run src/logic-functions/lib/__tests__/handle-record-update-marker.spec.ts src/logic-functions/lib/__tests__/handlers.spec.ts src/logic-functions/lib/__tests__/recompute.spec.ts`
Expected: all PASS. For suites that never set the metadata seam, `markerFieldExistsOnObject`'s try/catch turns the real-metadata fetch failure into `false`, so the step exits without queries — that catch is what keeps `handlers.spec.ts`'s many pin-creating tests green; verify no existing test regresses on query counts.

- [ ] **Step 5: Commit**

```bash
git add src/logic-functions/lib/handle-record-update.ts src/logic-functions/lib/marker-converge.ts src/logic-functions/lib/__tests__/handle-record-update-marker.spec.ts
git commit -m "feat(formula-field): event-lane Overrides marker with pin-upsert gate"
```

---

### Task 7: Lifecycle lanes (create, disable, trash, destroy)

**Files:**
- Modify: `src/logic-functions/lib/handle-formula-change.ts` (insert the disable-lane hook ABOVE the first `enabled === false` guard at lines 137-145; add the creation-lane ensure hook, amended 2026-09-03, see Step 3)
- Modify: `src/logic-functions/lib/handle-definition-lifecycle.ts` (`handleDefinitionDeleted` lines 152-166; `handleDefinitionDestroyed` lines 213-257: add `recordId` to the selection, paginate, guard on `anotherDefinitionTargets`, converge after)
- Test: extend `src/logic-functions/lib/__tests__/handlers.spec.ts` (or its lifecycle sibling — grep for the suite that covers `handleDefinitionDestroyed`) with the cases below.

**Interfaces:**
- Consumes: `convergeMarkersForColumn`, `convergeMarkersForRecords`, `markerFieldExistsOnObject` (Task 4); `loadOverridesForObject` (Task 2); `ensureMarkerFieldExists` (Task 5); `loadEnabledFormulas` (`formula-repository`, existing); `anotherDefinitionTargets` (existing), `withRetry` (existing).
- Produces: no new exports. `handleFormulaChange` gains an optional injectable `ensureMarkerField` parameter (default `ensureMarkerFieldExists`) so tests can observe the creation hook without a real metadata client; existing callers pass nothing.

- [ ] **Step 1: Write the failing tests**

Test cases (write them concretely against the existing suite's fixture helpers):

```ts
it('definition creation ensures the marker field for an override-allowed definition', async () => {
  // Act: handleFormulaChange({ client, after: { ...definition, allowOverride: true }, updatedFields: undefined, ensureMarkerField: spy })
  //      where spy = vi.fn().mockResolvedValue('created').
  // Assert: spy called once with 'opportunity'; the handler otherwise proceeds normally.
});

it('definition creation skips the ensure for a locked definition and for updates', async () => {
  // Case A: after.allowOverride === false, updatedFields undefined -> spy not called.
  // Case B: allowOverride true but updatedFields = ['expression'] (an update) -> spy not called.
});

it('a failed ensure never fails the handler', async () => {
  // spy resolves 'failed' -> handler result identical to the success case.
});

it('plain disable converges markers before the disabled-bookkeeping return', async () => {
  // Seed: enabled definition on opportunity.dealScore; active pin on o1;
  // o1.fxOverrides = 'Deal Score'; marker field in the metadata seam.
  // Act: handleFormulaChange with after = { ...definition, enabled: false },
  //      updatedFields (or the handler's changedFields source) = ['enabled'].
  // Assert: client.writes contains 'opportunity:o1:fxOverrides=""' AND the
  //         handler still returns { handled: false, reason: 'disabled-bookkeeping' }.
});

it('pure bookkeeping write on a disabled definition does zero marker work', async () => {
  // Same seed, but changedFields = ['lastError'] and after.enabled === false.
  // Assert: no fxOverrides writes, no formulaOverrides queries.
});

it('trash converges markers without deleting pins', async () => {
  // Seed as above. Act: handleDefinitionDeleted(client, definition).
  // Assert: 'opportunity:o1:fxOverrides=""' written; formulaOverride rows intact
  //         (no deleteFormulaOverride in client.mutationSelections).
});

it('destroy paginates past 200 pins and converges exactly the affected records', async () => {
  // Seed 250 pins (a loop) on the column + matching records with markers.
  // Act: handleDefinitionDestroyed(client, definition).
  // Assert: 250 deleteFormulaOverride mutations; every record's marker blanked.
});

it('destroy spares a shared column: second definition still targets it', async () => {
  // Seed TWO definitions with the same targetObject/targetField, pins on o1.
  // Act: handleDefinitionDestroyed(client, definitionA).
  // Assert: zero deleteFormulaOverride mutations; o1 marker unchanged
  //         (survivor still enabled, pin still active).
});
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `yarn vitest run <lifecycle suite file>`
Expected: new cases FAIL.

- [ ] **Step 3: Implement**

`handle-formula-change.ts` — creation lane (spec §5.1, amended 2026-09-03). Add `ensureMarkerField = ensureMarkerFieldExists` as an optional destructured parameter of `handleFormulaChange` (type `typeof ensureMarkerFieldExists`), and near the top of the handler, before validation and before any early return that a creation can hit:

```ts
  // Overrides marker field is created with the object's first override-allowed
  // definition (spec §5.1) so it can be positioned before any pin exists.
  // Creation events arrive with updatedFields === undefined. Best-effort: the
  // sweep's ensure arm retries hourly.
  if (
    updatedFields === undefined &&
    after.allowOverride !== false &&
    after.targetObject
  ) {
    await ensureMarkerField(after.targetObject);
  }
```

(Verify how `handleFormulaChange` distinguishes create from update today — `on-formula-definition-created.ts` passes `updatedFields: undefined`; if the handler already derives an `isCreation` flag, reuse it instead of re-deriving.)

`handle-formula-change.ts` — disable lane; insert ABOVE the line-137 guard:

```ts
  // Overrides marker: a definition leaving the enabled set must drop its label
  // from markers (spec §5.4). Runs above the disabled-bookkeeping recursion
  // guard deliberately — a plain human disable returns there and would never
  // reach a later hook. The includes('enabled') gate keeps pure bookkeeping
  // writes (which that guard exists to absorb) from paying for this.
  if (
    after.enabled === false &&
    changedFields?.includes('enabled') &&
    after.targetObject &&
    after.targetField
  ) {
    await convergeMarkersForColumn(client, after.targetObject, after.targetField);
  }
```

`handle-definition-lifecycle.ts` — `handleDefinitionDeleted` gains the same call before `refreshFormulaStatuses`:

```ts
  if (before.targetObject && before.targetField) {
    await convergeMarkersForColumn(client, before.targetObject, before.targetField);
  }
```

(the parameter is currently `_before` — rename it to `before`).

`handleDefinitionDestroyed` — replace the pin-deletion block (lines 223-249) with this final shape (paginated, shared-column-guarded, record ids collected; `convergeMarkersForColumn` only in the shared branch — after deletion the column enumeration would find nothing, so the delete branch converges the collected ids directly, with the record's OTHER columns' pins still counting via a fresh object-wide pin load):

```ts
  let overridesDeleted = 0;
  if (before.targetObject && before.targetField) {
    // A surviving definition on the same column still owns these pins —
    // destroying one of two sharers must not erase the survivor's pins.
    const shared = await anotherDefinitionTargets(client, before);
    if (shared) {
      await convergeMarkersForColumn(client, before.targetObject, before.targetField);
    } else {
      const affectedRecordIds: string[] = [];
      let after: string | undefined;
      for (;;) {
        const response = await withRetry(() =>
          client.query({
            formulaOverrides: {
              __args: {
                first: 200,
                filter: {
                  targetObject: { eq: before.targetObject },
                  targetField: { eq: before.targetField },
                },
                ...(after ? { after } : {}),
              },
              edges: { node: { id: true, recordId: true } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          }),
        );
        const connection = response?.formulaOverrides;
        for (const edge of connection?.edges ?? []) {
          if (edge?.node?.id) {
            await withRetry(() =>
              client.mutation({
                deleteFormulaOverride: { __args: { id: edge.node.id }, id: true },
              }),
            );
            overridesDeleted += 1;
            if (edge.node.recordId) affectedRecordIds.push(edge.node.recordId);
          }
        }
        if (!connection?.pageInfo?.hasNextPage) break;
        after = connection.pageInfo.endCursor ?? undefined;
      }

      if (
        affectedRecordIds.length > 0 &&
        (await markerFieldExistsOnObject(before.targetObject))
      ) {
        const definitions = await loadEnabledFormulas(client, before.targetObject);
        const pinRows = await loadOverridesForObject(client, before.targetObject);
        await convergeMarkersForRecords({
          client,
          objectName: before.targetObject,
          recordIds: affectedRecordIds,
          definitions,
          pinRows,
        });
      }
    }
  }
```

- [ ] **Step 4: Run the lifecycle suite + full unit suite**

Run: `yarn test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logic-functions/lib/handle-formula-change.ts src/logic-functions/lib/handle-definition-lifecycle.ts <test files>
git commit -m "feat(formula-field): marker convergence on definition disable, trash and destroy"
```

---

### Task 8: Sweep backstop (`marker-sweep.ts` + wiring)

**Files:**
- Create: `src/logic-functions/lib/marker-sweep.ts`
- Modify: `src/logic-functions/formula-sweep.ts` (wire the pass between `loadAllEnabledFormulas` (line 50) and the per-definition loop (line 59), inside its own try/catch like `cleanupCompanionFields`)
- Test: `src/logic-functions/lib/__tests__/marker-sweep.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5 exports; `loadAllObjectsWithFields`; `loadTrashedFormulas` from `formula-repository` (grep its signature — the widget imports it); `findFields` + the deactivate/delete pattern from `fx-status-cleanup.ts:89-105`.
- Produces: `convergeAllMarkers(client: FormulaClient, formulas: FormulaDefinitionRecord[], options: { deadlineAt: number; ensure?: typeof ensureMarkerFieldExists }): Promise<MarkerSweepResult>` with `export type MarkerSweepResult = { objects: number; written: number; ensured: number; fieldsDeleted: number; truncated: boolean }`. The `ensure` parameter defaults to `ensureMarkerFieldExists` and exists so tests inject a spy.

- [ ] **Step 1: Write the failing tests**

```ts
// src/logic-functions/lib/__tests__/marker-sweep.spec.ts — cases:

it('converges pin-arm candidates and dirty markers in one object pass', async () => {
  // Seed: enabled def on opportunity.dealScore; active pin o1; INACTIVE pin o2
  // (record lost its pin, marker still says 'Deal Score'); o3 has a tampered
  // marker ('junk') and no pin rows at all. Marker field in metadata seam.
  // Assert after convergeAllMarkers: o1 -> 'Deal Score' (if stale), o2 -> '',
  // o3 -> '' (dirty-marker arm caught it).
});

it('dirty-marker arm runs even when the object has zero enabled definitions', async () => {
  // Seed: marker field present, NO enabled definitions, o1.fxOverrides='Ghost'.
  // Assert: o1 converged to '' — the spec §5.5 step 1 rule.
});

it('retries ensure for an object with an override-allowed definition but no marker field', async () => {
  // Metadata seam WITHOUT fxOverrides on opportunity; one enabled override-allowed
  // definition (no pins needed); a spy proving ensure was invoked with 'opportunity'.
  // Counter-case: an object whose only definition is locked (allowOverride false)
  // must NOT trigger ensure.
  // (Inject the ensure dependency — give convergeAllMarkers an optional
  // `ensure` parameter defaulting to ensureMarkerFieldExists.)
});

it('deletes the marker field only when the object has zero definitions in any state', async () => {
  // Case A: no live defs, one TRASHED def -> field kept.
  // Case B: no defs at all -> deactivate-then-delete (assert both metadata
  // mutations, in order, via the injected metadata client).
});

it('a fully converged workspace does zero record mutations', async () => {
  // Seed converged state; assert client.mutations === 0 after the pass.
});

it('respects the deadline: stops between objects and reports truncated', async () => {
  // Two objects with work; deadlineAt = Date.now() - 1 -> truncated: true,
  // zero writes.
});
```

Write these fully, mirroring `marker-converge.spec.ts`'s fixture style.

- [ ] **Step 2: Run to verify they fail** — `yarn vitest run src/logic-functions/lib/__tests__/marker-sweep.spec.ts` — FAIL, module not found.

- [ ] **Step 3: Implement `marker-sweep.ts`**

Shape (write it out fully; the pieces all exist):

```ts
export type MarkerSweepResult = {
  objects: number;
  written: number;
  ensured: number;
  fieldsDeleted: number;
  truncated: boolean;
};

export const convergeAllMarkers = async (
  client: FormulaClient,
  formulas: FormulaDefinitionRecord[],
  {
    deadlineAt,
    ensure = ensureMarkerFieldExists,
  }: { deadlineAt: number; ensure?: typeof ensureMarkerFieldExists },
): Promise<MarkerSweepResult> => { ... };
```

Algorithm per spec §5.5, in this order:

1. `objects = await loadAllObjectsWithFields()`. Build `markerBearing` = objects whose active fields include `MARKER_FIELD_NAME`; `formulaObjects` = distinct `targetObject`s of `formulas` (enabled set, passed in).
2. For each object in the union (markerBearing ∪ formulaObjects): if `Date.now() > deadlineAt` → `truncated = true`, break.
3. Per object: `pinRows = await loadOverridesForObject(client, objectName)`.
   - Ensure arm (amended 2026-09-03): object NOT marker-bearing, but has ≥1 enabled `allowOverride !== false` definition in `formulas` → `await ensure(objectName)`; count `ensured`; whatever the result, skip convergence this pass (the catalog is stale for a just-created field; next hour converges). Do not load pin rows for such an object.
   - Pin arm (only when the object has ≥1 enabled `allowOverride !== false` definition): candidate ids = pin rows whose `targetField` is one of those definitions' columns (ANY active state).
   - Dirty-marker arm (marker-bearing objects, unconditional): one record query `{ filter: { [MARKER_FIELD_NAME]: { is: graphqlEnum('NOT_NULL') } } }` selecting `{ id, [MARKER_FIELD_NAME] }` (paginated, same connection shape as `loadCurrentMarkerValues`) — collect ids AND prime a `currentValues` map from the same response. `graphqlEnum` MUST wrap the value: `FakeClient` accepts a quoted `'NOT_NULL'` string too, but the real server rejects it against the enum type (`dynamic-client.ts:31-35`) — a quoted literal ships green and fails live. Import `graphqlEnum` from the same module `variation-sync.ts:978` and `formula-repository.ts:59` import it from.
   - `convergeMarkersForRecords({ client, objectName, recordIds: union, definitions: formulas, pinRows, currentValues })`.
4. Cleanup arm (marker-bearing objects only): zero entries in `formulas` for the object AND a direct `formulaDefinitions` query filtered `{ targetObject: { eq } }` (any enabled state, paginated loop — this also covers trashed rows only if the default query scope includes them; it does not, so ALSO check `loadTrashedFormulas(client)` for the object) returns none → deactivate-then-delete via the `fx-status-cleanup.ts:89-105` pattern (`findFields` for the field id, `updateOneField isActive:false`, then `deleteOneField`), each in its own try/catch, count `fieldsDeleted`.

Wire into `formula-sweep.ts` after line 50 (`loadAllEnabledFormulas`):

```ts
  const MARKER_BUDGET_MS = 15_000;
  let markerSweep: MarkerSweepResult = {
    objects: 0, written: 0, ensured: 0, fieldsDeleted: 0, truncated: false,
  };
  try {
    markerSweep = await convergeAllMarkers(client, formulas, {
      deadlineAt: Date.now() + MARKER_BUDGET_MS,
    });
  } catch {
    // Best-effort backstop: a failed marker pass must never block recompute.
  }
```

and add `markerSweep` to the returned result object (line 100-110).

- [ ] **Step 4: Run tests to verify they pass** — `yarn vitest run src/logic-functions/lib/__tests__/marker-sweep.spec.ts` plus `yarn test` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logic-functions/lib/marker-sweep.ts src/logic-functions/formula-sweep.ts src/logic-functions/lib/__tests__/marker-sweep.spec.ts
git commit -m "feat(formula-field): hourly marker convergence backstop with budget slice"
```

---

### Task 9: Widget toggle lane (`formula-editor.tsx`)

**Files:**
- Modify: `src/front-components/formula-editor.tsx` (inside `toggleOverride`, lines 674-852: after each successful branch, write the marker)
- Create: `src/front-components/lib/marker-toggle.ts` (the testable pure/IO-thin part)
- Test: `src/front-components/lib/__tests__/marker-toggle.spec.ts`

**Interfaces:**
- Consumes: `computeMarkerValue`, `MARKER_FIELD_NAME` (Task 1); `textValuesConverged`; the widget's `Definition` rows (they carry `enabled`, `allowOverride`, `order`, `name`, `targetField`, `targetObject`).
- Produces: `writeMarkerAfterToggle(args: { client: MarkerToggleClient; objectName: string; recordId: string; definitions: Array<{ id: string; name: string; targetField: string; targetObject: string; enabled: boolean; allowOverride: boolean; order: number | null }>; activeOverrideFields: ReadonlySet<string> }): Promise<'written' | 'converged' | 'skipped'>` — reads the current marker via a single-record query (try/catch: a query error means the marker field does not exist on this object → `'skipped'`), compares, writes via `update<Object>` mutation only on diff. The `id` is required because `computeMarkerValue` takes `FormulaDefinitionRecord[]` (whose `id` is non-optional); widget rows already carry it.

- [ ] **Step 1: Write the failing tests**

```ts
// src/front-components/lib/__tests__/marker-toggle.spec.ts — cases, written fully:

it("writes the marker when it differs ('written')", ...);
it("does not mutate when converged, blank-vs-null included ('converged')", ...);
it("returns 'skipped' and never mutates when the marker query errors (field absent)", ...);
it('maps definitions through the same enabled/allowOverride/order rules as the server', ...);
// Use a stub client { query: vi.fn(), mutation: vi.fn() }; assert the mutation
// key is `updateOpportunity` with __args { id, data: { fxOverrides: <expected> } }.
```

The definition-mapping case pins lane consistency: feed one disabled and one locked definition plus one live pinned one; expect the written value to include only the live one.

- [ ] **Step 2: Run to verify they fail** — `yarn vitest run src/front-components/lib/__tests__/marker-toggle.spec.ts` — FAIL.

- [ ] **Step 3: Implement `marker-toggle.ts`**

```ts
// src/front-components/lib/marker-toggle.ts
import {
  computeMarkerValue,
  MARKER_FIELD_NAME,
} from 'src/logic-functions/lib/override-marker';
import { textValuesConverged } from 'src/logic-functions/lib/value-io';

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

export type MarkerToggleClient = {
  query: (selection: Record<string, unknown>) => Promise<any>;
  mutation: (selection: Record<string, unknown>) => Promise<any>;
};

// Toggle-off can converge without any record write (deactivate -> recompute ->
// no-op -> no event), so the widget writes the marker itself (spec §5.3).
export const writeMarkerAfterToggle = async ({
  client,
  objectName,
  recordId,
  definitions,
  activeOverrideFields,
}: {
  client: MarkerToggleClient;
  objectName: string;
  recordId: string;
  definitions: Array<{
    id: string;
    name: string;
    targetField: string;
    targetObject: string;
    enabled: boolean;
    allowOverride: boolean;
    order: number | null;
  }>;
  activeOverrideFields: ReadonlySet<string>;
}): Promise<'written' | 'converged' | 'skipped'> => {
  let current: string | null;
  try {
    const response = await client.query({
      [objectName]: {
        __args: { filter: { id: { eq: recordId } } },
        id: true,
        [MARKER_FIELD_NAME]: true,
      },
    });
    current = (response?.[objectName]?.[MARKER_FIELD_NAME] as string | null) ?? null;
  } catch {
    // Selecting a field the object does not have throws — the marker field
    // has not been created yet, so there is nothing to maintain.
    return 'skipped';
  }

  const expected = computeMarkerValue(objectName, definitions, activeOverrideFields);
  if (textValuesConverged(expected, current)) {
    return 'converged';
  }
  await client.mutation({
    [`update${capitalize(objectName)}`]: {
      __args: { id: recordId, data: { [MARKER_FIELD_NAME]: expected } },
      id: true,
    },
  });
  return 'written';
};
```

(`capitalize` already exists in `formula-editor.tsx` — if it is exported from a shared lib module, import it instead of redefining; grep first.)

- [ ] **Step 4: Wire into `toggleOverride`**

In `formula-editor.tsx`, at the end of the `try` block (after the `turnOn` branches, before `finally` at line 846), compute the post-toggle active set from local state and call the helper:

```ts
        const activeAfterToggle = new Set(
          Object.entries(overrides)
            .filter(([, entry]) => entry?.active)
            .map(([field]) => field),
        );
        if (turnOn) {
          activeAfterToggle.add(definition.targetField);
        } else {
          activeAfterToggle.delete(definition.targetField);
        }
        await writeMarkerAfterToggle({
          client,
          objectName: definition.targetObject,
          recordId,
          definitions: definitionsRef.current.filter(
            (candidate) => candidate.targetObject === definition.targetObject,
          ),
          activeOverrideFields: activeAfterToggle,
        });
```

Two staleness hazards, both must be handled: (a) `overrides` is the PRE-toggle state captured by the callback closure (the `setOverrides` calls above are async) — that is why the toggled field is added/removed explicitly; **add `overrides` to `toggleOverride`'s dependency array** (currently `[recordId, values, load]` at line 851) or the captured map can be stale across renders. (b) Definitions must come from `definitionsRef.current` (the ref added at `formula-editor.tsx:234` for exactly this closure-staleness hazard), NOT the `definitions` state binding — a stale initial `[]` would compute an empty marker and blank it on every toggle. Verify the ref and state names against the file; the row type carries all six helper fields per the `load()` mapping at lines 301-326.

- [ ] **Step 5: Run tests + typecheck the front component**

Run: `yarn vitest run src/front-components/lib/__tests__/marker-toggle.spec.ts && yarn test`
Then: `npx tsgo -p tsconfig.json --noEmit` (from the app directory; fall back to `npx tsc -p tsconfig.json --noEmit` if tsgo is unavailable).
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/front-components/lib/marker-toggle.ts src/front-components/lib/__tests__/marker-toggle.spec.ts src/front-components/formula-editor.tsx
git commit -m "feat(formula-field): widget override toggle maintains the Overrides marker"
```

---

### Task 10: Docs, ADR 0031, version bump

**Files:**
- Create: `docs/adr/0031-override-marker-field.md`
- Modify: `docs/adr/README.md` (index line), `README.md` (feature section), `package.json` (version)

**Interfaces:** none — documentation.

- [ ] **Step 1: Write ADR 0031**

Adapt the spec into the app's ADR voice (mirror ADR 0028's structure: Context / Decision / Consequences / Alternatives). Required content, all from `docs/superpowers/specs/2026-09-01-override-marker-field-design.md`:
- Context: overrides invisible outside the Formulas tab; tab-mount lazy rendering kills any widget/toast signal (§1 + the superseded-toast note); why this is not ADR 0021's chip (per-object, per-record event-paced state, no layout convergence).
- Decision: the field contract (§3, verbatim identity strings), value semantics (§4), the four lanes and their gates (§5.1-5.5), diff-guard-only loop safety (§6), containment (syncable exclusion both sites, timeline formula-managed set).
- Consequences: enabled-only semantics (disabled/trashed definitions drop from markers), the one-echo-per-marker-write cost, dirty-marker arm unconditional, the accepted timeline residue on definition-less objects, the widget's 100-definition ceiling.
- Alternatives considered: toast from the Formulas widget (mount-gated, dead end — cite the twenty-front lazy-tab evidence), per-formula chip (ADR 0021), value-embedded markers (data corruption + SELECT gate).
- Record Task 0's probe results verbatim (from `docs/superpowers/plans/2026-09-01-probe-results.md`).

- [ ] **Step 2: README + index + version**

- `docs/adr/README.md`: add `0031` to the index list, matching the existing line format.
- `README.md`: add an "Overrides marker" subsection under the overrides feature docs: what the field is, that it appears on an object as soon as its first override-allowed formula is created (blank until something is overridden) and can be positioned like any field (P2: it lands directly in the Fields card, no reveal needed), the "filter by Overrides not-empty for an audit view" tip, and that the field is app-managed/view-only.
- `package.json`: `"version": "0.6.0"`.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0031-override-marker-field.md docs/adr/README.md README.md package.json
git commit -m "docs(formula-field): ADR 0031 override marker field; bump to 0.6.0"
```

---

### Task 11: Full verification + live checklist

**Files:** none new.

- [ ] **Step 1: Full unit suite** — `yarn test` — all PASS (record the count).
- [ ] **Step 2: Lint** — `yarn lint` — clean (fix with `yarn lint:fix` where mechanical).
- [ ] **Step 3: Typecheck** — `npx tsgo -p tsconfig.json --noEmit` (app dir) — clean.
- [ ] **Step 4: Live checklist** (dev stack + `yarn twenty dev --once`, marker field state from Task 0 cleaned or adopted):
  1. Create a formula (overrides allowed) on an object → within seconds the object gains a blank `Overrides` field in the Fields card (positionable). Override the formula's value on a record in the table UI → within seconds that record's `Overrides` field shows the formula's label.
  2. Toggle the override off in the Formulas tab → marker blanks without waiting for the sweep.
  3. Toggle back on → marker returns.
  4. Tamper: write `fxOverrides` directly via API (playwright page-context mutation, as in Task 0 P3) → reverted on the next event or sweep.
  5. Disable the definition in the editor → marker blanks (event-lane, not sweep-delayed).
  6. UI check: `Overrides` is view-only (greyed) in table and record views; timeline shows no lingering "Overrides changed" entries after the cleanup cron (10-min cycle) has run.
  7. Filter a table view by `Overrides: is not empty` → only the overridden record appears.
- [ ] **Step 5: Any deviation from expected behavior**: stop and diagnose with superpowers:systematic-debugging before touching code.
- [ ] **Step 6: Finish** — invoke superpowers:finishing-a-development-branch (merge target: `main`).

---

## Self-review notes (kept for the executor)

- Spec §5.2's "no early return before the marker step" claim was code-verified (single `return` at the end of `handleRecordUpdate`); if an intervening refactor adds one, the marker step must move with the return.
- The two exact-GraphQL-shape spots are resolved in place: Task 4 imports `pluralize` from `plural.ts`; Task 8 wraps `NOT_NULL` in `graphqlEnum` (a quoted string passes `FakeClient` but the real server rejects it — never test-verify that one by green suite alone).
- Lane consistency invariant: Tasks 1, 6, 7, 8, 9 all funnel through `computeMarkerValue` — never reimplement its filters in a lane.
