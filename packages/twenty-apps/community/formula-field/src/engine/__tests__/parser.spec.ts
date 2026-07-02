import { describe, expect, it } from 'vitest';

import { type AstNode } from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import { parse } from 'src/engine/parser';

// Fully evaluate a constant AST so precedence can be asserted by result rather
// than by matching node shapes. Variable-free, so no resolver is needed.
const evalConst = (node: AstNode): number => {
  switch (node.type) {
    case 'number':
      return node.value;
    case 'unary':
      return node.operator === '-'
        ? -evalConst(node.operand)
        : evalConst(node.operand);
    case 'binary': {
      const left = evalConst(node.left);
      const right = evalConst(node.right);
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '%':
          return left % right;
      }
    }
    // eslint-disable-next-line no-fallthrough
    default:
      throw new Error('variable in constant expression');
  }
};

describe('parser precedence & associativity', () => {
  it('multiplies before adding', () => {
    expect(evalConst(parse('1 + 2 * 3'))).toBe(7);
  });

  it('honors parentheses', () => {
    expect(evalConst(parse('(1 + 2) * 3'))).toBe(9);
  });

  it('is left-associative for subtraction', () => {
    expect(evalConst(parse('10 - 3 - 2'))).toBe(5);
  });

  it('is left-associative for division', () => {
    expect(evalConst(parse('100 / 5 / 2'))).toBe(10);
  });

  it('handles modulo at multiplicative precedence', () => {
    expect(evalConst(parse('10 + 7 % 3'))).toBe(11);
  });

  it('applies unary minus', () => {
    expect(evalConst(parse('-5 + 3'))).toBe(-2);
    expect(evalConst(parse('3 * -2'))).toBe(-6);
    expect(evalConst(parse('--5'))).toBe(5);
  });

  it('handles deep nesting', () => {
    expect(evalConst(parse('((((1 + 1))))'))).toBe(2);
  });

  it('builds field and crossref nodes', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    const ast = parse(`inputA + [company:${uuid}:employees]`);
    expect(ast.type).toBe('binary');
    if (ast.type === 'binary') {
      expect(ast.left).toEqual({ type: 'field', path: 'inputA' });
      expect(ast.right).toEqual({
        type: 'crossref',
        ref: { object: 'company', recordId: uuid, fieldPath: 'employees' },
      });
    }
  });
});

describe('parser errors', () => {
  it('rejects trailing tokens', () => {
    expect(() => parse('1 2')).toThrow(FormulaError);
    expect(() => parse('1 +')).toThrowError(/Unexpected end/);
  });

  it('rejects unbalanced parentheses', () => {
    expect(() => parse('(1 + 2')).toThrowError(/closing parenthesis/);
    expect(() => parse('1 + 2)')).toThrow(FormulaError);
  });

  it('rejects an empty expression', () => {
    expect(() => parse('')).toThrowError(/Unexpected end/);
    expect(() => parse('   ')).toThrowError(/Unexpected end/);
  });

  it('rejects a lone operator', () => {
    expect(() => parse('*')).toThrow(FormulaError);
  });

  it('rejects two operators in a row (non-unary)', () => {
    expect(() => parse('1 * / 2')).toThrow(FormulaError);
  });
});

describe('parser hardening (DoS guards)', () => {
  it('rejects an over-long expression before tokenizing', () => {
    const huge = new Array(3000).fill('1').join('+');
    expect(() => parse(huge)).toThrowError(/max length/);
  });

  it('rejects deeply nested parentheses instead of overflowing the stack', () => {
    const deep = '('.repeat(500) + '1' + ')'.repeat(500);
    expect(() => parse(deep)).toThrowError(/max depth/);
  });
});
