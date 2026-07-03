import { describe, expect, it } from 'vitest';

import { coerceToNumber } from 'src/logic-functions/lib/coercion';
import { MS_PER_DAY } from 'src/logic-functions/lib/date-serial';

// Coercion of raw field values to the engine's number domain, focused on the
// Excel serial-date model (ADR 0011): DATE/DATE_TIME strings parse to epoch-days
// so `closeDate + 30` is plain number math, while plain numbers and numeric
// strings are unaffected.

describe('coerceToNumber date parsing', () => {
  it('should parse a "yyyy-MM-dd" DATE string to whole UTC epoch-days', () => {
    // 1970-01-01 is day 0; 1970-01-02 is day 1.
    expect(coerceToNumber('1970-01-01')).toBe(0);
    expect(coerceToNumber('1970-01-02')).toBe(1);
    // A known date: 2026-07-03.
    const expected = Date.UTC(2026, 6, 3) / MS_PER_DAY;
    expect(coerceToNumber('2026-07-03')).toBe(expected);
    expect(Number.isInteger(coerceToNumber('2026-07-03'))).toBe(true);
  });

  it('should parse an ISO datetime with Z to fractional epoch-days', () => {
    // 1970-01-01T06:00:00Z is a quarter of a day.
    expect(coerceToNumber('1970-01-01T06:00:00.000Z')).toBe(0.25);
    expect(coerceToNumber('2026-07-03T05:00:00.000Z')).toBe(
      Date.parse('2026-07-03T05:00:00.000Z') / MS_PER_DAY,
    );
  });

  it('should parse an ISO datetime with a +hh:mm offset in UTC', () => {
    // 02:00 at +02:00 offset is 00:00 UTC -> whole epoch-day.
    expect(coerceToNumber('2026-07-03T02:00:00+02:00')).toBe(
      Date.UTC(2026, 6, 3) / MS_PER_DAY,
    );
  });

  it('should parse an ISO datetime without milliseconds', () => {
    expect(coerceToNumber('1970-01-01T12:00:00Z')).toBe(0.5);
  });

  it('should reject a datetime without a timezone designator', () => {
    // Date.parse would read it as LOCAL time, silently breaking the UTC-only
    // guarantee — naive datetimes stay non-numeric instead.
    expect(() => coerceToNumber('2026-07-03T05:00:00')).toThrowError(
      /NON_NUMERIC_VALUE|not a numeric value|not numeric/i,
    );
  });

  it('should throw NON_NUMERIC_VALUE for an impossible date rather than NaN', () => {
    expect(() => coerceToNumber('2026-13-45')).toThrowError(
      /NON_NUMERIC_VALUE|not a valid date/,
    );
    expect(() => coerceToNumber('2026-02-30')).toThrow();
  });

  it('should throw for an ISO datetime with an impossible time', () => {
    expect(() => coerceToNumber('2026-07-03T99:99:99Z')).toThrow();
  });

  it('should leave plain numbers unaffected', () => {
    expect(coerceToNumber(42)).toBe(42);
    expect(coerceToNumber(3.14)).toBe(3.14);
    expect(coerceToNumber(0)).toBe(0);
  });

  it('should leave numeric strings unaffected (not treated as dates)', () => {
    expect(coerceToNumber('123')).toBe(123);
    expect(coerceToNumber('3.14')).toBe(3.14);
    // A bare 4-digit year-like number is a number, not a date.
    expect(coerceToNumber('2026')).toBe(2026);
  });

  it('should still coerce null/boolean/currency inputs as before', () => {
    expect(coerceToNumber(null)).toBeNull();
    expect(coerceToNumber(true)).toBe(1);
    expect(coerceToNumber(false)).toBe(0);
    expect(coerceToNumber({ amountMicros: 5_000_000 })).toBe(5_000_000);
  });
});
