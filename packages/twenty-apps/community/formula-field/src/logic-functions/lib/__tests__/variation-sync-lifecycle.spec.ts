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
