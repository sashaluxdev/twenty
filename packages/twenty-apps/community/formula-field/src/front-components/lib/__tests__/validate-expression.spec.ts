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
