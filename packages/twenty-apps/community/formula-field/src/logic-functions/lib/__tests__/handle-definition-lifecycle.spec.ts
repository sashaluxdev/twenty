import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleDefinitionDeleted,
  handleDefinitionDestroyed,
  handleDefinitionRestored,
} from 'src/logic-functions/lib/handle-definition-lifecycle';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// Definition lifecycle after the naive-delete change (ADR 0009 refinement):
// trashing a definition performs NO field-metadata mutation — dependents are
// re-flagged OFFLINE purely by the trashed-target liveness rule inside
// refreshFormulaStatuses. Restore still heals legacy-deactivated fields, and
// destroy still deactivates the owned pair + cleans override rows.
//
// The lifecycle helpers instantiate `new MetadataApiClient()` directly (field
// lookups + isActive flips), so we mock the module and hand back a
// fixture-driven fake that dispatches on the top-level selection key. The core
// FormulaClient side uses the in-memory FakeClient.

type FieldFixture = {
  id: string;
  name: string;
  isActive: boolean;
  type?: string;
};

type ObjectFixture = {
  id: string;
  nameSingular: string;
  fields: FieldFixture[];
};

class FakeMetadataClient {
  // Every updateOneField mutation, recorded as { id, isActive } for assertions.
  public updateOneFieldCalls: Array<{ id: string; isActive: boolean }> = [];
  public objectQueries = 0;

  constructor(private readonly objects: ObjectFixture[]) {}

  async query(selection: Record<string, unknown>): Promise<unknown> {
    const key = Object.keys(selection)[0];
    if (key === 'objects') {
      this.objectQueries += 1;
      return {
        objects: {
          edges: this.objects.map((object) => ({
            cursor: object.id,
            node: {
              id: object.id,
              nameSingular: object.nameSingular,
              // loadAllObjectsWithFields reads the non-paginated fieldsList.
              fieldsList: object.fields.map((field) => ({
                id: field.id,
                name: field.name,
                type: field.type ?? 'NUMBER',
                isActive: field.isActive,
              })),
              // findFields reads the paginated fields connection.
              fields: {
                edges: object.fields.map((field) => ({
                  node: {
                    id: field.id,
                    name: field.name,
                    isActive: field.isActive,
                  },
                })),
              },
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    throw new Error(`FakeMetadataClient: unhandled query ${key}`);
  }

  async mutation(
    selection: Record<string, { __args: { input: { id: string; update: { isActive: boolean } } } }>,
  ): Promise<unknown> {
    const key = Object.keys(selection)[0];
    if (key === 'updateOneField') {
      const input = selection[key].__args.input;
      this.updateOneFieldCalls.push({
        id: input.id,
        isActive: input.update.isActive,
      });
      for (const object of this.objects) {
        for (const field of object.fields) {
          if (field.id === input.id) field.isActive = input.update.isActive;
        }
      }
      return { updateOneField: { id: input.id } };
    }
    throw new Error(`FakeMetadataClient: unhandled mutation ${key}`);
  }
}

const mocks = vi.hoisted(() => ({ client: null as FakeMetadataClient | null }));

vi.mock('twenty-client-sdk/metadata', () => ({
  MetadataApiClient: vi.fn(function () {
    return mocks.client;
  }),
}));

const useMetadata = (objects: ObjectFixture[]): FakeMetadataClient => {
  const fake = new FakeMetadataClient(objects);
  mocks.client = fake;
  return fake;
};

describe('handleDefinitionDeleted (naive trash — no field mutation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('performs no field metadata mutations but still refreshes statuses', async () => {
    const metadata = useMetadata([
      { id: 'obj-company', nameSingular: 'company', fields: [
        { id: 'field-fb', name: 'fb', isActive: true },
        // The deleted definition's own field pair, still active: the old naive
        // delete would have deactivated these — the new behavior must not.
        { id: 'field-fx', name: 'fx', isActive: true },
        { id: 'field-fxstatus', name: 'fxFxStatus', isActive: true },
      ] },
    ]);
    const client = new FakeClient();
    // A live dependent reading company.x — x is not a live field, so a status
    // refresh must flag it OFFLINE. That transition proves the refresh ran.
    client.seed('formulaDefinition', [
      {
        id: 'b',
        targetObject: 'company',
        targetField: 'fb',
        expression: 'x + 1',
        enabled: true,
      },
    ]);
    const before: FormulaDefinitionRecord = {
      id: 'd',
      targetObject: 'company',
      targetField: 'fx',
      createdField: true,
    };

    await handleDefinitionDeleted(client, before);

    expect(metadata.updateOneFieldCalls).toHaveLength(0);
    expect(client.get('formulaDefinition', 'b')!.status).toBe('OFFLINE');
  });
});

describe('handleDefinitionDestroyed (permanent — deactivate + clean overrides)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deactivates the owned field pair and deletes override rows', async () => {
    const metadata = useMetadata([
      { id: 'obj-company', nameSingular: 'company', fields: [
        { id: 'field-fx', name: 'fx', isActive: true },
        { id: 'field-fxstatus', name: 'fxFxStatus', isActive: true },
      ] },
    ]);
    const client = new FakeClient();
    client.seed('formulaOverride', [
      {
        id: 'ov1',
        targetObject: 'company',
        targetField: 'fx',
        recordId: 'r1',
        overrideValue: 5,
        active: true,
      },
    ]);
    const before: FormulaDefinitionRecord = {
      id: 'd',
      targetObject: 'company',
      targetField: 'fx',
      createdField: true,
    };

    const result = await handleDefinitionDestroyed(client, before);

    // Both the value field and its companion are deactivated (never deleted).
    expect(metadata.updateOneFieldCalls).toEqual([
      { id: 'field-fx', isActive: false },
      { id: 'field-fxstatus', isActive: false },
    ]);
    expect(result.overridesDeleted).toBe(1);
    expect(client.get('formulaOverride', 'ov1')).toBeUndefined();
  });
});

describe('handleDefinitionRestored (reactivates only inactive fields)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const restored: FormulaDefinitionRecord = {
    id: 'd',
    targetObject: 'company',
    targetField: 'fx',
    createdField: true,
    // Empty expression -> no recompute path to plumb.
    expression: '',
    enabled: true,
  };

  it('makes zero field mutations when the field pair is already active (the new normal)', async () => {
    const metadata = useMetadata([
      { id: 'obj-company', nameSingular: 'company', fields: [
        { id: 'field-fx', name: 'fx', isActive: true },
        { id: 'field-fxstatus', name: 'fxFxStatus', isActive: true },
      ] },
    ]);
    const client = new FakeClient();
    client.seed('formulaDefinition', [restored]);

    await handleDefinitionRestored(client, restored);

    expect(metadata.updateOneFieldCalls).toHaveLength(0);
  });

  it('reactivates exactly one field when a legacy-deactivated field remains', async () => {
    const metadata = useMetadata([
      { id: 'obj-company', nameSingular: 'company', fields: [
        { id: 'field-fx', name: 'fx', isActive: false },
        { id: 'field-fxstatus', name: 'fxFxStatus', isActive: true },
      ] },
    ]);
    const client = new FakeClient();
    client.seed('formulaDefinition', [restored]);

    await handleDefinitionRestored(client, restored);

    expect(metadata.updateOneFieldCalls).toEqual([
      { id: 'field-fx', isActive: true },
    ]);
  });
});
