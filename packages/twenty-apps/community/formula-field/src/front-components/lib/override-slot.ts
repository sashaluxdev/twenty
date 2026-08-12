import { type EngineValue } from 'src/engine';
import { decodeMirrorOverrideValue } from 'src/logic-functions/lib/override-repository';
import {
  targetFieldKind,
  type TargetFieldKind,
  usesTextDomain,
} from 'src/logic-functions/lib/value-io';

// WHICH column a record's pinned override lives in, and how to read it back.
// A FormulaOverride row has two value columns: `overrideValue` (numeric) and
// `overrideValueText` (JSON-encoded). Choosing the wrong one is silent data
// loss — a TEXT pin read from the numeric column renders empty, and restoring
// from it would clear the user's pinned text — so the choice is made once here,
// from the row's KIND, and shared by the record-page widget's read, restore and
// pin paths. `overrideSlotForKind` (override-repository) owns the matching WRITE
// convention; this module is its read side.

// A mirror row pins its raw passthrough value ('raw'); every other row pins by
// its engine target kind.
export type OverrideSlotKind = TargetFieldKind | 'raw';

export const overrideSlotKind = (
  targetFieldType: string,
  isMirror: boolean,
): OverrideSlotKind => (isMirror ? 'raw' : targetFieldKind(targetFieldType));

// TEXT/SELECT and mirror pins all live in the JSON-text column (the convention
// decodeMirrorOverrideValue reads); the numeric kinds live in overrideValue.
// Delegates to value-io's usesTextDomain so a new text-domain target can never
// fork the read and write conventions (ADR 0029 D2).
const usesTextSlot = (slot: OverrideSlotKind): boolean => usesTextDomain(slot);

export type OverrideValueColumns = {
  overrideValue?: number | null;
  overrideValueText?: string | null;
};

// The pinned value as the widget DISPLAYS it. A corrupted or absent text pin
// decodes to null, which renders as the missing-value dash.
export const pinnedOverrideDisplayValue = (
  slot: OverrideSlotKind,
  row: OverrideValueColumns,
): unknown =>
  usesTextSlot(slot)
    ? decodeMirrorOverrideValue(row.overrideValueText).value
    : row.overrideValue ?? null;

// The pinned value an ENGINE row (never a mirror) writes back to its field when
// the override is re-enabled, in the target kind's own domain. `restorable`
// false means there is nothing to write back — the caller pins the CURRENT value
// instead of clearing the field with a phantom null. Numeric kinds are always
// restorable: their column IS the pinned value, and a null pin legitimately
// clears the field. A TEXT pin decoding to a NULL is restorable (the pin really
// is "empty"), but one decoding to a non-string — a legacy mirror pin over a
// TEXT column that held dirty data — is NOT: writing it verbatim would put a
// number in a text field, and normalizing it to null would erase the pinned
// value while leaving the override active, so recompute could never repair it.
// Unrestorable hands the decision back to the caller's re-pin branch.
export const pinnedEngineOverrideValue = (
  slot: OverrideSlotKind,
  row: OverrideValueColumns,
): { restorable: boolean; value: EngineValue } => {
  if (!usesTextDomain(slot)) {
    return { restorable: true, value: row.overrideValue ?? null };
  }
  const decoded = decodeMirrorOverrideValue(row.overrideValueText);
  if (decoded.value !== null && typeof decoded.value !== 'string') {
    return { restorable: false, value: null };
  }
  return { restorable: decoded.restorable, value: decoded.value };
};
