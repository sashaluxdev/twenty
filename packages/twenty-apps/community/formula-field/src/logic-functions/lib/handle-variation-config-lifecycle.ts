import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import {
  findFields,
  type MetadataQueryClient,
} from 'src/logic-functions/lib/handle-definition-lifecycle';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { sweepVariationConfig } from 'src/logic-functions/lib/variation-sync';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';

// VariationConfig destroy/restore lifecycle (record-variations Plan 2, Task 3):
// the variation-shaped analogue of handle-definition-lifecycle.ts, with three
// deliberate differences from the formula precedent:
//
//   1. NO override-row deletion on destroy. handleDefinitionDestroyed deletes
//      FormulaOverride rows scoped by (targetObject, targetField) because a
//      destroyed FormulaDefinition owns that exact column forever. A
//      VariationConfig has no such single-column scope — its overrides span
//      every syncable field of targetObject, the same (object, field, record)
//      key space a FUTURE FormulaDefinition on this object could still need.
//      There is no safe surgical filter here, so override rows are simply left
//      in place; an orphaned override just never gets read again once sync
//      stops (see the no-`.deleted`-trigger note below).
//   2. Only ONE field to deactivate: the MANY_TO_ONE relation field
//      (relationFieldName). Twenty's server cascades isActive to the
//      ONE_TO_MANY inverse field automatically, so the inverse is never looked
//      up or mutated here (doing so would be redundant and could race the
//      cascade).
//   3. Restore additionally runs ONE immediate sweepVariationConfig to
//      converge values that drifted stale while the config sat in the trash —
//      the formula precedent recomputes a single record; the variation
//      analogue re-syncs every variation of the object.
//
// There is no variationConfig.deleted (soft-delete/trash) trigger: every
// repository read (findVariationConfigByTargetObject,
// loadAllEnabledVariationConfigs) already excludes soft-deleted rows by
// default, so a trashed config simply stops being picked up by any sync path
// — no handler is needed to make that true.

// A superset of the read-only MetadataQueryClient findFields accepts — mirrors
// front-components/lib/delete-definition-completely.ts's MetadataMutationClient.
export type MetadataMutationClient = MetadataQueryClient & {
  mutation: (selection: any) => Promise<any>;
};

// Private local copy of the precedent's setFieldActive (short enough not to
// share), but unlike the precedent, accepts an injected client so it is
// testable the same way findFields is.
const setFieldActive = async (
  metadataClient: MetadataMutationClient,
  fieldId: string,
  isActive: boolean,
): Promise<void> => {
  await metadataClient.mutation({
    updateOneField: {
      __args: { input: { id: fieldId, update: { isActive } } },
      id: true,
    },
  });
};

export const handleVariationConfigDestroyed = async (
  _client: FormulaClient,
  before: VariationConfigRecord,
  metadataClient: MetadataMutationClient = new MetadataApiClient(),
): Promise<Record<string, unknown>> => {
  // Only touch a field this config actually provisioned — a config that never
  // created its own relation field (pointed at a pre-existing one) must never
  // have that field deactivated on destroy.
  if (
    before.createdRelationField !== true ||
    !before.targetObject ||
    !before.relationFieldName
  ) {
    return { deactivated: [] };
  }

  const { fields } = await findFields(
    before.targetObject,
    [before.relationFieldName],
    metadataClient,
  );
  const field = fields.get(before.relationFieldName);
  const deactivated: string[] = [];
  if (field && field.isActive) {
    await setFieldActive(metadataClient, field.id, false);
    deactivated.push(field.name);
  }
  return { deactivated };
};

export const handleVariationConfigRestored = async (
  client: FormulaClient,
  after: VariationConfigRecord,
  metadataClient: MetadataMutationClient = new MetadataApiClient(),
): Promise<Record<string, unknown>> => {
  const reactivated: string[] = [];
  if (
    after.createdRelationField === true &&
    after.targetObject &&
    after.relationFieldName
  ) {
    const { fields } = await findFields(
      after.targetObject,
      [after.relationFieldName],
      metadataClient,
    );
    const field = fields.get(after.relationFieldName);
    // Restore-after-destroy heal: reactivate only if it was left deactivated.
    // Restore-after-trash (the field was never touched) finds it already
    // active and this is a no-op.
    if (field && !field.isActive) {
      await setFieldActive(metadataClient, field.id, true);
      reactivated.push(field.name);
    }
  }

  if (after.enabled === false) {
    return { reactivated };
  }

  // Values are stale from the time in the trash — one immediate sweep
  // converges every variation of the object, same posture as the formula
  // precedent's post-restore recompute.
  const sweep = await sweepVariationConfig(client, after);
  return { reactivated, ...sweep };
};
