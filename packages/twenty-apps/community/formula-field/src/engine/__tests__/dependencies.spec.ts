import { describe, expect, it } from 'vitest';

import { extractDependencies } from 'src/engine/dependencies';

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
