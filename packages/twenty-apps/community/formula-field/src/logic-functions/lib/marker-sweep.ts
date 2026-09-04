import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { graphqlEnum } from 'src/logic-functions/lib/dynamic-client';
import { ensureMarkerFieldExists } from 'src/logic-functions/lib/ensure-marker-field';
import { findFields } from 'src/logic-functions/lib/find-fields';
import { loadTrashedFormulas } from 'src/logic-functions/lib/formula-repository';
import { convergeMarkersForRecords } from 'src/logic-functions/lib/marker-converge';
import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import { MARKER_FIELD_NAME } from 'src/logic-functions/lib/override-marker';
import {
  loadOverridesForObject,
  type OverrideRecord,
} from 'src/logic-functions/lib/override-repository';
import { pluralize } from 'src/logic-functions/lib/plural';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// Method-shorthand syntax (not arrow-typed properties) so TS checks params
// bivariantly — MetadataApiClient's genql-generated query/mutation are generic
// over the selection shape and don't structurally match a plain property type.
// Same shape as ensure-marker-field.ts's local client type.
type MarkerSweepMetadataClient = {
  query(selection: unknown): Promise<unknown>;
  mutation(selection: unknown): Promise<unknown>;
};

export type MarkerSweepResult = {
  objects: number;
  written: number;
  ensured: number;
  fieldsDeleted: number;
  truncated: boolean;
};

const DIRTY_MARKER_PAGE_SIZE = 200;

