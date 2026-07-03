import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { refreshFormulaStatuses } from 'src/logic-functions/lib/formula-status';
import { companionFieldName } from 'src/logic-functions/lib/fx-status-field';
import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Definition lifecycle (ADR 0009): deleting a definition deactivates its
// APP-OWNED value field pair (the column disappears but its data survives —
// "formula columns are holy": no orphaned pseudo-regular fields), restoring
// reactivates and recomputes, destroying additionally cleans up override rows.
// After any of these the operational statuses (OFFLINE/UPSTREAM) are
// recomputed from scratch so dependents get flagged / unflagged.

type FieldMetadataInfo = {
  id: string;
  name: string;
  isActive: boolean;
};

// One metadata query (ObjectFilter cannot filter by name); client-side pick.
const findFields = async (
  objectName: string,
  fieldNames: string[],
): Promise<{
  objectMetadataId: string | null;
  fields: Map<string, FieldMetadataInfo>;
}> => {
  const result = new Map<string, FieldMetadataInfo>();
  let objectMetadataId: string | null = null;
  try {
    const client = new MetadataApiClient();
    const response = await client.query({
      objects: {
        __args: { filter: {}, paging: { first: 1000 } },
        edges: {
          node: {
            id: true,
            nameSingular: true,
            fields: {
              __args: { paging: { first: 1000 }, filter: {} },
              edges: {
                node: { id: true, name: true, isActive: true },
              },
            },
          },
        },
      },
    });
    const objectNode = (response?.objects?.edges ?? [])
      .map((edge: { node?: { id?: string; nameSingular?: string } }) => edge?.node)
      .find((node: { nameSingular?: string } | undefined) => node?.nameSingular === objectName);
    objectMetadataId = (objectNode as { id?: string } | undefined)?.id ?? null;
    for (const fieldEdge of (objectNode as any)?.fields?.edges ?? []) {
      const field = fieldEdge?.node;
      if (field?.id && fieldNames.includes(field.name)) {
        result.set(field.name, {
          id: field.id,
          name: field.name,
          isActive: field.isActive !== false,
        });
      }
    }
  } catch {
    // Metadata unavailable -> act on nothing (safe no-op).
  }
  return { objectMetadataId, fields: result };
};

const setFieldActive = async (fieldId: string, isActive: boolean) => {
  const client = new MetadataApiClient();
  await client.mutation({
    updateOneField: {
      __args: { input: { id: fieldId, update: { isActive } } },
      id: true,
    },
  });
};

// True when another (non-deleted) definition targets the same field — its
// output column must not be touched.
const anotherDefinitionTargets = async (
  client: FormulaClient,
  definition: FormulaDefinitionRecord,
): Promise<boolean> => {
  const response = await withRetry(() =>
    client.query({
      formulaDefinitions: {
        __args: {
          first: 10,
          filter: {
            targetObject: { eq: definition.targetObject },
            targetField: { eq: definition.targetField },
          },
        },
        edges: { node: { id: true } },
      },
    }),
  );
  return (response?.formulaDefinitions?.edges ?? []).some(
    (edge: { node?: { id?: string } }) => edge?.node?.id !== definition.id,
  );
};

const deactivateOwnedFields = async (
  client: FormulaClient,
  definition: FormulaDefinitionRecord,
): Promise<string[]> => {
  if (!definition.targetObject || !definition.targetField) return [];
  // Provenance: only touch fields the wizard created for THIS definition.
  // (createOneField stamps fields with the workspace custom application, not
  // this app, so metadata ownership cannot be used.)
  if (definition.createdField !== true) return [];
  if (await anotherDefinitionTargets(client, definition)) return [];

  const names = [
    definition.targetField,
    companionFieldName(definition.targetField),
  ];
  const { fields } = await findFields(definition.targetObject, names);
  const deactivated: string[] = [];
  for (const name of names) {
    const field = fields.get(name);
    if (field && field.isActive) {
      await setFieldActive(field.id, false);
      deactivated.push(name);
    }
  }
  return deactivated;
};

export const handleDefinitionDeleted = async (
  client: FormulaClient,
  before: FormulaDefinitionRecord,
): Promise<Record<string, unknown>> => {
  const deactivated = await deactivateOwnedFields(client, before);
  const statuses = await refreshFormulaStatuses(client);
  return {
    deactivated,
    offline: statuses.offline,
    upstream: statuses.upstream,
  };
};

export const handleDefinitionRestored = async (
  client: FormulaClient,
  after: FormulaDefinitionRecord,
): Promise<Record<string, unknown>> => {
  const reactivated: string[] = [];
  if (after.targetObject && after.targetField && after.createdField === true) {
    const companionName = companionFieldName(after.targetField);
    const { fields } = await findFields(after.targetObject, [
      after.targetField,
      companionName,
    ]);
    // Reactivate the pair (companions are always-active; visibility is a
    // layout concern). The dropped viewField rows CANNOT be restored here —
    // view mutations reject application tokens — the front components
    // re-converge layout via convergeFormulaFieldLayout when rendered.
    for (const name of [after.targetField, companionName]) {
      const field = fields.get(name);
      if (field && !field.isActive) {
        await setFieldActive(field.id, true);
        reactivated.push(field.name);
      }
    }
  }

  // Refresh statuses first (the field is live again), THEN recompute with the
  // fresh verdict — the event payload's own status is stale.
  const statuses = await refreshFormulaStatuses(client);
  let recomputed = 0;
  if (
    after.enabled !== false &&
    (after.expression ?? '') !== '' &&
    statuses.byId.get(after.id)?.status !== 'OFFLINE'
  ) {
    // Values are stale from the time in the trash.
    recomputed = (await recomputeAllRecords(client, after)).length;
  }
  return {
    reactivated,
    recomputed,
    offline: statuses.offline,
    upstream: statuses.upstream,
  };
};

export const handleDefinitionDestroyed = async (
  client: FormulaClient,
  before: FormulaDefinitionRecord,
): Promise<Record<string, unknown>> => {
  // Covers a straight destroy (no prior soft delete) too; a field already
  // deactivated by the soft delete is skipped. Never deletes the field or its
  // data — the trash auto-purges, and a purge must not drop a column.
  const deactivated = await deactivateOwnedFields(client, before);

  // The definition is gone forever: its override rows can never apply again.
  let overridesDeleted = 0;
  if (before.targetObject && before.targetField) {
    const response = await withRetry(() =>
      client.query({
        formulaOverrides: {
          __args: {
            first: 200,
            filter: {
              targetObject: { eq: before.targetObject },
              targetField: { eq: before.targetField },
            },
          },
          edges: { node: { id: true } },
        },
      }),
    );
    for (const edge of response?.formulaOverrides?.edges ?? []) {
      if (edge?.node?.id) {
        await withRetry(() =>
          client.mutation({
            deleteFormulaOverride: { __args: { id: edge.node.id }, id: true },
          }),
        );
        overridesDeleted += 1;
      }
    }
  }
  const statuses = await refreshFormulaStatuses(client);
  return {
    deactivated,
    overridesDeleted,
    offline: statuses.offline,
    upstream: statuses.upstream,
  };
};
