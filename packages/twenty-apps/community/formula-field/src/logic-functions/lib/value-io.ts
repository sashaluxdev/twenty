import { coerceToNumber, navigatePath } from 'src/logic-functions/lib/coercion';
import {
  epochDaysToDateString,
  epochDaysToIsoDateTime,
  MS_PER_DAY,
} from 'src/logic-functions/lib/date-serial';

// Reading and writing a formula's VALUE field, abstracting over the field type.
// NUMBER fields hold the value directly. CURRENCY fields are composite: the
// formula's numeric domain is the amountMicros sub-field (consistent with how
// the evaluator coerces currency inputs and cross-references — micros
// end-to-end, ADR 0003), so reads and writes go through amountMicros.
// DATE / DATE_TIME fields are the Excel serial-date model (ADR 0011): the
// numeric domain is epoch-days; writes serialize back to the "yyyy-MM-dd" /
// ISO-UTC scalar, and reads parse the scalar back (via coerceToNumber in
// normalizeStoredValue) so stored and computed values always compare in one
// representation.

export type TargetFieldKind = 'NUMBER' | 'CURRENCY' | 'DATE' | 'DATE_TIME';

export const targetFieldKind = (
  targetFieldType: string | null | undefined,
): TargetFieldKind => {
  if (targetFieldType === 'CURRENCY') return 'CURRENCY';
  if (targetFieldType === 'DATE') return 'DATE';
  if (targetFieldType === 'DATE_TIME') return 'DATE_TIME';
  return 'NUMBER';
};

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

// True when the target is an integer-backed NUMBER field. The wizard's "integer"
// format creates a NUMBER field with settings.dataType 'int', whose GraphQL
// scalar is Int and THROWS on a fractional write — so `x / 3` on an integer
// target fails permanently unless the value is rounded (finding M2).
// outputFormat is the cheapest reliable signal already on the definition record;
// targetFieldType alone cannot tell an int NUMBER from a float NUMBER. (A
// targetFieldSettings JSON field being added concurrently can become the source
// later.)
export const isIntegerBackedFormat = (
  outputFormat: string | null | undefined,
): boolean => outputFormat === 'integer';

// The value as it will actually be stored, in the field's own representation:
// CURRENCY keeps integer micros; DATE floors to a whole UTC epoch-day (a date
// has no time); DATE_TIME rounds to whole milliseconds (the scalar resolution);
// an integer-backed NUMBER rounds to a whole number (the Int scalar). Comparisons
// against stored values MUST use this, or a fractional result would never
// converge (recompute) and the app's own write would look like a human override
// (override detection) — the rewrite-forever trap (ADR 0011, mirroring the
// CURRENCY-micros precedent).
export const normalizeComputedValue = (
  targetFieldType: string | null | undefined,
  value: number | null,
  options?: { integerBacked?: boolean },
): number | null => {
  if (value === null) return value;
  const kind = targetFieldKind(targetFieldType);
  if (kind === 'CURRENCY') return Math.round(value);
  if (kind === 'DATE') return Math.floor(value);
  if (kind === 'DATE_TIME') return Math.round(value * MS_PER_DAY) / MS_PER_DAY;
  // Integer-backed NUMBER: round through the same funnel CURRENCY uses so the
  // Int scalar accepts the write and comparisons converge (no rewrite loop).
  if (options?.integerBacked) return Math.round(value);
  return value;
};

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
  const kind = targetFieldKind(targetFieldType);

  // Excel serial-date model (ADR 0011): the value is epoch-days; serialize back
  // to the field's scalar. DATE floors to a whole UTC day -> "yyyy-MM-dd";
  // DATE_TIME rounds to whole ms -> ISO UTC. null clears the field.
  if (kind === 'DATE') {
    return {
      [targetField]: value === null ? null : epochDaysToDateString(value),
    };
  }
  if (kind === 'DATE_TIME') {
    return {
      [targetField]: value === null ? null : epochDaysToIsoDateTime(value),
    };
  }

  if (kind !== 'CURRENCY') {
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
