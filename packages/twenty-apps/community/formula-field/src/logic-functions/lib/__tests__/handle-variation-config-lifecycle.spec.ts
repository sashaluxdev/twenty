import { describe, expect, it } from 'vitest';

import {
  handleVariationConfigDestroyed,
  handleVariationConfigRestored,
} from 'src/logic-functions/lib/handle-variation-config-lifecycle';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// VariationConfig destroy/restore lifecycle (record-variations Plan 2, Task 3):
// the variation-shaped analogue of handle-definition-lifecycle.spec.ts. Unlike
// the formula precedent (which module-mocks MetadataApiClient because its
// handlers take no injected client), both new handlers accept an INJECTED
// metadata client, so these tests hand in plain fakes — same posture as
// delete-definition-completely.spec.ts. No module mocking needed.

const makeMetadataClient = (
  objectName: string,
  fields: Record<string, { id: string; isActive: boolean }>,
) => {
  const mutationCalls: unknown[] = [];
  return {
    mutationCalls,
    query: async () => ({
      objects: {
        edges: [
          {
            node: {
              id: 'object-1',
              nameSingular: objectName,
              fields: {
                edges: Object.entries(fields).map(([name, field]) => ({
                  node: { id: field.id, name, isActive: field.isActive },
                })),
              },
            },
          },
        ],
      },
    }),
    mutation: async (selection: Record<string, unknown>) => {
      mutationCalls.push(selection);
      const key = Object.keys(selection)[0];
      if (key === 'updateOneField') {
        const input = (
          selection as {
            updateOneField: { __args: { input: { id: string } } };
          }
        ).updateOneField.__args.input;
        return { updateOneField: { id: input.id } };
      }
      throw new Error(`unexpected metadata mutation ${key}`);
    },
  };
};

const config = (
  overrides: Partial<VariationConfigRecord> = {},
): VariationConfigRecord => ({
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
  ...overrides,
});

describe('handleVariationConfigDestroyed', () => {
  it('deactivates the relation field via the injected client and leaves formulaOverride rows untouched', async () => {
    const client = new FakeClient();
    // Seeded to prove destroy never touches overrides — unlike the formula
    // precedent's handleDefinitionDestroyed, which deletes them.
    client.seed('formulaOverride', [
      {
        id: 'ov1',
        targetObject: 'company',
        targetField: 'employees',
        recordId: 'v1',
        overrideValue: 5,
        active: true,
      },
    ]);
    const metadataClient = makeMetadataClient('company', {
      primaryRecord: { id: 'field-primary', isActive: true },
    });

    const result = await handleVariationConfigDestroyed(
      client,
      config(),
      metadataClient,
    );

    expect(metadataClient.mutationCalls).toEqual([
      {
        updateOneField: {
          __args: {
            input: { id: 'field-primary', update: { isActive: false } },
          },
          id: true,
        },
      },
    ]);
    expect(result.deactivated).toEqual(['primaryRecord']);
    // Zero core-client mutations at all -> the override row was never reached.
    expect(client.mutations).toBe(0);
    expect(client.get('formulaOverride', 'ov1')).toBeDefined();
  });

  it('performs zero metadata mutations when the config never created the relation field', async () => {
    const client = new FakeClient();
    const metadataClient = makeMetadataClient('company', {
      primaryRecord: { id: 'field-primary', isActive: true },
    });

    const result = await handleVariationConfigDestroyed(
      client,
      config({ createdRelationField: false }),
      metadataClient,
    );

    expect(metadataClient.mutationCalls).toEqual([]);
    expect(result.deactivated).toEqual([]);
  });

  it('performs zero metadata mutations when the field is already inactive', async () => {
    const client = new FakeClient();
    const metadataClient = makeMetadataClient('company', {
      primaryRecord: { id: 'field-primary', isActive: false },
    });

    const result = await handleVariationConfigDestroyed(
      client,
      config(),
      metadataClient,
    );

    expect(metadataClient.mutationCalls).toEqual([]);
    expect(result.deactivated).toEqual([]);
  });
});

describe('handleVariationConfigRestored', () => {
  it('reactivates the deactivated relation field and sweeps to converge stale variations', async () => {
    const client = new FakeClient();
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
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
    ]);
    client.seed('variationConfig', [config()]);
    const metadataClient = makeMetadataClient('company', {
      primaryRecord: { id: 'field-primary', isActive: false },
    });

    const result = await handleVariationConfigRestored(
      client,
      config(),
      metadataClient,
    );

    expect(metadataClient.mutationCalls).toEqual([
      {
        updateOneField: {
          __args: {
            input: { id: 'field-primary', update: { isActive: true } },
          },
          id: true,
        },
      },
    ]);
    expect(result.reactivated).toEqual(['primaryRecord']);
    // Sweep counters are included in the return, and convergence actually ran.
    expect(result.written).toBe(1);
    expect(client.get('company', 'v1')!.employees).toBe(50);
  });

  it('heals the relation field but does not sweep when the config is disabled', async () => {
    const client = new FakeClient();
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 10, primaryRecordId: 'p1' },
    ]);
    const metadataClient = makeMetadataClient('company', {
      primaryRecord: { id: 'field-primary', isActive: false },
    });

    const result = await handleVariationConfigRestored(
      client,
      config({ enabled: false }),
      metadataClient,
    );

    expect(metadataClient.mutationCalls).toEqual([
      {
        updateOneField: {
          __args: {
            input: { id: 'field-primary', update: { isActive: true } },
          },
          id: true,
        },
      },
    ]);
    expect(result.reactivated).toEqual(['primaryRecord']);
    // No sweep outcome keys at all -> sweepVariationConfig never ran.
    expect(result.written).toBeUndefined();
    expect(result.evaluated).toBeUndefined();
    expect(client.get('company', 'v1')!.employees).toBe(10);
  });
});
