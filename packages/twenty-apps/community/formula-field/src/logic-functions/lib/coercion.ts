import { FormulaError } from 'src/engine/errors';

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

  // Numeric strings (the NUMERIC field type can serialise as a string).
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new FormulaError(
    'NON_NUMERIC_VALUE',
    `Field value is not numeric (${JSON.stringify(raw)})`,
  );
};
