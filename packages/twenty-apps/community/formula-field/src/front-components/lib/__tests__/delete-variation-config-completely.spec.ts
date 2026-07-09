import { beforeEach, describe, expect, it } from 'vitest';

import {
  deleteVariationConfigCompletely,
  planDeleteVariationConfig,
} from 'src/front-components/lib/delete-variation-config-completely';

// The deletion runs through INJECTED clients, so the tests hand in plain fakes —
// no module mocking, same posture as delete-definition-completely.spec.ts. The
// core client answers the fresh re-fetch of the config by id and records the
// destroy mutation (and would record any override deletion, proving none
// happens); the metadata client answers the objects lookup and records
// deactivate/delete field mutations.

type ConfigNode = {
  id: string;
  targetObject: string;
  relationFieldName: string;
  createdRelationField: boolean;
};

const makeCoreClient = ({ config }: { config: ConfigNode }) => {
  const destroyedIds: string[] = [];
  const otherMutationKeys: string[] = [];
  return {
    destroyedIds,
    otherMutationKeys,
    query: async () => ({
      // Fresh re-fetch of the config being deleted.
      variationConfigs: { edges: [{ node: config }] },
    }),
    mutation: async (selection: any) => {
      const key = Object.keys(selection)[0];
      if (key === 'destroyVariationConfig') {
        const id = selection.destroyVariationConfig.__args.id;
        destroyedIds.push(id);
        return { destroyVariationConfig: { id } };
      }
      // Any other mutation (e.g. an override deletion) is recorded so a test can
      // prove the flow never issues one.
      otherMutationKeys.push(key);
      return {};
    },
  };
};

const makeMetadataClient = (
  objectName: string,
  fields: Record<string, { id: string; isActive: boolean }>,
) => {
  const deactivatedIds: string[] = [];
  const deletedIds: string[] = [];
  return {
    deactivatedIds,
    deletedIds,
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
    mutation: async (selection: any) => {
      const key = Object.keys(selection)[0];
      if (key === 'updateOneField') {
        deactivatedIds.push(selection.updateOneField.__args.input.id);
        return { updateOneField: { id: selection.updateOneField.__args.input.id } };
      }
      if (key === 'deleteOneField') {
        deletedIds.push(selection.deleteOneField.__args.input.id);
        return { deleteOneField: { id: selection.deleteOneField.__args.input.id } };
      }
      throw new Error(`unexpected metadata mutation ${key}`);
    },
  };
};

const config: ConfigNode = {
  id: 'vc-1',
  targetObject: 'company',
  relationFieldName: 'primaryRecord',
  createdRelationField: true,
};

describe('deleteVariationConfigCompletely', () => {
  beforeEach(() => {});

  it('should deactivate + delete the relation field and destroy the config when the app created the field', async () => {
    const coreClient = makeCoreClient({ config });
    const metadataClient = makeMetadataClient('company', {
      primaryRecord: { id: 'field-primary', isActive: true },
    });

    const result = await deleteVariationConfigCompletely({
      coreClient,
      metadataClient,
      configId: 'vc-1',
    });

    // Deactivate then delete the relation field; the server cascades the inverse.
    expect(metadataClient.deactivatedIds).toEqual(['field-primary']);
    expect(metadataClient.deletedIds).toEqual(['field-primary']);
    expect(coreClient.destroyedIds).toEqual(['vc-1']);
    expect(result.deleteRelationField).toBe(true);
    expect(result.deletedFields).toEqual(['primaryRecord']);
  });

  it('should leave the relation field untouched but still destroy the config when the field was not created by this app', async () => {
    const coreClient = makeCoreClient({
      config: { ...config, createdRelationField: false },
    });
    const metadataClient = makeMetadataClient('company', {
      primaryRecord: { id: 'field-primary', isActive: true },
    });

    const result = await deleteVariationConfigCompletely({
      coreClient,
      metadataClient,
      configId: 'vc-1',
    });

    expect(metadataClient.deactivatedIds).toEqual([]);
    expect(metadataClient.deletedIds).toEqual([]);
    expect(coreClient.destroyedIds).toEqual(['vc-1']);
    expect(result.deleteRelationField).toBe(false);
    expect(result.deletedFields).toEqual([]);

    const plan = await planDeleteVariationConfig(coreClient, 'vc-1');
    expect(plan.keepReason).toBe('not-created');
  });

  it('should still destroy the config and not throw when the relation field is already gone', async () => {
    const coreClient = makeCoreClient({ config });
    // Metadata has no primaryRecord field — a partial prior cleanup.
    const metadataClient = makeMetadataClient('company', {});

    const result = await deleteVariationConfigCompletely({
      coreClient,
      metadataClient,
      configId: 'vc-1',
    });

    expect(metadataClient.deactivatedIds).toEqual([]);
    expect(metadataClient.deletedIds).toEqual([]);
    expect(coreClient.destroyedIds).toEqual(['vc-1']);
    expect(result.deleteRelationField).toBe(true);
    expect(result.deletedFields).toEqual([]);
  });

  it('should never delete override rows (deliberate deviation from the formula precedent)', async () => {
    const coreClient = makeCoreClient({ config });
    const metadataClient = makeMetadataClient('company', {
      primaryRecord: { id: 'field-primary', isActive: true },
    });

    await deleteVariationConfigCompletely({
      coreClient,
      metadataClient,
      configId: 'vc-1',
    });

    // The ONLY core mutation issued is the config destroy — no formulaOverride
    // query or delete: the shared (object, field, record) override key space is
    // left entirely intact.
    expect(coreClient.destroyedIds).toEqual(['vc-1']);
    expect(coreClient.otherMutationKeys).toEqual([]);
  });
});
