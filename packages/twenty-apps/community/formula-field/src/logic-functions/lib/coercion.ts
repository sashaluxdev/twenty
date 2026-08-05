import { FormulaError } from 'src/engine/errors';
import { type EngineValue, excerptForError } from 'src/engine/evaluator';
import {
  parseDateOnlyToEpochDays,
  parseIsoDateTimeToEpochDays,
} from 'src/engine/date-serial';

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
    // Numeric strings (the NUMERIC field type can serialise as a string).
    // Nothing here inspects the string's SHAPE beyond that: a DATE column
    // reaches the engine through coerceToDateSerial, driven by the field's
    // metadata kind, so a date-LOOKING string in a NUMBER column is exactly
    // what it appears to be — non-numeric content.
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new FormulaError(
    'NON_NUMERIC_VALUE',
    // Bounded like the evaluator's own numeric chokepoint: this message lands
    // in FormulaDefinition.lastError, which must not carry a whole TEXT column.
    `Field value is not numeric (${excerptForError(JSON.stringify(raw))})`,
  );
};

// Parses a stored DATE / DATE_TIME scalar into the Excel serial-date domain
// (ADR 0011: epoch-days), driven by the field's KIND rather than by the
// content's shape. The kind picks which parser runs FIRST, not the only one —
// a DATE column holding an ISO datetime, and a DATE_TIME column holding a bare
// date, both occur in real data and both must resolve.
//
// Dirty content degrades to null instead of throwing. A throw here would fail
// every pass of a deployed formula forever (ADR 0022's frozen-target mode); a
// null propagates and the formula simply computes nothing for that record.
export const coerceToDateSerial = (
  raw: unknown,
  kind: 'date' | 'datetime',
): number | null => {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  const trimmed = raw.trim();
  const parsers =
    kind === 'date'
      ? [parseDateOnlyToEpochDays, parseIsoDateTimeToEpochDays]
      : [parseIsoDateTimeToEpochDays, parseDateOnlyToEpochDays];
  for (const parse of parsers) {
    try {
      return parse(trimmed);
    } catch {
      // Try the other spelling, then degrade.
    }
  }
  return null;
};

// The DEGRADATION coercion into the engine's number | string | null domain
// (ADR 0026), used when a reference's kind could not be resolved at all (no
// metadata, or a dotted subpath). Purely JS-type-directed: no transforms, no
// shape inspection, and never a hard error for a string — a numeric-shaped
// string keeps its leading zeros for text output, and an empty one is text
// rather than a NON_NUMERIC_VALUE error. Numeric contexts coerce text at point
// of use inside the evaluator instead.
export const coerceToEngineValue = (raw: unknown): EngineValue =>
  typeof raw === 'string' ? raw : coerceToNumber(raw);
