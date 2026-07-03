import { describe, expect, it } from 'vitest';

import {
  areFormatOptionsValid,
  buildCurrencyDefaultValue,
  buildFieldSettings,
  deriveFieldName,
  getOutputFormat,
  isValidCustomUnicodeDateFormat,
  isValidFieldName,
  makeFormatOptions,
  optionsFromSettings,
  OUTPUT_FORMATS,
  parseTargetFieldSettings,
  serializeTargetFieldSettings,
} from 'src/front-components/lib/formula-field-formats';

describe('OUTPUT_FORMATS', () => {
  it('covers the agreed output formats (incl. the native "Short" number)', () => {
    expect(OUTPUT_FORMATS.map((format) => format.key)).toEqual([
      'integer',
      'decimal',
      'percent',
      'shortNumber',
      'currency',
      'date',
      'datetime',
    ]);
  });

  it('maps date / datetime to DATE / DATE_TIME field types', () => {
    expect(getOutputFormat('date')).toMatchObject({
      fieldType: 'DATE',
      targetFieldType: 'DATE',
    });
    expect(getOutputFormat('datetime')).toMatchObject({
      fieldType: 'DATE_TIME',
      targetFieldType: 'DATE_TIME',
    });
  });

  it('maps currency to a CURRENCY field type', () => {
    expect(getOutputFormat('currency')).toMatchObject({
      fieldType: 'CURRENCY',
      targetFieldType: 'CURRENCY',
    });
  });
});

describe('buildFieldSettings — NUMBER', () => {
  it('writes the native { type, decimals } shape (+ harmless dataType)', () => {
    expect(buildFieldSettings('integer', makeFormatOptions('integer'))).toEqual({
      type: 'number',
      decimals: 0,
      dataType: 'int',
    });
    expect(buildFieldSettings('decimal', makeFormatOptions('decimal'))).toEqual({
      type: 'number',
      decimals: 2,
      dataType: 'float',
    });
    expect(buildFieldSettings('percent', makeFormatOptions('percent'))).toEqual({
      type: 'percentage',
      decimals: 2,
      dataType: 'float',
    });
  });

  it('forces decimals to 0 for shortNumber', () => {
    const options = { ...makeFormatOptions('shortNumber'), decimals: 4 };
    expect(buildFieldSettings('shortNumber', options)).toEqual({
      type: 'shortNumber',
      decimals: 0,
      dataType: 'float',
    });
  });

  it('clamps decimals into the native 0-100 range', () => {
    const tooMany = { ...makeFormatOptions('decimal'), decimals: 250 };
    expect(buildFieldSettings('decimal', tooMany)).toMatchObject({
      decimals: 100,
    });
  });
});

describe('buildFieldSettings — CURRENCY', () => {
  it('omits decimals for the short format', () => {
    const options = { ...makeFormatOptions('currency'), currencyFormat: 'short' as const };
    expect(buildFieldSettings('currency', options)).toEqual({ format: 'short' });
  });

  it('includes decimals (0-5) only for the full format', () => {
    const options = {
      ...makeFormatOptions('currency'),
      currencyFormat: 'full' as const,
      decimals: 2,
    };
    expect(buildFieldSettings('currency', options)).toEqual({
      format: 'full',
      decimals: 2,
    });

    const clamped = { ...options, decimals: 9 };
    expect(buildFieldSettings('currency', clamped)).toEqual({
      format: 'full',
      decimals: 5,
    });
  });

  it('quote-wraps the currency code in the default value', () => {
    expect(buildCurrencyDefaultValue('EUR')).toEqual({
      amountMicros: null,
      currencyCode: "'EUR'",
    });
  });
});

