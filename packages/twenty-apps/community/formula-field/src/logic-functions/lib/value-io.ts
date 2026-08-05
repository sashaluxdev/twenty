import { type EngineValue } from 'src/engine/evaluator';
import { formatNumberAsText } from 'src/engine/text-format';
import {
  coerceToDateSerial,
  coerceToNumber,
} from 'src/logic-functions/lib/coercion';
import {
  epochDaysToDateString,
  epochDaysToIsoDateTime,
  MS_PER_DAY,
} from 'src/engine/date-serial';
import { type ComputedValue } from 'src/logic-functions/lib/types';

// Reading and writing a formula's VALUE field, abstracting over the field type.
// NUMBER fields hold the value directly. CURRENCY fields are composite: the
// formula's numeric domain is the amountMicros sub-field (consistent with how
// the evaluator coerces currency inputs and cross-references — micros
// end-to-end, ADR 0003), so reads and writes go through amountMicros.
// DATE / DATE_TIME fields are the Excel serial-date model (ADR 0011): the
// numeric domain is epoch-days; writes serialize back to the "yyyy-MM-dd" /
// ISO-UTC scalar, and reads parse the scalar back (via coerceToDateSerial in
// normalizeStoredValue, selected by the KIND) so stored and computed values
// always compare in one representation.

// The engine's value family — the SINGLE source of truth (FM Task 1 rider).
// targetFieldKind derives its family membership from this array, and
// mirror-kinds' ENGINE_FAMILY_KINDS is built from it, so the two can never drift
// silently (a drift-guard test asserts they stay equal).
// TEXT joins the family with the string output domain (ADR 0026): the engine can
// now EXPRESS a text result, so the write boundary must be able to store one.
// TEXT is no longer in MIRRORABLE_KINDS: a bare-ref TEXT target is a one-term
// engine formula whose writes match what the mirror lane used to produce.
export const ENGINE_FAMILY = [
  'NUMBER',
  'CURRENCY',
  'DATE',
  'DATE_TIME',
  'TEXT',
] as const;

export type TargetFieldKind = (typeof ENGINE_FAMILY)[number];

export const targetFieldKind = (
  targetFieldType: string | null | undefined,
): TargetFieldKind =>
  (ENGINE_FAMILY as readonly string[]).includes(targetFieldType ?? '')
    ? (targetFieldType as TargetFieldKind)
    : 'NUMBER';

// Selection entry for a field of the given metadata type: composite fields
// need an explicit sub-selection, scalars use `true`. Used for the value field
// (via targetFieldType) and for dependency fields (via metadata field kinds).
export const selectionEntryForFieldKind = (
  fieldKind: string | null | undefined,
): true | Record<string, boolean> =>
  fieldKind === 'CURRENCY'
    ? { amountMicros: true, currencyCode: true }
    : true;

// Normalizes a raw stored/written value into the target kind's own domain.
// NUMBER/CURRENCY: plain numbers, numeric strings (bigint columns serialise as
// strings) and currency composites (-> amountMicros); anything non-numeric
// normalizes to null. DATE/DATE_TIME: the stored scalar parses back to
// epoch-days by KIND (ADR 0011), never by the string's shape. TEXT: the stored
// string verbatim (an empty string is a real value, not a null), anything else
// null. The kind is REQUIRED because the domains disagree about the same bytes —
// "042" is 42 to a NUMBER target and "042" to a TEXT one, and "2026-01-15" is a
// serial to a DATE target and non-numeric content to a NUMBER one.
//
// This is the READ half of the convergence loop (F1): what buildTargetWriteData
// serialized must parse back BIT-IDENTICALLY here, or recompute's `===`
// comparison never matches and the definition rewrites the same value forever.
export const normalizeStoredValue = (
  raw: unknown,
  kind: TargetFieldKind,
): EngineValue => {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (kind === 'TEXT') {
    return typeof raw === 'string' ? raw : null;
  }
  if (kind === 'DATE' || kind === 'DATE_TIME') {
    return coerceToDateSerial(raw, kind === 'DATE' ? 'date' : 'datetime');
  }
  try {
    return coerceToNumber(raw);
  } catch {
    return null;
  }
};

// The write boundary's numeric coercion: a text value reaching a numeric target
// coerces exactly as the resolver used to at resolve time — "42" succeeds,
// "INV42" throws NON_NUMERIC_VALUE and the caller turns it into an eval error.
const numericDomainValue = (value: EngineValue): number | null =>
  typeof value === 'string' ? coerceToNumber(value) : value;

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
  value: EngineValue,
  options?: { integerBacked?: boolean },
): EngineValue => {
  const kind = targetFieldKind(targetFieldType);
  // TEXT target: a string is already in the field's domain; a number renders
  // through the engine's canonical decimal rendering (ADR 0026) so the stored
  // text matches what a text context inside a formula would have produced.
  if (kind === 'TEXT') {
    if (value === null) return null;
    return typeof value === 'string' ? value : formatNumberAsText(value);
  }
  const numeric = numericDomainValue(value);
  if (numeric === null) return null;
  if (kind === 'CURRENCY') return Math.round(numeric);
  if (kind === 'DATE') return Math.floor(numeric);
  if (kind === 'DATE_TIME') return Math.round(numeric * MS_PER_DAY) / MS_PER_DAY;
  // Integer-backed NUMBER: round through the same funnel CURRENCY uses so the
  // Int scalar accepts the write and comparisons converge (no rewrite loop).
  if (options?.integerBacked) return Math.round(numeric);
  return numeric;
};

// Tags a normalized engine value with the lane its bookkeeping must take, so
// downstream code dispatches on `kind` instead of re-deriving the domain with
// typeof. normalizeComputedValue already guarantees the value matches the kind —
// the guards here are the type-level proof of that, not a runtime policy.
export const tagEngineValue = (
  kind: TargetFieldKind,
  value: EngineValue,
): ComputedValue =>
  kind === 'TEXT'
    ? { kind: 'text', value: typeof value === 'string' ? value : null }
    : { kind: 'number', value: typeof value === 'number' ? value : null };

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
  value: EngineValue,
  currentRaw?: unknown,
  defaultCurrencyCode?: string | null,
): Record<string, unknown> => {
  const kind = targetFieldKind(targetFieldType);

  // TEXT target: the string goes to the column as-is. An empty string is written
  // AS an empty string (the behavior a TEXT mirror already has), not collapsed
  // to null — only a null result clears the field.
  if (kind === 'TEXT') {
    return { [targetField]: value };
  }

  const numeric = numericDomainValue(value);

  // Excel serial-date model (ADR 0011): the value is epoch-days; serialize back
  // to the field's scalar. DATE floors to a whole UTC day -> "yyyy-MM-dd";
  // DATE_TIME rounds to whole ms -> ISO UTC. null clears the field.
  if (kind === 'DATE') {
    return {
      [targetField]: numeric === null ? null : epochDaysToDateString(numeric),
    };
  }
  if (kind === 'DATE_TIME') {
    return {
      [targetField]: numeric === null ? null : epochDaysToIsoDateTime(numeric),
    };
  }

  if (kind !== 'CURRENCY') {
    return { [targetField]: numeric };
  }

  const existingCode =
    typeof currentRaw === 'object' &&
    currentRaw !== null &&
    typeof (currentRaw as { currencyCode?: unknown }).currencyCode === 'string'
      ? (currentRaw as { currencyCode: string }).currencyCode
      : '';

  return {
    [targetField]: {
      amountMicros: numeric === null ? null : Math.round(numeric),
      currencyCode:
        existingCode || defaultCurrencyCode || FALLBACK_CURRENCY_CODE,
    },
  };
};
