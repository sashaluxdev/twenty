import { deepJsonEqual } from 'src/logic-functions/lib/deep-equal';
import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import { selectionEntryForMirrorKind } from 'src/logic-functions/lib/mirror-kinds';
import { navigatePath } from 'src/logic-functions/lib/coercion';
import {
  loadActiveOverrideFieldsForRecord,
  upsertOverride,
} from 'src/logic-functions/lib/override-repository';
import { pluralize } from 'src/logic-functions/lib/recompute';
import {
  computeSyncableFields,
  type SyncableFieldInfo,
} from 'src/logic-functions/lib/syncable-fields';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import {
  findVariationConfigByTargetObject,
  updateVariationConfigBookkeeping,
} from 'src/logic-functions/lib/variation-config-repository';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
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

export type PrimaryFetchResult = {
  record: (Record<string, unknown> & { id: string }) | null;
  // True when the primary is trashed OR no longer exists at all (destroyed) —
  // freeze semantics do not distinguish the two (design 2026-07-07): sync skips
  // the variation entirely either way, no writes, values stay as they were.
  frozen: boolean;
};

// Fetches the primary INCLUDING trashed rows, via the plural connection with an
// explicit (empty) `deletedAt` filter key — the same withDeleted() convention
// already proven for FakeClient/the server elsewhere in this app (see
// FakeClient.connection). Also always selects the primary's OWN relation
// pointer so callers get the single-level guard for free.
export const fetchPrimaryRecordInclTrashed = async (
  client: FormulaClient,
  targetObject: string,
  primaryRecordId: string,
  fields: string[],
  selectionOverrides: Record<string, unknown>,
  relationFieldName: string,
): Promise<PrimaryFetchResult> => {
  const pluralName = pluralize(targetObject);
  const pointerField = `${relationFieldName}Id`;
  const response = await withRetry(() =>
    client.query({
      [pluralName]: {
        __args: {
          first: 1,
          filter: { id: { eq: primaryRecordId }, deletedAt: {} },
        },
        edges: {
          node: {
            ...fieldSelection(fields),
            ...selectionOverrides,
            deletedAt: true,
            [pointerField]: true,
          },
        },
      },
    }),
  );
  const node = response?.[pluralName]?.edges?.[0]?.node as
    | (Record<string, unknown> & { id: string; deletedAt?: string | null })
    | undefined;

  if (!node) {
    return { record: null, frozen: true };
  }
  if (node.deletedAt) {
    return { record: node, frozen: true };
  }
  return { record: node, frozen: false };
};

export type NewVariationSyncArgs = {
  client: FormulaClient;
  targetObject: string;
  variationRecordId: string;
  primaryRecordId: string;
  relationFieldName: string;
};

// Variation created: full initial sync of every syncable field. Covers
// API-created variations directly (the widget's create path, built in Plan 3,
// relies on this SAME handler rather than duplicating sync client-side).
export const syncNewVariationRecord = async ({
  client,
  targetObject,
  variationRecordId,
  primaryRecordId,
  relationFieldName,
}: NewVariationSyncArgs): Promise<
  SyncOutcome & { frozen?: boolean; skippedNestedPrimary?: boolean }
> => {
  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);
  const pointerField = `${relationFieldName}Id`;

  const { record: primary, frozen } = await fetchPrimaryRecordInclTrashed(
    client,
    targetObject,
    primaryRecordId,
    syncable.map((field) => field.name),
    selectionOverridesFor(syncable),
    relationFieldName,
  );

  if (frozen || !primary) {
    return {
      variationRecordId,
      changed: false,
      changedFields: [],
      error: null,
      frozen: true,
    };
  }

  // Single-level guard: the chosen primary must not itself be a variation. A
  // variation cannot be a primary — this can only happen if data raced in via
  // the API (the widget hides "create variation" on a record with a pointer,
  // and the create path re-checks server-side before calling this function).
  if (navigatePath(primary, pointerField)) {
    return {
      variationRecordId,
      changed: false,
      changedFields: [],
      error: null,
      skippedNestedPrimary: true,
    };
  }

  const outcome = await syncOneVariation(client, targetObject, primary, variationRecordId, syncable);
  return outcome;
};

// The FormulaOverride value slot for a raw variation value: overrideValue (a
// NUMBER column) can only literally hold a plain JS number. Since variation
// sync never evaluates anything, only a bare NUMBER field's raw value already
// IS a number — every other kind (including CURRENCY's {amountMicros,
// currencyCode} object and DATE/DATE_TIME's string scalars) goes to
// overrideValueText as JSON. This deliberately differs from the formula
// engine's "ENGINE_FAMILY_KINDS -> numeric slot" convention, which only holds
// because a formula EVALUATES to a float; variation sync just copies bytes.
const overrideSlotFor = (
  kind: string,
  rawValue: unknown,
): { numeric?: number; text?: string } => {
  if (kind === 'NUMBER' && typeof rawValue === 'number') {
    return { numeric: rawValue };
  }
  return { text: JSON.stringify(rawValue ?? null) };
};

