import { describe, expect, it } from 'vitest';

import {
  bareReferenceOf,
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

  it('should eagerly union field dependencies across ALL SUM arguments (ADR 0016)', () => {
    const deps = extractDependencies('SUM(a, b, c)');
    expect(deps.sameRecordFields).toEqual(['a', 'b', 'c']);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('should collect dependencies from nested expressions inside SUM arguments', () => {
    const deps = extractDependencies(`SUM(a + b, [company:${UUID}:revenue])`);
    expect(deps.sameRecordFields).toEqual(['a', 'b']);
    expect(deps.crossRecordRefs).toEqual([
      { object: 'company', recordId: UUID, field: 'revenue', fieldPath: 'revenue' },
    ]);
  });

  it('should collect dependencies through AND/OR/NOT combinators (ADR 0017)', () => {
    const deps = extractDependencies(
      'IF(AND(OR(a > 1, b > 2), NOT(c = 0)), 1, 0)',
    );
    expect(deps.sameRecordFields).toEqual(['a', 'b', 'c']);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('should collect the ISBLANK operand as a real dependency (ADR 0017)', () => {
    const deps = extractDependencies('IF(ISBLANK(email), 1, other)');
    expect(deps.sameRecordFields).toEqual(['email', 'other']);
  });

  it('should collect both IFBLANK arguments as dependencies (ADR 0017)', () => {
    const deps = extractDependencies('IFBLANK(a, b)');
    expect(deps.sameRecordFields).toEqual(['a', 'b']);
  });

  it('should collect cross-record refs nested inside combinators (ADR 0017)', () => {
    const deps = extractDependencies(
      `IF(AND(ISBLANK([company:${UUID}:name]), a > 1), 1, 0)`,
    );
    expect(deps.sameRecordFields).toEqual(['a']);
    expect(deps.crossRecordRefs).toEqual([
      { object: 'company', recordId: UUID, field: 'name', fieldPath: 'name' },
    ]);
  });

  // ADR 0018: IFS/SWITCH desugar to nested IfNodes, so dependency extraction
  // reaches every rung's condition and value with NO production change — the
  // existing 'if' walk case does all the work. These tests document that.
  it('should collect every rung condition and value across a desugared IFS ladder', () => {
    const deps = extractDependencies('IFS(a > 1, x, b > 2, y, z)');
    expect(deps.sameRecordFields).toEqual(['a', 'b', 'x', 'y', 'z']);
  });

  it('should collect the subject and all rung values across a desugared SWITCH ladder', () => {
    const deps = extractDependencies('SWITCH(stage, 1, x, 2, y, z)');
    // `stage` is the shared subject of every rung comparison; x/y are rung
    // values; z is the default. The subject dedupes despite N-fold duplication.
    expect(deps.sameRecordFields).toEqual(['stage', 'x', 'y', 'z']);
  });

  it('should contribute no dependency for a default-less ladder NullNode else', () => {
    const deps = extractDependencies('IFS(a > 1, x)');
    expect(deps.sameRecordFields).toEqual(['a', 'x']);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('should union every operand of a concatenation', () => {
    const deps = extractDependencies(`a & "-" & [company:${UUID}:name]`);
    expect(deps.sameRecordFields).toEqual(['a']);
    expect(deps.crossRecordRefs).toEqual([
      {
        object: 'company',
        recordId: UUID,
        field: 'name',
        fieldPath: 'name',
      },
    ]);
  });

  it('should contribute no dependency for a DATE() literal (parse-time constant)', () => {
    const deps = extractDependencies('DATE("2026-01-15")');
    expect(deps.sameRecordFields).toEqual([]);
    expect(deps.crossRecordRefs).toEqual([]);
  });

  it('should collect the operand as a dependency for NUMBER() and TEXT()', () => {
    expect(extractDependencies('NUMBER(code)').sameRecordFields).toEqual(['code']);
    expect(extractDependencies('TEXT(amount)').sameRecordFields).toEqual(['amount']);
  });

  it('should collect nested dependencies through a cast operand', () => {
    const deps = extractDependencies('NUMBER(a + b)');
    expect(deps.sameRecordFields).toEqual(['a', 'b']);
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

  it('detects TODAY() inside a SUM argument', () => {
    expect(usesToday(parse('SUM(a, TODAY())'))).toBe(true);
  });

  it('returns false for a SUM with no TODAY()', () => {
    expect(usesToday(parse('SUM(a, b, 3)'))).toBe(false);
  });

  it('detects TODAY() inside a combinator argument (ADR 0017)', () => {
    expect(usesToday(parse('IF(AND(a > 1, b > TODAY()), 1, 0)'))).toBe(true);
    expect(usesToday(parse('IF(NOT(a > TODAY()), 1, 0)'))).toBe(true);
    expect(usesToday(parse('IF(ISBLANK(a - TODAY()), 1, 0)'))).toBe(true);
  });

  it('detects TODAY() inside an IFBLANK argument (ADR 0017)', () => {
    expect(usesToday(parse('IFBLANK(a, TODAY())'))).toBe(true);
  });

  it('returns false for combinators with no TODAY() (ADR 0017)', () => {
    expect(usesToday(parse('IF(AND(a > 1, b > 2), 1, 0)'))).toBe(false);
    expect(usesToday(parse('IFBLANK(a, 0)'))).toBe(false);
  });

  it('detects TODAY() inside a desugared IFS/SWITCH ladder (ADR 0018)', () => {
    expect(usesToday(parse('IFS(a > TODAY(), 1, 0)'))).toBe(true);
    expect(usesToday(parse('IFS(a > 1, TODAY(), 0)'))).toBe(true);
    expect(usesToday(parse('SWITCH(TODAY(), 1, 2, 0)'))).toBe(true);
    expect(usesToday(parse('SWITCH(x, 1, TODAY(), 0)'))).toBe(true);
  });

  it('returns false for a ladder with no TODAY() (ADR 0018)', () => {
    expect(usesToday(parse('IFS(a > 1, 2, 0)'))).toBe(false);
    expect(usesToday(parse('SWITCH(x, 1, 2, 3, 4, 0)'))).toBe(false);
  });

  it('detects TODAY() inside a concatenation operand', () => {
    expect(usesToday(parse('TODAY() & ""'))).toBe(true);
    expect(usesToday(parse('a & "x"'))).toBe(false);
  });

  it('returns false for a DATE() literal (parse-time constant, no TODAY())', () => {
    expect(usesToday(parse('DATE("2026-01-15")'))).toBe(false);
  });

  it('detects TODAY() nested inside a NUMBER()/TEXT() cast operand', () => {
    expect(usesToday(parse('NUMBER(TODAY())'))).toBe(true);
    expect(usesToday(parse('TEXT(TODAY())'))).toBe(true);
    expect(usesToday(parse('NUMBER(a)'))).toBe(false);
    expect(usesToday(parse('TEXT(a)'))).toBe(false);
  });
});

describe('bareReferenceOf', () => {
  it('matches a bare same-record field', () => {
    expect(bareReferenceOf(parse('status'))).toEqual({
      kind: 'same',
      field: 'status',
    });
  });

  it('matches a bare whole-field cross-record ref', () => {
    expect(bareReferenceOf(parse(`[company:${UUID}:status]`))).toEqual({
      kind: 'cross',
      ref: { object: 'company', recordId: UUID, fieldPath: 'status' },
    });
  });

  it('rejects a dotted same-record subpath', () => {
    expect(bareReferenceOf(parse('amount.amountMicros'))).toBeNull();
  });

  it('rejects a dotted cross-record subpath', () => {
    expect(
      bareReferenceOf(parse(`[company:${UUID}:amount.amountMicros]`)),
    ).toBeNull();
  });

  it('rejects an arithmetic expression', () => {
    expect(bareReferenceOf(parse('inputA + 0'))).toBeNull();
  });

  it('rejects an IF expression', () => {
    expect(bareReferenceOf(parse('IF(inputA > 1, 1, 0)'))).toBeNull();
  });

  it('rejects a bare numeric literal', () => {
    expect(bareReferenceOf(parse('5'))).toBeNull();
  });

  it('rejects SUM(field) so it is never classified as a mirror (ADR 0016)', () => {
    expect(bareReferenceOf(parse('SUM(status)'))).toBeNull();
    expect(bareReferenceOf(parse(`SUM([company:${UUID}:status])`))).toBeNull();
  });
});
