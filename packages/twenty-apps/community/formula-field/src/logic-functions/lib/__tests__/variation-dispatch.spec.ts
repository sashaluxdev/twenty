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
