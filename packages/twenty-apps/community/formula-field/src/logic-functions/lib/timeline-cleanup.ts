import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import { type MetadataQueryClient } from 'src/logic-functions/lib/find-fields';
import { companionFieldName } from 'src/logic-functions/lib/fx-status-field';
import { workspaceCacheKey } from 'src/logic-functions/lib/metadata-objects';
import { MARKER_FIELD_NAME } from 'src/logic-functions/lib/override-marker';
import { computeSyncableFields } from 'src/logic-functions/lib/syncable-fields';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { loadAllEnabledVariationConfigs } from 'src/logic-functions/lib/variation-config-repository';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Post-hoc Timeline cleanup: the app's automated formula/mirror writes emit
// `recordUpdated` timelineActivity rows that flood record Timelines. The
// platform offers no suppression switch, so this module soft-deletes (or strips)
// the app's own noise rows via the workspace GraphQL API. It is deliberately
// fail-safe toward KEEPING rows — only rows positively identified as entirely
// app-managed are deleted (Global Constraints). A later task wires it to a cron.
//
// The platform dropped the row's `name` column ("<object>.updated") for a typed
// contract: `timelineActivityTypeId` (workspace-local) plus a
// `timelineActivityTypeSnapshot` JSON blob carrying the type's stable
// universalIdentifier, and the row -> object mapping now comes only from the
// single populated `target<Object>Id` column.
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
  // true when the maxPages cap was hit with more rows remaining — the next cron
  // run picks up the rest (already-deleted rows drop out of later queries). Never
  // silent: surfaced here so callers can log it.
  truncated: boolean;
};

// Only touch rows from the last 48h: older app noise is out of the Timeline's
// "recent" view anyway and a bounded window keeps each run cheap.
const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

// The standard `recordUpdated` timelineActivityType, identified by its
// universalIdentifier (twenty-server's
// standard-timeline-activity-type-definitions.constant.ts). That identifier is
// the same in every workspace, whereas the row's `timelineActivityTypeId` is
// workspace-local and must be resolved from metadata at runtime.
export const RECORD_UPDATED_TYPE_UNIVERSAL_IDENTIFIER =
  '20202020-0d1a-4f0e-8a55-1c0a2f0a2c02';

// The self-referencing relation field a config provisions defaults to
// "primaryRecord". Server code reads `config.relationFieldName ?? 'primaryRecord'`
// inline (variation-sync.ts) — there is no exported server-side accessor, and the
// front lib's relationFieldOf must never be imported into server code, so the
// fallback is replicated minimally here following that convention.
const DEFAULT_RELATION_FIELD = 'primaryRecord';
const relationFieldNameOf = (config: VariationConfigRecord): string =>
  config.relationFieldName ?? DEFAULT_RELATION_FIELD;

// The actor name core stamps on this app's writes (application-config.ts
// displayName). Kept as a local literal: application-config imports
// twenty-sdk/define, which server lib code must not pull in.
const APP_ACTOR_NAME = 'Formula Field';

// Definition-object bookkeeping keys — always app-written (isUIEditable: false
// or engine-owned). A row whose diff touches ONLY these is pure app noise.
// `order` is deliberately absent: the widget's drag-reorder writes it on the
// user's behalf, so it stays keep-side (fail-safe).
const DEFINITION_BOOKKEEPING_KEYS = new Set([
  'lastValue',
  'lastValueText',
  'lastEvaluatedAt',
  'lastError',
  'status',
  'statusReason',
  'dependencies',
]);
const VARIATION_CONFIG_BOOKKEEPING_KEYS = new Set([
  'lastSyncedAt',
  'lastError',
  'status',
  'statusReason',
]);

const capitalize = (value: string): string =>
  value.length === 0 ? '' : value.charAt(0).toUpperCase() + value.slice(1);

// The timelineActivity column that stores the parent record's id for an object.
// Core writes exactly one such column per row — the changed record's id — so
// the cleanup selects it to know which record a row belongs to.
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
  timelineActivityTypeSnapshot?: unknown;
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

