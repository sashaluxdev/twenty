import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import { companionFieldName } from 'src/logic-functions/lib/fx-status-field';
import { computeSyncableFields } from 'src/logic-functions/lib/syncable-fields';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { loadAllEnabledVariationConfigs } from 'src/logic-functions/lib/variation-config-repository';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Post-hoc Timeline cleanup: the app's automated formula/mirror writes emit
// `<object>.updated` timelineActivity rows that flood record Timelines. The
// platform offers no suppression switch, so this module soft-deletes (or strips)
// the app's own noise rows via the workspace GraphQL API. It is deliberately
// fail-safe toward KEEPING rows — only rows positively identified as entirely
// app-managed are deleted (Global Constraints). A later task wires it to a cron.
//
// Two flavors of app noise are recognized: formula/mirror writes (a formula's
// targetField + companion FxStatus field, managed unconditionally) and variation
// sync writes (ordinary user fields the variation engine mirrors onto VARIATION
// records — `syncVariationFieldsBatch`). The same field name on a PRIMARY record
// can be human/integration-authored, so variation-managed keys are deletable
// only when the row's parent record is itself a variation (its config-relation
// FK is non-null).

export type TimelineCleanupCounts = {
  scanned: number;
  deleted: number;
  stripped: number;
  kept: number;
  // true when the MAX_PAGES cap was hit with more rows remaining — the next cron
  // run picks up the rest (already-deleted rows drop out of later queries). Never
  // silent: surfaced here so callers can log it.
  truncated: boolean;
};

// Only touch rows from the last 48h: older app noise is out of the Timeline's
// "recent" view anyway and a bounded window keeps each run cheap.
const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const UPDATED_SUFFIX = '.updated';

// The self-referencing relation field a config provisions defaults to
// "primaryRecord". Server code reads `config.relationFieldName ?? 'primaryRecord'`
// inline (variation-sync.ts) — there is no exported server-side accessor, and the
// front lib's relationFieldOf must never be imported into server code, so the
// fallback is replicated minimally here following that convention.
const DEFAULT_RELATION_FIELD = 'primaryRecord';
const relationFieldNameOf = (config: VariationConfigRecord): string =>
  config.relationFieldName ?? DEFAULT_RELATION_FIELD;

const capitalize = (value: string): string =>
  value.length === 0 ? '' : value.charAt(0).toUpperCase() + value.slice(1);

// The timelineActivity column that stores the parent record's id for an object.
// Every `<object>.updated` row is written with this column set to the changed
// record's id, so the cleanup selects it to know which record a row belongs to.
// Derivation is authoritative, pinned in twenty-server:
//   - the insert/upsert path keys each row by `getTimelineActivityPropertyName`
//     (timeline-activity.repository.ts:159-169, 198-200), which is
//     `${buildTimelineActivityRelatedMorphFieldMetadataName(object)}Id`;
//   - that builder is `target${capitalize(object)}`
//     (timeline-activity-related-morph-field-metadata-name-builder.util.ts:3-7).
// So the column is `target${Capitalized}Id` for BOTH standard objects
// (company -> targetCompanyId, opportunity -> targetOpportunityId; the typed
// columns on timeline-activity.workspace-entity.ts:26-47 confirm the standard
// set) AND custom objects — the repository runs the SAME builder for every
// object, so a custom object `myThing` is `targetMyThingId` (the entity's
// generic `targetCustom` morph carries it). Only the first character is
// upper-cased; the rest of the name is untouched.
export const parentRecordIdSelectionFor = (objectNameSingular: string): string =>
  `target${capitalize(objectNameSingular)}Id`;

type RowOutcome = 'deleted' | 'stripped' | 'kept';

type TimelineRow = {
  id: string;
  name?: unknown;
  properties?: unknown;
  happensAt?: unknown;
  // Per-object parent pointer columns (targetCompanyId, …) selected dynamically.
  [column: string]: unknown;
};

