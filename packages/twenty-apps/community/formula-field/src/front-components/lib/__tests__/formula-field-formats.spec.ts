import { describe, expect, it } from 'vitest';

import {
  deriveFieldName,
  getOutputFormat,
  isValidFieldName,
  OUTPUT_FORMATS,
} from 'src/front-components/lib/formula-field-formats';

describe('OUTPUT_FORMATS', () => {
  it('covers the agreed output formats', () => {
    expect(OUTPUT_FORMATS.map((format) => format.key)).toEqual([
      'integer',
      'decimal',
      'percent',
      'currency',
      'date',
      'datetime',
    ]);
  });

  it('maps date / datetime to DATE / DATE_TIME fields without settings', () => {
    expect(getOutputFormat('date')).toMatchObject({
      fieldType: 'DATE',
      targetFieldType: 'DATE',
      settings: null,
    });
    expect(getOutputFormat('datetime')).toMatchObject({
      fieldType: 'DATE_TIME',
      targetFieldType: 'DATE_TIME',
      settings: null,
    });
  });

  it('maps number formats to the server settings shape (lowercase dataType)', () => {
    expect(getOutputFormat('integer')).toMatchObject({
      fieldType: 'NUMBER',
      targetFieldType: 'NUMBER',
      settings: { dataType: 'int', decimals: 0, type: 'number' },
    });
    expect(getOutputFormat('decimal').settings).toEqual({
      dataType: 'float',
      decimals: 2,
      type: 'number',
    });
    expect(getOutputFormat('percent').settings).toEqual({
      dataType: 'float',
      decimals: 2,
      type: 'percentage',
    });
  });

  it('maps currency to a CURRENCY field without settings', () => {
    expect(getOutputFormat('currency')).toMatchObject({
      fieldType: 'CURRENCY',
      targetFieldType: 'CURRENCY',
      settings: null,
    });
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
