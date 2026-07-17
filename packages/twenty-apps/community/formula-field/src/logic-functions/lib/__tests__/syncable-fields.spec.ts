import { afterEach, describe, expect, it } from 'vitest';

import { __clearEnabledFormulasCacheForTests } from 'src/logic-functions/lib/formula-repository';
import { computeSyncableFields } from 'src/logic-functions/lib/syncable-fields';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

afterEach(() => __clearEnabledFormulasCacheForTests());

describe('computeSyncableFields', () => {
  it('includes mirrorable and engine-family kinds, excludes the label field, the relation field, and non-writable kinds and settings-less relations', async () => {
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

  it('excludes a unique field of an otherwise-syncable kind, but keeps a non-unique field of the same kind', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-domain', name: 'domainName', type: 'LINKS', isActive: true, isSystem: false, isUnique: true },
          { id: 'field-website', name: 'website', type: 'LINKS', isActive: true, isSystem: false, isUnique: false },
        ],
      },
    ]);

    const result = await computeSyncableFields(client, 'company', 'primaryRecord');

    expect(result.map((field) => field.name).sort()).toEqual(['website']);
  });

  it('includes a MANY_TO_ONE relation as its join column, keyed kind RELATION', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-owner', name: 'accountOwner', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'accountOwnerId' },
          { id: 'field-people', name: 'people', type: 'RELATION', isActive: true, isSystem: false, relationType: 'ONE_TO_MANY', joinColumnName: null },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'primaryRecordId' },
        ],
      },
    ]);

    const result = await computeSyncableFields(client, 'company', 'primaryRecord');

    expect(result).toContainEqual({ name: 'accountOwnerId', kind: 'RELATION' });
    // ONE_TO_MANY inverse (no local FK) stays excluded.
    expect(result.map((field) => field.name)).not.toContain('people');
    expect(result.map((field) => field.name)).not.toContain('peopleId');
    // The config's own pointer relation is never syncable.
    expect(result.map((field) => field.name)).not.toContain('primaryRecordId');
    expect(result.map((field) => field.name)).not.toContain('primaryRecord');
  });

  it('excludes a RELATION field with MANY_TO_ONE type but no join column, and MORPH_RELATION entirely', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        // Label id points at no real field here (unlike the other cases) so the
        // plain `name` field is genuinely syncable and can prove it survives
        // while the broken relation and the MORPH_RELATION are excluded.
        labelIdentifierFieldMetadataId: 'field-label',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-broken', name: 'brokenRel', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: null },
          { id: 'field-morph', name: 'owner', type: 'MORPH_RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'ownerId' },
        ],
      },
    ]);

    const result = await computeSyncableFields(client, 'company', 'primaryRecord');

    expect(result.map((field) => field.name).sort()).toEqual(['name']);
  });

  it('returns an empty array for an unknown object', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([]);

    const result = await computeSyncableFields(client, 'unknown', 'primaryRecord');

    expect(result).toEqual([]);
  });
});
