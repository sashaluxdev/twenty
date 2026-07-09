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

describe('evaluator SUM()', () => {
  it('sums numeric literal arguments', () => {
    expect(run('SUM(1, 2, 3)')).toBe(6);
  });

  it('sums non-null field arguments', () => {
    expect(run('SUM(a, b, c)', { a: 10, b: 20, c: 30 })).toBe(60);
  });

  it('skips null arguments instead of treating them as 0', () => {
    // b is null -> skipped, so the total is a + c, not nulled and not a+0+c
    // via a coerced 0 (same number here, but the null is genuinely skipped).
    expect(run('SUM(a, b, c)', { a: 10, b: null, c: 5 })).toBe(15);
  });

  it('returns null when EVERY argument is null (ADR 0016, not 0)', () => {
    expect(run('SUM(a, b)', { a: null, b: null })).toBeNull();
  });

  it('returns null for a single null argument', () => {
    expect(run('SUM(a)', { a: null })).toBeNull();
  });

  it('handles a mix where a null and a real value coexist', () => {
    expect(run('SUM(a, 5)', { a: null })).toBe(5);
  });

  it('evaluates ALL arguments so an error in any argument propagates', () => {
    // Not lazy: even though the first argument alone would suffice, the
    // divide-by-zero in the second argument still fires.
    try {
      run('SUM(1, 2 / 0)');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
  });

  it('resolves TODAY() inside a SUM argument', () => {
    expect(
      evaluate(parse('SUM(a, TODAY())'), resolverFor({ a: 100 }), {
        todayEpochDay: 20000,
      }),
    ).toBe(20100);
  });

  it('nulls only the null args when TODAY() is present and a field is null', () => {
    expect(
      evaluate(parse('SUM(a, TODAY())'), resolverFor({ a: null }), {
        todayEpochDay: 20000,
      }),
    ).toBe(20000);
  });

  it('composes SUM with surrounding arithmetic under null propagation', () => {
    // SUM(...) returns null when all-null, and that null propagates through the
    // outer '+', consistent with the engine's null policy.
    expect(run('SUM(a, b) + 1', { a: null, b: null })).toBeNull();
    expect(run('SUM(a, b) + 1', { a: 4, b: null })).toBe(5);
  });
});

describe('evaluator boolean condition functions (ADR 0017)', () => {
  it('evaluates AND truth table (all true -> then, any false -> else)', () => {
    expect(run('IF(AND(a > 1, b > 1), 100, 200)', { a: 2, b: 2 })).toBe(100);
    expect(run('IF(AND(a > 1, b > 1), 100, 200)', { a: 2, b: 0 })).toBe(200);
    expect(run('IF(AND(a > 1, b > 1), 100, 200)', { a: 0, b: 0 })).toBe(200);
  });

  it('evaluates OR truth table (any true -> then, all false -> else)', () => {
    expect(run('IF(OR(a > 1, b > 1), 100, 200)', { a: 2, b: 0 })).toBe(100);
    expect(run('IF(OR(a > 1, b > 1), 100, 200)', { a: 0, b: 0 })).toBe(200);
  });

  it('evaluates NOT (inverts the truth of its argument)', () => {
    expect(run('IF(NOT(a > 1), 100, 200)', { a: 0 })).toBe(100);
    expect(run('IF(NOT(a > 1), 100, 200)', { a: 2 })).toBe(200);
  });

  it('propagates null strictly through AND when any argument truth is null', () => {
    // a is null -> a > 1 is null -> AND is null -> IF result null. No short-circuit
    // to false even though b > 1 is false.
    expect(run('IF(AND(a > 1, b > 1), 100, 200)', { a: null, b: 0 })).toBeNull();
    // Even AND(false, null) is null (strict, not Kleene).
    expect(run('IF(AND(a > 1, b > 1), 100, 200)', { a: 0, b: null })).toBeNull();
  });

  it('propagates null strictly through OR when any argument truth is null', () => {
    // OR(true, null) is null under strict propagation (not Kleene true).
    expect(run('IF(OR(a > 1, b > 1), 100, 200)', { a: 2, b: null })).toBeNull();
  });

  it('propagates null through NOT of a null argument', () => {
    expect(run('IF(NOT(a > 1), 100, 200)', { a: null })).toBeNull();
  });

  it('does NOT short-circuit — an error in any argument always fires', () => {
    // AND: the divide-by-zero in the second argument fires even though the first
    // is already false.
    try {
      run('IF(AND(a > 1, 1 / 0 > 0), 1, 0)', { a: 0 });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
    // OR: error fires even though the first argument is already true.
    try {
      run('IF(OR(a > 1, 1 / 0 > 0), 1, 0)', { a: 2 });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
  });

  it('applies STRICT null propagation to combinators mixing ISBLANK with a null-poisoned comparison', () => {
    // NOTE (ADR 0017 contradiction, flagged in the phase-1 report): the ADR
    // prose lists OR(ISBLANK(x), x > 10) / AND(NOT(ISBLANK(x)), x > 10) as
    // null-tolerance idioms, but those only work under Kleene logic, which the
    // ADR's binding decision explicitly REJECTS in favour of strict propagation.
    // Under the binding strict rule, any null argument nulls the combinator:
    // x > 10 with x=null is null, so the whole OR/AND is null regardless of
    // ISBLANK's true/false. These assertions pin the strict behaviour that the
    // engine actually implements.
    expect(run('IF(OR(ISBLANK(x), x > 10), 1, 0)', { x: null })).toBeNull();
    expect(run('IF(OR(ISBLANK(x), x > 10), 1, 0)', { x: 20 })).toBe(1);
    expect(run('IF(OR(ISBLANK(x), x > 10), 1, 0)', { x: 5 })).toBe(0);
    expect(run('IF(AND(NOT(ISBLANK(x)), x > 10), 1, 0)', { x: null })).toBeNull();
    expect(run('IF(AND(NOT(ISBLANK(x)), x > 10), 1, 0)', { x: 20 })).toBe(1);

    // The idiom that DOES tolerate null under strict semantics is IFBLANK
    // (substitute a value), the sanctioned escape hatch.
    expect(run('IF(IFBLANK(x, 0) > 10, 1, 0)', { x: null })).toBe(0);
    expect(run('IF(IFBLANK(x, 99) > 10, 1, 0)', { x: null })).toBe(1);
  });

  it('keeps IF branches lazy even when combinators wrap the condition', () => {
    // The condition is true, so the else branch (division by zero) never runs.
    expect(run('IF(AND(a > 1, b > 1), 10, 1 / 0)', { a: 2, b: 2 })).toBe(10);
  });
});

describe('evaluator ISBLANK (ADR 0017)', () => {
  it('numeric semantics without resolveRaw: null is blank, a number is not', () => {
    expect(run('IF(ISBLANK(a), 1, 0)', { a: null })).toBe(1);
    expect(run('IF(ISBLANK(a), 1, 0)', { a: 42 })).toBe(0);
    expect(run('IF(ISBLANK(a), 1, 0)', { a: 0 })).toBe(0);
  });

  it('treats a compound (arithmetic) operand as blank iff it evaluates to null', () => {
    expect(run('IF(ISBLANK(a + b), 1, 0)', { a: null, b: 3 })).toBe(1);
    expect(run('IF(ISBLANK(a + b), 1, 0)', { a: 1, b: 3 })).toBe(0);
  });

  it('never returns null itself — it observes blankness rather than propagating', () => {
    // ISBLANK(a) with a=null is TRUE (blank), so the IF is NOT nulled.
    expect(run('IF(ISBLANK(a), 100, 200)', { a: null })).toBe(100);
  });

  it('still throws UNKNOWN_VARIABLE for a typo field inside ISBLANK', () => {
    try {
      run('IF(ISBLANK(doesNotExist), 1, 0)', {});
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('UNKNOWN_VARIABLE');
    }
  });

  it('raw-first: an empty string is blank, whitespace-only is blank, non-empty is not', () => {
    expect(runStr('IF(ISBLANK(email), 1, 0)', { email: '' })).toBe(1);
    expect(runStr('IF(ISBLANK(email), 1, 0)', { email: '   ' })).toBe(1);
    expect(runStr('IF(ISBLANK(email), 1, 0)', { email: 'a@b.com' })).toBe(0);
  });

  it('raw-first falls back to numeric when the raw value is not a string', () => {
    // A number raw -> resolveRaw returns non-string -> numeric fallback. But the
    // numeric resolver here is empty, so the field is truly unknown -> throws.
    // Use a resolver that has the numeric value to exercise the fallback cleanly.
    const raw = rawResolverFor({ a: 42 });
    expect(
      evaluate(parse('IF(ISBLANK(a), 1, 0)'), resolverFor({ a: 42 }), {
        resolveRaw: raw,
      }),
    ).toBe(0);
    expect(
      evaluate(parse('IF(ISBLANK(a), 1, 0)'), resolverFor({ a: null }), {
        resolveRaw: rawResolverFor({ a: 42 }),
      }),
    ).toBe(1);
  });

  it('raw-first: a missing cross record reads as blank (numeric fallback null)', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    expect(
      evaluate(
        parse(`IF(ISBLANK([company:${uuid}:name]), 1, 0)`),
        resolverFor({ [`[company:${uuid}:name]`]: null }),
        { resolveRaw: rawResolverFor({}) },
      ),
    ).toBe(1);
  });
});

describe('evaluator IFBLANK (ADR 0017)', () => {
  it('returns the value when it is non-null', () => {
    expect(run('IFBLANK(a, 0)', { a: 42 })).toBe(42);
    expect(run('IFBLANK(a, 99)', { a: 0 })).toBe(0);
  });

  it('returns the fallback when the value is null', () => {
    expect(run('IFBLANK(a, 0)', { a: null })).toBe(0);
    expect(run('IFBLANK(a, b)', { a: null, b: 7 })).toBe(7);
  });

  it('returns a null fallback (blank stays blank)', () => {
    expect(run('IFBLANK(a, b)', { a: null, b: null })).toBeNull();
  });

  it('evaluates BOTH arguments so an error in the fallback fires even when unused', () => {
    try {
      run('IFBLANK(a, 1 / 0)', { a: 42 });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
  });

  it('composes as the documented null-propagation escape hatch', () => {
    expect(run('revenue + IFBLANK(upsell, 0)', { revenue: 100, upsell: null })).toBe(100);
    expect(run('IF(AND(stage > 0, IFBLANK(amount, 0) > 1000), 1, 0)', { stage: 1, amount: null })).toBe(0);
    expect(run('IF(AND(stage > 0, IFBLANK(amount, 0) > 1000), 1, 0)', { stage: 1, amount: 2000 })).toBe(1);
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

  it('yields null for != when the field raw is null (null-propagation beats != intuition)', () => {
    // A naive reading of `status != "active"` on an empty field might expect
    // "true" (null is not "active"); the app's null-propagation policy overrides
    // that — a null operand nulls the whole IF regardless of the operator.
    expect(runStr('IF(status != "active", 1, 0)', { status: null })).toBeNull();
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

  it('fails loud when a condition node reaches a value slot (ADR 0017)', () => {
    // The parser can never produce these in a value slot — they are transient
    // condition nodes like ComparisonNode. Guard for hand-built ASTs.
    const nodes: AstNode[] = [
      { type: 'and', args: [{ type: 'number', value: 1 }, { type: 'number', value: 1 }] },
      { type: 'or', args: [{ type: 'number', value: 1 }, { type: 'number', value: 1 }] },
      { type: 'not', operand: { type: 'number', value: 1 } },
      { type: 'isblank', operand: { type: 'number', value: 1 } },
    ];
    for (const node of nodes) {
      try {
        evaluate(node, resolverFor({}));
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(FormulaError);
        expect((error as FormulaError).code).toBe('PARSE_ERROR');
      }
    }
  });
});