// Per-object managed field model. `formula` is always app-owned; `variation`
// keys are app-owned only when the row's record is itself a variation, so the
// relation field name is carried to read that record's config-relation FK.
type ObjectManagedModel = {
  formula: Set<string>;
  variation: Set<string>;
  relationFieldName: string;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// The timeline row's `properties` arrives as an object or a JSON string (both are
// seen in the wild); defensively coerce to an object, or null when unparsable.
const parseProperties = (
  properties: unknown,
): Record<string, unknown> | null => {
  if (typeof properties === 'string') {
    try {
      const parsed: unknown = JSON.parse(properties);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isPlainObject(properties) ? properties : null;
};

// Object nameSingular from an `<object>.updated` timeline row name, or null when
// the name is not an updated-event (so it is left alone).
const objectFromName = (name: unknown): string | null => {
  if (typeof name !== 'string' || !name.endsWith(UPDATED_SUFFIX)) {
    return null;
  }
  return name.slice(0, -UPDATED_SUFFIX.length);
};

// Loads every FormulaDefinition (regardless of `enabled` — a disabled formula's
// field is still app-owned, so its old rows must stay cleanable) and builds
// object nameSingular -> set of app-managed field names (each targetField plus
// its companion FxStatus field). Wizard drafts with an empty target are skipped.
const loadFormulaManagedByObject = async (
  client: FormulaClient,
): Promise<Map<string, Set<string>>> => {
  const response = await withRetry(() =>
    client.query({
      formulaDefinitions: {
        __args: { first: 200 },
        edges: { node: { targetObject: true, targetField: true } },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    }),
  );

  const edges: Array<{
    node?: { targetObject?: string | null; targetField?: string | null };
  }> = response?.formulaDefinitions?.edges ?? [];

  const managedByObject = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targetObject = edge?.node?.targetObject;
    const targetField = edge?.node?.targetField;
    if (!targetObject || !targetField) {
      continue;
    }
    const fields = managedByObject.get(targetObject) ?? new Set<string>();
    fields.add(targetField);
    fields.add(companionFieldName(targetField));
    managedByObject.set(targetObject, fields);
  }
  return managedByObject;
};

// Builds object nameSingular -> {variation field names, relation field name} for
// every ENABLED variation config. The syncable set already includes MANY_TO_ONE
// join columns (ADR 0019), which is exactly what relation mirroring puts in the
// diff. A disabled config is excluded (its object is unclaimed), matching the
// enabled-only loader the rest of the sync engine drives its role resolution on.
const loadVariationManagedByObject = async (
  client: FormulaClient,
): Promise<Map<string, { fields: Set<string>; relationFieldName: string }>> => {
  const configs = await loadAllEnabledVariationConfigs(client);
  const byObject = new Map<
    string,
    { fields: Set<string>; relationFieldName: string }
  >();
  for (const config of configs) {
    const targetObject = config.targetObject;
    if (!targetObject) {
      continue;
    }
    const relationFieldName = relationFieldNameOf(config);
    const syncable = await computeSyncableFields(
      client,
      targetObject,
      relationFieldName,
    );
    // One config per object is the uniqueness anchor, but union defensively so a
    // duplicate config can never shrink the managed set.
    const entry = byObject.get(targetObject) ?? {
      fields: new Set<string>(),
      relationFieldName,
    };
    for (const field of syncable) {
      entry.fields.add(field.name);
    }
    entry.relationFieldName = relationFieldName;
    byObject.set(targetObject, entry);
  }
  return byObject;
};

// Merges the formula and variation managed sets into one per-object model.
const buildManagedModel = async (
  client: FormulaClient,
): Promise<Map<string, ObjectManagedModel>> => {
  const formulaByObject = await loadFormulaManagedByObject(client);
  const variationByObject = await loadVariationManagedByObject(client);

  const model = new Map<string, ObjectManagedModel>();
  for (const [object, formula] of formulaByObject) {
    model.set(object, {
      formula,
      variation: new Set<string>(),
      relationFieldName: DEFAULT_RELATION_FIELD,
    });
  }
  for (const [object, { fields, relationFieldName }] of variationByObject) {
    const existing = model.get(object);
    if (existing) {
      existing.variation = fields;
      existing.relationFieldName = relationFieldName;
    } else {
      model.set(object, {
        formula: new Set<string>(),
        variation: fields,
        relationFieldName,
      });
    }
  }
  return model;
};

// Is the record at `parentRecordId` itself a variation? A variation carries a
// non-null config-relation FK (`${relationFieldName}Id`). The verdict is cached
// per run so N rows for one record cost one lookup — keyed `object:recordId` to
// make the one-object-per-uuid invariant explicit rather than assumed. Fail-safe:
// a missing record or a failed read returns null (unresolvable), which the
// caller treats as KEEP.
const resolveParentIsVariation = async (
  client: FormulaClient,
  objectName: string,
  relationFieldName: string,
  parentRecordId: string,
  verdictCache: Map<string, boolean>,
): Promise<boolean | null> => {
  const cacheKey = `${objectName}:${parentRecordId}`;
  const cached = verdictCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const pointerField = `${relationFieldName}Id`;
  try {
    const response = await withRetry(() =>
      client.query({
        [objectName]: {
          __args: { filter: { id: { eq: parentRecordId } } },
          id: true,
          [pointerField]: true,
        },
      }),
    );
    const record = response?.[objectName] as
      | Record<string, unknown>
      | null
      | undefined;
    if (!record) {
      // Parent record vanished/unresolvable -> fail-safe, do not cache a
      // verdict off a missing row.
      return null;
    }
    const isVariation = record[pointerField] != null;
    verdictCache.set(cacheKey, isVariation);
    return isVariation;
  } catch {
    // Read failed -> fail-safe keep; leave the cache empty so a genuinely
    // resolvable later row can still try.
    return null;
  }
};

// Soft-deletes one row. A failure is contained (counted as kept) so one bad row
// cannot abort the sweep — same posture as recomputeAllRecords.
const deleteRow = async (
  client: FormulaClient,
  row: TimelineRow,
): Promise<RowOutcome> => {
  try {
    await withRetry(() =>
      client.mutation({
        deleteTimelineActivity: { __args: { id: row.id }, id: true },
      }),
    );
    return 'deleted';
  } catch {
    return 'kept';
  }
};

// Strips `stripKeys` from the row's diff, preserving every other `properties`
// subkey and the surviving keys' payloads. Nothing to strip -> keep untouched.
// A failed write is contained (counted as kept).
const stripKeysFromRow = async (
  client: FormulaClient,
  row: TimelineRow,
  parsedProperties: Record<string, unknown> | null,
  diff: Record<string, unknown>,
  keys: string[],
  stripKeys: Set<string>,
): Promise<RowOutcome> => {
  if (stripKeys.size === 0) {
    return 'kept';
  }
  try {
    const newDiff: Record<string, unknown> = {};
    for (const key of keys) {
      if (!stripKeys.has(key)) {
        newDiff[key] = diff[key];
      }
    }
    await withRetry(() =>
      client.mutation({
        updateTimelineActivity: {
          __args: {
            id: row.id,
            data: { properties: { ...(parsedProperties ?? {}), diff: newDiff } },
          },
          id: true,
        },
      }),
    );
    return 'stripped';
  } catch {
    return 'kept';
  }
};

// Classifies a single timeline row and applies the cleanup. Fail-safe: a row
// whose diff is missing/empty/unparsable, or belongs to an object with no
// managed fields, or whose changed fields are all human, is KEPT untouched.
const processRow = async (
  client: FormulaClient,
  row: TimelineRow,
  model: Map<string, ObjectManagedModel>,
  verdictCache: Map<string, boolean>,
): Promise<RowOutcome> => {
  const parsedProperties = parseProperties(row.properties);
  const rawDiff = parsedProperties ? parsedProperties.diff : undefined;
  const diff = isPlainObject(rawDiff) ? rawDiff : {};
  const keys = Object.keys(diff);
  if (keys.length === 0) {
    return 'kept';
  }

  const objectName = objectFromName(row.name);
  const managed = objectName ? model.get(objectName) : undefined;
  if (!objectName || !managed) {
    return 'kept';
  }

  const formulaKeys = new Set(keys.filter((key) => managed.formula.has(key)));
  const variationKeys = new Set(
    keys.filter((key) => managed.variation.has(key)),
  );
  const otherKeys = keys.filter(
    (key) => !formulaKeys.has(key) && !variationKeys.has(key),
  );

  // A non-app key present -> a human/integration touched this row. Never delete,
  // and never strip variation keys (their presence next to a human edit is
  // evidence the record is human-authored). Strip only formula keys, which the
  // app always owns.
  if (otherKeys.length > 0) {
    return stripKeysFromRow(
      client,
      row,
      parsedProperties,
      diff,
      keys,
      formulaKeys,
    );
  }

  // Every changed field is app-managed. With no variation keys this is the
  // Task 1 all-formula case: pure app noise -> delete (no parent read needed).
  if (variationKeys.size === 0) {
    return deleteRow(client, row);
  }

  // Variation keys, nothing human alongside. Deletable ONLY when the parent
  // record is itself a variation; the same field name on a PRIMARY can be
  // human-authored. An unresolvable parent (missing column, failed read,
  // vanished record) fails safe to keep.
  const parentColumn = parentRecordIdSelectionFor(objectName);
  const parentRecordIdValue = row[parentColumn];
  const parentRecordId =
    typeof parentRecordIdValue === 'string' && parentRecordIdValue.length > 0
      ? parentRecordIdValue
      : null;
  const parentIsVariation = parentRecordId
    ? await resolveParentIsVariation(
        client,
        objectName,
        managed.relationFieldName,
        parentRecordId,
        verdictCache,
      )
    : null;

  if (parentIsVariation === true) {
    return deleteRow(client, row);
  }

  // Primary or unresolvable: variation keys stay (not proven app noise); strip
  // only formula keys, which are always app noise (keeps the row when there are
  // none).
  return stripKeysFromRow(client, row, parsedProperties, diff, keys, formulaKeys);
};

// Soft-deletes (or strips) the app's own automated `<object>.updated` timeline
// noise. Human-authored rows are never even fetched (the query filters
// workspaceMemberId IS NULL). Returns per-outcome counts for logging.
export const cleanupFormulaTimelineNoise = async (
  client: FormulaClient,
): Promise<TimelineCleanupCounts> => {
  const counts: TimelineCleanupCounts = {
    scanned: 0,
    deleted: 0,
    stripped: 0,
    kept: 0,
    truncated: false,
  };

  const model = await buildManagedModel(client);
  // No app-owned fields anywhere -> nothing to clean; do NOT query the (large)
  // timelineActivities table.
  if (model.size === 0) {
    return counts;
  }

  const objectNames = [...model.keys()];
  const names = objectNames.map((object) => `${object}${UPDATED_SUFFIX}`);
  // Select every candidate parent-pointer column so each row exposes its own
  // record id (one boolean per queried object; only the row's own is populated).
  const parentColumns = objectNames.map((object) =>
    parentRecordIdSelectionFor(object),
  );
  const filter = {
    name: { in: names },
    // Human-authored rows carry a workspaceMemberId; app/API writes do not. Only
    // the app's own rows are ever fetched. NULL is a FilterIs enum, emitted
    // unquoted via graphqlEnum (the raw serializer quotes strings, which the
    // server rejects against the enum type) — same mechanism loadTrashedFormulas
    // uses for its deletedAt NOT_NULL filter.
    workspaceMemberId: { is: graphqlEnum('NULL') },
    happensAt: { gte: new Date(Date.now() - LOOKBACK_MS).toISOString() },
  };

  // Per-record variation verdict cache (keyed `object:recordId`), one lookup
  // per record for the whole run.
  const verdictCache = new Map<string, boolean>();

  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await withRetry(() =>
      client.query({
        timelineActivities: {
          __args: {
            first: PAGE_SIZE,
            filter,
            ...(after ? { after } : {}),
          },
          edges: {
            node: {
              id: true,
              name: true,
              properties: true,
              happensAt: true,
              ...Object.fromEntries(
                parentColumns.map((column) => [column, true]),
              ),
            },
          },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );

    const connection = response?.timelineActivities;
    const edges: Array<{ node?: TimelineRow }> = connection?.edges ?? [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node?.id) {
        continue;
      }
      counts.scanned += 1;
      const outcome = await processRow(client, node, model, verdictCache);
      if (outcome === 'deleted') {
        counts.deleted += 1;
      } else if (outcome === 'stripped') {
        counts.stripped += 1;
      } else {
        counts.kept += 1;
      }
    }

    if (!connection?.pageInfo?.hasNextPage) {
      return counts;
    }
    after = connection.pageInfo.endCursor ?? undefined;
  }

  // Exited via the MAX_PAGES cap with rows still remaining.
  counts.truncated = true;
  return counts;
};