// A RAW_JSON column on a timeline row (`properties`,
// `timelineActivityTypeSnapshot`) arrives as an object or a JSON string (both
// are seen in the wild); defensively coerce to an object, or null when
// unparsable.
const parseJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isPlainObject(value) ? value : null;
};

// The in-process half of the recordUpdated gate. The server filter matches the
// workspace-local `timelineActivityTypeId`; this re-checks the row's own
// snapshot against the stable universalIdentifier, so a routed object-specific
// type, a stale id, or a widened filter can never reach the classifier.
const isRecordUpdatedRow = (row: TimelineRow): boolean =>
  parseJsonObject(row.timelineActivityTypeSnapshot)?.universalIdentifier ===
  RECORD_UPDATED_TYPE_UNIVERSAL_IDENTIFIER;

// Object nameSingular for a row, read off its parent-pointer columns: core
// populates exactly one `target<Object>Id` per row. Zero (an object outside the
// managed set, or an unselected column) or more than one (an ambiguous mapping)
// yields null, which the caller treats as KEEP. A non-string value counts
// toward the tally but never resolves, so it too fails safe.
const objectFromParentColumns = (
  row: TimelineRow,
  objectNames: string[],
): string | null => {
  let populatedCount = 0;
  let resolved: string | null = null;
  for (const objectName of objectNames) {
    const value = row[parentRecordIdSelectionFor(objectName)];
    if (value == null) {
      continue;
    }
    populatedCount += 1;
    if (typeof value === 'string' && value.length > 0) {
      resolved = objectName;
    }
  }
  return populatedCount === 1 ? resolved : null;
};

