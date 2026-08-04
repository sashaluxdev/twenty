import { type EngineValue } from 'src/engine';
import { decodeMirrorOverrideValue } from 'src/logic-functions/lib/override-repository';
import { targetFieldKind, type TargetFieldKind } from 'src/logic-functions/lib/value-io';

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

// TEXT and mirror pins both live in the JSON-text column (the convention
// decodeMirrorOverrideValue reads); the numeric kinds live in overrideValue.
const usesTextSlot = (slot: OverrideSlotKind): boolean =>
  slot === 'raw' || slot === 'TEXT';

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
// clears the field. A TEXT pin that decodes to a non-string is normalized to
// null, exactly as the backend's own read path does (handle-record-update).
export const pinnedEngineOverrideValue = (
  slot: OverrideSlotKind,
  row: OverrideValueColumns,
): { restorable: boolean; value: EngineValue } => {
  if (slot !== 'TEXT') {
    return { restorable: true, value: row.overrideValue ?? null };
  }
  const decoded = decodeMirrorOverrideValue(row.overrideValueText);
  return {
    restorable: decoded.restorable,
    value: typeof decoded.value === 'string' ? decoded.value : null,
  };
};
