import { FormulaError } from 'src/engine/errors';
import { type EngineValue } from 'src/engine/evaluator';
import {
  isDateOnlyString,
  isIsoDateTimeString,
  parseDateOnlyToEpochDays,
  parseIsoDateTimeToEpochDays,
} from 'src/logic-functions/lib/date-serial';

// Turns a raw field value (as returned by the GraphQL API) into the number the
// interpreter works with, applying the coercion rules from ADR 0003.
//
// Distinction that drives the null policy:
//   - `undefined` (path segment missing / field not selected) -> the variable
//     does not resolve; the caller reports UNKNOWN_VARIABLE.
//   - `null` (field present but empty) -> null, which propagates in the
//     interpreter.

// Walks a dotted path over a record object. Returns `undefined` if any
// intermediate segment is missing (not present in the object at all).
export const navigatePath = (
  record: Record<string, unknown> | null | undefined,
  path: string,
): unknown => {
  if (record === null || record === undefined) {
    return undefined;
  }

  let current: unknown = record;

  for (const segment of path.split('.')) {
    if (current === null) {
      // A null intermediate means "empty" -> null propagates.
      return null;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    if (!(segment in (current as Record<string, unknown>))) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
};

// Coerces a resolved raw value to number | null, or throws NON_NUMERIC_VALUE.
export const coerceToNumber = (raw: unknown): number | null => {
  if (raw === null) {
    return null;
  }

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new FormulaError(
        'NON_NUMERIC_VALUE',
        `Field value is not finite (${raw})`,
      );
    }
    return raw;
  }

  if (typeof raw === 'boolean') {
    return raw ? 1 : 0;
  }

  // CURRENCY composite referenced without a sub-path -> use its micros amount.
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'amountMicros' in (raw as Record<string, unknown>)
  ) {
    const micros = (raw as { amountMicros: unknown }).amountMicros;
    if (micros === null) {
      return null;
    }
    if (typeof micros === 'number' && Number.isFinite(micros)) {
      return micros;
    }
    const parsed = Number(micros);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim();
    // Excel serial-date model (ADR 0011): dates ARE numbers. A DATE scalar
    // ("yyyy-MM-dd") becomes whole UTC epoch-days; an ISO 8601 datetime becomes
    // fractional epoch-days. Matched by pattern (kind-agnostic, mirroring the
    // existing leniency where a numeric string already parses), so a formula can
    // do `closeDate + 30` regardless of whether the ref is typed DATE. An
    // impossible date (2026-13-45) throws NON_NUMERIC_VALUE rather than NaN.
    if (isDateOnlyString(trimmed)) {
      return parseDateOnlyToEpochDays(trimmed);
    }
    if (isIsoDateTimeString(trimmed)) {
      return parseIsoDateTimeToEpochDays(trimmed);
    }
    // Numeric strings (the NUMERIC field type can serialise as a string).
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new FormulaError(
    'NON_NUMERIC_VALUE',
    `Field value is not numeric (${JSON.stringify(raw)})`,
  );
};

// Coerces a resolved raw value into the engine's number | string | null domain
// (ADR 0026). Semi-eager by design: VALID DATE/DATE_TIME strings still become
// serials at resolve time, so deployed date comparisons and `closeDate + 30` are
// untouched, while every other string resolves VERBATIM — a numeric-shaped
// string keeps its leading zeros for text output, and an empty one is text
// rather than a NON_NUMERIC_VALUE error. Numeric contexts coerce text at point
// of use inside the evaluator instead.
export const coerceToEngineValue = (raw: unknown): EngineValue => {
  if (typeof raw !== 'string') {
    return coerceToNumber(raw);
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return raw;
  }

  // Date eagerness is gated on SHAPE **and** VALIDITY. A part number
  // ("8801-25-03"), a reference code ("1234-56-78") or a hyphenated phone number
  // matches the DATE shape without being a calendar date; throwing there would
  // fail every pass of a deployed TEXT mirror over such a column and freeze its
  // target forever. A parse failure therefore falls back to the ADR 0026 rule
  // for every non-date string: resolve VERBATIM as text. coerceToNumber keeps
  // throwing — a numeric context genuinely has no answer for that content.
  if (isDateOnlyString(trimmed) || isIsoDateTimeString(trimmed)) {
    try {
      return isDateOnlyString(trimmed)
        ? parseDateOnlyToEpochDays(trimmed)
        : parseIsoDateTimeToEpochDays(trimmed);
    } catch {
      return raw;
    }
  }

  return raw;
};
