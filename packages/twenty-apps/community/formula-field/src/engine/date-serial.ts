import { FormulaError } from 'src/engine/errors';

// Excel serial-date model (ADR 0011): a DATE/DATE_TIME value IS a number —
// fractional days since the Unix epoch (1970-01-01 UTC). A whole epoch-day is a
// calendar date; a fraction is a time of day. ALL conversion is done in UTC
// (Date.UTC / getTime), never local-Date math, so results are DST-immune.
//
// This module is the single chokepoint for date <-> number conversion, shared by
// the read path (coercion.ts extends coerceToNumber with these parsers), the
// write path (value-io.ts serializes epoch-days back with these formatters),
// and the engine itself (parser.ts folds a DATE("YYYY-MM-DD") literal through
// parseDateOnlyToEpochDays at parse time — text-format.ts precedent: lives in
// the engine, imported by both layers). It contains NO system-clock read —
// that lone exception (currentEpochDay) lives app-side in
// src/logic-functions/lib/current-epoch-day.ts, so the engine stays a pure
// function of its inputs.

export const MS_PER_DAY = 86_400_000;

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

// 1-entry cache: a scan repeatedly rendering the same serial (e.g.
// TEXT(TODAY()) across a multi-hundred-record sweep) hits this one value on
// every call, so caching just the last render skips the Date construction and
// padding for the whole run.
let lastRenderedSerial: number | null = null;
let lastRenderedString = '';

// Serializes epoch-days back to the DATE scalar "yyyy-MM-dd", flooring to the
// whole UTC day first (a DATE has no time component).
export const epochDaysToDateString = (epochDays: number): string => {
  if (epochDays === lastRenderedSerial) {
    return lastRenderedString;
  }
  const date = new Date(Math.floor(epochDays) * MS_PER_DAY);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const rendered = `${year}-${month}-${day}`;
  lastRenderedSerial = epochDays;
  lastRenderedString = rendered;
  return rendered;
};

// Serializes epoch-days back to an ISO UTC datetime string, rounding to the
// whole millisecond (the DATE_TIME scalar's resolution).
export const epochDaysToIsoDateTime = (epochDays: number): string =>
  new Date(Math.round(epochDays * MS_PER_DAY)).toISOString();
