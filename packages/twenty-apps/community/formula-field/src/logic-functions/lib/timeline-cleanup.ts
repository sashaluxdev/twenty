import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import { companionFieldName } from 'src/logic-functions/lib/fx-status-field';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Post-hoc Timeline cleanup: the app's automated formula/mirror writes emit
// `<object>.updated` timelineActivity rows that flood record Timelines. The
// platform offers no suppression switch, so this module soft-deletes (or strips)
// the app's own noise rows via the workspace GraphQL API. It is deliberately
// fail-safe toward KEEPING rows — only rows positively identified as entirely
// app-managed are deleted (Global Constraints). A later task wires it to a cron.

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

type RowOutcome = 'deleted' | 'stripped' | 'kept';

type TimelineRow = {
  id: string;
  name?: unknown;
  properties?: unknown;
  happensAt?: unknown;
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
const loadManagedFieldsByObject = async (
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

// Classifies a single timeline row and applies the cleanup. Fail-safe: a row
// whose diff is missing/empty/unparsable, or belongs to an object with no
// managed fields, or whose changed fields are all human, is KEPT untouched. A
// per-row mutation failure is contained (counted as kept) so one bad row cannot
// abort the sweep — same posture as recomputeAllRecords.
const processRow = async (
  client: FormulaClient,
  row: TimelineRow,
  managedByObject: Map<string, Set<string>>,
): Promise<RowOutcome> => {
  const parsedProperties = parseProperties(row.properties);
  const rawDiff = parsedProperties ? parsedProperties.diff : undefined;
  const diff = isPlainObject(rawDiff) ? rawDiff : {};
  const keys = Object.keys(diff);
  if (keys.length === 0) {
    return 'kept';
  }

  const objectName = objectFromName(row.name);
  const managed = objectName ? managedByObject.get(objectName) : undefined;
  if (!managed) {
    return 'kept';
  }

  const managedKeys = keys.filter((key) => managed.has(key));
  if (managedKeys.length === 0) {
    return 'kept';
  }

  try {
    // Every changed field is app-managed -> the whole row is app noise. Soft
    // delete only (the role cannot destroy records).
    if (managedKeys.length === keys.length) {
      await withRetry(() =>
        client.mutation({
          deleteTimelineActivity: { __args: { id: row.id }, id: true },
        }),
      );
      return 'deleted';
    }

    // Mixed row: strip the managed keys from the diff and keep the human ones,
    // preserving every other `properties` subkey and the human keys' payloads.
    const newDiff: Record<string, unknown> = {};
    for (const key of keys) {
      if (!managed.has(key)) {
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
    // Fail-safe containment: a failed delete/strip must not abort the run.
    return 'kept';
  }
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

  const managedByObject = await loadManagedFieldsByObject(client);
  // No app-owned fields anywhere -> nothing to clean; do NOT query the (large)
  // timelineActivities table.
  if (managedByObject.size === 0) {
    return counts;
  }

  const names = [...managedByObject.keys()].map(
    (object) => `${object}${UPDATED_SUFFIX}`,
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
      const outcome = await processRow(client, node, managedByObject);
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
