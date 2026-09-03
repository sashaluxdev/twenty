import { flushBatchedWrites, type PendingWrite } from 'src/logic-functions/lib/batch-write';
import { loadEnabledFormulas } from 'src/logic-functions/lib/formula-repository';
import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import {
  computeMarkerValue,
  MARKER_FIELD_NAME,
} from 'src/logic-functions/lib/override-marker';
import {
  loadActiveOverridesForRecord,
  loadOverridesForObject,
  type OverrideRecord,
} from 'src/logic-functions/lib/override-repository';
import { pluralize } from 'src/logic-functions/lib/plural';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { textValuesConverged } from 'src/logic-functions/lib/value-io';
import { withRetry } from 'src/logic-functions/lib/with-retry';

export const markerFieldExistsOnObject = async (
  objectName: string,
): Promise<boolean> => {
  // Metadata unavailable -> "no field" -> the marker step degrades to a no-op
  // and the sweep retries. Throwing here would abort the whole record handler.
  try {
    const objects = await loadAllObjectsWithFields();
    const object = objects.find(
      (candidate) => candidate.nameSingular === objectName,
    );
    return (
      object?.fields.some(
        (field) => field.name === MARKER_FIELD_NAME && field.isActive,
      ) ?? false
    );
  } catch {
    return false;
  }
};

const activeFieldSetByRecord = (
  pinRows: OverrideRecord[],
): Map<string, Set<string>> => {
  const byRecord = new Map<string, Set<string>>();
  for (const row of pinRows) {
    if (!row.active) continue;
    const fields = byRecord.get(row.recordId) ?? new Set<string>();
    fields.add(row.targetField);
    byRecord.set(row.recordId, fields);
  }
  return byRecord;
};

// Chunked read of current marker values. Mirrors the record-scan query shape
// recomputeAllRecords uses (a plural connection filtered by id), reusing the
// same canonical pluralizer (plural.ts) recompute.ts and batch-write.ts import.
const loadCurrentMarkerValues = async (
  client: FormulaClient,
  objectName: string,
  recordIds: string[],
): Promise<Map<string, string | null>> => {
  const values = new Map<string, string | null>();
  const CHUNK = 100;
  const pluralName = pluralize(objectName);
  for (let start = 0; start < recordIds.length; start += CHUNK) {
    const chunk = recordIds.slice(start, start + CHUNK);
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: { first: CHUNK, filter: { id: { in: chunk } } },
          edges: { node: { id: true, [MARKER_FIELD_NAME]: true } },
        },
      }),
    );
    for (const edge of response?.[pluralName]?.edges ?? []) {
      if (edge?.node?.id) {
        values.set(
          edge.node.id,
          (edge.node[MARKER_FIELD_NAME] as string | null | undefined) ?? null,
        );
      }
    }
  }
  return values;
};

export const convergeMarkersForRecords = async ({
  client,
  objectName,
  recordIds,
  definitions,
  pinRows,
  currentValues,
}: {
  client: FormulaClient;
  objectName: string;
  recordIds: string[];
  definitions: FormulaDefinitionRecord[];
  pinRows: OverrideRecord[];
  currentValues?: Map<string, string | null>;
}): Promise<{ written: number }> => {
  const uniqueIds = [...new Set(recordIds)];
  if (uniqueIds.length === 0) return { written: 0 };

  const known = currentValues ?? new Map<string, string | null>();
  const missing = uniqueIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    const fetched = await loadCurrentMarkerValues(client, objectName, missing);
    for (const [id, value] of fetched) known.set(id, value);
  }

  const activeByRecord = activeFieldSetByRecord(pinRows);
  const writes: PendingWrite[] = [];
  for (const recordId of uniqueIds) {
    // A record absent from `known` after the fetch no longer exists — skip.
    if (!known.has(recordId)) continue;
    const expected = computeMarkerValue(
      objectName,
      definitions,
      activeByRecord.get(recordId) ?? new Set<string>(),
    );
    if (!textValuesConverged(expected, known.get(recordId) ?? null)) {
      writes.push({ recordId, data: { [MARKER_FIELD_NAME]: expected } });
    }
  }
  if (writes.length > 0) {
    await flushBatchedWrites(client, objectName, writes);
  }
  return { written: writes.length };
};

export const convergeMarkersForColumn = async (
  client: FormulaClient,
  targetObject: string,
  targetField: string,
): Promise<{ written: number; records: number }> => {
  if (!(await markerFieldExistsOnObject(targetObject))) {
    return { written: 0, records: 0 };
  }
  const objectPins = await loadOverridesForObject(client, targetObject);
  const columnRecordIds = objectPins
    .filter((row) => row.targetField === targetField)
    .map((row) => row.recordId);
  if (columnRecordIds.length === 0) return { written: 0, records: 0 };

  const definitions = await loadEnabledFormulas(client, targetObject);
  const { written } = await convergeMarkersForRecords({
    client,
    objectName: targetObject,
    recordIds: columnRecordIds,
    definitions,
    pinRows: objectPins,
    // Marker computation must see the record's WHOLE pin set, not just this
    // column's — hence objectPins, filtered only for the candidate ids.
  });
  return { written, records: new Set(columnRecordIds).size };
};

// Single-record convergence for the record-update event lane (spec §5.2). The
// caller gates this on real pin-state change or a touched marker field, so
// reaching here already means the marker plausibly moved. The comparison and
// the write are the batch helper's — this only supplies its inputs.
export const convergeMarkerAfterEvent = async ({
  client,
  objectName,
  recordId,
  definitions,
  after,
}: {
  client: FormulaClient;
  objectName: string;
  recordId: string;
  definitions: FormulaDefinitionRecord[];
  after: Record<string, unknown> | null | undefined;
}): Promise<void> => {
  // The field is created on definition creation (spec §5.1); a missing field
  // here means creation lags or the object only has locked definitions — skip
  // before spending any further query.
  if (!(await markerFieldExistsOnObject(objectName))) return;

  const pinRows = await loadActiveOverridesForRecord(
    client,
    objectName,
    recordId,
  );

  // A present payload key is the current value (null means blank); an absent
  // key is UNKNOWN, never assumed blank — assuming blank inverts the F3 loop in
  // the non-blank cell (spec §5.2). Leaving currentValues undefined makes the
  // helper fetch it, which also drops a record deleted between event and fetch.
  const currentValues =
    after !== null && after !== undefined && MARKER_FIELD_NAME in after
      ? new Map<string, string | null>([
          [
            recordId,
            (after[MARKER_FIELD_NAME] as string | null | undefined) ?? null,
          ],
        ])
      : undefined;

  await convergeMarkersForRecords({
    client,
    objectName,
    recordIds: [recordId],
    definitions,
    pinRows,
    currentValues,
  });
};
