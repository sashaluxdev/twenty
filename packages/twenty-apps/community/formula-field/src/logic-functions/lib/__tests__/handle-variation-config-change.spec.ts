import { beforeEach, describe, expect, it } from 'vitest';

import { handleVariationConfigChange } from 'src/logic-functions/lib/handle-variation-config-change';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('handleVariationConfigChange', () => {
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

  it('skips a pure bookkeeping-only update with zero mutations', async () => {
    const after: VariationConfigRecord = {
      id: 'vc1',
      name: 'company',
      targetObject: 'company',
      relationFieldName: 'primaryRecord',
      enabled: true,
      lastError: '',
    };
    client.seed('variationConfig', [after]);

    const result = await handleVariationConfigChange({
      client,
      after,
      updatedFields: ['lastSyncedAt'],
    });

    expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
    expect(client.mutations).toBe(0);
  });

  it('skips a disabled config whose update only touched enabled/bookkeeping fields', async () => {
    const after: VariationConfigRecord = {
      id: 'vc1',
      name: 'company',
      targetObject: 'company',
      relationFieldName: 'primaryRecord',
      enabled: false,
      lastError: 'some error',
    };
    client.seed('variationConfig', [after]);

    const result = await handleVariationConfigChange({
      client,
      after,
      updatedFields: ['enabled', 'lastError'],
    });

    expect(result).toEqual({ handled: false, reason: 'disabled-bookkeeping' });
    expect(client.mutations).toBe(0);
  });

  it('leaves a disabled config alone when a non-bookkeeping field is edited', async () => {
    const after: VariationConfigRecord = {
      id: 'vc1',
      name: 'company',
      targetObject: 'company',
      relationFieldName: 'primaryRecord',
      enabled: false,
      lastError: '',
    };
    client.seed('variationConfig', [after]);

    const result = await handleVariationConfigChange({
      client,
      after,
      updatedFields: ['targetObject'],
    });

    expect(result).toEqual({ handled: false, reason: 'disabled' });
    expect(client.mutations).toBe(0);
  });

  it('disables an invalid config and records its error, then is write-avoidant on the resulting re-trigger', async () => {
    const after: VariationConfigRecord = {
      id: 'vc1',
      name: 'company',
      targetObject: 'company',
      relationFieldName: '',
      enabled: true,
      lastError: '',
    };
    client.seed('variationConfig', [after]);

    const result = await handleVariationConfigChange({
      client,
      after,
      updatedFields: undefined,
    });

    expect(result).toEqual({
      handled: true,
      valid: false,
      error: 'relationFieldName is required',
    });
    expect(client.get('variationConfig', 'vc1')!.enabled).toBe(false);
    expect(client.get('variationConfig', 'vc1')!.lastError).toBe(
      'relationFieldName is required',
    );

    const mutationsAfterFirstRun = client.mutations;

    // The disable write itself fires the update trigger again — assert the
    // recursion guard swallows it with zero further mutations.
    const reTriggeredAfter = client.get('variationConfig', 'vc1') as unknown as VariationConfigRecord;
    const secondResult = await handleVariationConfigChange({
      client,
      after: reTriggeredAfter,
      updatedFields: ['lastError', 'enabled'],
    });

    expect(secondResult).toEqual({ handled: false, reason: 'disabled-bookkeeping' });
    expect(client.mutations).toBe(mutationsAfterFirstRun);
  });

  it('clears a stale lastError and converges variations via a real sweep on a valid config', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 42, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: null, primaryRecordId: 'p1' },
    ]);
    const after: VariationConfigRecord = {
      id: 'vc1',
      name: 'company',
      targetObject: 'company',
      relationFieldName: 'primaryRecord',
      enabled: true,
      lastError: 'stale error',
    };
    client.seed('variationConfig', [after]);

    const result = await handleVariationConfigChange({
      client,
      after,
      updatedFields: ['enabled'],
    });

    expect(result).toMatchObject({ handled: true, valid: true, written: 1, evaluated: 1 });
    expect(client.get('variationConfig', 'vc1')!.lastError).toBe('');
    expect(client.get('company', 'v1')!.employees).toBe(42);
  });
});
