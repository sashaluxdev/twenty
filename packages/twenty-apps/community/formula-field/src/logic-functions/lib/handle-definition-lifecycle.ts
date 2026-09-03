import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { findFields } from 'src/logic-functions/lib/find-fields';
import { loadEnabledFormulas } from 'src/logic-functions/lib/formula-repository';
import { refreshFormulaStatuses } from 'src/logic-functions/lib/formula-status';
import { companionFieldName } from 'src/logic-functions/lib/fx-status-field';
import {
  convergeMarkersForColumn,
  convergeMarkersForRecords,
  markerFieldExistsOnObject,
} from 'src/logic-functions/lib/marker-converge';
import { loadOverridesForObject } from 'src/logic-functions/lib/override-repository';
import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Definition lifecycle (ADR 0009): naive-trashing a definition performs NO
// field-metadata mutation — the app-owned value field pair stays active so the
// column and its data survive untouched ("formula columns are holy"); dependents
// are re-flagged OFFLINE purely by the trashed-target liveness rule. Restoring
// reactivates any legacy-deactivated field (healing pre-change trashes) and
// recomputes; destroying deactivates the owned pair (a purge must never drop a
// data column) and cleans up override rows. After any of these the operational
// statuses (OFFLINE/UPSTREAM) are recomputed from scratch so dependents get
// flagged / unflagged.

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
// output column must not be touched. Exported so the "delete completely" flow
// reuses the exact same shared-target guard instead of duplicating it.
export const anotherDefinitionTargets = async (
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

// `shared` (another live definition targets the same column) is passed in
// rather than re-queried: the destroy handler already needs that verdict for
// the pin cleanup, and it is one query per destroy either way.
const deactivateOwnedFields = async (
  client: FormulaClient,
  definition: FormulaDefinitionRecord,
  shared: boolean,
): Promise<string[]> => {
  if (!definition.targetObject || !definition.targetField) return [];
  // Provenance: only touch fields the wizard created for THIS definition.
  // (createOneField stamps fields with the workspace custom application, not
  // this app, so metadata ownership cannot be used.)
  if (definition.createdField !== true) return [];
  if (shared) return [];

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

// Marker work is best-effort (spec §5): a metadata or read failure must never
// abort the lifecycle handler around it — the hourly sweep reconverges.
const runMarkerStep = async (step: () => Promise<unknown>): Promise<void> => {
  try {
    await step();
  } catch {
    // The sweep reconverges.
  }
};

export const handleDefinitionDeleted = async (
  client: FormulaClient,
  before: FormulaDefinitionRecord,
): Promise<Record<string, unknown>> => {
  // Naive trash performs NO field-metadata mutation: the wizard-created field
  // pair stays active so its column and data survive untouched ("formula
  // columns are holy"). Dependents of this now-trashed definition are re-flagged
  // OFFLINE purely by the trashed-target liveness rule inside
  // refreshFormulaStatuses (buildTrashDeadFieldKeys) — no deactivation needed.

  // The trashed definition has left the enabled set, so its label must leave
  // every marker it appears in (spec §5.4). The pins stay: a restore brings the
  // overrides — and their labels — back.
  if (before.targetObject && before.targetField) {
    const { targetObject, targetField } = before;
    await runMarkerStep(() =>
      convergeMarkersForColumn(client, targetObject, targetField),
    );
  }

  const statuses = await refreshFormulaStatuses(client);
  return {
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
    // view mutations reject application tokens — so a reactivated legacy
    // companion is simply invisible until the hourly cleanup sweep deletes
    // it (ADR 0021).
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
  // A surviving definition on the same column still owns its field AND its
  // pins — destroying one of two sharers must not erase the survivor's work.
  const shared =
    before.targetObject && before.targetField
      ? await anotherDefinitionTargets(client, before)
      : false;

  // Covers a straight destroy (no prior soft delete) too; a field already
  // deactivated by the soft delete is skipped. Never deletes the field or its
  // data — the trash auto-purges, and a purge must not drop a column.
  const deactivated = await deactivateOwnedFields(client, before, shared);

  // The definition is gone forever: its override rows can never apply again.
  let overridesDeleted = 0;
  if (before.targetObject && before.targetField) {
    const { targetObject, targetField } = before;
    if (shared) {
      await runMarkerStep(() =>
        convergeMarkersForColumn(client, targetObject, targetField),
      );
    } else {
      const affectedRecordIds: string[] = [];
      let after: string | undefined;
      for (;;) {
        const response = await withRetry(() =>
          client.query({
            formulaOverrides: {
              __args: {
                first: 200,
                filter: {
                  targetObject: { eq: targetObject },
                  targetField: { eq: targetField },
                },
                ...(after ? { after } : {}),
              },
              edges: { node: { id: true, recordId: true } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          }),
        );
        const connection = response?.formulaOverrides;
        for (const edge of connection?.edges ?? []) {
          if (edge?.node?.id) {
            await withRetry(() =>
              client.mutation({
                deleteFormulaOverride: { __args: { id: edge.node.id }, id: true },
              }),
            );
            overridesDeleted += 1;
            if (edge.node.recordId) affectedRecordIds.push(edge.node.recordId);
          }
        }
        if (!connection?.pageInfo?.hasNextPage) break;
        after = connection.pageInfo.endCursor ?? undefined;
      }

      // Converges the collected ids directly rather than by column: the pins
      // that enumerate the column are gone by now. A fresh object-wide pin load
      // keeps the record's OTHER columns' pins counting.
      if (affectedRecordIds.length > 0) {
        await runMarkerStep(async () => {
          if (!(await markerFieldExistsOnObject(targetObject))) return;
          const definitions = await loadEnabledFormulas(client, targetObject);
          const pinRows = await loadOverridesForObject(client, targetObject);
          await convergeMarkersForRecords({
            client,
            objectName: targetObject,
            recordIds: affectedRecordIds,
            definitions,
            pinRows,
          });
        });
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
