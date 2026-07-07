import { describe, expect, it } from 'vitest';

import {
  checkRelationFieldName,
  countSyncableFields,
  eligibleTargetObjects,
  INVERSE_FIELD_LABEL,
  INVERSE_FIELD_NAME,
  type VariationTargetObject,
} from 'src/front-components/lib/variation-setup-logic';

const buildTargetObject = (
  overrides: Partial<VariationTargetObject> = {},
): VariationTargetObject => ({
  id: 'obj-company',
  nameSingular: 'company',
  labelSingular: 'Company',
  labelIdentifierFieldMetadataId: 'field-name',
  fields: [
    { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
  ],
  ...overrides,
});

describe('INVERSE_FIELD_LABEL / INVERSE_FIELD_NAME', () => {
  it('stays consistent with the slugify -> camelCase rule for a simple ASCII word', () => {
    expect(INVERSE_FIELD_LABEL).toBe('Variations');
    expect(INVERSE_FIELD_NAME).toBe('variations');
    expect(INVERSE_FIELD_NAME).toBe(INVERSE_FIELD_LABEL.toLowerCase());
  });
});

describe('checkRelationFieldName', () => {
  it('accepts a fresh, valid, non-colliding name', () => {
    const targetObject = buildTargetObject();

    const result = checkRelationFieldName('primaryRecord', targetObject);

    expect(result).toEqual({ ok: true, resume: false });
  });

  it('rejects an empty name', () => {
    const targetObject = buildTargetObject();

    const result = checkRelationFieldName('', targetObject);

    expect(result).toEqual({ ok: false, error: 'Field name is required' });
  });

  it('rejects a name that fails the GraphQL identifier grammar', () => {
    const targetObject = buildTargetObject();

    const result = checkRelationFieldName('has space', targetObject);

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toMatch(/identifier/i);
  });

  it('rejects a name starting with a digit', () => {
    const targetObject = buildTargetObject();

    const result = checkRelationFieldName('1stField', targetObject);

    expect(result.ok).toBe(false);
  });

  it('rejects the inverse field name itself as a self-collision', () => {
    const targetObject = buildTargetObject();

    const result = checkRelationFieldName('variations', targetObject);

    expect(result.ok).toBe(false);
  });

  it('rejects a name colliding with an existing active non-RELATION field', () => {
    const targetObject = buildTargetObject({
      fields: [
        { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'field-owner', name: 'owner', type: 'TEXT', isActive: true, isSystem: false },
      ],
    });

    const result = checkRelationFieldName('owner', targetObject);

    expect(result).toEqual({
      ok: false,
      error: 'Field "owner" already exists on Company',
    });
  });

  it('does not treat an inactive field with the same name as a collision', () => {
    const targetObject = buildTargetObject({
      fields: [
        { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'field-owner', name: 'owner', type: 'TEXT', isActive: false, isSystem: false },
      ],
    });

    const result = checkRelationFieldName('owner', targetObject);

    expect(result).toEqual({ ok: true, resume: false });
  });

  it('resumes when the name collides with an existing active RELATION field', () => {
    const targetObject = buildTargetObject({
      fields: [
        { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
      ],
    });

    const result = checkRelationFieldName('primaryRecord', targetObject);

    expect(result).toEqual({ ok: true, resume: true, existingFieldId: 'field-primary' });
  });

  it('rejects when the requested name is fresh but the inverse field name already exists as a non-RELATION field', () => {
    const targetObject = buildTargetObject({
      fields: [
        { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'field-variations', name: 'variations', type: 'TEXT', isActive: true, isSystem: false },
      ],
    });

    const result = checkRelationFieldName('primaryRecord', targetObject);

    expect(result.ok).toBe(false);
  });

  it('resumes when both the requested name and the inverse field name already exist as active RELATION fields', () => {
    const targetObject = buildTargetObject({
      fields: [
        { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        { id: 'field-variations', name: 'variations', type: 'RELATION', isActive: true, isSystem: false },
      ],
    });

    const result = checkRelationFieldName('primaryRecord', targetObject);

    expect(result).toEqual({ ok: true, resume: true, existingFieldId: 'field-primary' });
  });
});

describe('countSyncableFields', () => {
  it('counts only active, non-system, syncable-kind fields excluding the label, relation, and inverse fields', () => {
    const targetObject = buildTargetObject({
      labelIdentifierFieldMetadataId: 'field-name',
      fields: [
        { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false }, // label field, excluded by id
        { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false }, // syncable (ENGINE_FAMILY)
        { id: 'field-domain', name: 'domainName', type: 'TEXT', isActive: true, isSystem: false }, // syncable (MIRRORABLE)
        { id: 'field-owner', name: 'owner', type: 'RELATION', isActive: true, isSystem: false }, // excluded, kind not syncable
        { id: 'field-created-by', name: 'createdBy', type: 'ACTOR', isActive: true, isSystem: false }, // excluded, kind not syncable
        { id: 'field-position', name: 'position', type: 'TEXT', isActive: true, isSystem: true }, // excluded, system
        { id: 'field-legacy', name: 'legacyField', type: 'TEXT', isActive: false, isSystem: false }, // excluded, inactive
        { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false }, // excluded, relation field itself
        { id: 'field-variations', name: 'variations', type: 'TEXT', isActive: true, isSystem: false }, // excluded, inverse field name
      ],
    });

    const result = countSyncableFields(targetObject, 'primaryRecord');

    expect(result).toBe(2);
  });

  it('returns zero when there are no syncable fields', () => {
    const targetObject = buildTargetObject({
      fields: [
        { id: 'field-owner', name: 'owner', type: 'RELATION', isActive: true, isSystem: false },
        { id: 'field-created-by', name: 'createdBy', type: 'ACTOR', isActive: true, isSystem: false },
      ],
    });

    const result = countSyncableFields(targetObject, 'primaryRecord');

    expect(result).toBe(0);
  });
});

describe('eligibleTargetObjects', () => {
  it('excludes app-owned objects, already-configured objects, and objects with zero syncable fields, then sorts by label', () => {
    const formulaDefinitionObject = buildTargetObject({
      id: 'obj-formula-definition',
      nameSingular: 'formulaDefinition',
      labelSingular: 'Formula Definition',
      fields: [
        { id: 'field-a', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
      ],
    });
    const variationConfigObject = buildTargetObject({
      id: 'obj-variation-config',
      nameSingular: 'variationConfig',
      labelSingular: 'Variation Config',
      fields: [
        { id: 'field-b', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
      ],
    });
    const alreadyConfiguredObject = buildTargetObject({
      id: 'obj-opportunity',
      nameSingular: 'opportunity',
      labelSingular: 'Opportunity',
      fields: [
        { id: 'field-c', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
      ],
    });
    const zeroSyncableObject = buildTargetObject({
      id: 'obj-person',
      nameSingular: 'person',
      labelSingular: 'Person',
      fields: [
        { id: 'field-d', name: 'owner', type: 'RELATION', isActive: true, isSystem: false },
      ],
    });
    const zebraObject = buildTargetObject({
      id: 'obj-zebra',
      nameSingular: 'zebra',
      labelSingular: 'Zebra',
      fields: [
        { id: 'field-e', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
      ],
    });
    const appleObject = buildTargetObject({
      id: 'obj-apple',
      nameSingular: 'apple',
      labelSingular: 'Apple',
      fields: [
        { id: 'field-f', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
      ],
    });

    const result = eligibleTargetObjects(
      [
        formulaDefinitionObject,
        variationConfigObject,
        alreadyConfiguredObject,
        zeroSyncableObject,
        zebraObject,
        appleObject,
      ],
      ['opportunity'],
    );

    expect(result.map((object) => object.nameSingular)).toEqual(['apple', 'zebra']);
  });
});
