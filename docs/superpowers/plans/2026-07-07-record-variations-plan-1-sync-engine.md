# Record Variations — Plan 1: Data Model + Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `VariationConfig` object and the backend sync engine that keeps a variation's fields mirrored from its primary record, with no UI — fully covered by vitest using the existing `FakeClient` fixture.

**Architecture:** A per-object `VariationConfig` row turns on variation sync for that object. A `primaryRecord` self-referencing MANY_TO_ONE relation field (created in Plan 2) marks any record with a non-null pointer as a variation. This plan builds everything that computes the syncable-field set, copies changed fields from primary to variations, detects a human edit on a variation and pins it as a `FormulaOverride`, freezes sync when the primary is trashed/destroyed, and sweeps hourly for convergence. All of this rides the existing `formula-field` app's plumbing (`FormulaOverride`, `deepJsonEqual`, `MIRRORABLE_KINDS`, the dynamic GraphQL client, the wildcard `*.updated`/`*.created` triggers) — see the design doc at `docs/superpowers/specs/2026-07-07-record-variations-design.md` for full background and rationale.

**Tech Stack:** TypeScript, `twenty-sdk`/`twenty-client-sdk` (deploy-time app framework), vitest (NOT jest — this package uses `vitest run`).

**Root package for every file in this plan:** `packages/twenty-apps/community/formula-field/`. All paths below are relative to this directory unless stated otherwise.

## Global Constraints

- This package uses **vitest**, not jest. Run tests with `npx vitest run <path>` from `packages/twenty-apps/community/formula-field/`, or `npx vitest run` for the whole suite. Test files match `src/**/*.spec.ts`.
- No `any` type. Named exports only. No abbreviations in variable names. Short `//` comments explaining WHY, never JSDoc blocks, never restating WHAT the code does.
- Every new GraphQL-facing function takes a `client: FormulaClient` (from `src/logic-functions/lib/types.ts`) as its first argument, exactly like the existing formula code — this is what makes everything unit-testable with `FakeClient` (`src/logic-functions/lib/__tests__/fake-client.ts`), no server, no network.
- Never trust the wildcard trigger's `after` event payload for anything beyond a plain scalar the event is guaranteed to carry verbatim. For composite fields and for anything used in a "is this a stale echo" comparison, do a fresh, kind-aware read via the client. This is an established, hard-learned rule in this codebase (see `handle-record-update.ts`'s mirror branch) — violating it reintroduces the exact bug class the mirror engine had to fix twice.
- Every paginated GraphQL connection read must loop `after`/`hasNextPage` to completion — no `first: N` cap without pagination (this exact class of bug, "finding m3", silently truncated formula metadata reads in this codebase before).
- Reuse, do not duplicate: `deepJsonEqual` (`lib/deep-equal.ts`), `MIRRORABLE_KINDS`/`ENGINE_FAMILY_KINDS`/`selectionEntryForMirrorKind` (`lib/mirror-kinds.ts`), `selectionEntryForFieldKind` (`lib/value-io.ts`), `findOverride`/`upsertOverride`/`deactivateOverride`/`activateOverride`/`overrideKey` (`lib/override-repository.ts`), `loadAllObjectsWithFields` (`lib/metadata-objects.ts`), `loadAllEnabledFormulas` (`lib/formula-repository.ts`), `pluralize` (`lib/recompute.ts`, already exported), `withRetry` (`lib/with-retry.ts`), `navigatePath` (`lib/coercion.ts`), `graphqlEnum` (`lib/dynamic-client.ts`), `FormulaClient` type (`lib/types.ts`).
- **Every new field kind's raw value is copied VERBATIM (typed passthrough), never engine-evaluated.** This applies uniformly to `NUMBER`/`CURRENCY`/`DATE`/`DATE_TIME` too — variation sync is not formula computation, so `value-io.ts`'s `normalizeComputedValue`/`buildTargetWriteData` (which serialize an *engine-computed* number back into a field) are NOT used here. Use `selectionEntryForMirrorKind` for every syncable kind's read/write sub-selection (its `default: true` case already covers `NUMBER`/`DATE`/`DATE_TIME`/`TEXT`/`SELECT`/etc. correctly; only `CURRENCY` and the mirror composites need an explicit sub-selection, which it already provides).
- **Override value slot is NOT "engine family = numeric slot."** `FormulaOverride.overrideValue` (NUMBER column) can only literally hold a JS `number`. Since variation sync's raw value for `NUMBER` fields already IS a plain number, `NUMBER` uses the numeric slot; every other kind — including `CURRENCY` (a `{amountMicros, currencyCode}` object) and `DATE`/`DATE_TIME` (date-string/ISO scalars, not floats) — must JSON-stringify into `overrideValueText`. This deliberately differs from the formula engine's `ENGINE_FAMILY_KINDS → numeric slot` convention, which only holds because formulas evaluate to a float; variation sync never evaluates anything.
- Generate a fresh UUID for every new `universalIdentifier` — never copy an existing one. Use `node -e "console.log(require('crypto').randomUUID())"` (no `uuidgen` binary in this environment).

---

### Task 1: `VariationConfig` object definition

**Files:**
- Create: `src/objects/variation-config.object.ts`

**Interfaces:**
- Produces: `VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER: string`, `VARIATION_CONFIG_FIELDS: { name, targetObject, relationFieldName, createdRelationField, enabled, lastSyncedAt, lastError, status, statusReason }` (all `string` UUIDs) — later tasks' repository code references field *names* (`targetObject`, `relationFieldName`, etc.), not these UUID constants directly, so this task only needs to get the object's shape right, not be imported by later tasks.

This is a pure declarative deploy-time file, modeled exactly on `src/objects/formula-definition.object.ts` — no logic, no test file (matches the existing convention: `*.object.ts` files have no `.spec.ts`).

- [ ] **Step 1: Write the object definition**

```typescript
import { defineObject, FieldType } from 'twenty-sdk/define';

// VariationConfig — one row per object with variations enabled. Any record of
// that object with a non-null `<relationFieldName>Id` pointer IS a variation of
// the record it points to; a null pointer means "primary" (or a plain record on
// an object with no config). This is the ENTIRE data model for record variations
// (design 2026-07-07): the relation field this config provisions is
// simultaneously the data model, the per-record sync scope, and the per-record
// source pointer. See docs/superpowers/specs/2026-07-07-record-variations-design.md.

export const VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER =
  '205a2c5a-d8e6-49b3-bd16-00527de8d845';

export const VARIATION_CONFIG_FIELDS = {
  name: 'd0dc73bf-b2e9-432c-a768-a9deda6419e1',
  targetObject: '0c57eba9-edb0-454c-ac51-2a08428dcd98',
  relationFieldName: '29200c51-b83e-491a-9dcf-d51c14dcf72e',
  createdRelationField: '7f409dcd-454e-40b7-9dcc-267913069418',
  enabled: '7d32abb9-b6d3-46d8-b475-b628a8c3d0b6',
  lastSyncedAt: '19e1bc28-f526-4925-afc0-c68a78f85677',
  lastError: '71869f54-7640-44be-b9b4-d400b557eae3',
  status: 'b8d8936b-b0e8-43f0-8f5e-71dd803b453c',
  statusReason: 'dcd0e241-534f-414f-952a-c8484ef0c39f',
} as const;

export default defineObject({
  universalIdentifier: VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'variationConfig',
  namePlural: 'variationConfigs',
  labelSingular: 'Variation config',
  labelPlural: 'Variation configs',
  description:
    'Enables record variations on an object: a primaryRecord relation plus ' +
    'automatic field sync from primary to variation.',
  icon: 'IconGitFork',
  labelIdentifierFieldMetadataUniversalIdentifier: VARIATION_CONFIG_FIELDS.name,
  fields: [
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      description:
        'Deterministic key = target object nameSingular (uniqueness anchor: ' +
        'one config per object).',
      icon: 'IconTag',
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.targetObject,
      type: FieldType.TEXT,
      name: 'targetObject',
      label: 'Target object',
      description: 'nameSingular of the object variations are enabled on.',
      icon: 'IconBox',
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.relationFieldName,
      type: FieldType.TEXT,
      name: 'relationFieldName',
      label: 'Relation field name',
      description:
        'Name of the self-referencing MANY_TO_ONE relation field this config ' +
        'created ("primaryRecord" by default). Stored explicitly, never ' +
        're-derived.',
      icon: 'IconLink',
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.createdRelationField,
      type: FieldType.BOOLEAN,
      name: 'createdRelationField',
      label: 'Created relation field',
      description:
        'True when the wizard created the relation field for this config — ' +
        'the disable/destroy lifecycle only deactivates a field it created.',
      icon: 'IconWand',
      defaultValue: false,
      isUIEditable: false,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.enabled,
      type: FieldType.BOOLEAN,
      name: 'enabled',
      label: 'Enabled',
      description: 'When off, variation sync does not run for this object.',
      icon: 'IconToggleRight',
      defaultValue: true,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.lastSyncedAt,
      type: FieldType.DATE_TIME,
      name: 'lastSyncedAt',
      label: 'Last synced at',
      description: 'Timestamp of the last hourly sweep pass over this object.',
      icon: 'IconClock',
      isUIEditable: false,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.lastError,
      type: FieldType.TEXT,
      name: 'lastError',
      label: 'Last error',
      description: 'Last sweep error, empty when healthy.',
      icon: 'IconAlertTriangle',
      isUIEditable: false,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.status,
      type: FieldType.TEXT,
      name: 'status',
      label: 'Status',
      description: 'Operational status (system-managed), same posture as FormulaDefinition.',
      icon: 'IconHeartbeat',
      isUIEditable: false,
    },
    {
      universalIdentifier: VARIATION_CONFIG_FIELDS.statusReason,
      type: FieldType.TEXT,
      name: 'statusReason',
      label: 'Status reason',
      description:
        'Diagnostic detail, e.g. how many variations were skipped this sweep ' +
        'because their primary itself turned out to be a variation ' +
        '(single-level guard).',
      icon: 'IconInfoCircle',
      isUIEditable: false,
    },
  ],
});
```

- [ ] **Step 2: Typecheck**

