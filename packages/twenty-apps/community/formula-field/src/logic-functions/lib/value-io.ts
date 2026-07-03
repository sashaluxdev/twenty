import { coerceToNumber, navigatePath } from 'src/logic-functions/lib/coercion';

// Reading and writing a formula's VALUE field, abstracting over the field type.
// NUMBER fields hold the value directly. CURRENCY fields are composite: the
// formula's numeric domain is the amountMicros sub-field (consistent with how
// the evaluator coerces currency inputs and cross-references — micros
// end-to-end, ADR 0003), so reads and writes go through amountMicros.

export type TargetFieldKind = 'NUMBER' | 'CURRENCY';

export const targetFieldKind = (
  targetFieldType: string | null | undefined,
): TargetFieldKind => (targetFieldType === 'CURRENCY' ? 'CURRENCY' : 'NUMBER');

// Selection entry for a field of the given metadata type: composite fields
// need an explicit sub-selection, scalars use `true`. Used for the value field
// (via targetFieldType) and for dependency fields (via metadata field kinds).
export const selectionEntryForFieldKind = (
  fieldKind: string | null | undefined,
): true | Record<string, boolean> =>
  fieldKind === 'CURRENCY'
    ? { amountMicros: true, currencyCode: true }
    : true;

// Normalizes a raw stored/written value to number | null. Handles plain
// numbers, numeric strings (bigint columns serialise as strings) and currency
// composites (-> amountMicros). Anything non-numeric normalizes to null.
export const normalizeStoredValue = (raw: unknown): number | null => {
  if (raw === undefined || raw === null) {
    return null;
  }
  try {
    return coerceToNumber(raw);
  } catch {
    return null;
  }
};

// Reads the current numeric value of the value field from a record.
export const readTargetValue = (
  record: Record<string, unknown> | null | undefined,
  targetField: string,
): number | null => normalizeStoredValue(navigatePath(record, targetField));

// The value as it will actually be stored: CURRENCY keeps integer micros, so
// fractional results round. Comparisons against stored values must use this,
// or a fractional result would never converge (recompute) and the app's own
// write would look like a human override (override detection).
export const normalizeComputedValue = (
  targetFieldType: string | null | undefined,
  value: number | null,
): number | null =>
  targetFieldKind(targetFieldType) === 'CURRENCY' && value !== null
    ? Math.round(value)
    : value;

// Currency code used when a record has none and the formula does not specify
// one (the wizard default is also JPY).
export const FALLBACK_CURRENCY_CODE = 'JPY';

// Builds the mutation `data` payload writing `value` to the value field.
// CURRENCY: amountMicros must be an integer; the code keeps the record's
// existing currency, else the formula's configured code, else JPY — so a
// freshly computed value displays with a unit.
export const buildTargetWriteData = (
  targetField: string,
  targetFieldType: string | null | undefined,
  value: number | null,
  currentRaw?: unknown,
  defaultCurrencyCode?: string | null,
): Record<string, unknown> => {
  if (targetFieldKind(targetFieldType) !== 'CURRENCY') {
    return { [targetField]: value };
  }

  const existingCode =
    typeof currentRaw === 'object' &&
    currentRaw !== null &&
    typeof (currentRaw as { currencyCode?: unknown }).currencyCode === 'string'
      ? (currentRaw as { currencyCode: string }).currencyCode
      : '';

  return {
    [targetField]: {
      amountMicros: value === null ? null : Math.round(value),
      currencyCode:
        existingCode || defaultCurrencyCode || FALLBACK_CURRENCY_CODE,
    },
  };
};
