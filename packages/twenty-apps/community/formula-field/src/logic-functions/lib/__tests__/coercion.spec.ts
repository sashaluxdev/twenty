import { describe, expect, it } from 'vitest';

import {
  coerceToDateSerial,
  coerceToEngineValue,
  coerceToNumber,
} from 'src/logic-functions/lib/coercion';
import { MS_PER_DAY } from 'src/engine/date-serial';
import { isFormulaError } from 'src/engine/errors';

// Coercion of raw field values, AFTER the strict-typing reversal of design
// decision B2: nothing here sniffs the SHAPE of a string any more. A stored
// value is interpreted by the field's KIND (coerceToDateSerial, driven by the
// metadata map) — content that merely looks like a date is text, everywhere.

describe('coerceToNumber (no date shape-sniffing)', () => {
  const codeOfThrow = (raw: unknown): string | null => {
    try {
      coerceToNumber(raw);
      return null;
    } catch (error) {
      return isFormulaError(error) ? error.code : 'NOT_A_FORMULA_ERROR';
    }
  };

  it('rejects a "yyyy-MM-dd" DATE string instead of parsing it to epoch-days', () => {
    // REVERSAL (B2): these returned 0 / 1 / a serial. A DATE column reaches the
    // engine through the kind-directed resolver now, never through this shape.
    expect(codeOfThrow('1970-01-01')).toBe('NON_NUMERIC_VALUE');
    expect(codeOfThrow('1970-01-02')).toBe('NON_NUMERIC_VALUE');
    expect(codeOfThrow('2026-07-03')).toBe('NON_NUMERIC_VALUE');
  });

  it('rejects ISO datetime strings in every accepted spelling', () => {
    expect(codeOfThrow('1970-01-01T06:00:00.000Z')).toBe('NON_NUMERIC_VALUE');
    expect(codeOfThrow('2026-07-03T05:00:00.000Z')).toBe('NON_NUMERIC_VALUE');
    // A +hh:mm offset and a millisecond-less form used to parse too.
    expect(codeOfThrow('2026-07-03T02:00:00+02:00')).toBe('NON_NUMERIC_VALUE');
    expect(codeOfThrow('1970-01-01T12:00:00Z')).toBe('NON_NUMERIC_VALUE');
  });

  it('rejects a datetime without a timezone designator (unchanged posture)', () => {
    expect(codeOfThrow('2026-07-03T05:00:00')).toBe('NON_NUMERIC_VALUE');
  });

  it('rejects impossible dates (unchanged posture, plainer message)', () => {
    expect(codeOfThrow('2026-13-45')).toBe('NON_NUMERIC_VALUE');
    expect(codeOfThrow('2026-02-30')).toBe('NON_NUMERIC_VALUE');
    expect(codeOfThrow('2026-07-03T99:99:99Z')).toBe('NON_NUMERIC_VALUE');
  });

  it('leaves plain numbers unaffected', () => {
    expect(coerceToNumber(42)).toBe(42);
    expect(coerceToNumber(3.14)).toBe(3.14);
    expect(coerceToNumber(0)).toBe(0);
  });

  it('leaves numeric strings unaffected', () => {
    expect(coerceToNumber('123')).toBe(123);
    expect(coerceToNumber('3.14')).toBe(3.14);
    expect(coerceToNumber('2026')).toBe(2026);
  });

  it('should still coerce null/boolean/currency inputs as before', () => {
    expect(coerceToNumber(null)).toBeNull();
    expect(coerceToNumber(true)).toBe(1);
    expect(coerceToNumber(false)).toBe(0);
    expect(coerceToNumber({ amountMicros: 5_000_000 })).toBe(5_000_000);
  });

  it('bounds its error message (no unbounded record content in lastError)', () => {
    // This message lands in lastError on the resolver path exactly as the
    // evaluator's toNumber message does; that one is already bounded, this one
    // was not. toThrowError does not accept a predicate in this vitest version,
    // so assert on the caught error directly (evaluator.spec.ts pattern).
    try {
      coerceToNumber('x'.repeat(500));
      throw new Error('should have thrown');
    } catch (error) {
      expect(isFormulaError(error)).toBe(true);
      expect((error as Error).message.length).toBeLessThan(160);
    }
  });
});