Run: `npx nx typecheck twenty-apps` (or, if this app package has its own typecheck script, check `package.json` in `packages/twenty-apps/community/formula-field/` for the exact command — likely `yarn typecheck` or `tsc --noEmit` from that directory) and confirm no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/objects/variation-config.object.ts
git commit -m "feat(record-variations): add VariationConfig object definition"
```

---

### Task 2: Syncable-field-set computation

**Files:**
- Modify: `src/logic-functions/lib/metadata-objects.ts`
- Create: `src/logic-functions/lib/syncable-fields.ts`
- Test: `src/logic-functions/lib/__tests__/syncable-fields.spec.ts`

**Interfaces:**
- Consumes: `loadAllObjectsWithFields(): Promise<MetadataObjectInfo[]>` (existing, extended below), `loadAllEnabledFormulas(client: FormulaClient): Promise<FormulaDefinitionRecord[]>` (existing, from `lib/formula-repository.ts` — already returns `.targetObject`/`.targetField` per the `FormulaDefinitionRecord` type in `lib/types.ts`), `MIRRORABLE_KINDS: ReadonlySet<string>`, `ENGINE_FAMILY_KINDS: ReadonlySet<string>` (existing, `lib/mirror-kinds.ts`), `FormulaClient` (existing, `lib/types.ts`).
- Produces: `export type SyncableFieldInfo = { name: string; kind: string }`, `export const computeSyncableFields = async (client: FormulaClient, targetObject: string, relationFieldName: string): Promise<SyncableFieldInfo[]>` — every later task in this plan calls this exact function with this exact signature to get the field set to sync.

First, extend the metadata loader with two fields every downstream exclusion rule needs: which field is the object's label identifier, and whether a field is system-owned (both currently missing from `MetadataFieldInfo`/`MetadataObjectInfo`). This is purely additive — no existing caller's behavior changes.

- [ ] **Step 1: Write the failing test for the metadata-objects extension**

Add to a new file `src/logic-functions/lib/__tests__/syncable-fields.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { computeSyncableFields } from 'src/logic-functions/lib/syncable-fields';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('computeSyncableFields', () => {
  it('includes mirrorable and engine-family kinds, excludes the label field, the relation field, and non-writable kinds', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-domain', name: 'domainName', type: 'LINKS', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
          { id: 'field-people', name: 'people', type: 'RELATION', isActive: true, isSystem: false },
          { id: 'field-created-by', name: 'createdBy', type: 'ACTOR', isActive: true, isSystem: false },
          { id: 'field-position', name: 'position', type: 'POSITION', isActive: true, isSystem: true },
          { id: 'field-search', name: 'searchVector', type: 'TS_VECTOR', isActive: true, isSystem: true },
          { id: 'field-inactive', name: 'legacyField', type: 'TEXT', isActive: false, isSystem: false },
        ],
      },
    ]);

    const result = await computeSyncableFields(client, 'company', 'primaryRecord');

    expect(result.map((field) => field.name).sort()).toEqual(['domainName', 'employees']);
  });

  it('excludes any field targeted by an enabled FormulaDefinition on the same object', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-score', name: 'formulaScore', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('formulaDefinition', [
      {
        id: 'f1',
        targetObject: 'company',
        targetField: 'formulaScore',
        expression: 'employees * 2',
        enabled: true,
      },
    ]);

    const result = await computeSyncableFields(client, 'company', 'primaryRecord');

    expect(result.map((field) => field.name).sort()).toEqual(['employees']);
  });

  it('returns an empty array for an unknown object', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([]);

    const result = await computeSyncableFields(client, 'unknown', 'primaryRecord');

    expect(result).toEqual([]);
  });
});
```

This test calls `client.setObjectsWithFields(...)`, a new `FakeClient` method that does not exist yet — `computeSyncableFields` calls `loadAllObjectsWithFields()` (a free function backed by the real `MetadataApiClient`, not the `FormulaClient` passed in), so the fake needs a seam. Add this method now:

- [ ] **Step 2: Add a metadata seam to FakeClient**

Read `src/logic-functions/lib/__tests__/fake-client.ts` first. Add near the top (module-level, alongside the class):

```typescript
import {
  type MetadataObjectInfo,
  __setFakeObjectsWithFieldsForTests,
} from 'src/logic-functions/lib/metadata-objects';
```

Then add a method on `FakeClient`:

```typescript
  setObjectsWithFields(objects: MetadataObjectInfo[]): void {
    __setFakeObjectsWithFieldsForTests(objects);
  }
```

And in `metadata-objects.ts` (written in Step 3 below), export a test-only seam:

```typescript
let fakeObjectsForTests: MetadataObjectInfo[] | null = null;

// Test-only escape hatch: loadAllObjectsWithFields talks to the real
// MetadataApiClient directly (it is not parameterized by FormulaClient, unlike
// every other repository function in this app), so unit tests need a way to
// stub its result. Production code never calls this.
export const __setFakeObjectsWithFieldsForTests = (
  objects: MetadataObjectInfo[] | null,
): void => {
  fakeObjectsForTests = objects;
};
```

And at the top of `loadAllObjectsWithFields`'s body:

```typescript
export const loadAllObjectsWithFields = async (): Promise<
  MetadataObjectInfo[]
> => {
  if (fakeObjectsForTests !== null) {
    return fakeObjectsForTests;
  }
  // ... existing body unchanged
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/syncable-fields.spec.ts`
Expected: FAIL — `syncable-fields` module not found, and `MetadataFieldInfo`/`MetadataObjectInfo` don't yet have `isSystem`/`labelIdentifierFieldMetadataId`.

- [ ] **Step 4: Extend `metadata-objects.ts`**

Read the full current file first (`src/logic-functions/lib/metadata-objects.ts`). Apply these changes:

```typescript
export type MetadataFieldInfo = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  // System-owned fields (id, createdAt, position, search vector, etc.) are
  // never syncable — they are platform-managed, not user data.
  isSystem: boolean;
};

export type MetadataObjectInfo = {
  id: string;
  nameSingular: string;
  // The object's label-identifier field id (nullable on the DTO). Variations
  // must stay distinguishable from their primary, so this field is excluded
  // from the syncable set (design 2026-07-07).
  labelIdentifierFieldMetadataId: string | null;
  fields: MetadataFieldInfo[];
};
```

In the GraphQL selection inside `loadAllObjectsWithFields`, add the new fields:

```typescript
        edges: {
          cursor: true,
          node: {
            id: true,
            nameSingular: true,
            labelIdentifierFieldMetadataId: true,
            // fieldsList is the full, non-paginated field list — no first:1000
            // truncation, so a large object never yields a false OFFLINE.
            fieldsList: {
              id: true,
              name: true,
              type: true,
              isActive: true,
              isSystem: true,
            },
          },
        },
```

And in the mapping loop, capture the two new values:

```typescript
    for (const edge of response?.objects?.edges ?? []) {
      const node = edge?.node;
      if (!node?.nameSingular || !node?.id) {
        continue;
      }
      const fields: MetadataFieldInfo[] = [];
      for (const field of node.fieldsList ?? []) {
        if (field?.id && field?.name && field?.type) {
          fields.push({
            id: field.id,
            name: field.name,
            type: field.type,
            isActive: field.isActive !== false,
            isSystem: field.isSystem === true,
          });
        }
      }
      results.push({
        id: node.id,
        nameSingular: node.nameSingular,
        labelIdentifierFieldMetadataId: node.labelIdentifierFieldMetadataId ?? null,
        fields,
      });
    }
```

Add the test seam from Step 2 (the `fakeObjectsForTests` variable, `__setFakeObjectsWithFieldsForTests`, and the early-return in `loadAllObjectsWithFields`).

- [ ] **Step 5: Write `syncable-fields.ts`**

```typescript
import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import { loadAllEnabledFormulas } from 'src/logic-functions/lib/formula-repository';
import {
  ENGINE_FAMILY_KINDS,
  MIRRORABLE_KINDS,
} from 'src/logic-functions/lib/mirror-kinds';
import { type FormulaClient } from 'src/logic-functions/lib/types';

// Variation sync's field allowlist: every kind the mirror engine already knows
// how to typed-passthrough-copy (design 2026-07-07). Deliberately reuses the
// SAME two sets the mirror engine uses (not a new list) so the two can never
// drift about what "copyable" means.
const SYNCABLE_KINDS: ReadonlySet<string> = new Set([
  ...MIRRORABLE_KINDS,
  ...ENGINE_FAMILY_KINDS,
]);

export type SyncableFieldInfo = { name: string; kind: string };