export type DetectDivergenceArgs = {
  client: FormulaClient;
  targetObject: string;
  variationRecordId: string;
  primaryRecordId: string;
  after: Record<string, unknown> | null | undefined;
  updatedFields: string[] | undefined;
  // Set when the write came from a real person, not the app's own sync write.
  actorWorkspaceMemberId?: string | null;
  relationFieldName: string;
};

// A human edited a variation directly. Tells a genuine edit apart from the
// app's own sync write using the SAME compare-value-not-actor rule the mirror
// engine uses (an app write can inherit a human actor's identity on its event,
// so the actor alone can't decide this): fresh-fetch the CURRENT stored value
// (echo-race guard — a stale event must not be acted on once superseded),
// compare it to the primary's current value; equal means it's the app's own
// passthrough write, different means a human pinned a manual value.
export const detectVariationDivergence = async ({
  client,
  targetObject,
  variationRecordId,
  primaryRecordId,
  after,
  updatedFields,
  actorWorkspaceMemberId,
  relationFieldName,
}: DetectDivergenceArgs): Promise<void> => {
  if (!actorWorkspaceMemberId || !updatedFields || updatedFields.length === 0) {
    return;
  }

  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);
  const syncableByName = new Map(syncable.map((field) => [field.name, field]));
  const fieldsToCheck = updatedFields.filter((field) => syncableByName.has(field));
  if (fieldsToCheck.length === 0) {
    return;
  }

  const fieldsToCheckInfo = fieldsToCheck.map((field) => syncableByName.get(field)!);
  const { record: primary, frozen } = await fetchPrimaryRecordInclTrashed(
    client,
    targetObject,
    primaryRecordId,
    fieldsToCheckInfo.map((field) => field.name),
    selectionOverridesFor(fieldsToCheckInfo),
    relationFieldName,
  );
  if (frozen || !primary) {
    return; // Nothing to compare a diverging edit against.
  }

  for (const field of fieldsToCheckInfo) {
    const eventRaw = navigatePath(after ?? {}, field.name) ?? null;

    const freshVariation = await fetchRecordById(
      client,
      targetObject,
      variationRecordId,
      [field.name],
      { [field.name]: selectionEntryForMirrorKind(field.kind) },
    );
    if (!freshVariation) continue;
    const currentRaw = navigatePath(freshVariation, field.name) ?? null;

    // Superseded write in flight: the stored value already moved past what
    // this event reports -> a newer write is converging, skip the stale echo.
    if (!deepJsonEqual(currentRaw, eventRaw)) continue;

    const primaryRaw = navigatePath(primary, field.name) ?? null;
    // Current value equals the primary's -> the app's own sync write, not a
    // human pin.
    if (deepJsonEqual(primaryRaw, currentRaw)) continue;

    await upsertOverride(
      client,
      targetObject,
      field.name,
      variationRecordId,
      overrideSlotFor(field.kind, currentRaw),
    );
  }
};

export type SweepOutcome = {
  configId: string;
  evaluated: number;
  written: number;
  errored: number;
  frozen: number;
  skippedNestedPrimary: number;
};

