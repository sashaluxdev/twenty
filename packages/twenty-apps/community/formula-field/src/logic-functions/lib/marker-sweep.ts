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
// The scan is complete (paginated to exhaustion), which is what lets the caller
// treat "absent from this map" as "marker is blank" without spending a read.
const loadDirtyMarkerValues = async (
  client: FormulaClient,
  objectName: string,
): Promise<Map<string, string | null>> => {
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
    after = connection.pageInfo.endCursor ?? undefined;
  }

  return values;
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
// object, best-effort, budget-sliced: no cursor is needed because the candidate
// set shrinks to zero as markers converge, so a truncated pass finishes over
// successive sweeps.
export const convergeAllMarkers = async (
  client: FormulaClient,
  formulas: FormulaDefinitionRecord[],
  {
    deadlineAt,
    ensure = ensureMarkerFieldExists,
    metadataClient,
  }: {
    deadlineAt: number;
    ensure?: typeof ensureMarkerFieldExists;
    metadataClient?: MarkerSweepMetadataClient;
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

  for (const objectName of new Set([
    ...markerBearing,
    ...definitionsByObject.keys(),
  ])) {
    if (Date.now() > deadlineAt) {
      result.truncated = true;
      break;
    }
    result.objects += 1;

    try {
      // Legacy null allowOverride reads as allowed, matching the widget.
      const overridable = (definitionsByObject.get(objectName) ?? []).filter(
        (definition) => definition.allowOverride !== false,
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
      const currentValues = await loadDirtyMarkerValues(client, objectName);
      const candidateIds = new Set<string>(currentValues.keys());

      const activePinnedRecordIds = new Set<string>();
      for (const row of pinRows) {
        if (!eligibleColumns.has(row.targetField)) continue;
        // Deactivated rows count as candidates: they mark records that lost
        // their last active pin and may still carry a stale marker.
        candidateIds.add(row.recordId);
        if (row.active) activePinnedRecordIds.add(row.recordId);
      }

      for (const recordId of candidateIds) {
        if (currentValues.has(recordId)) continue;
        if (activePinnedRecordIds.has(recordId)) continue;
        // Absent from a complete NOT_NULL scan means the marker is blank, and
        // with no active pin the expected marker is blank too — already
        // converged, so priming it here saves the batched read.
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