// The set of fields variation sync copies from primary to variation for a given
// object, computed fresh from metadata every call (never persisted) so a field
// added to the object later is picked up automatically. Excludes: the object's
// label-identifier field (variations must stay distinguishable), the relation
// field itself, inactive/system fields, anything outside the syncable kind
// allowlist (which already excludes RELATION/MORPH_RELATION/ACTOR/RICH_TEXT/
// POSITION/TS_VECTOR by construction — they are simply not in either source
// set), and any field an enabled FormulaDefinition targets on this object (the
// formula owns that column; the two write sets must stay disjoint).
export const computeSyncableFields = async (
  client: FormulaClient,
  targetObject: string,
  relationFieldName: string,
): Promise<SyncableFieldInfo[]> => {
  const objects = await loadAllObjectsWithFields();
  const object = objects.find(
    (candidate) => candidate.nameSingular === targetObject,
  );
  if (!object) {
    return [];
  }

  const formulas = await loadAllEnabledFormulas(client);
  const formulaTargetFields = new Set(
    formulas
      .filter((formula) => formula.targetObject === targetObject)
      .map((formula) => formula.targetField)
      .filter((field): field is string => Boolean(field)),
  );

  return object.fields
    .filter((field) => field.isActive)
    .filter((field) => !field.isSystem)
    .filter((field) => field.id !== object.labelIdentifierFieldMetadataId)
    .filter((field) => field.name !== relationFieldName)
    .filter((field) => !formulaTargetFields.has(field.name))
    .filter((field) => SYNCABLE_KINDS.has(field.type))
    .map((field) => ({ name: field.name, kind: field.type }));
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/syncable-fields.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full package suite to confirm no regressions**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run`
Expected: PASS — the `metadata-objects.ts` change is additive; every existing formula test that seeds field kinds through `FakeClient.setFieldKinds` is unaffected (that is a separate seam from the new `setObjectsWithFields`).

- [ ] **Step 8: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/logic-functions/lib/metadata-objects.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/syncable-fields.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/fake-client.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/syncable-fields.spec.ts
git commit -m "feat(record-variations): compute per-object syncable-field set"
```

---

### Task 3: Bulk active-override lookup for a single record

**Files:**
- Modify: `src/logic-functions/lib/override-repository.ts`
- Test: `src/logic-functions/lib/__tests__/override-repository-active-fields.spec.ts`

**Interfaces:**
- Consumes: `withRetry` (existing, `lib/with-retry.ts`), `FormulaClient` (existing, `lib/types.ts`).
- Produces: `export const loadActiveOverrideFieldsForRecord = async (client: FormulaClient, targetObject: string, recordId: string): Promise<Set<string>>` — used by Task 5's `syncOneVariation` to skip fields the user has pinned on a specific variation, in ONE query instead of one `findOverride` call per field.

The existing `findOverride`/`loadOverriddenRecordIds` are shaped for "one field, many records" (formula recompute skips whole records). Variation sync needs the opposite shape: "one record, many fields" (skip only the pinned fields on this one variation, sync the rest) — hence a new function rather than reusing either existing one.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';

import { loadActiveOverrideFieldsForRecord } from 'src/logic-functions/lib/override-repository';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('loadActiveOverrideFieldsForRecord', () => {
  it('returns only the ACTIVE override field names for the given record', async () => {
    const client = new FakeClient();
    client.seed('formulaOverride', [
      {
        id: 'ov1',
        name: 'company.domainName#c1',
        targetObject: 'company',
        targetField: 'domainName',
        recordId: 'c1',
        overrideValue: null,
        overrideValueText: '{}',
        active: true,
      },
      {
        id: 'ov2',
        name: 'company.employees#c1',
        targetObject: 'company',
        targetField: 'employees',
        recordId: 'c1',
        overrideValue: 12,
        overrideValueText: null,
        active: false,
      },
      {
        id: 'ov3',
        name: 'company.domainName#c2',
        targetObject: 'company',
        targetField: 'domainName',
        recordId: 'c2',
        overrideValue: null,
        overrideValueText: '{}',
        active: true,
      },
    ]);

    const fields = await loadActiveOverrideFieldsForRecord(client, 'company', 'c1');

    expect(fields).toEqual(new Set(['domainName']));
  });

  it('returns an empty set when there are no overrides for the record', async () => {
    const client = new FakeClient();

    const fields = await loadActiveOverrideFieldsForRecord(client, 'company', 'c1');

    expect(fields).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/override-repository-active-fields.spec.ts`
Expected: FAIL — `loadActiveOverrideFieldsForRecord` is not exported.

- [ ] **Step 3: Add the function**

Read `src/logic-functions/lib/override-repository.ts` first. Add this export (near `loadOverriddenRecordIds`, same pagination shape):

```typescript
// The set of field names with an ACTIVE override on this ONE record — the
// inverse shape of loadOverriddenRecordIds (one field, many records). Variation
// sync needs this to skip only the pinned fields on a specific variation while
// still syncing everything else on it.
export const loadActiveOverrideFieldsForRecord = async (
  client: FormulaClient,
  targetObject: string,
  recordId: string,
  pageSize = 500,
): Promise<Set<string>> => {
  const fields = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        formulaOverrides: {
          __args: {
            first: pageSize,
            filter: {
              targetObject: { eq: targetObject },
              recordId: { eq: recordId },
              active: { eq: true },
            },
            ...(after ? { after } : {}),
          },
          edges: { node: { targetField: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.formulaOverrides;
    for (const edge of connection?.edges ?? []) {
      if (edge?.node?.targetField) fields.add(edge.node.targetField);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return fields;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/override-repository-active-fields.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/logic-functions/lib/override-repository.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/override-repository-active-fields.spec.ts
git commit -m "feat(record-variations): add per-record active-override lookup"
```

---

### Task 4: `VariationConfig` repository

**Files:**
- Create: `src/logic-functions/lib/variation-types.ts`
- Create: `src/logic-functions/lib/variation-config-repository.ts`
- Test: `src/logic-functions/lib/__tests__/variation-config-repository.spec.ts`

**Interfaces:**
- Consumes: `withRetry` (existing), `FormulaClient` (existing, `lib/types.ts`).
- Produces: `export type VariationConfigRecord = { id: string; name?: string|null; targetObject?: string|null; relationFieldName?: string|null; createdRelationField?: boolean|null; enabled?: boolean|null; lastSyncedAt?: string|null; lastError?: string|null; status?: string|null; statusReason?: string|null }` (in `variation-types.ts`), `export const loadAllEnabledVariationConfigs = async (client: FormulaClient): Promise<VariationConfigRecord[]>`, `export const findVariationConfigByTargetObject = async (client: FormulaClient, targetObject: string): Promise<VariationConfigRecord | null>`, `export const updateVariationConfigBookkeeping = async (client: FormulaClient, configId: string, data: { lastSyncedAt?: string; lastError?: string; status?: string; statusReason?: string }): Promise<void>` (all in `variation-config-repository.ts`) — every later task imports `VariationConfigRecord` from `variation-types.ts` and these three functions from `variation-config-repository.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, it } from 'vitest';

import {
  findVariationConfigByTargetObject,
  loadAllEnabledVariationConfigs,
  updateVariationConfigBookkeeping,
} from 'src/logic-functions/lib/variation-config-repository';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('variation-config-repository', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.seed('variationConfig', [
      {
        id: 'vc1',
        name: 'company',
        targetObject: 'company',
        relationFieldName: 'primaryRecord',
        createdRelationField: true,
        enabled: true,
        lastSyncedAt: null,
        lastError: '',
        status: '',
        statusReason: '',
      },
      {
        id: 'vc2',
        name: 'opportunity',
        targetObject: 'opportunity',
        relationFieldName: 'primaryRecord',
        createdRelationField: true,
        enabled: false,
        lastSyncedAt: null,
        lastError: '',
        status: '',
        statusReason: '',
      },
    ]);
  });

  it('loadAllEnabledVariationConfigs returns only enabled configs', async () => {
    const configs = await loadAllEnabledVariationConfigs(client);

    expect(configs.map((config) => config.targetObject)).toEqual(['company']);
  });

  it('findVariationConfigByTargetObject finds a config by its target object', async () => {
    const config = await findVariationConfigByTargetObject(client, 'opportunity');

    expect(config?.id).toBe('vc2');
  });

  it('findVariationConfigByTargetObject returns null when no config exists', async () => {
    const config = await findVariationConfigByTargetObject(client, 'person');

    expect(config).toBeNull();
  });

  it('updateVariationConfigBookkeeping writes the given fields', async () => {
    await updateVariationConfigBookkeeping(client, 'vc1', {
      lastSyncedAt: '2026-07-07T00:00:00.000Z',
      lastError: '',
      statusReason: '2 variation(s) skipped',
    });

    const record = client.get('variationConfig', 'vc1')!;
    expect(record.lastSyncedAt).toBe('2026-07-07T00:00:00.000Z');
    expect(record.statusReason).toBe('2 variation(s) skipped');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-config-repository.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `variation-types.ts`**

```typescript
// A VariationConfig record as the sync engine consumes it.
export type VariationConfigRecord = {
  id: string;
  // Deterministic key = targetObject (uniqueness anchor: one config per object).
  name?: string | null;
  targetObject?: string | null;
  // Name of the self-referencing relation field this config provisions
  // ("primaryRecord" by default). Stored explicitly, never re-derived.
  relationFieldName?: string | null;
  createdRelationField?: boolean | null;
  enabled?: boolean | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  status?: string | null;
  statusReason?: string | null;
};
```

- [ ] **Step 4: Write `variation-config-repository.ts`**

```typescript
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

const VARIATION_CONFIG_FIELDS_SELECTION = {
  id: true,
  name: true,
  targetObject: true,
  relationFieldName: true,
  createdRelationField: true,
  enabled: true,
  lastSyncedAt: true,
  lastError: true,
  status: true,
  statusReason: true,
} as const;

export const loadAllEnabledVariationConfigs = async (
  client: FormulaClient,
  pageSize = 200,
): Promise<VariationConfigRecord[]> => {
  const results: VariationConfigRecord[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        variationConfigs: {
          __args: {
            first: pageSize,
            filter: { enabled: { eq: true } },
            ...(after ? { after } : {}),
          },
          edges: { node: VARIATION_CONFIG_FIELDS_SELECTION },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.variationConfigs;
    for (const edge of connection?.edges ?? []) {
      if (edge?.node) results.push(edge.node as VariationConfigRecord);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return results;
};

export const findVariationConfigByTargetObject = async (
  client: FormulaClient,
  targetObject: string,
): Promise<VariationConfigRecord | null> => {
  const response = await withRetry(() =>
    client.query({
      variationConfigs: {
        __args: { first: 1, filter: { name: { eq: targetObject } } },
        edges: { node: VARIATION_CONFIG_FIELDS_SELECTION },
      },
    }),
  );
  return (
    (response?.variationConfigs?.edges?.[0]?.node as
      | VariationConfigRecord
      | undefined) ?? null
  );
};

export const updateVariationConfigBookkeeping = async (
  client: FormulaClient,
  configId: string,
  data: {
    lastSyncedAt?: string;
    lastError?: string;
    status?: string;
    statusReason?: string;
  },
): Promise<void> => {
  await withRetry(() =>
    client.mutation({
      updateVariationConfig: {
        __args: { id: configId, data },
        id: true,
      },
    }),
  );
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-config-repository.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/logic-functions/lib/variation-types.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/variation-config-repository.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/variation-config-repository.spec.ts
git commit -m "feat(record-variations): add VariationConfig repository"
```

---

### Task 5: Primary → variations propagation

**Files:**
- Create: `src/logic-functions/lib/variation-sync.ts`
- Test: `src/logic-functions/lib/__tests__/variation-sync-primary-update.spec.ts`

**Interfaces:**
- Consumes: `computeSyncableFields(client, targetObject, relationFieldName): Promise<SyncableFieldInfo[]>` (Task 2), `loadActiveOverrideFieldsForRecord(client, targetObject, recordId): Promise<Set<string>>` (Task 3), `deepJsonEqual` (existing, `lib/deep-equal.ts`), `selectionEntryForMirrorKind` (existing, `lib/mirror-kinds.ts`), `navigatePath` (existing, `lib/coercion.ts`), `pluralize` (existing, exported from `lib/recompute.ts`), `withRetry` (existing), `FormulaClient` (existing).
- Produces (all in `variation-sync.ts`, this task's additions): `export type SyncOutcome = { variationRecordId: string; changed: boolean; changedFields: string[]; error: string | null }`, `const capitalize`, `const fetchRecordById`, `export const loadVariationRecordIds = async (client, targetObject, relationFieldName, primaryRecordId, pageSize?): Promise<string[]>`, `export const syncOneVariation = async (client, targetObject, primaryRecord: Record<string, unknown>, variationId: string, fieldsToConsider: SyncableFieldInfo[]): Promise<SyncOutcome>`, `export type PrimaryUpdateSyncArgs = { client: FormulaClient; targetObject: string; primaryRecordId: string; updatedFields: string[] | undefined; relationFieldName: string }`, `export const syncPrimaryUpdateToVariations = async (args: PrimaryUpdateSyncArgs): Promise<SyncOutcome[]>`. Task 6, 7, 8, 9 all extend this SAME file and reuse `SyncOutcome`, `fetchRecordById`, `syncOneVariation`, `loadVariationRecordIds` by these exact names/signatures — do not rename them.

This is the core sync-planner: when a primary's syncable fields change, copy the changed ones onto each of its variations, batched into one mutation per variation, skipping fields with an active override, no-op-suppressed per field via `deepJsonEqual`.

- [ ] **Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, it } from 'vitest';

import { syncPrimaryUpdateToVariations } from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('syncPrimaryUpdateToVariations', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-domain', name: 'domainName', type: 'LINKS', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
  });

  it('copies a changed syncable field onto every variation in one mutation, skipping unchanged fields', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'acme.com', secondaryLinks: [] }, employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'old.com', secondaryLinks: [] }, employees: 50, primaryRecordId: 'p1' },
      { id: 'v2', name: 'Acme (variation 2)', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'acme.com', secondaryLinks: [] }, employees: 50, primaryRecordId: 'p1' },
    ]);

    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['domainName'],
      relationFieldName: 'primaryRecord',
    });

    expect(outcomes.find((outcome) => outcome.variationRecordId === 'v1')?.changed).toBe(true);
    expect(outcomes.find((outcome) => outcome.variationRecordId === 'v1')?.changedFields).toEqual(['domainName']);
    expect(client.get('company', 'v1')!.domainName).toEqual({
      primaryLinkLabel: '',
      primaryLinkUrl: 'acme.com',
      secondaryLinks: [],
    });
    // v2's domainName already matched -> no-op, zero writes for that field.
    expect(outcomes.find((outcome) => outcome.variationRecordId === 'v2')?.changed).toBe(false);
    const writesToV2 = client.writes.filter((write) => write.startsWith('company:v2:'));
    expect(writesToV2).toHaveLength(0);
  });

  it('skips a field with an active override on that variation, but still syncs its other changed fields', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'acme.com', secondaryLinks: [] }, employees: 99, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'old.com', secondaryLinks: [] }, employees: 50, primaryRecordId: 'p1' },
    ]);
    client.seed('formulaOverride', [
      {
        id: 'ov1',
        name: 'company.domainName#v1',
        targetObject: 'company',
        targetField: 'domainName',
        recordId: 'v1',
        overrideValue: null,
        overrideValueText: '{}',
        active: true,
      },
    ]);

    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['domainName', 'employees'],
      relationFieldName: 'primaryRecord',
    });

    expect(outcomes[0].changedFields).toEqual(['employees']);
    expect(client.get('company', 'v1')!.domainName).toEqual({
      primaryLinkLabel: '',
      primaryLinkUrl: 'old.com',
      secondaryLinks: [],
    });
    expect(client.get('company', 'v1')!.employees).toBe(99);
  });

  it('performs zero writes and returns an empty array when no changed field is syncable', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', primaryRecordId: 'p1' },
    ]);

    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['primaryRecordId'],
      relationFieldName: 'primaryRecord',
    });

    expect(outcomes).toEqual([]);
    expect(client.mutations).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-sync-primary-update.spec.ts`
Expected: FAIL — `variation-sync.ts` does not exist.

- [ ] **Step 3: Write `variation-sync.ts`**

```typescript
import { deepJsonEqual } from 'src/logic-functions/lib/deep-equal';
import { selectionEntryForMirrorKind } from 'src/logic-functions/lib/mirror-kinds';
import { navigatePath } from 'src/logic-functions/lib/coercion';
import {
  loadActiveOverrideFieldsForRecord,
} from 'src/logic-functions/lib/override-repository';
import { pluralize } from 'src/logic-functions/lib/recompute';
import {
  computeSyncableFields,
  type SyncableFieldInfo,
} from 'src/logic-functions/lib/syncable-fields';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Record-variations sync engine (design 2026-07-07). NOT a set of
// FormulaDefinitions: a parallel per-object concept that reuses the mirror
// engine's plumbing (deepJsonEqual, FormulaOverride, the kind-aware
// sub-selection helpers) to copy fields from a primary record to its
// variations — typed raw passthrough for every syncable kind, never engine
// evaluation.

