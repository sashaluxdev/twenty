import { beforeEach, describe, expect, it } from 'vitest';

import { validateVariationConfig } from 'src/logic-functions/lib/variation-config-validation';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

const companyConfig = (
  overrides: Partial<VariationConfigRecord> = {},
): VariationConfigRecord => ({
  id: 'vc1',
  name: 'company',
  targetObject: 'company',
  relationFieldName: 'primaryRecord',
  ...overrides,
});

describe('validateVariationConfig', () => {
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

  it('passes a valid config', async () => {
    const result = await validateVariationConfig(client, companyConfig(), []);

    expect(result).toEqual({ valid: true });
  });

  it('rejects a missing targetObject', async () => {
    const result = await validateVariationConfig(
      client,
      companyConfig({ targetObject: '', name: '' }),
      [],
    );

    expect(result).toEqual({ valid: false, error: 'targetObject is required' });
  });

  it('rejects an unsafe targetObject', async () => {
    const result = await validateVariationConfig(
      client,
      companyConfig({ targetObject: 'bad name!', name: 'bad name!' }),
      [],
    );

    expect(result).toEqual({
      valid: false,
      error: 'Invalid target object name "bad name!"',
    });
  });

  it('rejects a name that does not equal targetObject', async () => {
    const result = await validateVariationConfig(
      client,
      companyConfig({ name: 'not-company' }),
      [],
    );

    expect(result).toEqual({
      valid: false,
      error:
        'name must equal targetObject ("company") — it is the one-config-per-object key',
    });
  });

  it('rejects a missing relationFieldName', async () => {
    const result = await validateVariationConfig(
      client,
      companyConfig({ relationFieldName: '' }),
      [],
    );

    expect(result).toEqual({
      valid: false,
      error: 'relationFieldName is required',
    });
  });

  it('rejects an unsafe relationFieldName', async () => {
    const result = await validateVariationConfig(
      client,
      companyConfig({ relationFieldName: 'bad field!' }),
      [],
    );

    expect(result).toEqual({
      valid: false,
      error: 'Invalid relation field name "bad field!"',
    });
  });

  it('rejects a duplicate config for the same object owned by a different id', async () => {
    const result = await validateVariationConfig(client, companyConfig(), [
      companyConfig({ id: 'vc2' }),
    ]);

    expect(result).toEqual({
      valid: false,
      error: 'A variation config for "company" already exists',
    });
  });

  it('does not treat the candidate itself (same id) in otherConfigs as a duplicate', async () => {
    const result = await validateVariationConfig(client, companyConfig(), [
      companyConfig(),
    ]);

    expect(result).toEqual({ valid: true });
  });

  it('rejects a targetObject that does not exist in metadata', async () => {
    const result = await validateVariationConfig(
      client,
      companyConfig({ targetObject: 'ghost', name: 'ghost' }),
      [],
    );

    expect(result).toEqual({
      valid: false,
      error: 'Object "ghost" does not exist',
    });
  });

  it('rejects an object whose only fields are excluded kinds ("no syncable fields")', async () => {
    client.setObjectsWithFields([
      {
        id: 'obj-widget',
        nameSingular: 'widget',
        labelIdentifierFieldMetadataId: 'field-widget-name',
        fields: [
          { id: 'field-widget-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-widget-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
          { id: 'field-widget-notes', name: 'notes', type: 'RICH_TEXT', isActive: true, isSystem: false },
        ],
      },
    ]);

    const result = await validateVariationConfig(
      client,
      companyConfig({ targetObject: 'widget', name: 'widget' }),
      [],
    );

    expect(result).toEqual({
      valid: false,
      error: 'Object "widget" has no syncable fields',
    });
  });
});
