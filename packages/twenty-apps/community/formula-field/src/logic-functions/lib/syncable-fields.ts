import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
import { loadAllEnabledFormulas } from 'src/logic-functions/lib/formula-repository';
import {
  ENGINE_FAMILY_KINDS,
  MIRRORABLE_KINDS,
} from 'src/logic-functions/lib/mirror-kinds';
import { type FormulaClient } from 'src/logic-functions/lib/types';

// Variation sync's field allowlist: every kind the mirror engine already knows
// how to typed-passthrough-copy (design 2026-07-07). Deliberately reuses the
// SAME two sets the mirror engine uses (not a new list) so the two can never
// drift about what "copyable" means.
const SYNCABLE_KINDS: ReadonlySet<string> = new Set([
  ...MIRRORABLE_KINDS,
  ...ENGINE_FAMILY_KINDS,
]);

export type SyncableFieldInfo = { name: string; kind: string };

// The set of fields variation sync copies from primary to variation for a given
// object, computed fresh from metadata every call (never persisted) so a field
// added to the object later is picked up automatically. Excludes: the object's
// label-identifier field (variations must stay distinguishable), the relation
// field itself, inactive/system fields, anything outside the syncable kind
// allowlist (which already excludes RELATION/MORPH_RELATION/ACTOR/RICH_TEXT/
// POSITION/TS_VECTOR by construction — they are simply not in either source
// set), any field an enabled FormulaDefinition targets on this object (the
// formula owns that column; the two write sets must stay disjoint), and any
// UNIQUE-constrained field (e.g. Company domainName) — a unique value can
// never be legitimately mirrored onto a second record without colliding with
// the primary's own value, and since syncOneVariation writes every syncable
// field in one atomic batch, a single unique field in the set would reject
// the ENTIRE variation update, not just that field.
export const computeSyncableFields = async (
  client: FormulaClient,
  targetObject: string,
  relationFieldName: string,
): Promise<SyncableFieldInfo[]> => {
  const objects = await loadAllObjectsWithFields();
  const object = objects.find(
    (candidate) => candidate.nameSingular === targetObject,
  );
  if (!object) {
    return [];
  }

  const formulas = await loadAllEnabledFormulas(client);
  const formulaTargetFields = new Set(
    formulas
      .filter((formula) => formula.targetObject === targetObject)
      .map((formula) => formula.targetField)
      .filter((field): field is string => Boolean(field)),
  );

  return object.fields
    .filter((field) => field.isActive)
    .filter((field) => !field.isSystem)
    .filter((field) => field.id !== object.labelIdentifierFieldMetadataId)
    .filter((field) => field.name !== relationFieldName)
    .filter((field) => !formulaTargetFields.has(field.name))
    .filter((field) => SYNCABLE_KINDS.has(field.type))
    .filter((field) => !field.isUnique)
    .map((field) => ({ name: field.name, kind: field.type }));
};
