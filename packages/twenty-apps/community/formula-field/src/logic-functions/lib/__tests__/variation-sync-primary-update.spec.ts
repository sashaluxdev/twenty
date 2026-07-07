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