// Loads every FormulaDefinition (regardless of `enabled` — a disabled formula's
// field is still app-owned, so its old rows must stay cleanable) and builds
// object nameSingular -> set of app-managed field names (each targetField plus
// its companion FxStatus field). Wizard drafts with an empty target are skipped.
const loadFormulaManagedByObject = async (
  client: FormulaClient,
): Promise<{
  managedByObject: Map<string, Set<string>>;
  hasAnyDefinition: boolean;
}> => {
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
    // Any object with at least one definition gets its own Overrides marker
    // field (spec §3); register it here so the same classifier treats it as
    // app-managed. Definition-less objects are out of scope (residue note).
    fields.add(MARKER_FIELD_NAME);
    managedByObject.set(targetObject, fields);
  }
  // A draft definition (empty targetObject/targetField, skipped above) still
  // receives engine status/dependency writes, so its presence alone is enough
  // to warrant registering the definition objects for cleanup.
  return { managedByObject, hasAnyDefinition: edges.length > 0 };
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
  const { managedByObject: formulaByObject, hasAnyDefinition } =
    await loadFormulaManagedByObject(client);
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

  // The definition records themselves churn recordUpdated rows from engine
  // bookkeeping (ADR 0022). Register them as app-owned key sets so the same
  // classifier covers them. Only when the app has any definitions/configs at
  // all — otherwise model stays empty and the cron never queries timeline.
  if (model.size > 0 || hasAnyDefinition) {
    model.set('formulaDefinition', {
      formula: DEFINITION_BOOKKEEPING_KEYS,
      variation: new Set<string>(),
      relationFieldName: DEFAULT_RELATION_FIELD,
    });
    model.set('variationConfig', {
      formula: VARIATION_CONFIG_BOOKKEEPING_KEYS,
      variation: new Set<string>(),
      relationFieldName: DEFAULT_RELATION_FIELD,
    });
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
  dryRun: boolean,
): Promise<RowOutcome> => {
  if (dryRun) {
    return 'deleted';
  }
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

// The verdict of a strip, decided before any write so a dry run and a wet run
// can never disagree: both go through this function and only the mutation
// below is skipped. Two of the three outcomes are not strips at all — nothing
// to strip keeps the row, and stripping every key resolves to a delete.
type StripPlan =
  | { verdict: 'kept' }
  | { verdict: 'deleted' }
  | { verdict: 'stripped'; properties: Record<string, unknown> };

const planStrip = (
  parsedProperties: Record<string, unknown> | null,
  diff: Record<string, unknown>,
  keys: string[],
  stripKeys: Set<string>,
): StripPlan => {
  if (stripKeys.size === 0) {
    return { verdict: 'kept' };
  }
  const newDiff: Record<string, unknown> = {};
  for (const key of keys) {
    if (!stripKeys.has(key)) {
      newDiff[key] = diff[key];
    }
  }
  // Stripping everything would leave an empty-diff stub row; that IS pure app
  // noise, so delete it instead (mirrors core, which never creates empty-diff
  // update rows).
  if (Object.keys(newDiff).length === 0) {
    return { verdict: 'deleted' };
  }
  // Every other `properties` subkey and the surviving keys' payloads are
  // preserved verbatim.
  return {
    verdict: 'stripped',
    properties: { ...(parsedProperties ?? {}), diff: newDiff },
  };
};

// Applies a strip plan. A failed write is contained (counted as kept).
const stripKeysFromRow = async (
  client: FormulaClient,
  row: TimelineRow,
  parsedProperties: Record<string, unknown> | null,
  diff: Record<string, unknown>,
  keys: string[],
  stripKeys: Set<string>,
  dryRun: boolean,
): Promise<RowOutcome> => {
  const plan = planStrip(parsedProperties, diff, keys, stripKeys);
  if (plan.verdict === 'kept') {
    return 'kept';
  }
  if (plan.verdict === 'deleted') {
    return deleteRow(client, row, dryRun);
  }
  if (dryRun) {
    return 'stripped';
  }
  // Only the mutation is contained here: planStrip already ran outside the try,
  // over plain-object reads that cannot throw, so a `kept` from this catch
  // always means a failed WRITE — never a misread row.
  try {
    await withRetry(() =>
      client.mutation({
        updateTimelineActivity: {
          __args: { id: row.id, data: { properties: plan.properties } },
          id: true,
        },
      }),
    );
    return 'stripped';
  } catch {
    return 'kept';
  }
};

// Same TTL and in-flight-dedup shape as the metadata objects cache: the
// recordUpdated type id never changes for the life of a workspace, so this
// holds the cleanup at one extra request per run (and none at all for a run
// inside the TTL). Keyed by workspace because one worker process serves many.
const RECORD_UPDATED_TYPE_ID_TTL_MS = 60_000;

type RecordUpdatedTypeIdCacheEntry = {
  id: string | null;
  loadedAt: number;
};
const recordUpdatedTypeIdByWorkspace = new Map<
  string,
  RecordUpdatedTypeIdCacheEntry
>();
const inFlightRecordUpdatedTypeIdByWorkspace = new Map<
  string,
  Promise<string | null>
>();

// Test-only: clears the memoized type id (process-global module state, like the
// metadata objects cache). Called from vitest.setup.ts for every spec.
export const __resetRecordUpdatedTypeIdCacheForTests = (): void => {
  recordUpdatedTypeIdByWorkspace.clear();
  inFlightRecordUpdatedTypeIdByWorkspace.clear();
};

const fetchRecordUpdatedTypeId = async (
  metadataClient: MetadataQueryClient,
  cacheKey: string,
): Promise<string | null> => {
  let types: Array<Record<string, unknown> | null>;
  try {
    const response = await metadataClient.query({
      timelineActivityTypes: {
        id: true,
        universalIdentifier: true,
        isActive: true,
      },
    });
    const returned: unknown = response?.timelineActivityTypes;
    types = Array.isArray(returned) ? returned : [];
  } catch (error) {
    // Never silent: an unresolvable type id turns every run into a no-op that
    // nothing else reports (the 2026-08 `name` break at least threw). Not
    // cached either, so the next run retries reality.
    console.warn(
      '[formula-field] timeline cleanup could not load timelineActivityTypes; keeping every row this run',
      error,
    );
    return null;
  }

  const match = types.find((type) => {
    const id = type?.id;
    return (
      type?.universalIdentifier === RECORD_UPDATED_TYPE_UNIVERSAL_IDENTIFIER &&
      // An absent isActive reads as active, the coercion metadata-objects.ts
      // applies to the same nullable metadata flag.
      type?.isActive !== false &&
      // An empty id would build a filter matching nothing while reading as
      // resolved, i.e. the silent-zero mode this port exists to kill.
      typeof id === 'string' &&
      id.length > 0
    );
  });
  const id = (match?.id as string | undefined) ?? null;
  // Only a successful load is cached (a throw returns above), same posture as
  // loadAllObjectsWithFields. A null here is a real workspace fact (no active
  // recordUpdated type), so it is cached too; the caller warns per run.
  recordUpdatedTypeIdByWorkspace.set(cacheKey, { id, loadedAt: Date.now() });
  return id;
};

// The workspace-local `timelineActivityTypeId` of the standard recordUpdated
// type, or null when it cannot be resolved (the caller then scans nothing). The
// metadata client is injectable so unit tests and front components can hand in
// their own, the same seam findFields uses.
export const resolveRecordUpdatedTypeId = async (
  metadataClient: MetadataQueryClient = new MetadataApiClient(),
): Promise<string | null> => {
  const cacheKey = workspaceCacheKey();
  const cached = recordUpdatedTypeIdByWorkspace.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < RECORD_UPDATED_TYPE_ID_TTL_MS) {
    return cached.id;
  }

  const inFlight = inFlightRecordUpdatedTypeIdByWorkspace.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = fetchRecordUpdatedTypeId(metadataClient, cacheKey);
  inFlightRecordUpdatedTypeIdByWorkspace.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightRecordUpdatedTypeIdByWorkspace.delete(cacheKey);
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
  dryRun: boolean,
): Promise<RowOutcome> => {
  const parsedProperties = parseJsonObject(row.properties);
  const rawDiff = parsedProperties ? parsedProperties.diff : undefined;
  const diff = isPlainObject(rawDiff) ? rawDiff : {};
  const keys = Object.keys(diff);
  if (keys.length === 0) {
    return 'kept';
  }

  // Belt and braces on the server's timelineActivityTypeId filter: only a row
  // whose own snapshot says recordUpdated is a candidate.
  if (!isRecordUpdatedRow(row)) {
    return 'kept';
  }

  const objectName = objectFromParentColumns(row, [...model.keys()]);
  const managed = objectName ? model.get(objectName) : undefined;
  if (!objectName || !managed) {
    return 'kept';
  }

  // Core re-stamps updatedBy unconditionally on every accepted update, so a
  // redundant no-op write by this app (recompute race) leaves a diff whose only
  // key is updatedBy -> app noise. Only OUR actor qualifies; any other actor
  // (Supabase, another app) stays keep-side.
  const updatedByEntry = isPlainObject(diff.updatedBy) ? diff.updatedBy : null;
  const updatedByAfter =
    updatedByEntry && isPlainObject(updatedByEntry.after)
      ? updatedByEntry.after
      : null;
  const appActorUpdatedBy =
    updatedByAfter?.source === 'APPLICATION' &&
    updatedByAfter?.name === APP_ACTOR_NAME;

  const formulaKeys = new Set(
    keys.filter(
      (key) =>
        managed.formula.has(key) || (key === 'updatedBy' && appActorUpdatedBy),
    ),
  );
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
      dryRun,
    );
  }

  // Every changed field is app-managed. With no variation keys this is the
  // Task 1 all-formula case: pure app noise -> delete (no parent read needed).
  if (variationKeys.size === 0) {
    return deleteRow(client, row, dryRun);
  }

  // Variation keys, nothing human alongside. Deletable ONLY when the parent
  // record is itself a variation; the same field name on a PRIMARY can be
  // human-authored. An unresolvable parent (missing column, failed read,
  // vanished record) fails safe to keep.
  // objectName was resolved FROM this column, so it holds a non-empty string
  // here; the narrowing stays as the type-level guard.
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
    return deleteRow(client, row, dryRun);
  }

  // Primary or unresolvable: variation keys stay (not proven app noise); strip
  // only formula keys, which are always app noise (keeps the row when there are
  // none).
  return stripKeysFromRow(
    client,
    row,
    parsedProperties,
    diff,
    keys,
    formulaKeys,
    dryRun,
  );
};

