import { deepJsonEqual } from 'src/logic-functions/lib/deep-equal';
import { selectionEntryForMirrorKind } from 'src/logic-functions/lib/mirror-kinds';
import { navigatePath } from 'src/logic-functions/lib/coercion';
import {
  loadActiveOverrideFieldsForRecord,
} from 'src/logic-functions/lib/override-repository';
import { pluralize } from 'src/logic-functions/lib/recompute';
import {
  computeSyncableFields,
  type SyncableFieldInfo,
} from 'src/logic-functions/lib/syncable-fields';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Record-variations sync engine (design 2026-07-07). NOT a set of
// FormulaDefinitions: a parallel per-object concept that reuses the mirror
// engine's plumbing (deepJsonEqual, FormulaOverride, the kind-aware
// sub-selection helpers) to copy fields from a primary record to its
// variations — typed raw passthrough for every syncable kind, never engine
// evaluation.

export type SyncOutcome = {
  variationRecordId: string;
  changed: boolean;
  changedFields: string[];
  error: string | null;
};

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

const fieldSelection = (fields: string[]): Record<string, boolean> => {
  const selection: Record<string, boolean> = { id: true };
  for (const field of fields) {
    selection[field] = true;
  }
  return selection;
};

// Fetches a single record of `object` by id with kind-aware sub-selections.
// Mirrors recompute.ts's private fetchRecord (not exported there, so this is
// its own copy for this module).
const fetchRecordById = async (
  client: FormulaClient,
  object: string,
  recordId: string,
  fields: string[],
  selectionOverrides: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const response = await withRetry(() =>
    client.query({
      [object]: {
        __args: { filter: { id: { eq: recordId } } },
        ...fieldSelection(fields),
        ...selectionOverrides,
      },
    }),
  );
  return (response?.[object] as Record<string, unknown> | null) ?? null;
};

const selectionOverridesFor = (
  fields: SyncableFieldInfo[],
): Record<string, unknown> => {
  const overrides: Record<string, unknown> = {};
  for (const field of fields) {
    overrides[field.name] = selectionEntryForMirrorKind(field.kind);
  }
  return overrides;
};

// Every variation of `primaryRecordId` (records whose relation pointer equals
// it — the standard Twenty FK filter), paginated.
export const loadVariationRecordIds = async (
  client: FormulaClient,
  targetObject: string,
  relationFieldName: string,
  primaryRecordId: string,
  pageSize = 200,
): Promise<string[]> => {
  const pluralName = pluralize(targetObject);
  const filterFieldName = `${relationFieldName}Id`;
  const ids: string[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: {
            first: pageSize,
            filter: { [filterFieldName]: { eq: primaryRecordId } },
            ...(after ? { after } : {}),
          },
          edges: { node: { id: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.[pluralName];
    for (const edge of connection?.edges ?? []) {
      if (edge?.node?.id) ids.push(edge.node.id);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return ids;
};

// Copies `fieldsToConsider` from `primaryRecord` onto one variation: skips
// fields with an active override, compares the rest with deepJsonEqual against
// the variation's CURRENT stored value, and writes only the ones that actually
// differ, batched into ONE update mutation (sync owns many columns at once,
// unlike per-formula recompute's single-field write).
export const syncOneVariation = async (
  client: FormulaClient,
  targetObject: string,
  primaryRecord: Record<string, unknown>,
  variationId: string,
  fieldsToConsider: SyncableFieldInfo[],
): Promise<SyncOutcome> => {
  try {
    const overriddenFields = await loadActiveOverrideFieldsForRecord(
      client,
      targetObject,
      variationId,
    );
    const fieldsToSync = fieldsToConsider.filter(
      (field) => !overriddenFields.has(field.name),
    );
    if (fieldsToSync.length === 0) {
      return { variationRecordId: variationId, changed: false, changedFields: [], error: null };
    }

    const variationRecord = await fetchRecordById(
      client,
      targetObject,
      variationId,
      fieldsToSync.map((field) => field.name),
      selectionOverridesFor(fieldsToSync),
    );
    if (!variationRecord) {
      return {
        variationRecordId: variationId,
        changed: false,
        changedFields: [],
        error: 'Variation record not found',
      };
    }

    const data: Record<string, unknown> = {};
    const changedFieldNames: string[] = [];
    for (const field of fieldsToSync) {
      const primaryValue = navigatePath(primaryRecord, field.name) ?? null;
      const variationValue = navigatePath(variationRecord, field.name) ?? null;
      if (!deepJsonEqual(primaryValue, variationValue)) {
        data[field.name] = primaryValue;
        changedFieldNames.push(field.name);
      }
    }

    if (changedFieldNames.length === 0) {
      return { variationRecordId: variationId, changed: false, changedFields: [], error: null };
    }

    const mutationName = `update${capitalize(targetObject)}`;
    await withRetry(() =>
      client.mutation({
        [mutationName]: { __args: { id: variationId, data }, id: true },
      }),
    );

    return {
      variationRecordId: variationId,
      changed: true,
      changedFields: changedFieldNames,
      error: null,
    };
  } catch (error) {
    return {
      variationRecordId: variationId,
      changed: false,
      changedFields: [],
      error: String(error),
    };
  }
};

export type PrimaryUpdateSyncArgs = {
  client: FormulaClient;
  targetObject: string;
  primaryRecordId: string;
  // Which fields changed on the primary (from the event). undefined/empty is
  // never expected here (the caller always has updatedFields for an update
  // event) but is handled defensively as "nothing changed".
  updatedFields: string[] | undefined;
  relationFieldName: string;
};

// Primary updated: copy the changed syncable fields onto every one of its
// variations. Scoped to this primary's OWN variations only (never "recompute
// the whole object") — the m5 fan-out cliff this design explicitly avoids.
export const syncPrimaryUpdateToVariations = async ({
  client,
  targetObject,
  primaryRecordId,
  updatedFields,
  relationFieldName,
}: PrimaryUpdateSyncArgs): Promise<SyncOutcome[]> => {
  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);
  const syncableByName = new Map(syncable.map((field) => [field.name, field]));

  const changedSyncableFields = (updatedFields ?? [])
    .filter((field) => syncableByName.has(field))
    .map((field) => syncableByName.get(field)!);

  if (changedSyncableFields.length === 0) {
    return [];
  }

  // Fresh, kind-aware fetch of the primary for exactly the changed fields —
  // never trust the event's `after` payload for composite kinds (see Global
  // Constraints).
  const primary = await fetchRecordById(
    client,
    targetObject,
    primaryRecordId,
    changedSyncableFields.map((field) => field.name),
    selectionOverridesFor(changedSyncableFields),
  );
  if (!primary) {
    return [];
  }

  const variationIds = await loadVariationRecordIds(
    client,
    targetObject,
    relationFieldName,
    primaryRecordId,
  );

  const outcomes: SyncOutcome[] = [];
  for (const variationId of variationIds) {
    outcomes.push(
      await syncOneVariation(client, targetObject, primary, variationId, changedSyncableFields),
    );
  }
  return outcomes;
};
