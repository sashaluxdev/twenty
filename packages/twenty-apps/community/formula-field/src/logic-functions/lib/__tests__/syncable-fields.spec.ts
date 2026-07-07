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
