import { describe, expect, it } from 'vitest';

import { type AstNode } from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import {
  evaluate,
  type VariableReference,
  type VariableResolver,
} from 'src/engine/evaluator';
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

// Raw resolver used for string-mode comparisons. Mirrors resolverFor's keying
// but returns unknown, so a field can resolve to a string, a non-string, or
// nothing at all.
const rawResolverFor =
  (values: Record<string, unknown>) =>
  (reference: VariableReference): unknown => {
    if (reference.kind === 'same') {
      return values[reference.path];
    }
    const key = `[${reference.ref.object}:${reference.ref.recordId}:${reference.ref.fieldPath}]`;
    return values[key];
  };

// String-mode runner: fields resolve through resolveRaw, never the numeric
// resolver, so an empty numeric resolver is correct here.
const runStr = (source: string, raw: Record<string, unknown> = {}) =>
  evaluate(parse(source), resolverFor({}), { resolveRaw: rawResolverFor(raw) });

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

describe('evaluator IF conditionals', () => {
  it('should pick the then branch when the comparison is true and the else branch when false', () => {
    expect(run('IF(inputA > 9, inputA + inputB, inputA)', { inputA: 10, inputB: 5 })).toBe(15);
    expect(run('IF(inputA > 9, inputA + inputB, inputA)', { inputA: 3, inputB: 5 })).toBe(3);
  });

  it('should evaluate the full comparison truth table when operands are numbers', () => {
    expect(run('IF(2 > 1, 1, 0)')).toBe(1);
    expect(run('IF(1 > 2, 1, 0)')).toBe(0);
    expect(run('IF(1 > 1, 1, 0)')).toBe(0);
    expect(run('IF(1 < 2, 1, 0)')).toBe(1);
    expect(run('IF(2 < 1, 1, 0)')).toBe(0);
    expect(run('IF(1 >= 1, 1, 0)')).toBe(1);
    expect(run('IF(0 >= 1, 1, 0)')).toBe(0);
    expect(run('IF(1 <= 1, 1, 0)')).toBe(1);
    expect(run('IF(2 <= 1, 1, 0)')).toBe(0);
    expect(run('IF(1 = 1, 1, 0)')).toBe(1);
    expect(run('IF(1 = 2, 1, 0)')).toBe(0);
    expect(run('IF(1 == 1, 1, 0)')).toBe(1);
    expect(run('IF(1 != 2, 1, 0)')).toBe(1);
    expect(run('IF(1 != 1, 1, 0)')).toBe(0);
  });

  it('should apply Excel truthiness when the condition is numeric', () => {
    expect(run('IF(0, 1, 2)')).toBe(2);
    expect(run('IF(1, 1, 2)')).toBe(1);
    expect(run('IF(42, 1, 2)')).toBe(1);
    expect(run('IF(-1, 1, 2)')).toBe(1);
    expect(run('IF(inputA - inputA, 1, 2)', { inputA: 7 })).toBe(2);
  });

  it('should return null when the condition itself is null', () => {
    expect(run('IF(inputA, 1, 2)', { inputA: null })).toBeNull();
  });

  it('should return null when either comparison operand is null', () => {
    expect(run('IF(inputA > 1, 1, 2)', { inputA: null })).toBeNull();
    expect(run('IF(1 > inputA, 1, 2)', { inputA: null })).toBeNull();
    expect(run('IF(inputA = inputA, 1, 2)', { inputA: null })).toBeNull();
  });

  it('should not evaluate the untaken branch when it contains a division by zero', () => {
    expect(run('IF(1 > 0, 10, 1 / 0)')).toBe(10);
    expect(run('IF(0 > 1, 1 / 0, 20)')).toBe(20);
  });

  it('should still throw when the taken branch contains a division by zero', () => {
    try {
      run('IF(1 > 0, 1 / 0, 20)');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
  });

  it('should propagate null from the taken branch when its inputs are empty', () => {
    expect(run('IF(1 > 0, inputA + 1, 2)', { inputA: null })).toBeNull();
  });

  it('should evaluate nested IFs when they appear in branches and conditions', () => {
    const source = 'IF(IF(inputA > 5, 1, 0) = 1, IF(inputB > 5, 100, 200), 300)';
    expect(run(source, { inputA: 10, inputB: 10 })).toBe(100);
    expect(run(source, { inputA: 10, inputB: 1 })).toBe(200);
    expect(run(source, { inputA: 1, inputB: 10 })).toBe(300);
  });

  it('should enforce the eval-depth guard when IFs nest past maxDepth', () => {
    const levels = 30;
    const deep = 'IF(1,'.repeat(levels) + '1' + ',0)'.repeat(levels);
    try {
      evaluate(parse(deep), resolverFor({}), { maxDepth: 16 });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('MAX_DEPTH_EXCEEDED');
    }
  });
});

describe('evaluator TODAY()', () => {
  it('resolves to the caller-supplied todayEpochDay', () => {
    expect(evaluate(parse('TODAY()'), resolverFor({}), { todayEpochDay: 20000 })).toBe(20000);
  });

  it('composes with arithmetic and field references', () => {
    expect(
      evaluate(parse('TODAY() + 100'), resolverFor({}), { todayEpochDay: 20000 }),
    ).toBe(20100);
    expect(
      evaluate(parse('IF(startDate > TODAY() + 100, 1, 0)'), resolverFor({ startDate: 20200 }), {
        todayEpochDay: 20000,
      }),
    ).toBe(1);
    expect(
      evaluate(parse('IF(startDate > TODAY() + 100, 1, 0)'), resolverFor({ startDate: 20050 }), {
        todayEpochDay: 20000,
      }),
    ).toBe(0);
  });

  it('throws UNKNOWN_VARIABLE when todayEpochDay is not supplied', () => {
    try {
      evaluate(parse('TODAY() + 1'), resolverFor({}));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('UNKNOWN_VARIABLE');
    }
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

describe('evaluator string comparisons (resolveRaw)', () => {
  it('takes the then-branch when a field raw string equals the literal', () => {
    expect(runStr('IF(status = "active", 1, 0)', { status: 'active' })).toBe(1);
  });

  it('takes the else-branch when a field raw string differs from the literal', () => {
    expect(runStr('IF(status = "active", 1, 0)', { status: 'inactive' })).toBe(0);
  });

  it('handles != in both directions', () => {
    expect(runStr('IF(status != "active", 1, 0)', { status: 'inactive' })).toBe(1);
    expect(runStr('IF(status != "active", 1, 0)', { status: 'active' })).toBe(0);
  });

  it('yields null when a field raw is null (IF result null)', () => {
    expect(runStr('IF(status = "active", 1, 0)', { status: null })).toBeNull();
  });

  it('yields null when a field raw is a number, not a string', () => {
    expect(runStr('IF(status = "active", 1, 0)', { status: 42 })).toBeNull();
  });

  it('yields null when a literal is compared against an arithmetic operand', () => {
    // "a" makes it string mode; the 1 + 2 side is not a string -> null -> IF null.
    expect(runStr('IF("a" = 1 + 2, 1, 0)')).toBeNull();
  });

  it('compares two string literals directly', () => {
    expect(runStr('IF("A" = "A", 1, 0)')).toBe(1);
    expect(runStr('IF("A" = "B", 1, 0)')).toBe(0);
  });

  it('resolves a cross-record raw string via resolveRaw', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    expect(
      runStr(`IF([company:${uuid}:name] = "Acme", 1, 0)`, {
        [`[company:${uuid}:name]`]: 'Acme',
      }),
    ).toBe(1);
    expect(
      runStr(`IF([company:${uuid}:name] = "Acme", 1, 0)`, {
        [`[company:${uuid}:name]`]: 'Other',
      }),
    ).toBe(0);
  });

  it('yields null when resolveRaw is omitted entirely', () => {
    // No resolveRaw in options -> field operand resolves to null -> IF null.
    expect(evaluate(parse('IF(status = "active", 1, 0)'), resolverFor({}))).toBeNull();
  });

  it('regression: numeric comparisons behave identically when resolveRaw is present but unused', () => {
    const raw = rawResolverFor({ status: 'active' });
    expect(
      evaluate(parse('IF(inputA > 9, inputA + inputB, inputA)'), resolverFor({ inputA: 10, inputB: 5 }), {
        resolveRaw: raw,
      }),
    ).toBe(15);
    expect(
      evaluate(parse('IF(inputA > 9, inputA + inputB, inputA)'), resolverFor({ inputA: 3, inputB: 5 }), {
        resolveRaw: raw,
      }),
    ).toBe(3);
    expect(
      evaluate(parse('IF(1 = 1, 1, 0)'), resolverFor({}), { resolveRaw: raw }),
    ).toBe(1);
  });
});

describe('evaluator exhaustiveness guard (hand-built ASTs)', () => {
  it('throws NON_NUMERIC_VALUE when a string node reaches a value position', () => {
    // The parser can never produce this: a StringNode only appears beside = / !=.
    const stringInValueSlot: AstNode = { type: 'string', value: 'x' };
    try {
      evaluate(stringInValueSlot, resolverFor({}));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('NON_NUMERIC_VALUE');
    }
  });

  it('throws NON_NUMERIC_VALUE for an unknown/future node type', () => {
    const unknownNode = { type: 'bogus' } as unknown as AstNode;
    try {
      evaluate(unknownNode, resolverFor({}));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('NON_NUMERIC_VALUE');
    }
  });
});
