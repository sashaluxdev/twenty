import { describe, expect, it } from 'vitest';

import { FormulaError } from 'src/engine/errors';
import { evaluate, type VariableResolver } from 'src/engine/evaluator';
import { parse } from 'src/engine/parser';

const resolverFor =
  (values: Record<string, number | null | undefined>): VariableResolver =>
  (reference) => {
    if (reference.kind === 'same') {
      return values[reference.path];
    }
    const key = `[${reference.ref.object}:${reference.ref.recordId}:${reference.ref.fieldPath}]`;
    return values[key];
  };

const run = (
  source: string,
  values: Record<string, number | null | undefined> = {},
) => evaluate(parse(source), resolverFor(values));

describe('evaluator arithmetic', () => {
  it('evaluates the a + b * 2 acceptance formula', () => {
    expect(run('inputA + inputB * 2', { inputA: 5, inputB: 10 })).toBe(25);
  });

  it('resolves cross-record references', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    expect(
      run(`inputA + [company:${uuid}:employees]`, {
        inputA: 3,
        [`[company:${uuid}:employees]`]: 40,
      }),
    ).toBe(43);
  });

  it('resolves composite sub-paths (e.g. currency micros)', () => {
    expect(run('amount.amountMicros / 1000000', { 'amount.amountMicros': 5_000_000 })).toBe(5);
  });
});

describe('evaluator null policy (null propagates)', () => {
  it('returns null when any operand is null', () => {
    expect(run('inputA + inputB', { inputA: 5, inputB: null })).toBeNull();
    expect(run('inputA * inputB', { inputA: 0, inputB: null })).toBeNull();
    expect(run('-inputA', { inputA: null })).toBeNull();
  });

  it('does not treat null as zero', () => {
    // If null were coalesced to 0 this would be 5; null propagation makes it null.
    expect(run('inputA + inputB', { inputA: 5, inputB: null })).toBeNull();
  });

  it('computes normally when all operands are present', () => {
    expect(run('inputA + inputB', { inputA: 5, inputB: 0 })).toBe(5);
  });
});

describe('evaluator errors', () => {
  it('throws UNKNOWN_VARIABLE for a missing field', () => {
    try {
      run('doesNotExist + 1', {});
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('UNKNOWN_VARIABLE');
    }
  });

  it('throws DIVISION_BY_ZERO on divide by zero', () => {
    try {
      run('1 / 0');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
  });

  it('throws DIVISION_BY_ZERO on modulo by zero', () => {
    try {
      run('5 % 0');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
  });

  it('distinguishes divide-by-zero from divide-by-null (null wins)', () => {
    expect(run('1 / inputA', { inputA: null })).toBeNull();
  });

  it('enforces max depth at runtime', () => {
    // Parentheses collapse in the AST, so nest via left-associative operators to
    // build genuine AST depth: 1+1+1+... -> binary(binary(...),1).
    const deep = new Array(100).fill('1').join('+');
    try {
      evaluate(parse(deep), resolverFor({}), { maxDepth: 32 });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('MAX_DEPTH_EXCEEDED');
    }
  });
});
