import { beforeEach, describe, expect, it } from 'vitest';

import {
  loadDivergedFields,
  resyncDivergedField,
} from 'src/front-components/lib/variation-widget-data';
import {
  syncOneVariation,
  sweepVariationConfig,
} from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// R2: overrides are keyed by field-NAME string, so a field rename (same field
// id, new API name) orphans the override row — the syncable set carries the
// new name, the skip set the old one, and sync used to overwrite the user's
// intentionally-diverged value while the pin silently vanished from the
// widget. The reconcile: a changed field whose CURRENT stored value equals an
// orphaned override's pinned value (renames keep column data) is never
// overwritten, and an unambiguous match transfers the pin to the new name.

const CONFIG = {
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
};

const PINNED_TAGLINE = 'MY CUSTOM TAGLINE';

// Metadata AFTER the rename: the object has `tagline` (renamed from `slogan`).
const objectsAfterRename = (extraFields: Array<Record<string, unknown>> = []) => [
  {
    id: 'obj-company',
    nameSingular: 'company',
    labelIdentifierFieldMetadataId: 'field-name',
    fields: [
      { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
      { id: 'field-tagline', name: 'tagline', type: 'TEXT', isActive: true, isSystem: false },
      { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
      { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
      ...(extraFields as never[]),
    ],
  },
];

// The orphan: an ACTIVE override still keyed to the pre-rename name.
const orphanedSloganOverride = (overrides: Record<string, unknown> = {}) => ({
  id: 'ov-slogan',
  name: 'company.slogan#v1',
  targetObject: 'company',
  targetField: 'slogan',
  recordId: 'v1',
  overrideValue: null,
  overrideValueText: JSON.stringify(PINNED_TAGLINE),
  active: true,
  ...overrides,
});

const SYNC_FIELDS = [
  { name: 'tagline', kind: 'TEXT' },
  { name: 'employees', kind: 'NUMBER' },
];

describe('rename-proof divergence pins (R2)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setObjectsWithFields(objectsAfterRename());
    client.seed('company', [
      { id: 'p1', name: 'Acme', tagline: 'New corporate tagline', employees: 99, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', tagline: PINNED_TAGLINE, employees: 50, primaryRecordId: 'p1' },
    ]);
  });

  it('does not overwrite the diverged value and transfers the pin to the new name', async () => {
    client.seed('formulaOverride', [orphanedSloganOverride()]);

    const outcome = await syncOneVariation(
      client,
      'company',
      { id: 'p1', tagline: 'New corporate tagline', employees: 99 },
      'v1',
      SYNC_FIELDS,
      'primaryRecord',
    );

    // The diverged value survives; the other field still syncs.
    expect(client.get('company', 'v1')!.tagline).toBe(PINNED_TAGLINE);
    expect(client.get('company', 'v1')!.employees).toBe(99);
    expect(outcome.changedFields).toEqual(['employees']);
    expect(outcome.error).toBeNull();

    // The pin lives on under the NEW name...
    const transferred = client.get('formulaOverride', 'formulaOverride-1');
    expect(transferred).toMatchObject({
      name: 'company.tagline#v1',
      targetField: 'tagline',
      recordId: 'v1',
      overrideValueText: JSON.stringify(PINNED_TAGLINE),
      active: true,
    });
    // ...and the orphan row is deactivated, never deleted (shared key space).
    expect(client.get('formulaOverride', 'ov-slogan')).toMatchObject({
      targetField: 'slogan',
      active: false,
    });
  });

  it('keeps the pin visible in the widget diverged list under the new name', async () => {
    client.seed('formulaOverride', [orphanedSloganOverride()]);

    await syncOneVariation(
      client,
      'company',
      { id: 'p1', tagline: 'New corporate tagline', employees: 99 },
      'v1',
      SYNC_FIELDS,
      'primaryRecord',
    );

    const diverged = await loadDivergedFields(client, { ...CONFIG }, 'v1');
    expect(diverged).toEqual([{ name: 'tagline', kind: 'TEXT' }]);
  });

  it('holds through a full sweep: the next sync after a rename cannot clobber the pin', async () => {
    client.seed('formulaOverride', [orphanedSloganOverride()]);
    client.seed('variationConfig', [{ ...CONFIG }]);

    await sweepVariationConfig(client, { ...CONFIG });

    expect(client.get('company', 'v1')!.tagline).toBe(PINNED_TAGLINE);
    expect(client.get('company', 'v1')!.employees).toBe(99);
    expect(client.get('formulaOverride', 'ov-slogan')!.active).toBe(false);
  });

  it('transfers a numeric-slot pin (renamed NUMBER field) too', async () => {
    // employees was diverged and pinned, then the field got renamed to
    // headcount; the orphan pins via the numeric slot.
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-headcount', name: 'headcount', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
    client.seed('company', [
      { id: 'p2', name: 'Beta', headcount: 10, primaryRecordId: null },
      { id: 'v2', name: 'Beta (variation)', headcount: 75, primaryRecordId: 'p2' },
    ]);
    client.seed('formulaOverride', [
      {
        id: 'ov-employees',
        name: 'company.employees#v2',
        targetObject: 'company',
        targetField: 'employees',
        recordId: 'v2',
        overrideValue: 75,
        overrideValueText: null,
        active: true,
      },
    ]);

    await syncOneVariation(
      client,
      'company',
      { id: 'p2', headcount: 10 },
      'v2',
      [{ name: 'headcount', kind: 'NUMBER' }],
      'primaryRecord',
    );

    expect(client.get('company', 'v2')!.headcount).toBe(75);
    expect(client.get('formulaOverride', 'ov-employees')!.active).toBe(false);
    expect(client.get('formulaOverride', 'formulaOverride-1')).toMatchObject({
      name: 'company.headcount#v2',
      overrideValue: 75,
      active: true,
    });
  });

  it('leaves a non-matching orphan (deleted field) alone and syncs normally', async () => {
    client.seed('formulaOverride', [
      orphanedSloganOverride({ overrideValueText: JSON.stringify('something unrelated') }),
    ]);

    const outcome = await syncOneVariation(
      client,
      'company',
      { id: 'p1', tagline: 'New corporate tagline', employees: 99 },
      'v1',
      SYNC_FIELDS,
      'primaryRecord',
    );

    // No value matches -> no rename inference: normal sync semantics apply.
    expect(outcome.changedFields).toEqual(['tagline', 'employees']);
    expect(client.get('company', 'v1')!.tagline).toBe('New corporate tagline');
    // The orphan stays active and untouched (report #7 posture: inert row).
    expect(client.get('formulaOverride', 'ov-slogan')!.active).toBe(true);
    expect(client.get('formulaOverride', 'formulaOverride-1')).toBeUndefined();
  });

  it('is write-avoidant when the record has no overrides at all', async () => {
    await syncOneVariation(
      client,
      'company',
      { id: 'p1', tagline: 'New corporate tagline', employees: 50 },
      'v1',
      SYNC_FIELDS,
      'primaryRecord',
    );

    // Exactly one record write (tagline), zero override mutations.
    expect(client.writes).toEqual([
      `company:v1:tagline=${JSON.stringify('New corporate tagline')}`,
    ]);
  });

  it('is idempotent: the second sync after a transfer performs no further writes', async () => {
    client.seed('formulaOverride', [orphanedSloganOverride()]);
    const primary = { id: 'p1', tagline: 'New corporate tagline', employees: 99 };

    await syncOneVariation(client, 'company', primary, 'v1', SYNC_FIELDS, 'primaryRecord');
    const writesAfterFirst = client.writes.length;
    const mutationsAfterFirst = client.mutations;

    const second = await syncOneVariation(
      client,
      'company',
      primary,
      'v1',
      SYNC_FIELDS,
      'primaryRecord',
    );

    expect(second).toEqual({
      variationRecordId: 'v1',
      changed: false,
      changedFields: [],
      error: null,
    });
    expect(client.writes.length).toBe(writesAfterFirst);
    expect(client.mutations).toBe(mutationsAfterFirst);
  });

  it('holds without transferring when the match is ambiguous (two fields carry the pinned value)', async () => {
    client.setObjectsWithFields(
      objectsAfterRename([
        { id: 'field-motto', name: 'motto', type: 'TEXT', isActive: true, isSystem: false },
      ]),
    );
    client.seed('company', [
      { id: 'p1', name: 'Acme', tagline: 'New corporate tagline', motto: 'New motto', employees: 99, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', tagline: PINNED_TAGLINE, motto: PINNED_TAGLINE, employees: 50, primaryRecordId: 'p1' },
    ]);
    client.seed('formulaOverride', [orphanedSloganOverride()]);

    const outcome = await syncOneVariation(
      client,
      'company',
      { id: 'p1', tagline: 'New corporate tagline', motto: 'New motto', employees: 99 },
      'v1',
      [...SYNC_FIELDS, { name: 'motto', kind: 'TEXT' }],
      'primaryRecord',
    );

    // Neither candidate is overwritten (the pinned value is somewhere among
    // them and guessing wrong would destroy it) and the orphan is not
    // transferred — a safe hold, resolvable by a human.
    expect(client.get('company', 'v1')!.tagline).toBe(PINNED_TAGLINE);
    expect(client.get('company', 'v1')!.motto).toBe(PINNED_TAGLINE);
    expect(client.get('company', 'v1')!.employees).toBe(99);
    expect(outcome.changedFields).toEqual(['employees']);
    expect(client.get('formulaOverride', 'ov-slogan')!.active).toBe(true);
    expect(client.get('formulaOverride', 'formulaOverride-1')).toBeUndefined();
  });

  // M1 regression (R2/R1 interaction): the pin transfer COMMITS before the
  // record write; if that write then throws into the R1 retry ladder, the
  // orphan list is already consumed — the retry must still hold the
  // transferred field, or it would re-diff it and write the primary value
  // over the value the reconcile just protected.
  it('holds a transferred pin across an R1 retry after the batch write fails once', async () => {
    client.seed('formulaOverride', [orphanedSloganOverride()]);

    const realMutation = client.mutation.bind(client);
    let failedOnce = false;
    client.mutation = (async (selection: Record<string, unknown>) => {
      const key = Object.keys(selection)[0];
      // Fail the RECORD update exactly once (a non-retryable error, so it
      // throws straight past withRetry into the ladder); override mutations
      // pass through untouched.
      if (key === 'updateCompany' && !failedOnce) {
        failedOnce = true;
        throw new Error('transient write failure');
      }
      return realMutation(selection);
    }) as typeof client.mutation;

    const outcome = await syncOneVariation(
      client,
      'company',
      { id: 'p1', tagline: 'New corporate tagline', employees: 99 },
      'v1',
      SYNC_FIELDS,
      'primaryRecord',
    );

    // The protected value survives the retry; the other field still syncs.
    expect(client.get('company', 'v1')!.tagline).toBe(PINNED_TAGLINE);
    expect(client.get('company', 'v1')!.employees).toBe(99);
    expect(outcome.changedFields).toEqual(['employees']);
    expect(outcome.error).toBeNull();
    // The transferred pin stays consistent with the stored value.
    expect(client.get('formulaOverride', 'formulaOverride-1')).toMatchObject({
      name: 'company.tagline#v1',
      overrideValueText: JSON.stringify(PINNED_TAGLINE),
      active: true,
    });
    expect(client.get('formulaOverride', 'ov-slogan')!.active).toBe(false);
  });

  it('an explicit user re-sync beats the reconcile guard (no false transfer onto a resynced field)', async () => {
    // tagline has its OWN active pin (it shows in the diverged list) AND an
    // unrelated orphan happens to carry the identical value. The user's
    // explicit "re-sync this field" must copy the primary value, not re-pin.
    client.seed('formulaOverride', [
      orphanedSloganOverride(),
      {
        id: 'ov-tagline',
        name: 'company.tagline#v1',
        targetObject: 'company',
        targetField: 'tagline',
        recordId: 'v1',
        overrideValue: null,
        overrideValueText: JSON.stringify(PINNED_TAGLINE),
        active: true,
      },
    ]);

    const outcome = await resyncDivergedField(
      client,
      { ...CONFIG },
      'v1',
      { name: 'tagline', kind: 'TEXT' },
    );

    expect(outcome).toMatchObject({ changed: true, changedFields: ['tagline'] });
    expect(client.get('company', 'v1')!.tagline).toBe('New corporate tagline');
    expect(client.get('formulaOverride', 'ov-tagline')!.active).toBe(false);
    // The orphan is left for the regular sync paths to reconcile.
    expect(client.get('formulaOverride', 'ov-slogan')!.active).toBe(true);
  });
});
