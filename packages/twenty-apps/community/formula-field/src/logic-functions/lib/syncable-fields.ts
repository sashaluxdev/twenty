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
// field itself, inactive/system fields, and anything outside the syncable kind
// allowlist. MANY_TO_ONE relations ARE syncable — they mirror via their FK
// join column (emitted as a RELATION-kind entry named after joinColumnName);
// ONE_TO_MANY inverses (no local FK) and MORPH_RELATION (discriminator column,
// deferred) stay excluded, as do ACTOR/RICH_TEXT/POSITION/TS_VECTOR (simply not
// in either source set). Also excluded: any field an enabled FormulaDefinition
// targets on this object (the
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
    .filter((field) => !field.isUnique)
    .flatMap((field) => {
      // MANY_TO_ONE relations mirror via their FK join column: the server
      // reports that column in updatedFields and event payloads, and the
      // dynamic client reads/writes it as a plain scalar — so the syncable
      // entry IS the join column, and every downstream path (selection, diff,
      // write, divergence, override slot) treats it as an ordinary scalar.
      // ONE_TO_MANY inverses (no local FK) and MORPH_RELATION (discriminator
      // column, deferred) stay excluded.
      if (field.type === 'RELATION') {
        return field.relationType === 'MANY_TO_ONE' && field.joinColumnName
          ? [{ name: field.joinColumnName, kind: 'RELATION' }]
          : [];
      }
      return SYNCABLE_KINDS.has(field.type)
        ? [{ name: field.name, kind: field.type }]
        : [];
    });
};
