import { describe, expect, it } from 'vitest';

import {
  coerceToEngineValue,
  coerceToNumber,
} from 'src/logic-functions/lib/coercion';
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

// The resolver-side coercion for the number | string | null value domain: dates
// stay EAGER (deployed date comparisons keep working) while every other string
// resolves verbatim, so text survives into concatenation and text targets and
// numeric contexts coerce it at point of use instead.
describe('coerceToEngineValue', () => {
  it('should still coerce date-shaped strings to serials', () => {
    expect(coerceToEngineValue('2026-01-15')).toBe(
      Date.UTC(2026, 0, 15) / MS_PER_DAY,
    );
    expect(coerceToEngineValue('1970-01-01T06:00:00.000Z')).toBe(0.25);
  });

  it('should return numeric-shaped strings verbatim rather than parsing them', () => {
    // A leading zero is the tell: coercing at resolve time would render "042"
    // as 42 in text output.
    expect(coerceToEngineValue('042')).toBe('042');
    expect(coerceToEngineValue('42')).toBe('42');
  });

  it('should return empty and whitespace-only strings verbatim instead of throwing', () => {
    expect(coerceToEngineValue('')).toBe('');
    expect(coerceToEngineValue('   ')).toBe('   ');
  });

  it('should return non-numeric text verbatim instead of throwing', () => {
    expect(coerceToEngineValue('won')).toBe('won');
  });

  it('should delegate non-string values to coerceToNumber unchanged', () => {
    expect(coerceToEngineValue(null)).toBeNull();
    expect(coerceToEngineValue(true)).toBe(1);
    expect(coerceToEngineValue(false)).toBe(0);
    expect(coerceToEngineValue(42)).toBe(42);
    expect(coerceToEngineValue({ amountMicros: 5_000_000 })).toBe(5_000_000);
  });

  it('should resolve a date-SHAPED non-date verbatim instead of throwing', () => {
    // Date eagerness is validity-gated: a part number, a reference code or a
    // hyphenated phone number matches the DATE shape without being a calendar
    // date. Throwing failed every pass of a deployed TEXT mirror over such a
    // column, freezing its target at the last pre-upgrade value.
    expect(coerceToEngineValue('2026-13-45')).toBe('2026-13-45');
    expect(coerceToEngineValue('8801-25-03')).toBe('8801-25-03');
    expect(coerceToEngineValue('1234-56-78')).toBe('1234-56-78');
    expect(coerceToEngineValue('2024-07-32')).toBe('2024-07-32');
    // The same gate on the datetime shape.
    expect(coerceToEngineValue('2026-07-03T99:99:99Z')).toBe(
      '2026-07-03T99:99:99Z',
    );
  });

  it('should keep coerceToNumber throwing for the same content (numeric contexts)', () => {
    // The verbatim fallback belongs to the value domain only: a numeric context
    // genuinely has no answer for date-shaped junk, so nothing about arithmetic
    // changed.
    expect(() => coerceToNumber('8801-25-03')).toThrowError(
      /NON_NUMERIC_VALUE|not a valid date/,
    );
    expect(() => coerceToNumber('2026-13-45')).toThrow();
  });
});
