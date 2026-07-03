import { beforeEach, describe, expect, it } from 'vitest';

import {
  deleteDefinitionCompletely,
  planDeleteDefinition,
} from 'src/front-components/lib/delete-definition-completely';

// The deletion runs through INJECTED clients, so the tests hand in plain fakes —
// no module mocking. The core client answers two shapes of formulaDefinitions
// query (fresh re-fetch by id, and the shared-target guard by targetObject+field)
// and records destroy mutations; the metadata client answers the objects lookup
// and records deactivate/delete mutations.

type DefinitionNode = {
  id: string;
  targetObject: string;
  targetField: string;
  createdField: boolean;
};

const makeCoreClient = ({
  definition,
  otherTargetingIds = [],
}: {
  definition: DefinitionNode;
  otherTargetingIds?: string[];
}) => {
  const destroyedIds: string[] = [];
  return {
    destroyedIds,
    query: async (selection: any) => {
      const filter = selection.formulaDefinitions.__args.filter ?? {};
      if (filter.id) {
        // Fresh re-fetch of the definition being deleted.
        return { formulaDefinitions: { edges: [{ node: definition }] } };
      }
      // Shared-target guard: this definition plus any others on the same column.
      return {
        formulaDefinitions: {
          edges: [
            { node: { id: definition.id } },
            ...otherTargetingIds.map((id) => ({ node: { id } })),
          ],
        },
      };
    },
    mutation: async (selection: any) => {
      const key = Object.keys(selection)[0];
      if (key === 'destroyFormulaDefinition') {
        const id = selection.destroyFormulaDefinition.__args.id;
        destroyedIds.push(id);
        return { destroyFormulaDefinition: { id } };
      }
      throw new Error(`unexpected core mutation ${key}`);
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

const definition: DefinitionNode = {
  id: 'def-1',
  targetObject: 'opportunity',
  targetField: 'formulaScore',
  createdField: true,
};

describe('deleteDefinitionCompletely', () => {
  beforeEach(() => {});

  it('should deactivate + delete both fields (companion first) and destroy the record when the app created the field and no other definition shares it', async () => {
    const coreClient = makeCoreClient({ definition });
    const metadataClient = makeMetadataClient('opportunity', {
      formulaScore: { id: 'field-value', isActive: true },
      formulaScoreFxStatus: { id: 'field-companion', isActive: true },
    });

    const result = await deleteDefinitionCompletely({
      coreClient,
      metadataClient,
      definitionId: 'def-1',
    });

    // Companion first, then the value field — deactivate then delete each.
    expect(metadataClient.deactivatedIds).toEqual([
      'field-companion',
      'field-value',
    ]);
    expect(metadataClient.deletedIds).toEqual(['field-companion', 'field-value']);
    expect(coreClient.destroyedIds).toEqual(['def-1']);
    expect(result.deleteValueField).toBe(true);
    expect(result.deletedFields).toEqual(['formulaScoreFxStatus', 'formulaScore']);
  });

  it('should keep the value field and only destroy the record when another definition targets the same column', async () => {
    const coreClient = makeCoreClient({
      definition,
      otherTargetingIds: ['def-2'],
    });
    const metadataClient = makeMetadataClient('opportunity', {
      formulaScore: { id: 'field-value', isActive: true },
      formulaScoreFxStatus: { id: 'field-companion', isActive: true },
    });

    const result = await deleteDefinitionCompletely({
      coreClient,
      metadataClient,
      definitionId: 'def-1',
    });

    expect(metadataClient.deactivatedIds).toEqual([]);
    expect(metadataClient.deletedIds).toEqual([]);
    expect(coreClient.destroyedIds).toEqual(['def-1']);
    expect(result.deleteValueField).toBe(false);
    expect(result.deletedFields).toEqual([]);
  });

  it('should keep the value field when it was not created by this app', async () => {
    const coreClient = makeCoreClient({
      definition: { ...definition, createdField: false },
    });
    const metadataClient = makeMetadataClient('opportunity', {
      formulaScore: { id: 'field-value', isActive: true },
      formulaScoreFxStatus: { id: 'field-companion', isActive: true },
    });

    const result = await deleteDefinitionCompletely({
      coreClient,
      metadataClient,
      definitionId: 'def-1',
    });

    expect(metadataClient.deletedIds).toEqual([]);
    expect(coreClient.destroyedIds).toEqual(['def-1']);
    expect(result.deleteValueField).toBe(false);

    const plan = await planDeleteDefinition(coreClient, 'def-1');
    expect(plan.keepReason).toBe('not-created');
  });

  it('should still delete the value field and not throw when the companion is already gone', async () => {
    const coreClient = makeCoreClient({ definition });
    const metadataClient = makeMetadataClient('opportunity', {
      formulaScore: { id: 'field-value', isActive: true },
    });

    const result = await deleteDefinitionCompletely({
      coreClient,
      metadataClient,
      definitionId: 'def-1',
    });

    expect(metadataClient.deactivatedIds).toEqual(['field-value']);
    expect(metadataClient.deletedIds).toEqual(['field-value']);
    expect(coreClient.destroyedIds).toEqual(['def-1']);
    expect(result.deletedFields).toEqual(['formulaScore']);
  });
});