describe('buildFieldSettings — DATE / DATE_TIME', () => {
  it('defaults to USER_SETTINGS with no custom format', () => {
    expect(buildFieldSettings('date', makeFormatOptions('date'))).toEqual({
      displayFormat: 'USER_SETTINGS',
    });
  });

  it('requires and includes a custom Unicode format when CUSTOM', () => {
    const options = {
      ...makeFormatOptions('datetime'),
      dateDisplayFormat: 'CUSTOM' as const,
      customUnicodeDateFormat: '  yyyy-MM-dd HH:mm  ',
    };
    expect(buildFieldSettings('datetime', options)).toEqual({
      displayFormat: 'CUSTOM',
      customUnicodeDateFormat: 'yyyy-MM-dd HH:mm',
    });
  });

  it('treats an empty CUSTOM format as invalid', () => {
    const empty = {
      ...makeFormatOptions('date'),
      dateDisplayFormat: 'CUSTOM' as const,
      customUnicodeDateFormat: '   ',
    };
    expect(areFormatOptionsValid('date', empty)).toBe(false);
    expect(isValidCustomUnicodeDateFormat('   ')).toBe(false);
    expect(isValidCustomUnicodeDateFormat('yyyy-MM-dd')).toBe(true);
    expect(isValidCustomUnicodeDateFormat('----')).toBe(false);

    const valid = { ...empty, customUnicodeDateFormat: 'yyyy' };
    expect(areFormatOptionsValid('date', valid)).toBe(true);
  });

  it('considers non-custom date options always valid', () => {
    expect(areFormatOptionsValid('date', makeFormatOptions('date'))).toBe(true);
    expect(areFormatOptionsValid('integer', makeFormatOptions('integer'))).toBe(
      true,
    );
  });
});

describe('targetFieldSettings persistence', () => {
  it('round-trips settings + currency code', () => {
    const value = {
      settings: { format: 'full', decimals: 2 },
      currencyCode: 'USD',
    };
    expect(parseTargetFieldSettings(serializeTargetFieldSettings(value))).toEqual(
      value,
    );
  });

  it('returns null for blank or malformed input', () => {
    expect(parseTargetFieldSettings('')).toBeNull();
    expect(parseTargetFieldSettings('not json')).toBeNull();
  });
});

describe('optionsFromSettings', () => {
  it('reconstructs NUMBER options from a settings object', () => {
    expect(
      optionsFromSettings('percent', { type: 'percentage', decimals: 3 }),
    ).toMatchObject({ numberDisplayType: 'percentage', decimals: 3 });
  });

  it('reconstructs CURRENCY options incl. code', () => {
    expect(
      optionsFromSettings('currency', { format: 'full', decimals: 2 }, 'USD'),
    ).toMatchObject({
      currencyFormat: 'full',
      decimals: 2,
      currencyCode: 'USD',
    });
  });

  it('reconstructs DATE options incl. custom format', () => {
    expect(
      optionsFromSettings('datetime', {
        displayFormat: 'CUSTOM',
        customUnicodeDateFormat: 'HH:mm',
      }),
    ).toMatchObject({
      dateDisplayFormat: 'CUSTOM',
      customUnicodeDateFormat: 'HH:mm',
    });
  });

  it('falls back to format defaults when settings are null', () => {
    expect(optionsFromSettings('decimal', null)).toEqual(
      makeFormatOptions('decimal'),
    );
  });
});

describe('deriveFieldName', () => {
  it('camelCases words split on non-alphanumerics', () => {
    expect(deriveFieldName('Deal score')).toBe('dealScore');
    expect(deriveFieldName('deal_score-total')).toBe('dealScoreTotal');
    expect(deriveFieldName('  Margin % (net)  ')).toBe('marginNet');
  });

  it('preserves camelCase input and lowercases single words', () => {
    expect(deriveFieldName('dealScore')).toBe('dealScore');
    expect(deriveFieldName('SCORE')).toBe('score');
  });

  it('drops leading digits and handles empty input', () => {
    expect(deriveFieldName('3rd quarter target')).toBe('rdQuarterTarget');
    expect(deriveFieldName('%%%')).toBe('');
    expect(deriveFieldName('')).toBe('');
  });

  it('always produces a valid field name when non-empty', () => {
    for (const label of ['Deal score', 'a', 'Total 2024', 'x'.repeat(120)]) {
      const name = deriveFieldName(label);
      expect(isValidFieldName(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(50);
    }
  });
});

describe('isValidFieldName', () => {
  it('accepts lowercase-led alphanumerics only', () => {
    expect(isValidFieldName('dealScore')).toBe(true);
    expect(isValidFieldName('DealScore')).toBe(false);
    expect(isValidFieldName('3score')).toBe(false);
    expect(isValidFieldName('deal_score')).toBe(false);
    expect(isValidFieldName('')).toBe(false);
  });
});