export type SyncOutcome = {
  variationRecordId: string;
  changed: boolean;
  changedFields: string[];
  error: string | null;
};

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

const fieldSelection = (fields: string[]): Record<string, boolean> => {
  const selection: Record<string, boolean> = { id: true };
  for (const field of fields) {
    selection[field] = true;
  }
  return selection;
};

// Fetches a single record of `object` by id with kind-aware sub-selections.
// Mirrors recompute.ts's private fetchRecord (not exported there, so this is
// its own copy for this module).
const fetchRecordById = async (
  client: FormulaClient,
  object: string,
  recordId: string,
  fields: string[],
  selectionOverrides: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const response = await withRetry(() =>
    client.query({
      [object]: {
        __args: { filter: { id: { eq: recordId } } },
        ...fieldSelection(fields),
        ...selectionOverrides,
      },
    }),
  );
  return (response?.[object] as Record<string, unknown> | null) ?? null;
};

const selectionOverridesFor = (
  fields: SyncableFieldInfo[],
): Record<string, unknown> => {
  const overrides: Record<string, unknown> = {};
  for (const field of fields) {
    overrides[field.name] = selectionEntryForMirrorKind(field.kind);
  }
  return overrides;
};

// Every variation of `primaryRecordId` (records whose relation pointer equals
// it — the standard Twenty FK filter), paginated.
export const loadVariationRecordIds = async (
  client: FormulaClient,
  targetObject: string,
  relationFieldName: string,
  primaryRecordId: string,
  pageSize = 200,
): Promise<string[]> => {
  const pluralName = pluralize(targetObject);
  const filterFieldName = `${relationFieldName}Id`;
  const ids: string[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: {
            first: pageSize,
            filter: { [filterFieldName]: { eq: primaryRecordId } },
            ...(after ? { after } : {}),
          },
          edges: { node: { id: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.[pluralName];
    for (const edge of connection?.edges ?? []) {
      if (edge?.node?.id) ids.push(edge.node.id);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return ids;
};

// Copies `fieldsToConsider` from `primaryRecord` onto one variation: skips
// fields with an active override, compares the rest with deepJsonEqual against
// the variation's CURRENT stored value, and writes only the ones that actually
// differ, batched into ONE update mutation (sync owns many columns at once,
// unlike per-formula recompute's single-field write).
export const syncOneVariation = async (
  client: FormulaClient,
  targetObject: string,
  primaryRecord: Record<string, unknown>,
  variationId: string,
  fieldsToConsider: SyncableFieldInfo[],
): Promise<SyncOutcome> => {
  try {
    const overriddenFields = await loadActiveOverrideFieldsForRecord(
      client,
      targetObject,
      variationId,
    );
    const fieldsToSync = fieldsToConsider.filter(
      (field) => !overriddenFields.has(field.name),
    );
    if (fieldsToSync.length === 0) {
      return { variationRecordId: variationId, changed: false, changedFields: [], error: null };
    }

    const variationRecord = await fetchRecordById(
      client,
      targetObject,
      variationId,
      fieldsToSync.map((field) => field.name),
      selectionOverridesFor(fieldsToSync),
    );
    if (!variationRecord) {
      return {
        variationRecordId: variationId,
        changed: false,
        changedFields: [],
        error: 'Variation record not found',
      };
    }

    const data: Record<string, unknown> = {};
    const changedFieldNames: string[] = [];
    for (const field of fieldsToSync) {
      const primaryValue = navigatePath(primaryRecord, field.name) ?? null;
      const variationValue = navigatePath(variationRecord, field.name) ?? null;
      if (!deepJsonEqual(primaryValue, variationValue)) {
        data[field.name] = primaryValue;
        changedFieldNames.push(field.name);
      }
    }

    if (changedFieldNames.length === 0) {
      return { variationRecordId: variationId, changed: false, changedFields: [], error: null };
    }

    const mutationName = `update${capitalize(targetObject)}`;
    await withRetry(() =>
      client.mutation({
        [mutationName]: { __args: { id: variationId, data }, id: true },
      }),
    );

    return {
      variationRecordId: variationId,
      changed: true,
      changedFields: changedFieldNames,
      error: null,
    };
  } catch (error) {
    return {
      variationRecordId: variationId,
      changed: false,
      changedFields: [],
      error: String(error),
    };
  }
};

export type PrimaryUpdateSyncArgs = {
  client: FormulaClient;
  targetObject: string;
  primaryRecordId: string;
  // Which fields changed on the primary (from the event). undefined/empty is
  // never expected here (the caller always has updatedFields for an update
  // event) but is handled defensively as "nothing changed".
  updatedFields: string[] | undefined;
  relationFieldName: string;
};

// Primary updated: copy the changed syncable fields onto every one of its
// variations. Scoped to this primary's OWN variations only (never "recompute
// the whole object") — the m5 fan-out cliff this design explicitly avoids.
export const syncPrimaryUpdateToVariations = async ({
  client,
  targetObject,
  primaryRecordId,
  updatedFields,
  relationFieldName,
}: PrimaryUpdateSyncArgs): Promise<SyncOutcome[]> => {
  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);
  const syncableByName = new Map(syncable.map((field) => [field.name, field]));

  const changedSyncableFields = (updatedFields ?? [])
    .filter((field) => syncableByName.has(field))
    .map((field) => syncableByName.get(field)!);

  if (changedSyncableFields.length === 0) {
    return [];
  }

  // Fresh, kind-aware fetch of the primary for exactly the changed fields —
  // never trust the event's `after` payload for composite kinds (see Global
  // Constraints).
  const primary = await fetchRecordById(
    client,
    targetObject,
    primaryRecordId,
    changedSyncableFields.map((field) => field.name),
    selectionOverridesFor(changedSyncableFields),
  );
  if (!primary) {
    return [];
  }

  const variationIds = await loadVariationRecordIds(
    client,
    targetObject,
    relationFieldName,
    primaryRecordId,
  );

  const outcomes: SyncOutcome[] = [];
  for (const variationId of variationIds) {
    outcomes.push(
      await syncOneVariation(client, targetObject, primary, variationId, changedSyncableFields),
    );
  }
  return outcomes;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-sync-primary-update.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/logic-functions/lib/variation-sync.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/variation-sync-primary-update.spec.ts
git commit -m "feat(record-variations): sync changed primary fields onto variations"
```

---

### Task 6: Initial sync on variation creation, freeze on primary delete, single-level guards

**Files:**
- Modify: `src/logic-functions/lib/variation-sync.ts`
- Test: `src/logic-functions/lib/__tests__/variation-sync-lifecycle.spec.ts`

**Interfaces:**
- Consumes (from Task 5, same file): `SyncOutcome`, `fetchRecordById` (private in-file), `syncOneVariation`, `selectionOverridesFor` (private in-file), `capitalize` (private in-file); (from Task 2): `computeSyncableFields`.
- Produces (added to `variation-sync.ts`): `export type PrimaryFetchResult = { record: (Record<string, unknown> & { id: string }) | null; frozen: boolean }`, `export const fetchPrimaryRecordInclTrashed = async (client, targetObject, primaryRecordId, fields: string[], selectionOverrides: Record<string, unknown>, relationFieldName: string): Promise<PrimaryFetchResult>`, `export type NewVariationSyncArgs = { client; targetObject; variationRecordId; primaryRecordId; relationFieldName }`, `export const syncNewVariationRecord = async (args: NewVariationSyncArgs): Promise<SyncOutcome & { frozen?: boolean; skippedNestedPrimary?: boolean }>`. Task 8 (sweep) reuses `fetchPrimaryRecordInclTrashed` by this exact signature.

`fetchPrimaryRecordInclTrashed` queries the PLURAL connection (not the singular record type) specifically so it can pass `deletedAt: {}` in the filter — the existing, already-proven "return trashed rows only when the filter carries a `deletedAt` key" convention (see `FakeClient.connection`'s comment, mirroring the server's `withDeleted()` gate). It also always selects the primary's OWN `${relationFieldName}Id`, so a caller can check the single-level guard (a variation's primary must not itself be a variation) without a second fetch.

- [ ] **Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, it } from 'vitest';

import { syncNewVariationRecord } from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('syncNewVariationRecord', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
  });

  it('performs a full initial sync of every syncable field on a freshly created variation', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 42, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: null, primaryRecordId: 'p1' },
    ]);

    const outcome = await syncNewVariationRecord({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      relationFieldName: 'primaryRecord',
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.changedFields).toEqual(['employees']);
    expect(client.get('company', 'v1')!.employees).toBe(42);
  });

  it('freezes (no writes) when the primary is trashed', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 42, primaryRecordId: null, deletedAt: '2026-07-07T00:00:00.000Z' },
      { id: 'v1', name: 'Acme (variation)', employees: null, primaryRecordId: 'p1' },
    ]);

    const outcome = await syncNewVariationRecord({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      relationFieldName: 'primaryRecord',
    });

    expect(outcome.frozen).toBe(true);
    expect(outcome.changed).toBe(false);
    expect(client.get('company', 'v1')!.employees).toBeNull();
  });

  it('freezes (no writes) when the primary no longer exists at all', async () => {
    client.seed('company', [
      { id: 'v1', name: 'Acme (variation)', employees: null, primaryRecordId: 'missing' },
    ]);

    const outcome = await syncNewVariationRecord({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'missing',
      relationFieldName: 'primaryRecord',
    });

    expect(outcome.frozen).toBe(true);
  });

  it('skips sync when the chosen primary itself has a non-null pointer (single-level guard)', async () => {
    client.seed('company', [
      { id: 'root', name: 'Root', employees: 1, primaryRecordId: null },
      { id: 'p1', name: 'Acme', employees: 42, primaryRecordId: 'root' },
      { id: 'v1', name: 'Acme (variation)', employees: null, primaryRecordId: 'p1' },
    ]);

    const outcome = await syncNewVariationRecord({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      relationFieldName: 'primaryRecord',
    });

    expect(outcome.skippedNestedPrimary).toBe(true);
    expect(outcome.changed).toBe(false);
    expect(client.get('company', 'v1')!.employees).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-sync-lifecycle.spec.ts`
Expected: FAIL — `syncNewVariationRecord` is not exported.

- [ ] **Step 3: Add `fetchPrimaryRecordInclTrashed` and `syncNewVariationRecord` to `variation-sync.ts`**

Read the current file (from Task 5) first, then append:

```typescript
export type PrimaryFetchResult = {
  record: (Record<string, unknown> & { id: string }) | null;
  // True when the primary is trashed OR no longer exists at all (destroyed) —
  // freeze semantics do not distinguish the two (design 2026-07-07): sync skips
  // the variation entirely either way, no writes, values stay as they were.
  frozen: boolean;
};

// Fetches the primary INCLUDING trashed rows, via the plural connection with an
// explicit (empty) `deletedAt` filter key — the same withDeleted() convention
// already proven for FakeClient/the server elsewhere in this app (see
// FakeClient.connection). Also always selects the primary's OWN relation
// pointer so callers get the single-level guard for free.
export const fetchPrimaryRecordInclTrashed = async (
  client: FormulaClient,
  targetObject: string,
  primaryRecordId: string,
  fields: string[],
  selectionOverrides: Record<string, unknown>,
  relationFieldName: string,
): Promise<PrimaryFetchResult> => {
  const pluralName = pluralize(targetObject);
  const pointerField = `${relationFieldName}Id`;
  const response = await withRetry(() =>
    client.query({
      [pluralName]: {
        __args: {
          first: 1,
          filter: { id: { eq: primaryRecordId }, deletedAt: {} },
        },
        edges: {
          node: {
            ...fieldSelection(fields),
            ...selectionOverrides,
            deletedAt: true,
            [pointerField]: true,
          },
        },
      },
    }),
  );
  const node = response?.[pluralName]?.edges?.[0]?.node as
    | (Record<string, unknown> & { id: string; deletedAt?: string | null })
    | undefined;

  if (!node) {
    return { record: null, frozen: true };
  }
  if (node.deletedAt) {
    return { record: node, frozen: true };
  }
  return { record: node, frozen: false };
};

export type NewVariationSyncArgs = {
  client: FormulaClient;
  targetObject: string;
  variationRecordId: string;
  primaryRecordId: string;
  relationFieldName: string;
};

// Variation created: full initial sync of every syncable field. Covers
// API-created variations directly (the widget's create path, built in Plan 3,
// relies on this SAME handler rather than duplicating sync client-side).
export const syncNewVariationRecord = async ({
  client,
  targetObject,
  variationRecordId,
  primaryRecordId,
  relationFieldName,
}: NewVariationSyncArgs): Promise<
  SyncOutcome & { frozen?: boolean; skippedNestedPrimary?: boolean }
> => {
  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);
  const pointerField = `${relationFieldName}Id`;

  const { record: primary, frozen } = await fetchPrimaryRecordInclTrashed(
    client,
    targetObject,
    primaryRecordId,
    syncable.map((field) => field.name),
    selectionOverridesFor(syncable),
    relationFieldName,
  );

  if (frozen || !primary) {
    return {
      variationRecordId,
      changed: false,
      changedFields: [],
      error: null,
      frozen: true,
    };
  }

  // Single-level guard: the chosen primary must not itself be a variation. A
  // variation cannot be a primary — this can only happen if data raced in via
  // the API (the widget hides "create variation" on a record with a pointer,
  // and the create path re-checks server-side before calling this function).
  if (navigatePath(primary, pointerField)) {
    return {
      variationRecordId,
      changed: false,
      changedFields: [],
      error: null,
      skippedNestedPrimary: true,
    };
  }

  const outcome = await syncOneVariation(client, targetObject, primary, variationRecordId, syncable);
  return outcome;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-sync-lifecycle.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full package suite**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/logic-functions/lib/variation-sync.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/variation-sync-lifecycle.spec.ts
git commit -m "feat(record-variations): initial sync on create, freeze-on-delete, single-level guard"
```

---

### Task 7: Divergence detection (human edit on a variation → override)

**Files:**
- Modify: `src/logic-functions/lib/variation-sync.ts`
- Test: `src/logic-functions/lib/__tests__/variation-sync-divergence.spec.ts`

**Interfaces:**
- Consumes (from Task 5/6, same file): `fetchRecordById`, `fetchPrimaryRecordInclTrashed`, `selectionOverridesFor`, `computeSyncableFields`; (existing) `deepJsonEqual`, `ENGINE_FAMILY_KINDS` (`lib/mirror-kinds.ts`), `upsertOverride` (`lib/override-repository.ts`), `navigatePath`.
- Produces (added to `variation-sync.ts`): `export type DetectDivergenceArgs = { client; targetObject; variationRecordId; primaryRecordId; after: Record<string,unknown>|null|undefined; updatedFields: string[]|undefined; actorWorkspaceMemberId?: string|null; relationFieldName }`, `export const detectVariationDivergence = async (args: DetectDivergenceArgs): Promise<void>`. Task 9's trigger wiring calls this exact function on the "variation updated by a human" branch.

This mirrors `handle-record-update.ts`'s mirror branch's compare-value-not-actor + echo-race guard, generalized across the whole syncable-field set (not just mirror kinds) and using the field-kind-aware override slot split from Global Constraints (only `NUMBER` uses `overrideValue`; everything else — including `CURRENCY`/`DATE`/`DATE_TIME` — uses `overrideValueText`).

- [ ] **Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, it } from 'vitest';

import { detectVariationDivergence } from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('detectVariationDivergence', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-domain', name: 'domainName', type: 'LINKS', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
  });

  it('pins a NUMBER override (numeric slot) when a human edits a variation field away from the primary', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 75, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { employees: 75 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    const override = client.get('formulaOverride', 'ov-employees') ?? Array.from((client as any).store?.get?.('formulaOverride')?.values?.() ?? []).find((o: any) => o.targetField === 'employees');
    expect(override.overrideValue).toBe(75);
    expect(override.overrideValueText).toBeNull();
    expect(override.active).toBe(true);
  });

  it('pins a text override (JSON slot) when a human edits a composite (LINKS) variation field', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'acme.com', secondaryLinks: [] }, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'custom.com', secondaryLinks: [] }, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { domainName: { primaryLinkLabel: '', primaryLinkUrl: 'custom.com', secondaryLinks: [] } },
      updatedFields: ['domainName'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    const stored: any = Array.from((client as any).store.get('formulaOverride').values()).find(
      (o: any) => o.targetField === 'domainName',
    );
    expect(stored.overrideValue).toBeNull();
    expect(JSON.parse(stored.overrideValueText)).toEqual({
      primaryLinkLabel: '',
      primaryLinkUrl: 'custom.com',
      secondaryLinks: [],
    });
  });

  it('does NOT create an override when the value equals the primary (app echo)', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 50, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    expect(client.mutations).toBe(0);
  });

  it('does NOT create an override when there is no actor (API-key write)', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 75, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { employees: 75 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: null,
      relationFieldName: 'primaryRecord',
    });

    expect(client.mutations).toBe(0);
  });

  it('skips a superseded stale echo (stored value already moved past the event value)', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      // Stored value (75) has already moved past what this stale event reports (60).
      { id: 'v1', name: 'Acme (variation)', employees: 75, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { employees: 60 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    expect(client.mutations).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-sync-divergence.spec.ts`
Expected: FAIL — `detectVariationDivergence` is not exported.

- [ ] **Step 3: Add `detectVariationDivergence` to `variation-sync.ts`**

Add these imports at the top of the file (alongside the existing ones):

```typescript
import { ENGINE_FAMILY_KINDS } from 'src/logic-functions/lib/mirror-kinds';
import { upsertOverride } from 'src/logic-functions/lib/override-repository';
```

Then append:

```typescript
// The FormulaOverride value slot for a raw variation value: overrideValue (a
// NUMBER column) can only literally hold a plain JS number. Since variation
// sync never evaluates anything, only a bare NUMBER field's raw value already
// IS a number — every other kind (including CURRENCY's {amountMicros,
// currencyCode} object and DATE/DATE_TIME's string scalars) goes to
// overrideValueText as JSON. This deliberately differs from the formula
// engine's "ENGINE_FAMILY_KINDS -> numeric slot" convention, which only holds
// because a formula EVALUATES to a float; variation sync just copies bytes.
const overrideSlotFor = (
  kind: string,
  rawValue: unknown,
): { numeric?: number; text?: string } => {
  if (kind === 'NUMBER' && typeof rawValue === 'number') {
    return { numeric: rawValue };
  }
  return { text: JSON.stringify(rawValue ?? null) };
};

export type DetectDivergenceArgs = {
  client: FormulaClient;
  targetObject: string;
  variationRecordId: string;
  primaryRecordId: string;
  after: Record<string, unknown> | null | undefined;
  updatedFields: string[] | undefined;
  // Set when the write came from a real person, not the app's own sync write.
  actorWorkspaceMemberId?: string | null;
  relationFieldName: string;
};

// A human edited a variation directly. Tells a genuine edit apart from the
// app's own sync write using the SAME compare-value-not-actor rule the mirror
// engine uses (an app write can inherit a human actor's identity on its event,
// so the actor alone can't decide this): fresh-fetch the CURRENT stored value
// (echo-race guard — a stale event must not be acted on once superseded),
// compare it to the primary's current value; equal means it's the app's own
// passthrough write, different means a human pinned a manual value.
export const detectVariationDivergence = async ({
  client,
  targetObject,
  variationRecordId,
  primaryRecordId,
  after,
  updatedFields,
  actorWorkspaceMemberId,
  relationFieldName,
}: DetectDivergenceArgs): Promise<void> => {
  if (!actorWorkspaceMemberId || !updatedFields || updatedFields.length === 0) {
    return;
  }

  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);
  const syncableByName = new Map(syncable.map((field) => [field.name, field]));
  const fieldsToCheck = updatedFields.filter((field) => syncableByName.has(field));
  if (fieldsToCheck.length === 0) {
    return;
  }

  const fieldsToCheckInfo = fieldsToCheck.map((field) => syncableByName.get(field)!);
  const { record: primary, frozen } = await fetchPrimaryRecordInclTrashed(
    client,
    targetObject,
    primaryRecordId,
    fieldsToCheckInfo.map((field) => field.name),
    selectionOverridesFor(fieldsToCheckInfo),
    relationFieldName,
  );
  if (frozen || !primary) {
    return; // Nothing to compare a diverging edit against.
  }

  for (const field of fieldsToCheckInfo) {
    const eventRaw = navigatePath(after ?? {}, field.name) ?? null;

    const freshVariation = await fetchRecordById(
      client,
      targetObject,
      variationRecordId,
      [field.name],
      { [field.name]: selectionEntryForMirrorKind(field.kind) },
    );
    if (!freshVariation) continue;
    const currentRaw = navigatePath(freshVariation, field.name) ?? null;

    // Superseded write in flight: the stored value already moved past what
    // this event reports -> a newer write is converging, skip the stale echo.
    if (!deepJsonEqual(currentRaw, eventRaw)) continue;

    const primaryRaw = navigatePath(primary, field.name) ?? null;
    // Current value equals the primary's -> the app's own sync write, not a
    // human pin.
    if (deepJsonEqual(primaryRaw, currentRaw)) continue;

    await upsertOverride(
      client,
      targetObject,
      field.name,
      variationRecordId,
      overrideSlotFor(field.kind, currentRaw),
    );
  }
};
```

The unused `ENGINE_FAMILY_KINDS` import above is referenced only in the comment's reasoning, not in code — remove that import line if the linter flags it as unused (it is not needed at runtime since `overrideSlotFor` checks `kind === 'NUMBER'` directly rather than the broader engine-family set).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-sync-divergence.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full package suite and lint**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run`
Expected: PASS.

Run: `npx nx lint:diff-with-main twenty-apps` (or the equivalent lint command for this package — check `package.json`; if this app package isn't wired into the root `nx lint` targets, run its own `yarn lint` from `packages/twenty-apps/community/formula-field/`) and fix any unused-import/no-any violations before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/logic-functions/lib/variation-sync.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/variation-sync-divergence.spec.ts
git commit -m "feat(record-variations): detect human edits on a variation as overrides"
```

---

### Task 8: Hourly convergence sweep

**Files:**
- Modify: `src/logic-functions/lib/variation-sync.ts`
- Test: `src/logic-functions/lib/__tests__/variation-sweep.spec.ts`

**Interfaces:**
- Consumes (from Task 4): `VariationConfigRecord` (`variation-types.ts`), `updateVariationConfigBookkeeping` (`variation-config-repository.ts`); (from Task 5/6, same file): `computeSyncableFields`, `syncOneVariation`, `fetchPrimaryRecordInclTrashed`, `pluralize`, `navigatePath`, `withRetry`, `graphqlEnum` (existing, `lib/dynamic-client.ts`).
- Produces (added to `variation-sync.ts`): `export type SweepOutcome = { configId: string; evaluated: number; written: number; errored: number; frozen: number; skippedNestedPrimary: number }`, `export const sweepVariationConfig = async (client: FormulaClient, config: VariationConfigRecord, pageSize?: number): Promise<SweepOutcome>`. Task 9's cron logic-function file calls this once per enabled config.

Per enabled config, page every variation of that object (`{relationFieldName}Id: { is: NOT_NULL }`), re-sync all syncable fields (skipping active overrides — reusing `syncOneVariation`, which already does that), skip frozen/nested-primary ones, isolate per-record faults, write one heartbeat at the end. This is the formula-sweep pattern (`formula-sweep.ts`/`recomputeAllRecords`), generalized to variations.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';

import { sweepVariationConfig } from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

const config = (overrides: Record<string, unknown> = {}) => ({
  id: 'vc1',
  name: 'company',
  targetObject: 'company',
  relationFieldName: 'primaryRecord',
  createdRelationField: true,
  enabled: true,
  lastSyncedAt: null,
  lastError: '',
  status: '',
  statusReason: '',
  ...overrides,
});

describe('sweepVariationConfig', () => {
  it('re-syncs every variation of the object and records a heartbeat', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
    ]);
    client.seed('variationConfig', [config()]);

    const outcome = await sweepVariationConfig(client, config());

    expect(outcome.evaluated).toBe(1);
    expect(outcome.written).toBe(1);
    expect(client.get('company', 'v1')!.employees).toBe(50);
    expect(client.get('variationConfig', 'vc1')!.lastSyncedAt).toBeDefined();
  });

  it('freezes a variation whose primary is trashed, without aborting the sweep', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null, deletedAt: '2026-07-07T00:00:00.000Z' },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
      { id: 'p2', name: 'Beta', employees: 20, primaryRecordId: null },
      { id: 'v2', name: 'Beta (variation)', employees: 1, primaryRecordId: 'p2' },
    ]);
    client.seed('variationConfig', [config()]);

    const outcome = await sweepVariationConfig(client, config());

    expect(outcome.frozen).toBe(1);
    expect(outcome.written).toBe(1);
    expect(client.get('company', 'v1')!.employees).toBe(10);
    expect(client.get('company', 'v2')!.employees).toBe(20);
  });

  it('skips a variation whose primary is itself a variation and records a statusReason', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('company', [
      { id: 'root', name: 'Root', employees: 1, primaryRecordId: null },
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: 'root' },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
    ]);
    client.seed('variationConfig', [config()]);

    const outcome = await sweepVariationConfig(client, config());

    expect(outcome.skippedNestedPrimary).toBe(1);
    expect(client.get('company', 'v1')!.employees).toBe(10);
    expect(client.get('variationConfig', 'vc1')!.statusReason).toContain('1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-sweep.spec.ts`
Expected: FAIL — `sweepVariationConfig` is not exported.

- [ ] **Step 3: Add `sweepVariationConfig` to `variation-sync.ts`**

Add these imports at the top:

```typescript
import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import { updateVariationConfigBookkeeping } from 'src/logic-functions/lib/variation-config-repository';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
```

Then append:

```typescript
export type SweepOutcome = {
  configId: string;
  evaluated: number;
  written: number;
  errored: number;
  frozen: number;
  skippedNestedPrimary: number;
};

// Hourly convergence backstop, per enabled config: page every variation of the
// object, re-sync it against its (possibly-fresh) primary, skipping active
// overrides (syncOneVariation already does this) — same posture as
// formula-sweep.ts/recomputeAllRecords, generalized to variations.
export const sweepVariationConfig = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  pageSize = 100,
): Promise<SweepOutcome> => {
  const targetObject = config.targetObject ?? '';
  const relationFieldName = config.relationFieldName ?? 'primaryRecord';
  const pluralName = pluralize(targetObject);
  const pointerField = `${relationFieldName}Id`;
  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);

  let evaluated = 0;
  let written = 0;
  let errored = 0;
  let frozen = 0;
  let skippedNestedPrimary = 0;
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: {
            first: pageSize,
            filter: { [pointerField]: { is: graphqlEnum('NOT_NULL') } },
            ...(after ? { after } : {}),
          },
          edges: { node: { id: true, [pointerField]: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.[pluralName];
    const edges: Array<{ node?: Record<string, unknown> }> = connection?.edges ?? [];

    for (const edge of edges) {
      const variationId = edge?.node?.id as string | undefined;
      const primaryRecordId = edge?.node?.[pointerField] as string | undefined;
      if (!variationId || !primaryRecordId) continue;
      evaluated += 1;

      try {
        const { record: primary, frozen: isFrozen } = await fetchPrimaryRecordInclTrashed(
          client,
          targetObject,
          primaryRecordId,
          syncable.map((field) => field.name),
          selectionOverridesFor(syncable),
          relationFieldName,
        );
        if (isFrozen || !primary) {
          frozen += 1;
          continue;
        }
        if (navigatePath(primary, pointerField)) {
          skippedNestedPrimary += 1;
          continue;
        }
        const outcome = await syncOneVariation(client, targetObject, primary, variationId, syncable);
        if (outcome.error) errored += 1;
        else if (outcome.changed) written += 1;
      } catch (error) {
        errored += 1;
      }
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  const statusReason =
    skippedNestedPrimary > 0
      ? `${skippedNestedPrimary} variation(s) skipped: primary itself is a variation`
      : '';
  await updateVariationConfigBookkeeping(client, config.id, {
    lastSyncedAt: new Date().toISOString(),
    lastError: '',
    statusReason,
  });

  return { configId: config.id, evaluated, written, errored, frozen, skippedNestedPrimary };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-sweep.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full package suite**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run`
Expected: PASS — all prior tasks' tests plus this one.

- [ ] **Step 6: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/logic-functions/lib/variation-sync.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/variation-sweep.spec.ts
git commit -m "feat(record-variations): add hourly convergence sweep"
```

---

### Task 9: Wire the wildcard triggers and the cron sweep

**Files:**
- Create: `src/logic-functions/on-record-updated-variations.ts`
- Create: `src/logic-functions/on-record-created-variations.ts`
- Create: `src/logic-functions/variation-sweep.ts`
- Modify: `src/logic-functions/lib/variation-sync.ts` (add the two dispatcher functions below)
- Test: `src/logic-functions/lib/__tests__/variation-dispatch.spec.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 2–8 in `variation-sync.ts`, plus `findVariationConfigByTargetObject` (`variation-config-repository.ts`), `createDynamicCoreClient` (existing, `lib/dynamic-client.ts`), `defineLogicFunction`/`DatabaseEventPayload`/`ObjectRecordUpdateEvent`/`ObjectRecordCreateEvent` (existing, `twenty-sdk/define`).
- Produces: `export const handleVariationRecordUpdated = async (args): Promise<{ role: 'none' | 'primary' | 'variation'; outcomes: SyncOutcome[] }>`, `export const handleVariationRecordCreated = async (args): Promise<(SyncOutcome & {...}) | null>` (both in `variation-sync.ts`) — the three new logic-function files are thin wrappers around these two, exactly mirroring `on-record-updated.ts`/`on-record-created.ts`/`formula-sweep.ts`'s relationship to `handleRecordUpdate`/`recomputeAllRecords`.

These two dispatcher functions decide "is this record a primary or a variation?" by a FRESH read of its relation pointer (never trusting the wildcard event's `after` for this — see Global Constraints), then route to the Task 5/6/7 functions.

- [ ] **Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, it } from 'vitest';

import {
  handleVariationRecordCreated,
  handleVariationRecordUpdated,
} from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('handleVariationRecordUpdated / handleVariationRecordCreated', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('variationConfig', [
      {
        id: 'vc1',
        name: 'company',
        targetObject: 'company',
        relationFieldName: 'primaryRecord',
        createdRelationField: true,
        enabled: true,
        lastSyncedAt: null,
        lastError: '',
        status: '',
        statusReason: '',
      },
    ]);
  });

  it('routes an update on a primary (null pointer) to primary-fan-out sync', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
    ]);

    const result = await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(result.role).toBe('primary');
    expect(client.get('company', 'v1')!.employees).toBe(50);
  });

  it('routes an update on a variation (non-null pointer) to divergence detection', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 75, primaryRecordId: 'p1' },
    ]);

    const result = await handleVariationRecordUpdated({
      client,
      objectName: 'company',
      recordId: 'v1',
      after: { employees: 75 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(result.role).toBe('variation');
    const stored: any = Array.from((client as any).store.get('formulaOverride')?.values() ?? []).find(
      (o: any) => o.targetField === 'employees',
    );
    expect(stored.overrideValue).toBe(75);
  });

  it('does nothing when the object has no enabled VariationConfig', async () => {
    client.seed('opportunity', [{ id: 'o1', amount: 1 }]);

    const result = await handleVariationRecordUpdated({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: {},
      updatedFields: [],
      actorWorkspaceMemberId: 'wm-1',
    });

    expect(result.role).toBe('none');
  });

  it('performs the initial sync when a record is created with a non-null pointer', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: null, primaryRecordId: 'p1' },
    ]);

    const outcome = await handleVariationRecordCreated({
      client,
      objectName: 'company',
      recordId: 'v1',
      after: { id: 'v1', primaryRecordId: 'p1' },
    });

    expect(outcome?.changed).toBe(true);
    expect(client.get('company', 'v1')!.employees).toBe(50);
  });

  it('returns null when a record is created with no pointer (it is itself a primary)', async () => {
    client.seed('company', [{ id: 'p2', name: 'Beta', employees: 1, primaryRecordId: null }]);

    const outcome = await handleVariationRecordCreated({
      client,
      objectName: 'company',
      recordId: 'p2',
      after: { id: 'p2', primaryRecordId: null },
    });

    expect(outcome).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-dispatch.spec.ts`
Expected: FAIL — `handleVariationRecordUpdated`/`handleVariationRecordCreated` are not exported.

- [ ] **Step 3: Add the two dispatchers to `variation-sync.ts`**

Add this import at the top:

```typescript
import { findVariationConfigByTargetObject } from 'src/logic-functions/lib/variation-config-repository';
```

Then append:

```typescript
export type VariationRecordUpdatedArgs = {
  client: FormulaClient;
  objectName: string;
  recordId: string;
  after: Record<string, unknown> | null | undefined;
  updatedFields: string[] | undefined;
  actorWorkspaceMemberId?: string | null;
};

// Entry point for the *.updated wildcard trigger. Decides whether the changed
// record is a primary (fan out the change to its variations) or a variation
// (check whether a human just diverged one of its fields) by a FRESH read of
// its relation pointer — never trusted from the event payload (Global
// Constraints): a pointer field is exactly the kind of value an echo-race could
// make stale.
export const handleVariationRecordUpdated = async ({
  client,
  objectName,
  recordId,
  after,
  updatedFields,
  actorWorkspaceMemberId,
}: VariationRecordUpdatedArgs): Promise<{
  role: 'none' | 'primary' | 'variation';
  outcomes: SyncOutcome[];
}> => {
  const config = await findVariationConfigByTargetObject(client, objectName);
  if (!config || !config.enabled) {
    return { role: 'none', outcomes: [] };
  }

  const relationFieldName = config.relationFieldName ?? 'primaryRecord';
  const pointerField = `${relationFieldName}Id`;

  const current = await fetchRecordById(client, objectName, recordId, [pointerField], {});
  const primaryRecordId = current
    ? ((navigatePath(current, pointerField) as string | null | undefined) ?? null)
    : null;

  if (!primaryRecordId) {
    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: objectName,
      primaryRecordId: recordId,
      updatedFields,
      relationFieldName,
    });
    return { role: 'primary', outcomes };
  }

  await detectVariationDivergence({
    client,
    targetObject: objectName,
    variationRecordId: recordId,
    primaryRecordId,
    after,
    updatedFields,
    actorWorkspaceMemberId,
    relationFieldName,
  });
  return { role: 'variation', outcomes: [] };
};

