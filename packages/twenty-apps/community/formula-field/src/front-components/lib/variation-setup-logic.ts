import { isSafeGraphqlIdentifier } from 'src/logic-functions/lib/identifier';
import {
  ENGINE_FAMILY_KINDS,
  MIRRORABLE_KINDS,
} from 'src/logic-functions/lib/mirror-kinds';

// Wizard's pure validation/eligibility core (design 2026-07-07, Plan 2 Task 5).
// No metadata calls here — the UI layer loads objects/fields and hands them in,
// so every function below is synchronous and trivially testable.

// The wizard's picked object, as loaded from the metadata API by the UI layer.
export type VariationTargetObject = {
  id: string;
  nameSingular: string;
  labelSingular: string;
  isActive: boolean;
  isSystem: boolean;
  labelIdentifierFieldMetadataId: string | null;
  // Optional (mirrors MetadataFieldInfo.isUnique in metadata-objects.ts): keeps
  // this consistent with the server type and avoids forcing every fixture in
  // variation-setup-logic.spec.ts to set it.
  fields: {
    id: string;
    name: string;
    type: string;
    isActive: boolean;
    isSystem: boolean;
    isUnique?: boolean;
  }[];
};

export type RelationFieldNameCheck =
  | { ok: true; resume: false }
  | { ok: true; resume: true; existingFieldId: string }
  | { ok: false; error: string };

// The inverse collection field's fixed label and its server-derived API name.
// computeMetadataNameFromLabel('Variations') === 'variations' (simple ASCII
// word: slugify -> camelCase is identity-lowercased) — hardcoded rather than
// imported so the front bundle does not pull twenty-shared/metadata; the spec
// asserts the pair stays consistent with that rule.
export const INVERSE_FIELD_LABEL = 'Variations';
export const INVERSE_FIELD_NAME = 'variations';

// The app's own objects can't host a variation config — mirrors
// formula-setup-wizard.tsx's EXCLUDED_OBJECTS idea plus our own object.
const EXCLUDED_OBJECTS = new Set([
  'formulaDefinition',
  'formulaOverride',
  'variationConfig',
]);

const SYNCABLE_KINDS: ReadonlySet<string> = new Set([
  ...MIRRORABLE_KINDS,
  ...ENGINE_FAMILY_KINDS,
]);

const findActiveFieldByName = (
  targetObject: VariationTargetObject,
  name: string,
) =>
  targetObject.fields.find((field) => field.isActive && field.name === name);

export const checkRelationFieldName = (
  name: string,
  targetObject: VariationTargetObject,
): RelationFieldNameCheck => {
  if (!name) {
    return { ok: false, error: 'Field name is required' };
  }

  if (!isSafeGraphqlIdentifier(name)) {
    return {
      ok: false,
      error:
        'Field name must be a valid identifier (letters, digits, underscore; cannot start with a digit)',
    };
  }

  if (name === INVERSE_FIELD_NAME) {
    return {
      ok: false,
      error: `Field name cannot be "${INVERSE_FIELD_NAME}" — it would collide with its own inverse relation field`,
    };
  }

  // Two independent collision checks: the requested name, and the fixed
  // inverse field name. Either one erroring on a non-RELATION field makes the
  // whole check fail; a RELATION match on either is a resume candidate, not
  // an error.
  const requestedMatch = findActiveFieldByName(targetObject, name);
  if (requestedMatch && requestedMatch.type !== 'RELATION') {
    return {
      ok: false,
      error: `Field "${name}" already exists on ${targetObject.labelSingular}`,
    };
  }

  const inverseMatch = findActiveFieldByName(targetObject, INVERSE_FIELD_NAME);
  if (inverseMatch && inverseMatch.type !== 'RELATION') {
    return {
      ok: false,
      error: `Field "${INVERSE_FIELD_NAME}" already exists on ${targetObject.labelSingular} and is not a relation — the inverse side of the variation link would collide`,
    };
  }

  if (requestedMatch && requestedMatch.type === 'RELATION') {
    return { ok: true, resume: true, existingFieldId: requestedMatch.id };
  }

  return { ok: true, resume: false };
};

// Replicates computeSyncableFields' exclusion chain (syncable-fields.ts)
// against an in-hand field list. Deliberately OMITS the formula-target
// exclusion: that needs a formulas query the front component can't make from
// here; the server-side validator (Task 2) is authoritative there — this
// count is only a UX gate to grey out objects with nothing to sync.
export const countSyncableFields = (
  object: VariationTargetObject,
  relationFieldName: string,
): number =>
  object.fields
    .filter((field) => field.isActive)
    .filter((field) => !field.isSystem)
    .filter((field) => field.id !== object.labelIdentifierFieldMetadataId)
    .filter((field) => field.name !== relationFieldName)
    .filter((field) => field.name !== INVERSE_FIELD_NAME)
    .filter((field) => SYNCABLE_KINDS.has(field.type))
    // A unique value can never be legitimately mirrored onto a second record
    // (it would collide with the primary's own value), and the server's
    // atomic batch write means one unique field would reject the whole
    // variation sync — so it can't count toward "syncable" here either.
    .filter((field) => !field.isUnique)
    .length;

// Self-contained eligibility filter: drops non-active and system objects
// itself (countSyncableFields alone does NOT screen out a system object that
// happens to carry active non-system TEXT/NUMBER fields), plus app-owned and
// already-configured objects, keeping only those with at least one syncable
// field, then sorts by label.
export const eligibleTargetObjects = (
  objects: VariationTargetObject[],
  existingConfigTargetObjects: string[],
): VariationTargetObject[] => {
  const configuredObjects = new Set(existingConfigTargetObjects);

  return objects
    .filter((object) => object.isActive && !object.isSystem)
    .filter((object) => !EXCLUDED_OBJECTS.has(object.nameSingular))
    .filter((object) => !configuredObjects.has(object.nameSingular))
    .filter((object) => countSyncableFields(object, 'primaryRecord') > 0)
    .sort((first, second) =>
      first.labelSingular.localeCompare(second.labelSingular),
    );
};
