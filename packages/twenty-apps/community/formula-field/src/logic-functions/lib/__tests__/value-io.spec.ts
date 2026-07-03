import { describe, expect, it } from 'vitest';

import {
  buildTargetWriteData,
  normalizeComputedValue,
  normalizeStoredValue,
  targetFieldKind,
  selectionEntryForFieldKind,
} from 'src/logic-functions/lib/value-io';

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
});