export type VariationRecordCreatedArgs = {
  client: FormulaClient;
  objectName: string;
  recordId: string;
  after: Record<string, unknown> | null | undefined;
};

// Entry point for the *.created wildcard trigger. A create event's `after` is
// trusted for the pointer scalar directly (unlike the update path) — there is
// no prior state for a stale echo to race against on a brand-new record.
export const handleVariationRecordCreated = async ({
  client,
  objectName,
  recordId,
  after,
}: VariationRecordCreatedArgs): Promise<
  (SyncOutcome & { frozen?: boolean; skippedNestedPrimary?: boolean }) | null
> => {
  const config = await findVariationConfigByTargetObject(client, objectName);
  if (!config || !config.enabled) {
    return null;
  }

  const relationFieldName = config.relationFieldName ?? 'primaryRecord';
  const pointerField = `${relationFieldName}Id`;
  const primaryRecordId = (after?.[pointerField] as string | undefined) ?? null;

  // No pointer -> this new record IS a primary (or a plain record); nothing to
  // sync onto it.
  if (!primaryRecordId) {
    return null;
  }

  // Self-reference guard: reject wiring a record to itself (data raced in via
  // the API — the widget's own create path never sets this).
  if (primaryRecordId === recordId) {
    return null;
  }

  return syncNewVariationRecord({
    client,
    targetObject: objectName,
    variationRecordId: recordId,
    primaryRecordId,
    relationFieldName,
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run src/logic-functions/lib/__tests__/variation-dispatch.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the three logic-function trigger files**

`src/logic-functions/on-record-updated-variations.ts`:

```typescript
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordUpdateEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleVariationRecordUpdated } from 'src/logic-functions/lib/variation-sync';

// Separate wildcard subscription from the formula engine's on-record-updated.ts
// (design 2026-07-07): variation sync is a parallel concept, not a
// FormulaDefinition, so it gets its own trigger rather than coupling into
// handleRecordUpdate.
const APP_OWNED_OBJECTS = new Set([
  'formulaDefinition',
  'formulaOverride',
  'variationConfig',
]);

const handler = async (
  payload: DatabaseEventPayload<ObjectRecordUpdateEvent<Record<string, unknown>>>,
): Promise<Record<string, unknown>> => {
  const objectName = payload.objectMetadata?.nameSingular;
  if (!objectName || APP_OWNED_OBJECTS.has(objectName)) {
    return { skipped: true };
  }

  const client = createDynamicCoreClient();
  const { after, updatedFields } = payload.properties;
  const recordId = payload.recordId ?? (after?.id as string | undefined);
  if (!recordId) {
    return { skipped: true };
  }

  const result = await handleVariationRecordUpdated({
    client,
    objectName,
    recordId,
    after: after as unknown as Record<string, unknown>,
    updatedFields,
    actorWorkspaceMemberId: payload.workspaceMemberId,
  });

  return { role: result.role, outcomes: result.outcomes.length };
};

export default defineLogicFunction({
  universalIdentifier: '789cfc8d-e97a-44d0-a806-092c1a7d906e',
  name: 'on-record-updated-variations',
  description: 'Sync primary -> variations, or detect a diverging edit on a variation.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: '*.updated' },
});
```

`src/logic-functions/on-record-created-variations.ts`:

```typescript
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordCreateEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleVariationRecordCreated } from 'src/logic-functions/lib/variation-sync';

const APP_OWNED_OBJECTS = new Set([
  'formulaDefinition',
  'formulaOverride',
  'variationConfig',
]);

const handler = async (
  payload: DatabaseEventPayload<ObjectRecordCreateEvent<Record<string, unknown>>>,
): Promise<Record<string, unknown>> => {
  const objectName = payload.objectMetadata?.nameSingular;
  if (!objectName || APP_OWNED_OBJECTS.has(objectName)) {
    return { skipped: true };
  }

  const client = createDynamicCoreClient();
  const after = payload.properties.after;
  const recordId = payload.recordId ?? (after?.id as string | undefined);
  if (!recordId) {
    return { skipped: true };
  }

  const outcome = await handleVariationRecordCreated({
    client,
    objectName,
    recordId,
    after: after as unknown as Record<string, unknown>,
  });

  return { synced: outcome !== null, changed: outcome?.changed ?? false };
};

export default defineLogicFunction({
  universalIdentifier: '4e55d4a5-45aa-4adc-a60f-6f8c3c11bade',
  name: 'on-record-created-variations',
  description: 'Full initial sync when a record is created as a variation.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: '*.created' },
});
```

`src/logic-functions/variation-sweep.ts`:

```typescript
import { defineLogicFunction } from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { loadAllEnabledVariationConfigs } from 'src/logic-functions/lib/variation-config-repository';
import { sweepVariationConfig } from 'src/logic-functions/lib/variation-sync';

// The convergence backstop for variations, mirroring formula-sweep.ts: hourly,
// re-sync every enabled config's variations. Repairs anything staled by a
// missed event, a deploy window, or a transient error.
const handler = async (): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const configs = await loadAllEnabledVariationConfigs(client);

  let evaluated = 0;
  let written = 0;
  let errored = 0;
  let frozen = 0;

  for (const config of configs) {
    const outcome = await sweepVariationConfig(client, config);
    evaluated += outcome.evaluated;
    written += outcome.written;
    errored += outcome.errored;
    frozen += outcome.frozen;
  }

  return { configs: configs.length, evaluated, written, errored, frozen };
};

export default defineLogicFunction({
  universalIdentifier: 'd6e19796-a375-4ba0-ace6-b218094c632e',
  name: 'variation-sweep',
  description: 'Hourly re-sync of all enabled variation configs (convergence backstop).',
  timeoutSeconds: 120,
  handler,
  cronTriggerSettings: { pattern: '0 * * * *' },
});
```

These three files have no dedicated spec — matching the existing precedent that `on-record-updated.ts`/`on-record-created.ts`/`formula-sweep.ts` are thin wrappers with no `.spec.ts` of their own; all their logic is already covered by testing `handleVariationRecordUpdated`/`handleVariationRecordCreated`/`sweepVariationConfig` directly (Task 8/9's tests).

- [ ] **Step 6: Run the full package suite, typecheck, and lint**

Run: `cd packages/twenty-apps/community/formula-field && npx vitest run`
Expected: PASS — every test from Tasks 2 through 9.

Run: `npx nx typecheck twenty-apps` (or this package's own typecheck command per its `package.json`).
Expected: no errors.

Run: `npx nx lint:diff-with-main twenty-apps` (or this package's own lint command).
Expected: no errors. Fix any `no-unused-vars`/`no-any` violations before committing (in particular, double-check the `ENGINE_FAMILY_KINDS` import noted as possibly-unused in Task 7 — remove it there if the linter flags it).

- [ ] **Step 7: Commit**

```bash
git add packages/twenty-apps/community/formula-field/src/logic-functions/on-record-updated-variations.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/on-record-created-variations.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/variation-sweep.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/variation-sync.ts \
        packages/twenty-apps/community/formula-field/src/logic-functions/lib/__tests__/variation-dispatch.spec.ts
git commit -m "feat(record-variations): wire wildcard triggers and hourly sweep to the sync engine"
```

---

## Out of scope for this plan (covered by Plan 2 / Plan 3 / the design doc's own out-of-scope list)

- The `primaryRecord` relation field is not actually created anywhere in this plan — Plan 2 builds the opt-in wizard that calls `createOneField` with a `relationCreationPayload` to provision it, sets `createdRelationField: true`, and places the widget via the `ensure-formula-tab` pattern. Until Plan 2 ships, this plan's logic-functions and repository are complete and fully tested but dormant (no `VariationConfig` rows exist yet, so `findVariationConfigByTargetObject` always returns null and every handler no-ops).
- The dual-role widget (`variation-widget.tsx`) is Plan 3.
- Variation chains, cross-object variations, per-field sync opt-in, merging a variation back into its primary, bulk-create, and native-grid divergence badges are explicitly out of scope per the design doc.

## Self-Review

**Spec coverage** (design doc section → task):
- Core concept / variation link → Task 1 (object) + Plan 2 (relation field itself).
- Data model (`VariationConfig`, `FormulaOverride` reuse) → Tasks 1, 3, 4.
- Syncable-field set → Task 2.
- Sync semantics: primary updated → Task 5. Variation created → Task 6. Variation updated by human → Task 7. Hourly sweep → Task 8.
- Freeze on primary delete → Task 6 (`fetchPrimaryRecordInclTrashed`), reused by Tasks 7 and 8.
- Single level only (self-reference + nested-primary guards) → Task 6 (creation-time guard in `syncNewVariationRecord`), Task 9 (`handleVariationRecordCreated`'s self-reference check), Task 8 (sweep's nested-primary skip).
- Testing section's "Unit (vitest, fake-client fixtures)" bullets → covered one-for-one by Tasks 2 (syncable-set), 5 (sync planner + no-op skip), 6 (initial-sync-on-create + freeze), 7 (divergence branches), 8 (sweep pagination + fault isolation), 9 (single-level/self-reference routing).
- "Live verify (dev instance, seeded workspace)" bullet is explicitly deferred to Plan 2/3 (needs the wizard + widget to exist first — there is no UI path to enable variations or create one until then).

**Placeholder scan:** every step has complete, non-elided code; every test asserts concrete values; no "add error handling" or "similar to Task N" placeholders.

**Type consistency:** `SyncOutcome`, `SyncableFieldInfo`, `VariationConfigRecord`, `PrimaryFetchResult` are each defined exactly once (Tasks 5, 2, 4, 6 respectively) and referenced by the same name/shape in every later task. `computeSyncableFields`, `syncOneVariation`, `fetchRecordById`, `fetchPrimaryRecordInclTrashed`, `loadActiveOverrideFieldsForRecord` are each called with the same parameter order and types everywhere they're used across Tasks 5–9.
