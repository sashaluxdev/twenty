import { validateVariationConfig } from 'src/logic-functions/lib/variation-config-validation';
import {
  findVariationConfigById,
  loadAllEnabledVariationConfigs,
  updateVariationConfigBookkeeping,
} from 'src/logic-functions/lib/variation-config-repository';
import { sweepVariationConfig } from 'src/logic-functions/lib/variation-sync';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';

// Fields the app writes back as bookkeeping. An update touching only these is
// our own write — skip to avoid a validation/sweep loop (same guard as
// handle-formula-change.ts's BOOKKEEPING_FIELDS).
const BOOKKEEPING_FIELDS = new Set([
  'lastSyncedAt',
  'lastError',
  'status',
  'statusReason',
]);

const isPureBookkeepingUpdate = (
  updatedFields: string[] | undefined,
): boolean => {
  if (!updatedFields || updatedFields.length === 0) return false;
  return updatedFields.every((field) => BOOKKEEPING_FIELDS.has(field));
};

export type HandleVariationConfigChangeArgs = {
  client: FormulaClient;
  after: VariationConfigRecord | null | undefined;
  updatedFields: string[] | undefined;
};

// Runs after a VariationConfig is created or updated: validate, then either
// clear the error and converge immediately (one sweep of this config, so an
// enable/fix takes effect without waiting for the hour), or disable + record
// the error. Write-avoidant so the trigger does not re-fire itself.
export const handleVariationConfigChange = async ({
  client,
  after,
  updatedFields,
}: HandleVariationConfigChangeArgs): Promise<Record<string, unknown>> => {
  if (!after?.id) {
    return { handled: false };
  }
  if (isPureBookkeepingUpdate(updatedFields)) {
    return { handled: false, reason: 'bookkeeping-only' };
  }
  // Our own "disable on invalid" write sets { enabled: false, lastError }.
  // Skip it, or the now-excluded duplicate would seem to vanish and we would
  // wrongly re-validate clean (same second recursion guard as formulas).
  if (
    after.enabled === false &&
    updatedFields &&
    updatedFields.length > 0 &&
    updatedFields.every(
      (field) => BOOKKEEPING_FIELDS.has(field) || field === 'enabled',
    )
  ) {
    return { handled: false, reason: 'disabled-bookkeeping' };
  }
  // A disabled config is inert; only a human re-enable or a field edit flows on.
  if (after.enabled === false) {
    return { handled: false, reason: 'disabled' };
  }

  const existing = await loadAllEnabledVariationConfigs(client);
  const result = await validateVariationConfig(client, after, existing);

  if (!result.valid) {
    // Stale-event guard (mirrors variation-sync's echo-race discipline): the
    // `after` snapshot can be a superseded draft — a wizard draft is
    // enabled-by-default (variation-config.object.ts) yet invalid until its
    // relation field is wired — whose disable is only now landing, after a
    // newer valid enable already converged. Validating the PAYLOAD alone would
    // let that straggler silently revert the good save. Re-fetch and re-validate
    // the CURRENT stored record before disabling.
    const fresh = await findVariationConfigById(client, after.id);
    if (!fresh) {
      // Record vanished/trashed since the event -> nothing left to disable.
      return { handled: false, reason: 'superseded-missing' };
    }
    const freshResult = await validateVariationConfig(client, fresh, existing);
    if (freshResult.valid) {
      // Stale snapshot superseded by a valid write; the execution that made it
      // valid already ran its own sweep/bookkeeping. Do not disable.
      return { handled: false, reason: 'superseded' };
    }

    const needsWrite =
      fresh.enabled !== false || (fresh.lastError ?? '') !== freshResult.error;
    if (needsWrite) {
      // enabled: false rides the same bookkeeping write; the recursion guards
      // above keep this from looping.
      await updateVariationConfigBookkeeping(client, after.id, {
        lastError: freshResult.error,
      });
      await client.mutation({
        updateVariationConfig: {
          __args: { id: after.id, data: { enabled: false } },
          id: true,
        },
      });
    }
    return { handled: true, valid: false, error: freshResult.error };
  }

  const clearError = (after.lastError ?? '') !== '';
  if (clearError) {
    await updateVariationConfigBookkeeping(client, after.id, { lastError: '' });
  }

  // Converge now instead of waiting for the hourly sweep — an enable or fix
  // should take effect immediately (formula precedent: recomputeAllRecords on
  // valid save).
  const sweep = await sweepVariationConfig(client, after);
  return { handled: true, valid: true, ...sweep };
};
