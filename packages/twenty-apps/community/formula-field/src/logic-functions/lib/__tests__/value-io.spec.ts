import { describe, expect, it } from 'vitest';

import {
  buildTargetWriteData,
  normalizeComputedValue,
  normalizeStoredValue,
  targetFieldKind,
  selectionEntryForFieldKind,
} from 'src/logic-functions/lib/value-io';
import { MS_PER_DAY } from 'src/logic-functions/lib/date-serial';

describe('targetFieldKind', () => {
  it('defaults to NUMBER for null/undefined/unknown', () => {
    expect(targetFieldKind(null)).toBe('NUMBER');
    expect(targetFieldKind(undefined)).toBe('NUMBER');
    expect(targetFieldKind('NUMBER')).toBe('NUMBER');
    expect(targetFieldKind('anything')).toBe('NUMBER');
  });

  it('recognises CURRENCY', () => {
    expect(targetFieldKind('CURRENCY')).toBe('CURRENCY');
  });

  it('recognises DATE and DATE_TIME', () => {
    expect(targetFieldKind('DATE')).toBe('DATE');
    expect(targetFieldKind('DATE_TIME')).toBe('DATE_TIME');
  });
});

describe('selectionEntryForFieldKind', () => {
  it('selects the scalar directly for NUMBER', () => {
    expect(selectionEntryForFieldKind('NUMBER')).toBe(true);
    expect(selectionEntryForFieldKind(null)).toBe(true);
  });

  it('selects sub-fields for CURRENCY', () => {
    expect(selectionEntryForFieldKind('CURRENCY')).toEqual({
      amountMicros: true,
      currencyCode: true,
    });
  });

  it('selects the scalar directly for DATE / DATE_TIME (not composite)', () => {
    expect(selectionEntryForFieldKind('DATE')).toBe(true);
    expect(selectionEntryForFieldKind('DATE_TIME')).toBe(true);
  });
});

describe('normalizeStoredValue', () => {
  it('passes numbers through and maps empty to null', () => {
    expect(normalizeStoredValue(25)).toBe(25);
    expect(normalizeStoredValue(null)).toBeNull();
    expect(normalizeStoredValue(undefined)).toBeNull();
  });

  it('reads amountMicros from a currency composite', () => {
    expect(
      normalizeStoredValue({ amountMicros: 5_000_000, currencyCode: 'EUR' }),
    ).toBe(5_000_000);
    expect(
      normalizeStoredValue({ amountMicros: null, currencyCode: 'EUR' }),
    ).toBeNull();
    // bigint columns can serialise micros as strings
    expect(normalizeStoredValue({ amountMicros: '7000000' })).toBe(7_000_000);
  });

  it('normalizes garbage to null instead of throwing', () => {
    expect(normalizeStoredValue('not a number')).toBeNull();
    expect(normalizeStoredValue({ foo: 'bar' })).toBeNull();
  });
});

describe('normalizeComputedValue', () => {
  it('rounds only for CURRENCY (integer micros)', () => {
    expect(normalizeComputedValue('CURRENCY', 10.4)).toBe(10);
    expect(normalizeComputedValue('CURRENCY', null)).toBeNull();
    expect(normalizeComputedValue('NUMBER', 10.4)).toBe(10.4);
    expect(normalizeComputedValue(null, 10.4)).toBe(10.4);
  });
});

