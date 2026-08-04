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

  // Lane switch (Task 7): TEXT left MIRRORABLE_KINDS, so the mirror block no
  // longer constrains a TEXT target — a full engine expression validates.
  it('accepts a concatenation expression onto a TEXT target', () => {
    const result = validateExpressionCore({
      expression: 'aString & "INV" & 1+TODAY()',
      hostObject: 'opportunity',
      targetField: 'invoiceCode',
      targetFieldType: 'TEXT',
      otherFormulas: [],
    });

    expect(result.valid).toBe(true);
  });

  it('accepts a bare field reference onto a TEXT target (the deployed mirror shape)', () => {
    const result = validateExpressionCore({
      expression: 'sourceField',
      hostObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'TEXT',
      // A SELECT source onto a TEXT target would have been a kind mismatch under
      // the mirror rule; on the engine lane there is no same-kind requirement.
      fieldKinds: () => new Map([['sourceField', 'SELECT']]),
      otherFormulas: [],
    });

    expect(result.valid).toBe(true);
  });

  it('rejects a bare ref to a non-text source kind onto a TEXT target', () => {
    // The bare-ref shape IS the deployed-mirror shape, and main rejected it at
    // save time with this exact message. Losing the guard would let a BOOLEAN
    // source write "1"/"0" (and a MULTI_SELECT fail per record), so it survives
    // TEXT's move to the engine lane.
    const result = validateExpressionCore({
      expression: 'isActive',
      hostObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'TEXT',
      fieldKinds: () => new Map([['isActive', 'BOOLEAN']]),
      otherFormulas: [],
    });

    expect(result).toEqual({
      valid: false,
      error:
        'Cannot mirror BOOLEAN field "isActive" onto a TEXT field (kinds must match)',
    });
  });

  it('accepts a bare TEXT ref onto a TEXT target', () => {
    const result = validateExpressionCore({
      expression: 'sourceField',
      hostObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'TEXT',
      fieldKinds: () => new Map([['sourceField', 'TEXT']]),
      otherFormulas: [],
    });

    expect(result.valid).toBe(true);
  });

  it('leaves a non-bare expression over a non-text source unrestricted on a TEXT target', () => {
    // `isActive & ""` was never savable onto a TEXT target on main (the mirror
    // rule allowed a bare ref only), so the engine lane's general expressions
    // are a pure widening with no delta to protect.
    const result = validateExpressionCore({
      expression: 'isActive & ""',
      hostObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'TEXT',
      fieldKinds: () => new Map([['isActive', 'BOOLEAN']]),
      otherFormulas: [],
    });

    expect(result.valid).toBe(true);
  });

  // The mirror rule stays intact for the raw kinds it still owns.
  it('rejects a non-bare-ref expression onto a SELECT target with the mirror message', () => {
    const result = validateExpressionCore({
      expression: 'sourceField + 1',
      hostObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'SELECT',
      otherFormulas: [],
    });

    expect(result).toEqual({
      valid: false,
      error:
        'Only a plain field reference can be mirrored onto a SELECT field',
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
      // The pre-refactor validateFormula returned dependencies alongside a
      // cycle error, and CoreValidationResult's invalid branch was widened to
      // keep carrying them (Task 2). Pin the payload so a later change can't
      // silently drop it while leaving the rest of the suite green.
      expect(result.dependencies).toEqual({
        sameRecordFields: [],
        crossRecordRefs: [
          {
            object: 'opportunity',
            recordId: OPPORTUNITY_ID,
            field: 'score',
            fieldPath: 'score',
          },
        ],
      });
    }
  });
});