// The kind-directed date parser: the ONLY place a stored DATE / DATE_TIME
// scalar becomes a serial now. Dirty content degrades to null instead of
// throwing — a throw would fail every pass of a deployed formula forever.
describe('coerceToDateSerial', () => {
  it('parses a DATE scalar to whole UTC epoch-days', () => {
    expect(coerceToDateSerial('2026-01-15', 'date')).toBe(
      Date.UTC(2026, 0, 15) / MS_PER_DAY,
    );
  });

  it('parses a DATE_TIME scalar to fractional UTC epoch-days', () => {
    expect(coerceToDateSerial('2026-01-15T12:00:00.000Z', 'datetime')).toBe(
      Date.UTC(2026, 0, 15) / MS_PER_DAY + 0.5,
    );
  });

  it('accepts the other spelling on either kind (cross-fallback)', () => {
    // A DATE column that stores an ISO datetime, and a DATE_TIME column that
    // stores a bare date, both still resolve — the kind picks the FIRST parser,
    // not the only one.
    expect(coerceToDateSerial('2026-01-15T00:00:00.000Z', 'date')).toBe(
      Date.UTC(2026, 0, 15) / MS_PER_DAY,
    );
    expect(coerceToDateSerial('2026-01-15', 'datetime')).toBe(
      Date.UTC(2026, 0, 15) / MS_PER_DAY,
    );
  });

  it('passes an already-numeric serial through', () => {
    expect(coerceToDateSerial(20468, 'date')).toBe(20468);
    expect(coerceToDateSerial(20468.5, 'datetime')).toBe(20468.5);
  });

  it('degrades dirty or non-scalar content to null instead of throwing', () => {
    expect(coerceToDateSerial('8801-25-03', 'date')).toBeNull();
    expect(coerceToDateSerial('not a date', 'datetime')).toBeNull();
    expect(coerceToDateSerial('', 'date')).toBeNull();
    expect(coerceToDateSerial(null, 'date')).toBeNull();
    expect(coerceToDateSerial(undefined, 'date')).toBeNull();
    expect(coerceToDateSerial({ amountMicros: 1 }, 'date')).toBeNull();
    expect(coerceToDateSerial(Number.NaN, 'date')).toBeNull();
  });
});

// The DEGRADATION resolver (unknown kind / no metadata): JS-type-directed, no
// transforms, never a hard error for a string.
describe('coerceToEngineValue', () => {
  it('resolves date-shaped strings verbatim as text (strict typing: no shape-sniffing)', () => {
    // REVERSAL (B2): these became serials. A real DATE column now arrives with
    // its kind and goes through coerceToDateSerial; anything reaching HERE has
    // no resolved kind, so its bytes are all we know — and bytes are text.
    expect(coerceToEngineValue('2026-01-15')).toBe('2026-01-15');
    expect(coerceToEngineValue('1970-01-01T06:00:00.000Z')).toBe(
      '1970-01-01T06:00:00.000Z',
    );
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
    // Part numbers, reference codes and hyphenated phone numbers match the DATE
    // shape. Throwing here failed every pass of a deployed TEXT mirror over such
    // a column, freezing its target at the last pre-upgrade value.
    expect(coerceToEngineValue('2026-13-45')).toBe('2026-13-45');
    expect(coerceToEngineValue('8801-25-03')).toBe('8801-25-03');
    expect(coerceToEngineValue('1234-56-78')).toBe('1234-56-78');
    expect(coerceToEngineValue('2024-07-32')).toBe('2024-07-32');
    expect(coerceToEngineValue('2026-07-03T99:99:99Z')).toBe(
      '2026-07-03T99:99:99Z',
    );
  });

  it('should keep coerceToNumber throwing for the same content (numeric contexts)', () => {
    // The verbatim fallback belongs to the value domain only: a numeric context
    // genuinely has no answer for date-shaped junk.
    expect(() => coerceToNumber('8801-25-03')).toThrow();
    expect(() => coerceToNumber('2026-13-45')).toThrow();
  });
});
