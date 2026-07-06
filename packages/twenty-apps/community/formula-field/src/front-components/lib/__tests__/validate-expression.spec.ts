import { describe, expect, it } from 'vitest';

import {
  validateExpression,
  type ValidatableDefinition,
} from 'src/front-components/lib/validate-expression';

const OPPORTUNITY_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

describe('validateExpression', () => {
  it('returns null for a valid acyclic expression', () => {
    expect(validateExpression('amount + 1', 'company', 'score', [])).toBeNull();
  });

  it('surfaces a parse error as a message', () => {
    expect(validateExpression('amount +', 'company', 'score', [])).not.toBeNull();
  });

  // Regression (audit m2): two definitions on DIFFERENT objects sharing the same
  // targetField name must not mask a cross-object cycle. Excluding the candidate
  // by targetField alone would drop BOTH from the graph and wrongly pass.
  it('detects a cross-object cycle between same-named fields', () => {
    const definitions: ValidatableDefinition[] = [
      {
        targetObject: 'company',
        targetField: 'score',
        expression: `[opportunity:${OPPORTUNITY_ID}:score] + 1`,
      },
      {
        targetObject: 'opportunity',
        targetField: 'score',
        expression: `[company:${COMPANY_ID}:score] + 1`,
      },
    ];

    const result = validateExpression(
      `[opportunity:${OPPORTUNITY_ID}:score] + 1`,
      'company',
      'score',
      definitions,
    );

    expect(result).toContain('Dependency cycle');
  });

  it('accepts a SELECT field string comparison via the optional kinds param', () => {
    expect(
      validateExpression(
        'IF(stage = "QUALIFIED", 1, 0)',
        'opportunity',
        'formulaScore',
        [],
        new Map([['stage', 'SELECT']]),
      ),
    ).toBeNull();
  });

  it('accepts a TEXT field string comparison', () => {
    expect(
      validateExpression(
        'IF(tier = "gold", 1, 0)',
        'opportunity',
        'formulaScore',
        [],
        new Map([['tier', 'TEXT']]),
      ),
    ).toBeNull();
  });

  it('rejects a NUMBER field string comparison with the exact message', () => {
    expect(
      validateExpression(
        'IF(amount = "big", 1, 0)',
        'opportunity',
        'formulaScore',
        [],
        new Map([['amount', 'NUMBER']]),
      ),
    ).toBe(
      'String comparison against "amount" is not supported (field type NUMBER; only SELECT and TEXT fields)',
    );
  });

  it('is null when the kinds map is omitted (backward compatible)', () => {
    expect(
      validateExpression('IF(amount = "big", 1, 0)', 'opportunity', 'formulaScore', []),
    ).toBeNull();
  });

  it('passes a cross-record string comparison', () => {
    expect(
      validateExpression(
        `IF([company:${COMPANY_ID}:name] = "Acme", 1, 0)`,
        'opportunity',
        'formulaScore',
        [],
        new Map([['amount', 'NUMBER']]),
      ),
    ).toBeNull();
  });

  it('does not report a cycle for same-named fields with no dependency loop', () => {
    const definitions: ValidatableDefinition[] = [
      {
        targetObject: 'company',
        targetField: 'score',
        expression: 'amount + 1',
      },
      {
        targetObject: 'opportunity',
        targetField: 'score',
        expression: 'probability + 1',
      },
    ];

    const result = validateExpression(
      'amount + 1',
      'company',
      'score',
      definitions,
    );

    expect(result).toBeNull();
  });
});