describe('buildTargetWriteData', () => {
  it('writes the bare value for NUMBER fields', () => {
    expect(buildTargetWriteData('score', 'NUMBER', 25)).toEqual({ score: 25 });
    expect(buildTargetWriteData('score', null, null)).toEqual({ score: null });
  });

  it('writes a composite for CURRENCY, rounding to integer micros', () => {
    expect(buildTargetWriteData('budget', 'CURRENCY', 1_000_000.6)).toEqual({
      budget: { amountMicros: 1_000_001, currencyCode: 'JPY' },
    });
  });

  it('picks the code: existing record -> formula default -> JPY', () => {
    // existing record code wins
    expect(
      buildTargetWriteData(
        'budget',
        'CURRENCY',
        5,
        { amountMicros: 1, currencyCode: 'EUR' },
        'USD',
      ),
    ).toEqual({ budget: { amountMicros: 5, currencyCode: 'EUR' } });
    // formula-configured code when the record has none
    expect(
      buildTargetWriteData(
        'budget',
        'CURRENCY',
        5,
        { amountMicros: null, currencyCode: '' },
        'USD',
      ),
    ).toEqual({ budget: { amountMicros: 5, currencyCode: 'USD' } });
    // JPY when neither is set
    expect(
      buildTargetWriteData('budget', 'CURRENCY', 5, {
        amountMicros: null,
        currencyCode: '',
      }),
    ).toEqual({ budget: { amountMicros: 5, currencyCode: 'JPY' } });
  });

  it('clears a CURRENCY value with a null amount', () => {
    expect(
      buildTargetWriteData('budget', 'CURRENCY', null, {
        amountMicros: 3,
        currencyCode: 'GBP',
      }),
    ).toEqual({ budget: { amountMicros: null, currencyCode: 'GBP' } });
  });

  it('serializes a DATE target as a "yyyy-MM-dd" UTC string, flooring days', () => {
    const epochDays = Date.UTC(2026, 6, 3) / MS_PER_DAY;
    expect(buildTargetWriteData('due', 'DATE', epochDays)).toEqual({
      due: '2026-07-03',
    });
    // A fractional epoch-day (a time-of-day component) floors to the whole day.
    expect(buildTargetWriteData('due', 'DATE', epochDays + 0.99)).toEqual({
      due: '2026-07-03',
    });
  });

  it('serializes a DATE_TIME target as an ISO UTC string, rounding to ms', () => {
    const epochDays = Date.parse('2026-07-03T05:00:00.000Z') / MS_PER_DAY;
    expect(buildTargetWriteData('at', 'DATE_TIME', epochDays)).toEqual({
      at: '2026-07-03T05:00:00.000Z',
    });
  });

  it('clears a DATE / DATE_TIME value with null', () => {
    expect(buildTargetWriteData('due', 'DATE', null)).toEqual({ due: null });
    expect(buildTargetWriteData('at', 'DATE_TIME', null)).toEqual({ at: null });
  });
});

describe('DATE / DATE_TIME normalize + serialize round-trips (ADR 0011)', () => {
  it('floors a computed DATE to whole epoch-days', () => {
    const epochDays = Date.UTC(2026, 6, 3) / MS_PER_DAY;
    expect(normalizeComputedValue('DATE', epochDays + 0.75)).toBe(epochDays);
    expect(normalizeComputedValue('DATE', null)).toBeNull();
  });

  it('rounds a computed DATE_TIME to whole milliseconds', () => {
    const base = Date.parse('2026-07-03T05:00:00.000Z') / MS_PER_DAY;
    // Add a sub-millisecond wobble; it must round away.
    const wobbled = base + 0.4 / MS_PER_DAY;
    expect(normalizeComputedValue('DATE_TIME', wobbled)).toBe(base);
  });

  it('round-trips a DATE: store -> parse -> normalize is stable (no rewrite loop)', () => {
    const computed = Date.UTC(2026, 6, 3) / MS_PER_DAY + 0.3;
    const normalized = normalizeComputedValue('DATE', computed);
    const written = buildTargetWriteData('due', 'DATE', normalized).due;
    const reparsed = normalizeStoredValue(written);
    // Exact equality — this is what recompute's valuesEqual (===) compares.
    expect(reparsed).toBe(normalized);
  });

  it('round-trips a DATE_TIME: store -> parse -> normalize is stable', () => {
    const computed = Date.parse('2026-07-03T23:30:00.000Z') / MS_PER_DAY + 0.123;
    const normalized = normalizeComputedValue('DATE_TIME', computed);
    const written = buildTargetWriteData('at', 'DATE_TIME', normalized).at;
    const reparsed = normalizeStoredValue(written);
    expect(reparsed).toBe(normalized);
  });

  it('treats a 23:30 UTC datetime and a +02:00 crossing-midnight datetime as the same UTC instant', () => {
    // 2026-07-04T01:30:00+02:00 is 2026-07-03T23:30:00Z — the same instant,
    // even though the local wall-clock date is the 4th. UTC-only math means the
    // two strings normalize to the identical epoch-day fraction (DST-immune).
    const utcLate = normalizeStoredValue('2026-07-03T23:30:00.000Z');
    const offsetCrossingMidnight = normalizeStoredValue(
      '2026-07-04T01:30:00.000+02:00',
    );
    expect(offsetCrossingMidnight).toBe(utcLate);
    // And flooring that instant to a DATE yields the UTC day (the 3rd), not the
    // local day (the 4th).
    expect(buildTargetWriteData('due', 'DATE', utcLate).due).toBe('2026-07-03');
  });
});