// Every record on the object whose marker is non-blank, with its value. ADR 0030:
// blank TEXT stores as SQL NULL, so NOT_NULL is exactly "has a marker to repair".
// A COMPLETE scan is what lets the caller treat "absent from this map" as "marker
// is blank" without spending a read — so a scan cut short by the deadline says so,
// and the caller drops that inference for the object.
const loadDirtyMarkerValues = async (
  client: FormulaClient,
  objectName: string,
  deadlineAt: number,
  now: () => number,
): Promise<{ values: Map<string, string | null>; truncated: boolean }> => {
  const values = new Map<string, string | null>();
  const pluralName = pluralize(objectName);
  let after: string | undefined;

  for (;;) {
    const response = await withRetry(() =>
      client.query({
        [pluralName]: {
          __args: {
            first: DIRTY_MARKER_PAGE_SIZE,
            // NOT_NULL is a FilterIs enum value: quoting it ships green against
            // the fake and is rejected live by the server (dynamic-client.ts).
            filter: { [MARKER_FIELD_NAME]: { is: graphqlEnum('NOT_NULL') } },
            ...(after ? { after } : {}),
          },
          edges: { node: { id: true, [MARKER_FIELD_NAME]: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      }),
    );
    const connection = response?.[pluralName];
    for (const edge of connection?.edges ?? []) {
      if (edge?.node?.id) {
        values.set(
          edge.node.id,
          (edge.node[MARKER_FIELD_NAME] as string | null | undefined) ?? null,
        );
      }
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    // A large enough dirty set would otherwise run thousands of sequential pages
    // and blow the whole function's timeout, taking recompute down with it. The
    // check costs nothing on the single-page common case.
    if (now() > deadlineAt) return { values, truncated: true };
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return { values, truncated: false };
};

// Existence probe, not an enumeration: the cleanup arm only needs to know
// whether ANY live definition (enabled or not) still targets the object, so
// `first: 1` answers it without the precedent's page-sized fetch and can never
// truncate the decision the way an unpaginated enumeration would.
const hasLiveDefinition = async (
  client: FormulaClient,
  objectName: string,
): Promise<boolean> => {
  const response = await withRetry(() =>
    client.query({
      formulaDefinitions: {
        __args: { first: 1, filter: { targetObject: { eq: objectName } } },
        edges: { node: { id: true } },
        pageInfo: { hasNextPage: true, endCursor: true },
      },
    }),
  );
  return (response?.formulaDefinitions?.edges ?? []).length > 0;
};

// Deactivate-then-delete, mirroring fx-status-cleanup's ordering: deactivation
// drops the field's viewField rows so the column leaves every view cleanly.
const deleteMarkerField = async (
  objectName: string,
  metadataClient: MarkerSweepMetadataClient,
): Promise<boolean> => {
  const { fields } = await findFields(
    objectName,
    [MARKER_FIELD_NAME],
    metadataClient,
  );
  const field = fields.get(MARKER_FIELD_NAME);
  if (!field) return false;

  if (field.isActive) {
    try {
      await metadataClient.mutation({
        updateOneField: {
          __args: { input: { id: field.id, update: { isActive: false } } },
          id: true,
        },
      });
    } catch {
      // Deleting a still-active field would strand its view rows; leave the
      // whole removal for the next sweep instead.
      return false;
    }
  }

  try {
    await metadataClient.mutation({
      deleteOneField: { __args: { input: { id: field.id } }, id: true },
    });
    return true;
  } catch {
    // Deactivated but not deleted is already out of every view; retried hourly.
    return false;
  }
};

// The hourly convergence backstop for the Overrides marker (spec §5.5). Heals
// whatever the event, widget and lifecycle lanes missed, and is the second site
// (after definition creation) where the marker field gets created. Grouped per
// object, best-effort, budget-sliced.
//
// Deliberately cursorless, but NOT order-fixed: what converges is the write set,
// not the time cost — a fully converged object still pays its two queries every
// hour — so a fixed iteration order would truncate at the same object every pass
// and starve every object after it forever. Instead the start offset rotates by
// an epoch-hour counter over a stably sorted object list (stateless: no cursor to
// store, corrupt, or reset), so each object reaches the head of the list within N
// passes for any N.
export const convergeAllMarkers = async (
  client: FormulaClient,
  formulas: FormulaDefinitionRecord[],
  {
    deadlineAt,
    ensure = ensureMarkerFieldExists,
    metadataClient,
    now = Date.now,
  }: {
    deadlineAt: number;
    ensure?: typeof ensureMarkerFieldExists;
    metadataClient?: MarkerSweepMetadataClient;
    // Injectable clock: the rotation offset and every budget check read it, so a
    // test can pin the epoch hour and step time deterministically.
    now?: () => number;
  },
): Promise<MarkerSweepResult> => {
  const result: MarkerSweepResult = {
    objects: 0,
    written: 0,
    ensured: 0,
    fieldsDeleted: 0,
    truncated: false,
  };

  const catalog = await loadAllObjectsWithFields();
  const markerBearing = new Set(
    catalog
      .filter((object) =>
        object.fields.some(
          (field) => field.name === MARKER_FIELD_NAME && field.isActive,
        ),
      )
      .map((object) => object.nameSingular),
  );

  const definitionsByObject = new Map<string, FormulaDefinitionRecord[]>();
  for (const definition of formulas) {
    const objectName = definition.targetObject;
    if (!objectName) continue;
    const forObject = definitionsByObject.get(objectName) ?? [];
    forObject.push(definition);
    definitionsByObject.set(objectName, forObject);
  }

  // Sorted so the rotation below is applied to a stable sequence rather than to
  // whatever order the metadata catalog happened to return.
  const objectNames = [
    ...new Set([...markerBearing, ...definitionsByObject.keys()]),
  ].sort();
  // Counts hours since the epoch, not the hour of day: a 0..23 offset can only
  // ever reach the first 23 + (objects covered before the deadline) indices, so
  // any workspace with more objects than that starves its tail forever.
  const offset =
    objectNames.length === 0
      ? 0
      : Math.floor(now() / 3_600_000) % objectNames.length;

  for (const objectName of [
    ...objectNames.slice(offset),
    ...objectNames.slice(0, offset),
  ]) {
    if (now() > deadlineAt) {
      result.truncated = true;
      break;
    }
    result.objects += 1;

    try {
      // Legacy null allowOverride reads as allowed, matching the widget; the
      // enabled gate keeps a mixed definition set from ensuring a field for an
      // object whose only override-allowed definitions are switched off (R5).
      const overridable = (definitionsByObject.get(objectName) ?? []).filter(
        (definition) =>
          definition.enabled === true && definition.allowOverride !== false,
      );

      if (!markerBearing.has(objectName)) {
        // Ruling R5: the sweep is the field's second creation site — it covers
        // failed creates and definitions that predate this release. An object
        // whose definitions are all locked never gets the field.
        if (overridable.length > 0) {
          await ensure(objectName);
          result.ensured += 1;
        }
        // The 60s catalog cannot see a field created moments ago, so any
        // convergence here would query a column it believes absent. Next hour.
        continue;
      }

      const eligibleColumns = new Set(
        overridable
          .map((definition) => definition.targetField ?? '')
          .filter((targetField) => targetField !== ''),
      );

      // Pin arm — only an object with override-allowed enabled definitions can
      // have a non-blank expected marker, so an object without one skips the
      // pin query entirely and converges every candidate to blank.
      let pinRows: OverrideRecord[] = [];
      if (eligibleColumns.size > 0) {
        pinRows = await loadOverridesForObject(client, objectName);
      }

      // Dirty-marker arm — never gated on definitions: a record whose marker
      // outlived its cause (destroyed definition, disabled object, tamper) is
      // reachable only here.
      const { values: currentValues, truncated: scanTruncated } =
        await loadDirtyMarkerValues(client, objectName, deadlineAt, now);
      const candidateIds = new Set<string>(currentValues.keys());

      const activePinnedRecordIds = new Set<string>();
      for (const row of pinRows) {
        if (!eligibleColumns.has(row.targetField)) continue;
        if (row.active) activePinnedRecordIds.add(row.recordId);
        // A deadline-truncated scan leaves every unseen record's marker unknown,
        // so pin candidates are deferred to a later pass rather than each paying
        // a batched read past the budget to learn its current value.
        if (scanTruncated) continue;
        // Deactivated rows count as candidates: they mark records that lost
        // their last active pin and may still carry a stale marker.
        candidateIds.add(row.recordId);
      }

      for (const recordId of candidateIds) {
        if (currentValues.has(recordId)) continue;
        if (activePinnedRecordIds.has(recordId)) continue;
        // Only pin candidates reach here, and only from a COMPLETE scan: absent
        // from it means the marker is blank, and with no active pin the expected
        // marker is blank too — already converged, so priming it saves the read.
        currentValues.set(recordId, null);
      }

      if (candidateIds.size > 0) {
        const { written } = await convergeMarkersForRecords({
          client,
          objectName,
          recordIds: [...candidateIds],
          definitions: formulas,
          pinRows,
          currentValues,
        });
        result.written += written;
      }

      if (scanTruncated) {
        // The pages already paid for are converged rather than thrown away, so
        // an object too big for one budget slice still shrinks its dirty set
        // every pass instead of never converging. The pass ends here: the
        // budget is spent, and the rotation moves the start point next hour.
        result.truncated = true;
        break;
      }

      // Cleanup arm — an object with zero definitions in ANY state (enabled,
      // disabled or trashed) keeps no marker field.
      if ((definitionsByObject.get(objectName) ?? []).length > 0) continue;
      if (await hasLiveDefinition(client, objectName)) continue;
      if ((await loadTrashedFormulas(client, objectName)).length > 0) continue;
      const metadata = metadataClient ?? new MetadataApiClient();
      if (await deleteMarkerField(objectName, metadata)) {
        result.fieldsDeleted += 1;
      }
    } catch {
      // One object's failure (a dead column, a rejected read) must not starve
      // every object after it in the iteration order — same containment posture
      // as fx-status-cleanup's per-field try/catch. Retried next hour.
    }
  }

  return result;
};
