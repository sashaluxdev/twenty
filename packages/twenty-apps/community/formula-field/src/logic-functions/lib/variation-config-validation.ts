import {
  invalidateMetadataCache,
  loadAllObjectsWithFields,
  type MetadataObjectInfo,
} from 'src/logic-functions/lib/metadata-objects';
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
//   - the relation field exists, is active, and is a RELATION field (R3 —
//     previously skipped, which let a config with a dead relation field read
//     as healthy while every sync path threw raw GraphQL)
//   - the object has at least one syncable field
// The wizard-draft flow stays safe with the relation-field check: a draft has
// an empty relationFieldName (rejected earlier, exactly as before), and the
// finalize event fires AFTER the wizard created the field — the check below
// forces a fresh metadata pull before declaring the field missing, so the
// ≤60s cache cannot fail a just-finalized config.

export type ConfigValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export type RelationFieldHealth = { ok: true } | { ok: false; error: string };

// Shared by save-time validation and the sweep's health signal: is the
// config's relation field live? Trust the cached metadata when it says yes;
// before declaring the field dead, invalidate and re-pull once (bounded) so a
// stale cache can neither fail a field created seconds ago (wizard finalize)
// nor pass a field deleted seconds ago.
export const checkRelationFieldHealth = async (
  targetObject: string,
  relationFieldName: string,
): Promise<RelationFieldHealth> => {
  const fieldIsLive = (objects: MetadataObjectInfo[]): boolean => {
    const object = objects.find(
      (candidate) => candidate.nameSingular === targetObject,
    );
    const field = object?.fields.find(
      (candidate) => candidate.name === relationFieldName,
    );
    return field !== undefined && field.isActive && field.type === 'RELATION';
  };

  if (fieldIsLive(await loadAllObjectsWithFields())) {
    return { ok: true };
  }
  invalidateMetadataCache();
  if (fieldIsLive(await loadAllObjectsWithFields())) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Relation field "${relationFieldName}" is missing, inactive, or not a relation field on "${targetObject}"`,
  };
};

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
  const relationFieldHealth = await checkRelationFieldHealth(
    targetObject,
    relationFieldName,
  );
  if (!relationFieldHealth.ok) {
    return { valid: false, error: relationFieldHealth.error };
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
