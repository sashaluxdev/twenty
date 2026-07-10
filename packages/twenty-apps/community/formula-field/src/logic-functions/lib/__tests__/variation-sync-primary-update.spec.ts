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
          { id: 'field-owner', name: 'accountOwner', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'accountOwnerId' },
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

  it('mirrors a MANY_TO_ONE relation change by copying the join column onto variations', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: null, employees: 50, accountOwnerId: 'user-2', primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: null, employees: 50, accountOwnerId: 'user-1', primaryRecordId: 'p1' },
    ]);

    // Server-shape fidelity (cloud 2.19): a relation change reports BOTH the
    // relation name and the join column in updatedFields.
    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['accountOwner', 'accountOwnerId'],
      relationFieldName: 'primaryRecord',
    });

    expect(outcomes.find((outcome) => outcome.variationRecordId === 'v1')?.changed).toBe(true);
    expect(client.get('company', 'v1')!.accountOwnerId).toBe('user-2');
  });

  it('mirrors a relation cleared to null on the primary', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: null, employees: 50, accountOwnerId: null, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: null, employees: 50, accountOwnerId: 'user-1', primaryRecordId: 'p1' },
    ]);

    await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['accountOwner', 'accountOwnerId'],
      relationFieldName: 'primaryRecord',
    });

    expect(client.get('company', 'v1')!.accountOwnerId).toBeNull();
  });

  it('respects an active override pinning a variation relation (does not overwrite the pinned join column)', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: null, employees: 99, accountOwnerId: 'user-2', primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: null, employees: 50, accountOwnerId: 'user-1', primaryRecordId: 'p1' },
    ]);
    // Same override shape as 'skips a field with an active override ...' above,
    // but the pinned field is the JOIN COLUMN and the pinned id JSON-encodes
    // into the text slot (overrideSlotFor routes every non-NUMBER kind there).
    client.seed('formulaOverride', [
      {
        id: 'ov1',
        name: 'company.accountOwnerId#v1',
        targetObject: 'company',
        targetField: 'accountOwnerId',
        recordId: 'v1',
        overrideValue: null,
        overrideValueText: JSON.stringify('user-1'),
        active: true,
      },
    ]);

    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['accountOwner', 'accountOwnerId', 'employees'],
      relationFieldName: 'primaryRecord',
    });

    // The pinned relation is skipped; the other changed field still syncs.
    expect(outcomes[0].changedFields).toEqual(['employees']);
    expect(client.get('company', 'v1')!.accountOwnerId).toBe('user-1');
    expect(client.get('company', 'v1')!.employees).toBe(99);
  });

  it('does not treat an active relation pin as an orphan (null FK pin must not collide with a null-valued field)', async () => {
    // Regression: relation overrides store the JOIN COLUMN name
    // (accountOwnerId), but orphan classification built its live-name set from
    // metadata NAMES (accountOwner) — so every active relation pin was
    // mistaken for a rename/delete orphan. A null-cleared relation pin
    // (overrideValueText 'null') then collides with ANY other changed field
    // whose current value is null: the value-as-witness reconcile deactivates
    // the real relation pin and spuriously pins the unrelated field.
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: null, employees: 99, accountOwnerId: 'user-2', primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: null, employees: null, accountOwnerId: null, primaryRecordId: 'p1' },
    ]);
    client.seed('formulaOverride', [
      {
        id: 'ov-owner',
        name: 'company.accountOwnerId#v1',
        targetObject: 'company',
        targetField: 'accountOwnerId',
        recordId: 'v1',
        overrideValue: null,
        overrideValueText: JSON.stringify(null),
        active: true,
      },
    ]);

    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['accountOwner', 'accountOwnerId', 'employees'],
      relationFieldName: 'primaryRecord',
    });

    // The relation pin is respected: the FK stays null and the pin stays active.
    expect(client.get('company', 'v1')!.accountOwnerId).toBeNull();
    expect(client.get('formulaOverride', 'ov-owner')!.active).toBe(true);
    // The unrelated changed field syncs to the primary's value...
    expect(outcomes[0].changedFields).toEqual(['employees']);
    expect(client.get('company', 'v1')!.employees).toBe(99);
    // ...with NO spurious override created for it (the null-pin collision).
    expect(client.get('formulaOverride', 'formulaOverride-1')).toBeUndefined();
  });
});
