import { describe, expect, it } from 'vitest';

import { type AstNode } from 'src/engine/ast';
import { FormulaError } from 'src/engine/errors';
import {
  type EngineValue,
  evaluate,
  type VariableResolver,
} from 'src/engine/evaluator';
import { parse } from 'src/engine/parser';

const resolverFor =
  (values: Record<string, EngineValue | undefined>): VariableResolver =>
  (reference) => {
    if (reference.kind === 'same') {
      return values[reference.path];
    }
    const key = `[${reference.ref.object}:${reference.ref.recordId}:${reference.ref.fieldPath}]`;
    return values[key];
  };

const run = (
  source: string,
  values: Record<string, EngineValue | undefined> = {},
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

  it('combines AND with a null argument by Kleene rule (a false argument wins over null)', () => {
    // a is null -> a > 1 is null; b > 1 is false. Kleene AND: any false wins, so
    // AND is false -> IF else branch. NO short-circuit (b is still evaluated).
    expect(run('IF(AND(a > 1, b > 1), 100, 200)', { a: null, b: 0 })).toBe(200);
    // AND(false, null) is false (false dominates), regardless of argument order.
    expect(run('IF(AND(a > 1, b > 1), 100, 200)', { a: 0, b: null })).toBe(200);
    // AND(true, null) is null (no false to dominate; a null remains) -> IF null.
    expect(run('IF(AND(a > 1, b > 1), 100, 200)', { a: 2, b: null })).toBeNull();
  });

  it('combines OR with a null argument by Kleene rule (a true argument wins over null)', () => {
    // OR(true, null) is true (a true dominates) -> IF then branch.
    expect(run('IF(OR(a > 1, b > 1), 100, 200)', { a: 2, b: null })).toBe(100);
    // OR(false, null) is null (no true to dominate; a null remains) -> IF null.
    expect(run('IF(OR(a > 1, b > 1), 100, 200)', { a: 0, b: null })).toBeNull();
  });

  it('covers the full Kleene truth table for AND (false>null>true dominance)', () => {
    // Encode T with a>0 where the field is 1, F with the field 0, N with null.
    const and = (a: number | null, b: number | null) =>
      run('IF(AND(a > 0, b > 0), 1, 0)', { a, b });
    expect(and(1, 1)).toBe(1); // T,T -> T
    expect(and(1, 0)).toBe(0); // T,F -> F
    expect(and(0, 0)).toBe(0); // F,F -> F
    expect(and(1, null)).toBeNull(); // T,N -> N
    expect(and(0, null)).toBe(0); // F,N -> F
    expect(and(null, null)).toBeNull(); // N,N -> N
  });

  it('covers the full Kleene truth table for OR (true>null>false dominance)', () => {
    const or = (a: number | null, b: number | null) =>
      run('IF(OR(a > 0, b > 0), 1, 0)', { a, b });
    expect(or(1, 1)).toBe(1); // T,T -> T
    expect(or(1, 0)).toBe(1); // T,F -> T
    expect(or(0, 0)).toBe(0); // F,F -> F
    expect(or(1, null)).toBe(1); // T,N -> T
    expect(or(0, null)).toBeNull(); // F,N -> N
    expect(or(null, null)).toBeNull(); // N,N -> N
  });

  it('applies Kleene through nesting like OR(AND(a, b), c) with mixed nulls', () => {
    // AND(true, null) = null; OR(null, true) = true -> then branch.
    expect(run('IF(OR(AND(a > 0, b > 0), c > 0), 100, 200)', { a: 1, b: null, c: 1 })).toBe(100);
    // AND(false, null) = false; OR(false, false) = false -> else branch.
    expect(run('IF(OR(AND(a > 0, b > 0), c > 0), 100, 200)', { a: 0, b: null, c: 0 })).toBe(200);
    // AND(true, null) = null; OR(null, false) = null -> IF null.
    expect(run('IF(OR(AND(a > 0, b > 0), c > 0), 100, 200)', { a: 1, b: null, c: 0 })).toBeNull();
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

  it('makes the ADR 0017 null-tolerance idioms work under Kleene', () => {
    // OR(ISBLANK(x), x > 10) = "blank OR big": under Kleene the true ISBLANK
    // dominates the null from x > 10, so a blank x takes the then branch.
    expect(run('IF(OR(ISBLANK(x), x > 10), 1, 0)', { x: null })).toBe(1);
    expect(run('IF(OR(ISBLANK(x), x > 10), 1, 0)', { x: 20 })).toBe(1);
    expect(run('IF(OR(ISBLANK(x), x > 10), 1, 0)', { x: 5 })).toBe(0);
    // AND(NOT(ISBLANK(x)), x > 10) = "present AND big": a blank x makes
    // NOT(ISBLANK(x)) false, which dominates the null from x > 10, so AND is
    // false (fail-when-blank), not null.
    expect(run('IF(AND(NOT(ISBLANK(x)), x > 10), 1, 0)', { x: null })).toBe(0);
    expect(run('IF(AND(NOT(ISBLANK(x)), x > 10), 1, 0)', { x: 20 })).toBe(1);
    expect(run('IF(AND(NOT(ISBLANK(x)), x > 10), 1, 0)', { x: 5 })).toBe(0);

    // The IFBLANK escape hatch (substitute a value) still works too.
    expect(run('IF(IFBLANK(x, 0) > 10, 1, 0)', { x: null })).toBe(0);
    expect(run('IF(IFBLANK(x, 99) > 10, 1, 0)', { x: null })).toBe(1);
  });

  it('makes the ADR 0017 idioms work on a text field (empty string)', () => {
    // An empty-string field is blank, so OR(ISBLANK(email), ...) skips-when-blank
    // and AND(NOT(ISBLANK(email)), ...) fails-when-blank exactly as advertised —
    // no null leaks out.
    expect(run('IF(OR(ISBLANK(email), email = "vip@x.com"), 1, 0)', { email: '' })).toBe(1);
    expect(run('IF(OR(ISBLANK(email), email = "vip@x.com"), 1, 0)', { email: 'vip@x.com' })).toBe(1);
    expect(run('IF(OR(ISBLANK(email), email = "vip@x.com"), 1, 0)', { email: 'other@x.com' })).toBe(0);
    expect(run('IF(AND(NOT(ISBLANK(email)), email = "vip@x.com"), 1, 0)', { email: '' })).toBe(0);
    expect(run('IF(AND(NOT(ISBLANK(email)), email = "vip@x.com"), 1, 0)', { email: 'vip@x.com' })).toBe(1);
  });

  it('still fires errors in EVERY argument even when the result is already determined (no short-circuit)', () => {
    // OR is already true from the first argument, but the divide-by-zero in the
    // second still fires — evaluate-everything is untouched by Kleene.
    try {
      run('IF(OR(1 > 0, 1 / 0 > 2), 1, 0)');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
    // AND is already false from the first argument, but the divide-by-zero in
    // the second still fires (it is NOT collapsed to false without evaluating).
    try {
      run('IF(AND(1 > 2, 1 / 0 > 2), 1, 0)');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
  });

  it('keeps IF branches lazy even when combinators wrap the condition', () => {
    // The condition is true, so the else branch (division by zero) never runs.
    expect(run('IF(AND(a > 1, b > 1), 10, 1 / 0)', { a: 2, b: 2 })).toBe(10);
  });
});

describe('evaluator ISBLANK (ADR 0017)', () => {
  it('numeric semantics: null is blank, a number is not', () => {
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

  it('text: an empty string is blank, whitespace-only is blank, non-empty is not', () => {
    expect(run('IF(ISBLANK(email), 1, 0)', { email: '' })).toBe(1);
    expect(run('IF(ISBLANK(email), 1, 0)', { email: '   ' })).toBe(1);
    expect(run('IF(ISBLANK(email), 1, 0)', { email: 'a@b.com' })).toBe(0);
  });

  it('never treats numeric-shaped or zero-like text as blank', () => {
    // Blankness is observed on the TEXT, not on what it would coerce to: "0"
    // is content, so it is not blank (and neither is the number 0).
    expect(run('IF(ISBLANK(a), 1, 0)', { a: '0' })).toBe(0);
    expect(run('IF(ISBLANK(a), 1, 0)', { a: 0 })).toBe(0);
  });

  it('a missing cross record reads as blank (resolves to null)', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    expect(
      run(`IF(ISBLANK([company:${uuid}:name]), 1, 0)`, {
        [`[company:${uuid}:name]`]: null,
      }),
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

describe('evaluator IFS / SWITCH sugar (ADR 0018)', () => {
  it('evaluates an IFS range ladder rung by rung', () => {
    const ladder = 'IFS(score >= 90, 5, score >= 70, 4, score >= 50, 3, 0)';
    expect(run(ladder, { score: 95 })).toBe(5);
    expect(run(ladder, { score: 75 })).toBe(4);
    expect(run(ladder, { score: 55 })).toBe(3);
    expect(run(ladder, { score: 40 })).toBe(0);
  });

  it('returns null when no rung matches and there is no default (inherited from the NullNode else)', () => {
    expect(run('IFS(a > 100, 1, b > 100, 2)', { a: 1, b: 1 })).toBeNull();
  });

  it('short-circuits down the ladder: a later rung condition is never evaluated once an earlier rung matches', () => {
    // Rung 2's condition divides by zero. When rung 1 matches, that condition
    // lives in an untaken else branch (inherited IF laziness), so it never fires.
    expect(run('IFS(a > 0, 100, 1 / 0 > 5, 200, 300)', { a: 1 })).toBe(100);
  });

  it('DOES hit a later rung condition error when earlier rungs miss (proves the short-circuit is real)', () => {
    try {
      run('IFS(a > 0, 100, 1 / 0 > 5, 200, 300)', { a: -1 });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('DIVISION_BY_ZERO');
    }
  });

  it('evaluates an ADR 0017 combinator used as a rung condition', () => {
    const ladder = 'IFS(AND(a > 1, b > 1), 100, OR(a > 1, b > 1), 50, 0)';
    expect(run(ladder, { a: 2, b: 2 })).toBe(100);
    expect(run(ladder, { a: 2, b: 0 })).toBe(50);
    expect(run(ladder, { a: 0, b: 0 })).toBe(0);
  });

  it('maps a string SELECT field with SWITCH', () => {
    const ladder = 'SWITCH(stage, "lead", 1, "qualified", 2, "won", 3, 0)';
    expect(run(ladder, { stage: 'lead' })).toBe(1);
    expect(run(ladder, { stage: 'qualified' })).toBe(2);
    expect(run(ladder, { stage: 'won' })).toBe(3);
    expect(run(ladder, { stage: 'lost' })).toBe(0);
  });

  it('nulls the whole SWITCH ladder when the subject field is blank (first-rung null propagation)', () => {
    // A blank subject makes `stage = "lead"` null at the FIRST rung, so the
    // whole ladder is null — even though a default 0 is present (ADR 0018).
    expect(run('SWITCH(stage, "lead", 1, "won", 2, 0)', { stage: null })).toBeNull();
  });

  it('nulls a numeric SWITCH when the subject is null', () => {
    expect(run('SWITCH(x, 1, 10, 2, 20, 0)', { x: null })).toBeNull();
  });

  it('recovers a blank numeric subject with an IFBLANK-wrapped SWITCH subject', () => {
    // IFBLANK(x, 0) turns the blank into 0, so `0 = 0` matches the first rung.
    expect(run('SWITCH(IFBLANK(x, 0), 0, 10, 1, 20, 99)', { x: null })).toBe(10);
    expect(run('SWITCH(IFBLANK(x, 0), 0, 10, 1, 20, 99)', { x: 1 })).toBe(20);
    expect(run('SWITCH(IFBLANK(x, 0), 0, 10, 1, 20, 99)', { x: 5 })).toBe(99);
  });

  it('maps a numeric SELECT-like field with SWITCH', () => {
    const ladder = 'SWITCH(tier, 1, 10, 2, 20, 3, 30, 0)';
    expect(run(ladder, { tier: 1 })).toBe(10);
    expect(run(ladder, { tier: 2 })).toBe(20);
    expect(run(ladder, { tier: 9 })).toBe(0);
  });

  it('trips the eval-depth guard gracefully when an all-miss ladder descends past DEFAULT_MAX_DEPTH', () => {
    // Each rung desugars to one IF frame; with every condition false (`0`) the
    // evaluator walks the whole else chain, so descent depth equals the rung
    // count. DEFAULT_MAX_DEPTH is 64, and MAX_PARSE_DEPTH is 200, so 65 rungs is
    // squarely inside the window where PARSE passes but EVAL trips: 64 rungs
    // evaluate to the default, 65 exceed the guard. A raw ~65-deep ladder is a
    // pathological but legal expression — it must fail loud with
    // MAX_DEPTH_EXCEEDED, never blow the JS stack.
    const rungs = 65;
    const source =
      'IFS(' + Array.from({ length: rungs }, () => '0, 1').join(', ') + ', 999)';
    const parsed = parse(source); // parse succeeds (well under MAX_PARSE_DEPTH)
    try {
      evaluate(parsed, resolverFor({}));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).code).toBe('MAX_DEPTH_EXCEEDED');
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

describe('evaluator typed value domain', () => {
  it('resolves text fields verbatim and compares typed', () => {
    const values = { zip: '01234', amount: 42 };
    expect(run('IF(zip = "01234", 1, 0)', values)).toBe(1);
    // B1: `=` is typed and non-coercing, so a number never equals its text form.
    expect(run('IF(amount = "42", 1, 0)', values)).toBe(0);
    expect(run('IF(amount != "42", 1, 0)', values)).toBe(1);
  });

  it('coerces numeric-shaped text at point of use in arithmetic', () => {
    const values = { zip: '01234' };
    expect(run('zip + 1', values)).toBe(1235);
    // Concatenation evaluation lands in the next task; until then it is
    // unhandled by the value switch.
    expect(() => run('zip & 1', values)).toThrow();
  });

  it('treats empty text as non-numeric, not zero', () => {
    // Number('') is 0 — the empty-string guard is what stops a blank text field
    // from silently arithmetically behaving like a zero.
    expect(() => run('note + 1', { note: '' })).toThrow(FormulaError);
  });

  it('ISBLANK sees whitespace-only text as blank via the value domain', () => {
    const values = { note: '   ', name: 'x' };
    expect(run('IF(ISBLANK(note), 1, 0)', values)).toBe(1);
    expect(run('IF(ISBLANK(name), 1, 0)', values)).toBe(0);
  });

  it('compares two text fields without erroring', () => {
    // B4: no string literal is involved, so the old string mode never fired and
    // both operands went through the numeric resolver.
    expect(run('IF(a = b, 1, 0)', { a: 'won', b: 'won' })).toBe(1);
    expect(run('IF(a = b, 1, 0)', { a: 'won', b: 'lost' })).toBe(0);
  });

  it('orders text fields by their numeric value at point of use', () => {
    expect(run('IF(a > b, 1, 0)', { a: '10', b: '9' })).toBe(1);
    expect(() => run('IF(a > b, 1, 0)', { a: 'won', b: '9' })).toThrow(
      FormulaError,
    );
  });

  it('keeps text out of numeric truthiness unless it is numeric-shaped', () => {
    expect(run('IF(flag, 1, 0)', { flag: '0' })).toBe(0);
    expect(run('IF(flag, 1, 0)', { flag: '3' })).toBe(1);
    expect(() => run('IF(flag, 1, 0)', { flag: 'yes' })).toThrow(FormulaError);
  });
});

describe('evaluator string comparisons (typed value domain)', () => {
  it('takes the then-branch when a text field equals the literal', () => {
    expect(run('IF(status = "active", 1, 0)', { status: 'active' })).toBe(1);
  });

  it('takes the else-branch when a text field differs from the literal', () => {
    expect(run('IF(status = "active", 1, 0)', { status: 'inactive' })).toBe(0);
  });

  it('handles != in both directions', () => {
    expect(run('IF(status != "active", 1, 0)', { status: 'inactive' })).toBe(1);
    expect(run('IF(status != "active", 1, 0)', { status: 'active' })).toBe(0);
  });

  it('yields null for != when the field is null (null-propagation beats != intuition)', () => {
    // A naive reading of `status != "active"` on an empty field might expect
    // "true" (null is not "active"); the app's null-propagation policy overrides
    // that — a null operand nulls the whole IF regardless of the operator.
    expect(run('IF(status != "active", 1, 0)', { status: null })).toBeNull();
  });

  it('yields null when the field is null (IF result null)', () => {
    expect(run('IF(status = "active", 1, 0)', { status: null })).toBeNull();
  });

  it('compares FALSE, not null, when the field is a number (B4)', () => {
    // Typed equality: a number and a text literal are simply unequal, so the
    // else branch runs instead of the whole IF nulling out.
    expect(run('IF(status = "active", 1, 0)', { status: 42 })).toBe(0);
    expect(run('IF(status != "active", 1, 0)', { status: 42 })).toBe(1);
  });

  it('compares FALSE when a literal is compared against an arithmetic operand', () => {
    expect(run('IF("a" = 1 + 2, 1, 0)')).toBe(0);
  });

  it('compares two string literals directly', () => {
    expect(run('IF("A" = "A", 1, 0)')).toBe(1);
    expect(run('IF("A" = "B", 1, 0)')).toBe(0);
  });

  it('resolves a cross-record text value', () => {
    const uuid = '20202020-1c25-4d02-bf25-6aeccf7ea419';
    expect(
      run(`IF([company:${uuid}:name] = "Acme", 1, 0)`, {
        [`[company:${uuid}:name]`]: 'Acme',
      }),
    ).toBe(1);
    expect(
      run(`IF([company:${uuid}:name] = "Acme", 1, 0)`, {
        [`[company:${uuid}:name]`]: 'Other',
      }),
    ).toBe(0);
  });

  it('throws UNKNOWN_VARIABLE for an unresolvable field in a text comparison', () => {
    // The single resolver puts a text comparison under the same typo protection
    // as arithmetic; the old raw channel silently nulled the IF instead.
    try {
      run('IF(status = "active", 1, 0)', {});
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as FormulaError).code).toBe('UNKNOWN_VARIABLE');
    }
  });

  it('regression: numeric comparisons behave identically alongside text values', () => {
    const values = { inputA: 10, inputB: 5, status: 'active' };
    expect(run('IF(inputA > 9, inputA + inputB, inputA)', values)).toBe(15);
    expect(
      run('IF(inputA > 9, inputA + inputB, inputA)', { ...values, inputA: 3 }),
    ).toBe(3);
    expect(run('IF(1 = 1, 1, 0)', values)).toBe(1);
  });
});

describe('evaluator exhaustiveness guard (hand-built ASTs)', () => {
  it('evaluates a string node in a value position to its text', () => {
    // A StringNode is an ordinary value now that the domain carries text, so it
    // is no longer part of the guard — it evaluates like any other literal.
    const stringInValueSlot: AstNode = { type: 'string', value: 'x' };
    expect(evaluate(stringInValueSlot, resolverFor({}))).toBe('x');
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
        // The guard message matches the parser-reachable wording verbatim.
        expect((error as FormulaError).message).toMatch(
          /\(\.\.\.\) is only allowed inside an IF condition/,
        );
      }
    }
  });
});
