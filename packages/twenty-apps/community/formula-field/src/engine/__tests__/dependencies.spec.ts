import { describe, expect, it } from 'vitest';

import {
  collectStringComparisonRefs,
  extractDependencies,
  usesToday,
} from 'src/engine/dependencies';
import { parse } from 'src/engine/parser';

const UUID = '20202020-1c25-4d02-bf25-6aeccf7ea419';
const UUID2 = 'ac4d683d-f20b-4728-9ab0-7d52938dd36b';

describe('dependency extraction', () => {
  it('collects same-record fields', () => {
    const deps = extractDependencies('inputA + inputB * 2');
    expect(deps.sameRecordFields).toEqual(['inputA', 'inputB']);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('reduces composite paths to their root field', () => {
    const deps = extractDependencies('amount.amountMicros + amount.currencyCode');
    // Both sub-paths depend on the single root field "amount".
    expect(deps.sameRecordFields).toEqual(['amount']);
  });

  it('deduplicates repeated fields', () => {
    const deps = extractDependencies('inputA + inputA + inputA');
    expect(deps.sameRecordFields).toEqual(['inputA']);
  });

  it('collects cross-record references at field granularity', () => {
    const deps = extractDependencies(
      `inputA + [company:${UUID}:employees] + [company:${UUID}:employees.value]`,
    );
    expect(deps.sameRecordFields).toEqual(['inputA']);
    // Both refs reduce to the same (object, recordId, root field).
    expect(deps.crossRecordRefs).toEqual([
      {
        object: 'company',
        recordId: UUID,
        field: 'employees',
        fieldPath: 'employees',
      },
    ]);
  });

  it('keeps distinct cross-record references separate', () => {
    const deps = extractDependencies(
      `[company:${UUID}:employees] + [company:${UUID2}:employees]`,
    );
    expect(deps.crossRecordRefs).toHaveLength(2);
  });

  it('returns empty dependencies for a constant expression', () => {
    const deps = extractDependencies('1 + 2 * 3');
    expect(deps.sameRecordFields).toEqual([]);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('should collect refs from the condition and BOTH branches when the formula is an IF', () => {
    // Eager extraction: the untaken branch is never evaluated, but a change to
    // any of its inputs can flip which branch is taken next time.
    const deps = extractDependencies('IF(condA > condB, thenField, elseField)');
    expect(deps.sameRecordFields).toEqual([
      'condA',
      'condB',
      'elseField',
      'thenField',
    ]);
  });

  it('should collect cross-record refs from IF branches when they reference other records', () => {
    const deps = extractDependencies(
      `IF(inputA > 0, [company:${UUID}:employees], [company:${UUID2}:revenue.amountMicros])`,
    );
    expect(deps.sameRecordFields).toEqual(['inputA']);
    expect(deps.crossRecordRefs).toEqual([
      {
        object: 'company',
        recordId: UUID,
        field: 'employees',
        fieldPath: 'employees',
      },
      {
        object: 'company',
        recordId: UUID2,
        field: 'revenue',
        fieldPath: 'revenue.amountMicros',
      },
    ]);
  });

  it('should collect refs from a numeric condition when no comparison is written', () => {
    const deps = extractDependencies('IF(flagField, 1, 2)');
    expect(deps.sameRecordFields).toEqual(['flagField']);
  });

  it('should collect fields from a condition that compares against a string literal', () => {
    const deps = extractDependencies('IF(status = "X", a, b)');
    expect(deps.sameRecordFields).toEqual(['a', 'b', 'status']);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('should contribute no dependency for the string literal itself', () => {
    const deps = extractDependencies('IF("a" = "b", 1, 2)');
    expect(deps.sameRecordFields).toEqual([]);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('should treat TODAY() as a dependency-free no-op', () => {
    const deps = extractDependencies('TODAY() + 100');
    expect(deps.sameRecordFields).toEqual([]);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('should still collect field dependencies from an expression that also uses TODAY()', () => {
    const deps = extractDependencies('IF(startDate > TODAY() + 100, 1, 0)');
    expect(deps.sameRecordFields).toEqual(['startDate']);
    expect(deps.crossRecordRefs).toEqual([]);
  });
});

describe('usesToday', () => {
  it('detects TODAY() alone', () => {
    expect(usesToday(parse('TODAY()'))).toBe(true);
  });

  it('detects TODAY() inside a binary expression', () => {
    expect(usesToday(parse('TODAY() + 100'))).toBe(true);
  });

  it('detects TODAY() in an IF condition', () => {
    expect(usesToday(parse('IF(a > TODAY(), 1, 2)'))).toBe(true);
  });

  it('detects TODAY() in the THEN branch', () => {
    expect(usesToday(parse('IF(a, TODAY(), 2)'))).toBe(true);
  });

  it('detects TODAY() in the ELSE branch', () => {
    expect(usesToday(parse('IF(a, 1, TODAY())'))).toBe(true);
  });

  it('returns false for an expression with no TODAY()', () => {
    expect(usesToday(parse('a + b * 2'))).toBe(false);
  });

  it('returns false for a cross-record reference with no TODAY()', () => {
    expect(usesToday(parse(`[object:${UUID}:field] + 1`))).toBe(false);
  });

  it('returns false when a string literal is present but TODAY() is not', () => {
    expect(usesToday(parse('IF(status = "X", 1, 2)'))).toBe(false);
  });

  it('detects TODAY() nested under unary negation', () => {
    expect(usesToday(parse('-(TODAY())'))).toBe(true);
  });
});

describe('collectStringComparisonRefs', () => {
  it('collects a same-record field compared against a string literal', () => {
    const refs = collectStringComparisonRefs(parse('IF(status = "active", 1, 0)'));
    expect(refs.sameRecordPaths).toEqual(['status']);
    expect(refs.crossRefs).toEqual([]);
  });

  it('collects a cross-record ref compared against a string literal', () => {
    const refs = collectStringComparisonRefs(
      parse(`IF([company:${UUID}:name] = "Acme", 1, 0)`),
    );
    expect(refs.sameRecordPaths).toEqual([]);
    expect(refs.crossRefs).toEqual([
      { object: 'company', recordId: UUID, fieldPath: 'name' },
    ]);
  });

  it('ignores two string literals compared directly (no field operand)', () => {
    const refs = collectStringComparisonRefs(parse('IF("A" = "B", 1, 0)'));
    expect(refs.sameRecordPaths).toEqual([]);
    expect(refs.crossRefs).toEqual([]);
  });

  it('ignores a purely numeric comparison (not string mode)', () => {
    const refs = collectStringComparisonRefs(parse('IF(amount > 5, amount, 0)'));
    expect(refs.sameRecordPaths).toEqual([]);
    expect(refs.crossRefs).toEqual([]);
  });

  it('does not collect the IF branches, only the compared operand', () => {
    const refs = collectStringComparisonRefs(
      parse('IF(stage = "QUALIFIED", branchA, branchB)'),
    );
    expect(refs.sameRecordPaths).toEqual(['stage']);
  });

  it('finds a string comparison nested inside an operand sub-IF', () => {
    const refs = collectStringComparisonRefs(
      parse('IF(IF(status = "x", 1, 0) = 1, tier, 0)'),
    );
    expect(refs.sameRecordPaths).toEqual(['status']);
  });

  it('deduplicates and sorts collected same-record paths', () => {
    const refs = collectStringComparisonRefs(
      parse('IF(tier = "gold", IF(stage = "NEW", 1, IF(tier = "gold", 2, 3)), 0)'),
    );
    expect(refs.sameRecordPaths).toEqual(['stage', 'tier']);
  });
});