// Hourly convergence backstop, per enabled config: page every variation of the
// object, re-sync it against its (possibly-fresh) primary, skipping active
// overrides (syncOneVariation already does this) — same posture as
// formula-sweep.ts/recomputeAllRecords, generalized to variations.
export const sweepVariationConfig = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  pageSize = 100,
): Promise<SweepOutcome> => {
  const targetObject = config.targetObject ?? '';
  const relationFieldName = config.relationFieldName ?? 'primaryRecord';
  const pluralName = pluralize(targetObject);
  const pointerField = `${relationFieldName}Id`;
  const syncable = await computeSyncableFields(client, targetObject, relationFieldName);

  let evaluated = 0;
  let written = 0;
  let errored = 0;
  let frozen = 0;
  let skippedNestedPrimary = 0;
  // First per-record error only, matching formula-sweep.ts's precedent — a
  // sweep can fault many records, but only the first is worth surfacing on
  // the config's lastError.
  let firstError = '';
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: {
            first: pageSize,
            filter: { [pointerField]: { is: graphqlEnum('NOT_NULL') } },
            ...(after ? { after } : {}),
          },
          edges: { node: { id: true, [pointerField]: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.[pluralName];
    const edges: Array<{ node?: Record<string, unknown> }> = connection?.edges ?? [];

    for (const edge of edges) {
      const variationId = edge?.node?.id as string | undefined;
      const primaryRecordId = edge?.node?.[pointerField] as string | undefined;
      if (!variationId || !primaryRecordId) continue;
      evaluated += 1;

      try {
        const { record: primary, frozen: isFrozen } = await fetchPrimaryRecordInclTrashed(
          client,
          targetObject,
          primaryRecordId,
          syncable.map((field) => field.name),
          selectionOverridesFor(syncable),
          relationFieldName,
        );
        if (isFrozen || !primary) {
          frozen += 1;
          continue;
        }
        if (navigatePath(primary, pointerField)) {
          skippedNestedPrimary += 1;
          continue;
        }
        const outcome = await syncOneVariation(client, targetObject, primary, variationId, syncable);
        if (outcome.error) {
          errored += 1;
          if (!firstError) firstError = outcome.error;
        } else if (outcome.changed) written += 1;
      } catch (error) {
        errored += 1;
        if (!firstError) firstError = String(error);
      }
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? undefined;
  }

  const statusReason =
    skippedNestedPrimary > 0
      ? `${skippedNestedPrimary} variation(s) skipped: primary itself is a variation`
      : '';
  await updateVariationConfigBookkeeping(client, config.id, {
    lastSyncedAt: new Date().toISOString(),
    lastError: firstError,
    statusReason,
  });

  return { configId: config.id, evaluated, written, errored, frozen, skippedNestedPrimary };
};

export type VariationRecordUpdatedArgs = {
  client: FormulaClient;
  objectName: string;
  recordId: string;
  after: Record<string, unknown> | null | undefined;
  updatedFields: string[] | undefined;
  actorWorkspaceMemberId?: string | null;
};

// Entry point for the *.updated wildcard trigger. Decides whether the changed
// record is a primary (fan out the change to its variations) or a variation
// (check whether a human just diverged one of its fields) by a FRESH read of
// its relation pointer — never trusted from the event payload (Global
// Constraints): a pointer field is exactly the kind of value an echo-race could
// make stale.
export const handleVariationRecordUpdated = async ({
  client,
  objectName,
  recordId,
  after,
  updatedFields,
  actorWorkspaceMemberId,
}: VariationRecordUpdatedArgs): Promise<{
  role: 'none' | 'primary' | 'variation';
  outcomes: SyncOutcome[];
}> => {
  const config = await findVariationConfigByTargetObject(client, objectName);
  if (!config || !config.enabled) {
    return { role: 'none', outcomes: [] };
  }

  const relationFieldName = config.relationFieldName ?? 'primaryRecord';
  const pointerField = `${relationFieldName}Id`;

  const current = await fetchRecordById(client, objectName, recordId, [pointerField], {});
  const primaryRecordId = current
    ? ((navigatePath(current, pointerField) as string | null | undefined) ?? null)
    : null;

  if (!primaryRecordId) {
    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: objectName,
      primaryRecordId: recordId,
      updatedFields,
      relationFieldName,
    });
    return { role: 'primary', outcomes };
  }

  await detectVariationDivergence({
    client,
    targetObject: objectName,
    variationRecordId: recordId,
    primaryRecordId,
    after,
    updatedFields,
    actorWorkspaceMemberId,
    relationFieldName,
  });
  return { role: 'variation', outcomes: [] };
};

export type VariationRecordCreatedArgs = {
  client: FormulaClient;
  objectName: string;
  recordId: string;
  after: Record<string, unknown> | null | undefined;
};

// Entry point for the *.created wildcard trigger. A create event's `after` is
// trusted for the pointer scalar directly (unlike the update path) — there is
// no prior state for a stale echo to race against on a brand-new record.
export const handleVariationRecordCreated = async ({
  client,
  objectName,
  recordId,
  after,
}: VariationRecordCreatedArgs): Promise<
  (SyncOutcome & { frozen?: boolean; skippedNestedPrimary?: boolean }) | null
> => {
  const config = await findVariationConfigByTargetObject(client, objectName);
  if (!config || !config.enabled) {
    return null;
  }

  const relationFieldName = config.relationFieldName ?? 'primaryRecord';
  const pointerField = `${relationFieldName}Id`;
  const primaryRecordId = (after?.[pointerField] as string | undefined) ?? null;

  // No pointer -> this new record IS a primary (or a plain record); nothing to
  // sync onto it.
  if (!primaryRecordId) {
    return null;
  }

  // Self-reference guard: reject wiring a record to itself (data raced in via
  // the API — the widget's own create path never sets this).
  if (primaryRecordId === recordId) {
    return null;
  }

  return syncNewVariationRecord({
    client,
    targetObject: objectName,
    variationRecordId: recordId,
    primaryRecordId,
    relationFieldName,
  });
};
