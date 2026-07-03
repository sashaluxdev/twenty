import { FormulaError } from 'src/engine/errors';

// Excel serial-date model (ADR 0011): a DATE/DATE_TIME value IS a number —
// fractional days since the Unix epoch (1970-01-01 UTC). A whole epoch-day is a
// calendar date; a fraction is a time of day. ALL conversion is done in UTC
// (Date.UTC / getTime), never local-Date math, so results are DST-immune.
//
// This module is the single chokepoint for date <-> number conversion, shared by
// the read path (coercion.ts extends coerceToNumber with these parsers) and the
// write path (value-io.ts serializes epoch-days back with these formatters).

export const MS_PER_DAY = 86_400_000;

// A timezone-free calendar date, e.g. "2026-07-03" (the Twenty DATE scalar).
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// An ISO 8601 datetime, e.g. "2026-07-03T05:00:00.000Z" or with a ±hh:mm offset.
// Requires the `T` separator (that is what distinguishes it from a bare date)
// AND an explicit timezone designator: Date.parse treats a designator-less
// datetime as LOCAL time, which would silently break the UTC-only guarantee.
// Twenty's DATE_TIME scalar always emits Z-suffixed ISO, so nothing real is
// excluded; naive datetime strings in text fields stay NON_NUMERIC.
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const isDateOnlyString = (value: string): boolean =>
  DATE_ONLY_PATTERN.test(value);

export const isIsoDateTimeString = (value: string): boolean =>
  ISO_DATETIME_PATTERN.test(value);

// Parses "yyyy-MM-dd" into whole UTC epoch-days. Rejects impossible dates
// (e.g. 2026-13-45), which Date.UTC would otherwise silently roll over.
export const parseDateOnlyToEpochDays = (value: string): number => {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const millis = Date.UTC(year, month - 1, day);
  const date = new Date(millis);
  const isRealDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!isRealDate) {
    throw new FormulaError(
      'NON_NUMERIC_VALUE',
      `Field value is not a valid date (${value})`,
    );
  }
  return millis / MS_PER_DAY;
};

// Parses an ISO 8601 datetime into fractional UTC epoch-days via Date.parse.
export const parseIsoDateTimeToEpochDays = (value: string): number => {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new FormulaError(
      'NON_NUMERIC_VALUE',
      `Field value is not a valid datetime (${value})`,
    );
  }
  return millis / MS_PER_DAY;
};

// Serializes epoch-days back to the DATE scalar "yyyy-MM-dd", flooring to the
// whole UTC day first (a DATE has no time component).
export const epochDaysToDateString = (epochDays: number): string => {
  const date = new Date(Math.floor(epochDays) * MS_PER_DAY);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Serializes epoch-days back to an ISO UTC datetime string, rounding to the
// whole millisecond (the DATE_TIME scalar's resolution).
export const epochDaysToIsoDateTime = (epochDays: number): string =>
  new Date(Math.round(epochDays * MS_PER_DAY)).toISOString();
