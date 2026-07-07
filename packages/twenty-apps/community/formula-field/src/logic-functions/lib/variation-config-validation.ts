import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import { computeSyncableFields } from 'src/logic-functions/lib/syncable-fields';
import { isSafeGraphqlIdentifier } from 'src/logic-functions/lib/identifier';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { type VariationConfigRecord } from 'src/logic-functions/lib/variation-types';

// Save-time validation for a VariationConfig, mirroring validateFormula's
// posture: reject with a clear error and let the caller disable the config,
// rather than letting a malformed config reach the sync engine's dynamically
// built GraphQL. Checks (design doc "Validation & edge cases"):
//   - targetObject present, a safe identifier, and actually exists in metadata
//   - name equals targetObject (the deterministic one-config-per-object key)
//   - relationFieldName present and a safe identifier
//   - no OTHER config (different id) already covers this object
//   - the object has at least one syncable field
// Deliberately NOT checked here: whether the relation field exists yet — a
// fresh wizard draft is validated before field creation; the wizard's own
// create path guarantees the field, and a broken API-created config surfaces
// through the sweep's lastError instead.

export type ConfigValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export const validateVariationConfig = async (
  client: FormulaClient,
  candidate: VariationConfigRecord,
  otherConfigs: VariationConfigRecord[],
): Promise<ConfigValidationResult> => {
  const targetObject = candidate.targetObject ?? '';
  const relationFieldName = candidate.relationFieldName ?? '';

  if (!targetObject) {
    return { valid: false, error: 'targetObject is required' };
  }
  if (!isSafeGraphqlIdentifier(targetObject)) {
    return {
      valid: false,
      error: `Invalid target object name "${targetObject}"`,
    };
  }
  if ((candidate.name ?? '') !== targetObject) {
    return {
      valid: false,
      error: `name must equal targetObject ("${targetObject}") — it is the one-config-per-object key`,
    };
  }
  if (!relationFieldName) {
    return { valid: false, error: 'relationFieldName is required' };
  }
  if (!isSafeGraphqlIdentifier(relationFieldName)) {
    return {
      valid: false,
      error: `Invalid relation field name "${relationFieldName}"`,
    };
  }
  const duplicate = otherConfigs.find(
    (config) =>
      config.id !== candidate.id && config.targetObject === targetObject,
  );
  if (duplicate) {
    return {
      valid: false,
      error: `A variation config for "${targetObject}" already exists`,
    };
  }
  const objects = await loadAllObjectsWithFields();
  if (!objects.some((object) => object.nameSingular === targetObject)) {
    return {
      valid: false,
      error: `Object "${targetObject}" does not exist`,
    };
  }
  const syncable = await computeSyncableFields(
    client,
    targetObject,
    relationFieldName,
  );
  if (syncable.length === 0) {
    return {
      valid: false,
      error: `Object "${targetObject}" has no syncable fields`,
    };
  }
  return { valid: true };
};
