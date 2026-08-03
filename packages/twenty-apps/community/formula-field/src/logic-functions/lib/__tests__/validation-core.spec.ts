import { describe, expect, it } from 'vitest';

import {
  type ValidatableFormula,
  validateExpressionCore,
} from 'src/logic-functions/lib/validation-core';

const OPPORTUNITY_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

describe('validateExpressionCore', () => {
  it('accepts a valid numeric expression and returns its dependencies', () => {
    const result = validateExpressionCore({
      expression: 'amount + 1',
      hostObject: 'opportunity',
      targetField: 'formulaScore',
      otherFormulas: [],
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.dependencies.sameRecordFields).toContain('amount');
    }
  });

  it('rejects a string comparison against a NUMBER field with the exact message', () => {
    const result = validateExpressionCore({
      expression: 'IF(amount = "big", 1, 0)',
      hostObject: 'opportunity',
      targetField: 'formulaScore',
      fieldKinds: () => new Map([['amount', 'NUMBER']]),
      otherFormulas: [],
    });

    expect(result).toEqual({
      valid: false,
      error:
        'String comparison against "amount" is not supported (field type NUMBER; only SELECT and TEXT fields)',
    });
  });

  it('rejects a non-bare-ref expression onto a TEXT target with the mirror message', () => {
    const result = validateExpressionCore({
      expression: 'sourceField + 1',
      hostObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'TEXT',
      otherFormulas: [],
    });

    expect(result).toEqual({
      valid: false,
      error:
        'Only a plain field reference can be mirrored onto a TEXT field',
    });
  });

  it('rejects a two-formula cycle with the backend wording', () => {
    const otherFormulas: ValidatableFormula[] = [
      {
        id: 'other',
        targetObject: 'opportunity',
        targetField: 'score',
        expression: `[company:${COMPANY_ID}:score] + 1`,
      },
    ];

    const result = validateExpressionCore({
      expression: `[opportunity:${OPPORTUNITY_ID}:score] + 1`,
      hostObject: 'company',
      targetField: 'score',
      otherFormulas,
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/^Dependency cycle detected: /);
    }
  });
});
