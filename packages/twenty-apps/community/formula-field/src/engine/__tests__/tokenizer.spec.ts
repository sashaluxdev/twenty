import { describe, expect, it } from 'vitest';

import { FormulaError } from 'src/engine/errors';
import { tokenize } from 'src/engine/tokenizer';

const types = (source: string) => tokenize(source).map((token) => token.type);

describe('tokenizer', () => {
  it('tokenizes numbers, operators and parentheses', () => {
    expect(types('1 + 2 * (3 - 4) / 5 % 6')).toEqual([
      'NUMBER',
      'PLUS',
      'NUMBER',
      'STAR',
      'LPAREN',
      'NUMBER',
      'MINUS',
      'NUMBER',
      'RPAREN',
      'SLASH',
      'NUMBER',
      'PERCENT',
      'NUMBER',
      'EOF',
    ]);
  });

  it('parses integer and decimal numbers', () => {
    const tokens = tokenize('12 3.5 0.25');
    expect(tokens[0].numberValue).toBe(12);
    expect(tokens[1].numberValue).toBe(3.5);
    expect(tokens[2].numberValue).toBe(0.25);
  });

  it('reads same-record field references with dotted paths', () => {
    const tokens = tokenize('amount + amount.amountMicros');
    expect(tokens[0]).toMatchObject({ type: 'FIELD', fieldPath: 'amount' });
    expect(tokens[2]).toMatchObject({
      type: 'FIELD',
      fieldPath: 'amount.amountMicros',
    });
  });

  it('reads cross-record references', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    const tokens = tokenize(`[company:${uuid}:employees]`);
    expect(tokens[0]).toMatchObject({
      type: 'CROSSREF',
      crossRef: { object: 'company', recordId: uuid, fieldPath: 'employees' },
    });
  });

  it('rejects a cross-record reference with a non-uuid record id', () => {
    expect(() => tokenize('[company:not-a-uuid:employees]')).toThrowError(
      /UUID v4/,
    );
  });

  it('rejects a cross-record reference with wrong arity', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    expect(() => tokenize(`[company:${uuid}]`)).toThrow(FormulaError);
  });

  it('rejects an unterminated cross-record reference', () => {
    expect(() => tokenize('[company:x')).toThrowError(/Unterminated/);
  });

  describe('injection / hardening', () => {
    it('rejects a statement separator', () => {
      // Classic "escape the expression" attempt.
      expect(() => tokenize('1); process.exit(')).toThrowError(
        /Unexpected character ";"/,
      );
    });

    it('rejects prototype-pollution identifiers at tokenize time', () => {
      expect(() => tokenize('constructor.constructor')).toThrowError(
        /Forbidden identifier "constructor"/,
      );
      expect(() => tokenize('a.__proto__')).toThrowError(/Forbidden/);
      expect(() => tokenize('prototype')).toThrowError(/Forbidden/);
    });

    it('rejects unicode homoglyph operators', () => {
      // U+2212 MINUS SIGN (looks like "-") and fullwidth plus U+FF0B.
      expect(() => tokenize('1 ' + String.fromCharCode(0x2212) + ' 2')).toThrowError(/Unexpected character/);
      expect(() => tokenize('1 ' + String.fromCharCode(0xFF0B) + ' 2')).toThrowError(/Unexpected character/);
    });

    it('rejects fullwidth digits', () => {
      // U+FF11 U+FF12 look like "12" but are not ASCII digits.
      expect(() => tokenize(String.fromCharCode(0xFF11, 0xFF12))).toThrowError(/Unexpected character/);
    });

    it('rejects string/template/backtick characters', () => {
      for (const bad of ['"', "'", '`', '$', '{', '}', '\\', '=', '!', '&', '|', '^', '<', '>']) {
        expect(() => tokenize(`1 ${bad} 2`)).toThrow(FormulaError);
      }
    });

    it('rejects a non-breaking space', () => {
      expect(() => tokenize('1' + String.fromCharCode(0x00A0) + '2')).toThrowError(/Unexpected character/);
    });

    it('reports the offset of the offending character', () => {
      try {
        tokenize('12 + ;');
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(FormulaError);
        expect((error as FormulaError).position).toBe(5);
      }
    });
  });
});
