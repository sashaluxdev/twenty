import { deepJsonEqual } from 'src/logic-functions/lib/deep-equal';
import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import {
  invalidateMetadataCache,
  loadAllObjectsWithFields,
} from 'src/logic-functions/lib/metadata-objects';
import { selectionEntryForMirrorKind } from 'src/logic-functions/lib/mirror-kinds';
import { navigatePath } from 'src/logic-functions/lib/coercion';
import {
  decodeMirrorOverrideValue,
  loadActiveOverridesForRecord,
  type OverrideRecord,
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
import { checkRelationFieldHealth } from 'src/logic-functions/lib/variation-config-validation';
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

// R1 poison-window remedy, shared by every sync path: the syncable set is
// derived from a ≤60s-stale metadata cache while reads/writes hit the LIVE
// schema, so for up to a minute after a field is deactivated/deleted/renamed
// every selection naming the dead field throws — and because sync batches all
// fields, one dead field used to poison the whole variation. On a failure we
// invalidate the cache and re-derive ONCE (never a loop), keeping only the
// requested fields that survive with an UNCHANGED kind — a field that changed
// kind is dropped this round because the caller's primary snapshot was read
// with the old kind's sub-selection (writing that shape to the new kind would
// corrupt); a field that newly JOINED the set is deliberately not added, since
// the snapshot has no value for it (writing null would be data loss) — the
// next sweep backfills it, the same ≤1h convention as a freshly-added field.
const refreshFieldsAfterSyncFailure = async (
  client: FormulaClient,
  targetObject: string,
  relationFieldName: string,
  currentFields: SyncableFieldInfo[],
): Promise<SyncableFieldInfo[]> => {
  invalidateMetadataCache();
  try {
    const fresh = await computeSyncableFields(client, targetObject, relationFieldName);
    const freshKindByName = new Map(fresh.map((field) => [field.name, field.kind]));
    return currentFields.filter(
      (field) => freshKindByName.get(field.name) === field.kind,
    );
  } catch {
    // Metadata reload failed -> keep the original set; the retry stays bounded
    // either way.
    return currentFields;
  }
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

// Does this orphaned override pin exactly `currentValue`? Slot-aware: a text
// slot decodes its JSON (an undecodable slot never matches — the caller must
// not infer a rename off corrupted data); a numeric slot compares the number.
const orphanPinsValue = (
  orphan: OverrideRecord,
  currentValue: unknown,
): boolean => {
  if (orphan.overrideValueText !== null && orphan.overrideValueText !== undefined) {
    const decoded = decodeMirrorOverrideValue(orphan.overrideValueText);
    return decoded.restorable && deepJsonEqual(decoded.value, currentValue);
  }
  if (orphan.overrideValue !== null && orphan.overrideValue !== undefined) {
    return deepJsonEqual(orphan.overrideValue, currentValue);
  }
  return false;
};

// R2 rename reconcile. Overrides are keyed by field-NAME string (a key space
// shared with the formula feature — never migrated, rows never deleted), so a
// field rename (same id, same column data, new API name) orphans the row: the
// syncable set carries the new name, the skip set the old one, and without
// this guard sync would overwrite the user's intentionally-diverged value and
// the pin would silently vanish from the widget. Exact rename detection is
// impossible without field-id tracking on the row, but the pinned VALUE is a
// reliable witness: a would-be-overwritten field whose CURRENT stored value
// equals an orphan's pinned value is that orphan's renamed continuation.
// Policy: never overwrite a matching field; on an UNAMBIGUOUS match transfer
// the pin to the new name (upsert under the new key, deactivate — not delete —
// the orphan) so the widget's diverged list keeps showing it; on an ambiguous
// match (two fields carry the same value — a coincidence a wrong guess could
// destroy data over) hold every matching field unwritten and leave the orphan
// active for a human to resolve. Accepted "value is the witness" limitation
// (review L3): a DELETED-field orphan whose pinned value coincidentally equals
// a diverged field's current value causes a spurious transfer — conservative
// (a skipped write plus a visible, human-fixable pin) and recoverable (the
// orphan row is deactivated, never deleted).
//
// Held field names go into the SHARED `heldFields` set, and `orphans` is
// mutated (consumed on transfer): a transfer COMMITS before the record write,
// so if that write throws into the R1 ladder, the retry/per-field attempts
// must keep holding the transferred field (M1) — the held set carries that
// across attempts within one syncOneVariation call, and the consumed orphan
// list keeps the transfer itself idempotent.
const reconcileOrphanedOverrides = async (
  client: FormulaClient,
  targetObject: string,
  variationId: string,
  variationRecord: Record<string, unknown>,
  changedFields: SyncableFieldInfo[],
  orphans: OverrideRecord[],
  heldFields: Set<string>,
): Promise<void> => {
  for (const orphan of [...orphans]) {
    const matches = changedFields.filter(
      (field) =>
        !heldFields.has(field.name) &&
        orphanPinsValue(orphan, navigatePath(variationRecord, field.name) ?? null),
    );
    if (matches.length === 0) {
      continue;
    }
    for (const field of matches) {
      heldFields.add(field.name);
    }
    if (matches.length > 1) {
      continue;
    }
    const field = matches[0];
    const currentValue = navigatePath(variationRecord, field.name) ?? null;
    await upsertOverride(
      client,
      targetObject,
      field.name,
      variationId,
      overrideSlotFor(field.kind, currentValue),
    );
    await withRetry(() =>
      client.mutation({
        updateFormulaOverride: {
          __args: { id: orphan.id, data: { active: false } },
          id: true,
        },
      }),
    );
    orphans.splice(orphans.indexOf(orphan), 1);
  }
};

// The read -> diff -> write core of one sync attempt for one variation.
// Throws on a read/write failure so syncOneVariation can drive the
// poison-window retry/degrade ladder around it.
const syncVariationFieldsBatch = async (
  client: FormulaClient,
  targetObject: string,
  primaryRecord: Record<string, unknown>,
  variationId: string,
  fieldsToSync: SyncableFieldInfo[],
  orphanedOverrides: OverrideRecord[],
  heldFields: Set<string>,
): Promise<{ found: boolean; changedFields: string[] }> => {
  // Fields held by an earlier attempt's reconcile (transferred pins and
  // ambiguous matches) stay held on EVERY subsequent attempt — a retry after
  // a committed transfer must not re-diff the protected field and write the
  // primary value over it (M1).
  const effectiveFields = fieldsToSync.filter(
    (field) => !heldFields.has(field.name),
  );
  if (effectiveFields.length === 0) {
    return { found: true, changedFields: [] };
  }

  const variationRecord = await fetchRecordById(
    client,
    targetObject,
    variationId,
    effectiveFields.map((field) => field.name),
    selectionOverridesFor(effectiveFields),
  );
  if (!variationRecord) {
    return { found: false, changedFields: [] };
  }

  const data: Record<string, unknown> = {};
  let changedFields: SyncableFieldInfo[] = [];
  for (const field of effectiveFields) {
    const primaryValue = navigatePath(primaryRecord, field.name) ?? null;
    const variationValue = navigatePath(variationRecord, field.name) ?? null;
    if (!deepJsonEqual(primaryValue, variationValue)) {
      data[field.name] = primaryValue;
      changedFields.push(field);
    }
  }

  if (orphanedOverrides.length > 0 && changedFields.length > 0) {
    await reconcileOrphanedOverrides(
      client,
      targetObject,
      variationId,
      variationRecord,
      changedFields,
      orphanedOverrides,
      heldFields,
    );
    for (const field of changedFields) {
      if (heldFields.has(field.name)) {
        delete data[field.name];
      }
    }
    changedFields = changedFields.filter((field) => !heldFields.has(field.name));
  }

  if (changedFields.length === 0) {
    return { found: true, changedFields: [] };
  }

  const mutationName = `update${capitalize(targetObject)}`;
  await withRetry(() =>
    client.mutation({
      [mutationName]: { __args: { id: variationId, data }, id: true },
    }),
  );

  return { found: true, changedFields: changedFields.map((field) => field.name) };
};

const NOT_FOUND_ERROR = 'Variation record not found';

const outcomeFromBatch = (
  variationId: string,
  batch: { found: boolean; changedFields: string[] },
): SyncOutcome => ({
  variationRecordId: variationId,
  changed: batch.changedFields.length > 0,
  changedFields: batch.changedFields,
  error: batch.found ? null : NOT_FOUND_ERROR,
});

export type SyncOneVariationOptions = {
  // Default true. The widget's explicit "re-sync this field" passes false:
  // the user just asked for the primary's value, so the rename-reconcile
  // guard must not re-pin the field off a coincidental orphan value match.
  reconcileOverrides?: boolean;
};

// Copies `fieldsToConsider` from `primaryRecord` onto one variation: skips
// fields with an active override, compares the rest with deepJsonEqual against
// the variation's CURRENT stored value, and writes only the ones that actually
// differ, batched into ONE update mutation (sync owns many columns at once,
// unlike per-formula recompute's single-field write). On a batch failure the
// R1 ladder applies: refresh metadata + one batch retry, then per-field
// degrade so a permanently-bad field can never block the other fields. Before
// writing, the R2 reconcile protects values pinned under a since-renamed
// field name (see reconcileOrphanedOverrides).
export const syncOneVariation = async (
  client: FormulaClient,
  targetObject: string,
  primaryRecord: Record<string, unknown>,
  variationId: string,
  fieldsToConsider: SyncableFieldInfo[],
  relationFieldName: string,
  options: SyncOneVariationOptions = {},
): Promise<SyncOutcome> => {
  let fieldsToSync: SyncableFieldInfo[];
  // Rows orphaned by a rename/delete: active overrides whose targetField no
  // longer exists on the object AT ALL (a merely-deactivated field still
  // exists — its pin is inert, not endangered). Shared by every batch attempt
  // in the R1 ladder below; transfers consume from it, and the fields they
  // protected go into heldFields so every later attempt keeps holding them
  // even though the consumed orphan can no longer re-match (M1).
  const orphanedOverrides: OverrideRecord[] = [];
  const heldFields = new Set<string>();
  try {
    const overrideRows = await loadActiveOverridesForRecord(
      client,
      targetObject,
      variationId,
    );
    const overriddenFields = new Set(overrideRows.map((row) => row.targetField));
    fieldsToSync = fieldsToConsider.filter(
      (field) => !overriddenFields.has(field.name),
    );
    if (options.reconcileOverrides !== false && overrideRows.length > 0) {
      const objects = await loadAllObjectsWithFields();
      const objectFieldNames = new Set(
        objects
          .find((candidate) => candidate.nameSingular === targetObject)
          ?.fields.map((field) => field.name) ?? [],
      );
      // An unresolvable object (deleted mid-flight) yields no orphan
      // inference at all rather than treating EVERY row as orphaned.
      if (objectFieldNames.size > 0) {
        orphanedOverrides.push(
          ...overrideRows.filter((row) => !objectFieldNames.has(row.targetField)),
        );
      }
    }
  } catch (error) {
    // The overrides read never selects a syncable field, so a failure here is
    // not a poison-window suspect — report it, do not retry.
    return {
      variationRecordId: variationId,
      changed: false,
      changedFields: [],
      error: String(error),
    };
  }
  if (fieldsToSync.length === 0) {
    return { variationRecordId: variationId, changed: false, changedFields: [], error: null };
  }

  try {
    const batch = await syncVariationFieldsBatch(
      client,
      targetObject,
      primaryRecord,
      variationId,
      fieldsToSync,
      orphanedOverrides,
      heldFields,
    );
    return outcomeFromBatch(variationId, batch);
  } catch {
    const refreshedFields = await refreshFieldsAfterSyncFailure(
      client,
      targetObject,
      relationFieldName,
      fieldsToSync,
    );
    if (refreshedFields.length === 0) {
      // Every considered field left the syncable set -> nothing to sync.
      return { variationRecordId: variationId, changed: false, changedFields: [], error: null };
    }

    try {
      const batch = await syncVariationFieldsBatch(
        client,
        targetObject,
        primaryRecord,
        variationId,
        refreshedFields,
        orphanedOverrides,
        heldFields,
      );
      return outcomeFromBatch(variationId, batch);
    } catch {
      // Fresh metadata still disagrees with the live schema about some field.
      // Degrade to per-field sync: each field pays its own read+write, so the
      // bad one is isolated and reported while the rest still converge. Still
      // bounded — one pass, no recursion.
      const changedFields: string[] = [];
      let firstError = '';
      for (const field of refreshedFields) {
        try {
          const single = await syncVariationFieldsBatch(
            client,
            targetObject,
            primaryRecord,
            variationId,
            [field],
            orphanedOverrides,
            heldFields,
          );
          if (!single.found) {
            return {
              variationRecordId: variationId,
              changed: changedFields.length > 0,
              changedFields,
              error: NOT_FOUND_ERROR,
            };
          }
          changedFields.push(...single.changedFields);
        } catch (error) {
          if (!firstError) firstError = String(error);
        }
      }
      return {
        variationRecordId: variationId,
        changed: changedFields.length > 0,
        changedFields,
        error: firstError || null,
      };
    }
  }
};

export type PrimaryFetchResult = {
  record: (Record<string, unknown> & { id: string }) | null;
  // True when the primary is trashed OR no longer exists at all (destroyed) —
  // freeze semantics do not distinguish the two (design 2026-07-07): sync skips
  // the variation entirely either way, no writes, values stay as they were.
  frozen: boolean;
};

// Fetches the primary INCLUDING trashed rows in a single connection read. An
// `or` over `deletedAt IS NULL / IS NOT NULL` triggers the server's
// withDeleted() (which disables the default `deletedAt IS NULL` scope), so the
// row is returned whether it is live or trashed. The earlier `deletedAt: {}`
// form was server-invalid ("Filter for field deletedAt must have exactly one
// operator") and is fixed here. Also always selects the primary's OWN relation
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
          filter: {
            id: { eq: primaryRecordId },
            or: [
              { deletedAt: { is: graphqlEnum('NULL') } },
              { deletedAt: { is: graphqlEnum('NOT_NULL') } },
            ],
          },
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

type ResilientPrimaryFetch = {
  result: PrimaryFetchResult;
  // Subset of the requested fields that was actually read — narrowed by the
  // fresh-metadata retry and/or the per-field degrade, so callers sync exactly
  // what the record snapshot really contains.
  fields: SyncableFieldInfo[];
  // First per-field read error from the degraded path (null when nothing was
  // dropped): the honest trace of a field metadata lists but the live schema
  // rejects, for the sweep to persist on lastError.
  error: string | null;
};

// fetchPrimaryRecordInclTrashed wrapped in the R1 poison-window ladder: full
// batch read, then invalidate + one batch retry against the fresh syncable
// set, then per-field degrade — base row first (id/deletedAt/pointer always
// exist), then one single-field read each, dropping only the fields the live
// schema rejects. Bounded: at most 2 + 1 + N calls, never a loop. A base-read
// failure (real outage, not a dead field) propagates to the caller's existing
// error handling.
const fetchPrimaryResilient = async (
  client: FormulaClient,
  targetObject: string,
  primaryRecordId: string,
  fields: SyncableFieldInfo[],
  relationFieldName: string,
): Promise<ResilientPrimaryFetch> => {
  try {
    const result = await fetchPrimaryRecordInclTrashed(
      client,
      targetObject,
      primaryRecordId,
      fields.map((field) => field.name),
      selectionOverridesFor(fields),
      relationFieldName,
    );
    return { result, fields, error: null };
  } catch {
    const refreshedFields = await refreshFieldsAfterSyncFailure(
      client,
      targetObject,
      relationFieldName,
      fields,
    );
    try {
      const result = await fetchPrimaryRecordInclTrashed(
        client,
        targetObject,
        primaryRecordId,
        refreshedFields.map((field) => field.name),
        selectionOverridesFor(refreshedFields),
        relationFieldName,
      );
      return { result, fields: refreshedFields, error: null };
    } catch {
      const base = await fetchPrimaryRecordInclTrashed(
        client,
        targetObject,
        primaryRecordId,
        [],
        {},
        relationFieldName,
      );
      if (!base.record || base.frozen) {
        return { result: base, fields: [], error: null };
      }
      const survivors: SyncableFieldInfo[] = [];
      let firstError = '';
      for (const field of refreshedFields) {
        try {
          const single = await fetchPrimaryRecordInclTrashed(
            client,
            targetObject,
            primaryRecordId,
            [field.name],
            selectionOverridesFor([field]),
            relationFieldName,
          );
          if (single.record) {
            base.record[field.name] = single.record[field.name] ?? null;
            survivors.push(field);
          }
        } catch (error) {
          // Dead on the live schema -> dropped; everything else still syncs.
          if (!firstError) firstError = String(error);
        }
      }
      return { result: base, fields: survivors, error: firstError || null };
    }
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
  // Constraints). Resilient (R1): a poisoned selection refreshes metadata and
  // narrows instead of killing the whole fan-out. The deletedAt-inclusive read
  // reports a trashed primary as frozen — the same "nothing to fan out" skip
  // the previous default-scope null read produced.
  const {
    result: { record: primary, frozen },
    fields: liveFields,
  } = await fetchPrimaryResilient(
    client,
    targetObject,
    primaryRecordId,
    changedSyncableFields,
    relationFieldName,
  );
  if (frozen || !primary || liveFields.length === 0) {
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
      await syncOneVariation(
        client,
        targetObject,
        primary,
        variationId,
        liveFields,
        relationFieldName,
      ),
    );
  }
  return outcomes;
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

  const {
    result: { record: primary, frozen },
    fields: liveFields,
  } = await fetchPrimaryResilient(
    client,
    targetObject,
    primaryRecordId,
    syncable,
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

  const outcome = await syncOneVariation(
    client,
    targetObject,
    primary,
    variationRecordId,
    liveFields,
    relationFieldName,
  );
  return outcome;
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

  // One kind-aware fetch of the variation for ALL checked fields, before the
  // loop — a human editing 5 fields is now 1 read, not 5. Beyond cost, a single
  // consistent snapshot is BETTER for the echo-race guard than N staggered
  // reads: every field compares against the SAME point-in-time state, so a
  // write landing mid-loop can't make field A look superseded while field B
  // still reads live.
  const freshVariation = await fetchRecordById(
    client,
    targetObject,
    variationRecordId,
    fieldsToCheckInfo.map((field) => field.name),
    selectionOverridesFor(fieldsToCheckInfo),
  );
  if (!freshVariation) {
    return; // Variation vanished -> nothing to compare a diverging edit against.
  }

  for (const field of fieldsToCheckInfo) {
    const eventRaw = navigatePath(after ?? {}, field.name) ?? null;
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

  // R3 honest health signal: a relation field deactivated/deleted OUTSIDE the
  // app (Settings) makes every sync path throw raw GraphQL while the config
  // still read as healthy. Check it up front (fresh-metadata re-check inside,
  // so a stale cache cannot false-alarm): dead -> status OFFLINE with a
  // human-readable reason, skip the paging entirely. The config deliberately
  // STAYS enabled so the next sweep self-heals the moment the field is back —
  // save-time validation is where a human-present hard disable happens.
  const relationFieldHealth = await checkRelationFieldHealth(
    targetObject,
    relationFieldName,
  );
  if (!relationFieldHealth.ok) {
    await updateVariationConfigBookkeeping(client, config.id, {
      lastSyncedAt: new Date().toISOString(),
      lastError: relationFieldHealth.error,
      status: 'OFFLINE',
      statusReason: relationFieldHealth.error,
    });
    return {
      configId: config.id,
      evaluated: 0,
      written: 0,
      errored: 1,
      frozen: 0,
      skippedNestedPrimary: 0,
    };
  }

  let syncable = await computeSyncableFields(client, targetObject, relationFieldName);

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
        const {
          result: { record: primary, frozen: isFrozen },
          fields: liveFields,
          error: droppedFieldsError,
        } = await fetchPrimaryResilient(
          client,
          targetObject,
          primaryRecordId,
          syncable,
          relationFieldName,
        );
        // A field metadata lists but the live schema rejects is dropped, not
        // fatal — but it must not be silent: it is this sweep's lastError.
        if (droppedFieldsError && !firstError) firstError = droppedFieldsError;
        if (isFrozen || !primary) {
          frozen += 1;
          continue;
        }
        if (navigatePath(primary, pointerField)) {
          skippedNestedPrimary += 1;
          continue;
        }
        // Narrow the set for the REST of this run once the resilient fetch
        // dropped fields, so a big sweep pays the degrade ladder once, not
        // once per record. Next run recomputes from (now-fresh) metadata.
        if (liveFields.length < syncable.length) syncable = liveFields;
        const outcome = await syncOneVariation(
          client,
          targetObject,
          primary,
          variationId,
          liveFields,
          relationFieldName,
        );
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
    // A completed sweep proves the config is operational: clear an OFFLINE
    // status a previous unhealthy sweep may have set (recovery convention).
    status: '',
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

// R3: one BOUNDED bookkeeping attempt persisting an event-path failure to
// config.lastError (the sweep used to be the only path doing this, leaving a
// failing live edit silent for up to an hour). Write-avoidant: no write when
// lastError already says exactly this, so a repeating failure cannot storm
// the config with writes (each write re-fires the config trigger, even though
// the bookkeeping guard swallows it there). Accepted (review L2): the dedupe
// reads the config snapshot loaded at invocation entry, so two STRICTLY
// concurrent identical failures can each write once — still bounded (one
// write per invocation, same value) and each re-trigger is swallowed by the
// bookkeeping recursion guard.
const recordEventPathError = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  error: string,
): Promise<void> => {
  if ((config.lastError ?? '') === error) {
    return;
  }
  try {
    await updateVariationConfigBookkeeping(client, config.id, { lastError: error });
  } catch {
    // Swallowed: surfacing is best-effort — a failing bookkeeping write must
    // neither mask the original sync failure nor add a retry loop of its own.
  }
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
  error?: string;
}> => {
  // Outside the guarded region below: with no config there is nowhere to
  // record a failure anyway — a config-lookup throw propagates as before.
  const config = await findVariationConfigByTargetObject(client, objectName);
  if (!config || !config.enabled) {
    return { role: 'none', outcomes: [] };
  }

  const relationFieldName = config.relationFieldName ?? 'primaryRecord';
  const pointerField = `${relationFieldName}Id`;

  try {
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
      // Per-variation failures are caught inside syncOneVariation and come
      // back as outcome errors, not throws — persist the first one (same
      // first-error convention as the sweep).
      const firstOutcomeError = outcomes.find((outcome) => outcome.error)?.error;
      if (firstOutcomeError) {
        await recordEventPathError(client, config, firstOutcomeError);
      }
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
  } catch (error) {
    // A thrown failure (e.g. the pointer read against a deleted relation
    // field) used to hard-error the whole logic-function invocation — visible
    // only in server logs, invisible on the config. Record it and return
    // gracefully instead.
    await recordEventPathError(client, config, String(error));
    return { role: 'none', outcomes: [], error: String(error) };
  }
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