// Soft-deletes (or strips) the app's own automated `recordUpdated` timeline
// noise. Human-authored rows are never even fetched (the query filters
// workspaceMemberId IS NULL). Returns per-outcome counts for logging.
//
// `options` lets callers override the lookback window and page cap (spec F4)
// — the one-time retro-purge script needs an unbounded lookback and a higher
// page cap; the 10-minute cron omits options entirely, so its behavior is
// unchanged (defaults fall back to LOOKBACK_MS / MAX_PAGES). `metadataClient`
// is the test/front seam for the recordUpdated type-id lookup. `dryRun` runs
// the identical classification and reports the counts it WOULD have applied
// (`deleted`/`stripped`), issuing no mutation — the reads still happen.
export const cleanupFormulaTimelineNoise = async (
  client: FormulaClient,
  options: {
    lookbackMs?: number;
    maxPages?: number;
    metadataClient?: MetadataQueryClient;
    dryRun?: boolean;
  } = {},
): Promise<TimelineCleanupCounts> => {
  const lookbackMs = options.lookbackMs ?? LOOKBACK_MS;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const dryRun = options.dryRun ?? false;
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

  // Resolved AFTER the model check so a workspace with no definitions still
  // costs zero requests.
  const recordUpdatedTypeId = await resolveRecordUpdatedTypeId(
    options.metadataClient,
  );
  // No resolvable type id -> no safe candidate filter, so the (large)
  // timelineActivities table is not queried at all and every row is kept.
  // Warned here rather than in the resolver so a run served by the memo (which
  // caches a null verdict) is never the silent kind.
  if (recordUpdatedTypeId === null) {
    console.warn(
      '[formula-field] timeline cleanup could not resolve the recordUpdated timelineActivityType id; keeping every row this run',
    );
    return counts;
  }

  const objectNames = [...model.keys()];
  // Select every candidate parent-pointer column so each row exposes its own
  // record id (one boolean per queried object; only the row's own is populated).
  const parentColumns = objectNames.map((object) =>
    parentRecordIdSelectionFor(object),
  );
  const filter = {
    // Only recordUpdated rows are candidates. The id is workspace-local, hence
    // the metadata lookup; processRow re-checks each row's own snapshot.
    timelineActivityTypeId: { eq: recordUpdatedTypeId },
    // A row belongs to a managed object iff that object's parent-pointer column
    // is populated. `or` is a bracketed group ANDed with the sibling keys, so
    // this narrows candidates to the managed objects without widening anything.
    or: parentColumns.map((column) => ({
      [column]: { is: graphqlEnum('NOT_NULL') },
    })),
    // Human-authored rows carry a workspaceMemberId; app/API writes do not. Only
    // the app's own rows are ever fetched. NULL is a FilterIs enum, emitted
    // unquoted via graphqlEnum (the raw serializer quotes strings, which the
    // server rejects against the enum type) — same mechanism loadTrashedFormulas
    // uses for its deletedAt NOT_NULL filter.
    workspaceMemberId: { is: graphqlEnum('NULL') },
    happensAt: { gte: new Date(Date.now() - lookbackMs).toISOString() },
  };

  // Per-record variation verdict cache (keyed `object:recordId`), one lookup
  // per record for the whole run.
  const verdictCache = new Map<string, boolean>();

  let after: string | undefined;
  // Only a natural exit clears this; running out of pages leaves rows behind.
  let truncated = true;
  for (let page = 0; page < maxPages; page += 1) {
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
              timelineActivityTypeSnapshot: true,
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
      const outcome = await processRow(
        client,
        node,
        model,
        verdictCache,
        dryRun,
      );
      if (outcome === 'deleted') {
        counts.deleted += 1;
      } else if (outcome === 'stripped') {
        counts.stripped += 1;
      } else {
        counts.kept += 1;
      }
    }

    if (!connection?.pageInfo?.hasNextPage) {
      truncated = false;
      break;
    }
    after = connection.pageInfo.endCursor ?? undefined;
  }
  counts.truncated = truncated;

  // Never silent: model.size > 0 here (the early return above), so scanning
  // nothing means the candidate filter no longer matches reality. A throwing
  // query (the 2026-08 `name` break) surfaces on its own; a matching-nothing
  // filter would not, so this warn covers that mode.
  if (counts.scanned === 0) {
    console.warn(
      `[formula-field] timeline cleanup scanned 0 rows for ${model.size} managed objects`,
    );
  }
  return counts;
};
