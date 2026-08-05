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
    // Was branch 1b (string-comparison-only check); now caught by the strict
    // kind gate's comparison rule. The gate only runs against a known target
    // kind (its blank-target skip is mirror-lane territory), so this needs a
    // targetFieldType where 1b did not.
    const result = validateExpressionCore({
      expression: 'IF(amount = "big", 1, 0)',
      hostObject: 'opportunity',
      targetField: 'formulaScore',
      targetFieldType: 'NUMBER',
      fieldKinds: () => new Map([['amount', 'NUMBER']]),
      otherFormulas: [],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe(
        'Cannot compare number with text using "=" (kinds must match)',
      );
    }
  });

  // Lane switch (Task 7): TEXT left MIRRORABLE_KINDS, so the mirror block no
  // longer constrains a TEXT target — a full engine expression validates.
  it('accepts a concatenation expression onto a TEXT target', () => {
    // Under strict kind typing (Task 3) `1+TODAY()` infers `date`
    // (number+date -> date), and `&` requires text — so the bare arithmetic
    // form is no longer valid here; wrap it in TEXT() to keep the "a full
    // engine expression validates onto TEXT" coverage.
    const result = validateExpressionCore({
      expression: 'aString & "INV" & TEXT(1 + TODAY())',
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
    // save time. Losing the guard would let a BOOLEAN source write "1"/"0" (and
    // a MULTI_SELECT fail per record), so the protection survives TEXT's move
    // to the engine lane — but 1d is gone, so the rejection now comes from the
    // output gate (boolean output kind vs a text target) with a new message.
    const result = validateExpressionCore({
      expression: 'isActive',
      hostObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'TEXT',
      fieldKinds: () => new Map([['isActive', 'BOOLEAN']]),
      otherFormulas: [],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(
        /computes boolean but the target field holds text/,
      );
    }
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

  it('rejects a non-bare boolean expression concatenated onto a TEXT target (S5)', () => {
    // `isActive & ""` was never savable onto a TEXT target on main; under
    // strict kind typing (S5) it is ALSO rejected now — `&` requires text
    // operands, and a bare BOOLEAN operand does not coerce. Wrap it in TEXT()
    // to make the intent explicit (the positive companion below).
    const result = validateExpressionCore({
      expression: 'isActive & ""',
      hostObject: 'opportunity',
      targetField: 'mirrorField',
      targetFieldType: 'TEXT',
      fieldKinds: () => new Map([['isActive', 'BOOLEAN']]),
      otherFormulas: [],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(
        /"&" joins text; wrap boolean values in TEXT\(\)/,
      );
    }
  });

  it('accepts the same expression once the boolean operand is wrapped in TEXT()', () => {
    const result = validateExpressionCore({
      expression: 'TEXT(isActive) & ""',
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

describe('validateExpressionCore - strict kind gate (Task 3)', () => {
  const kinds = new Map<string, string>([
    ['amount', 'NUMBER'],
    ['closeDate', 'DATE'],
    ['name', 'TEXT'],
    ['isActive', 'BOOLEAN'],
    ['myLinks', 'LINKS'],
  ]);
  const opportunityKinds = new Map<string, string>([['closeDate', 'DATE']]);
  const kindsByObject = new Map<string, Map<string, string>>([
    ['company', kinds],
    ['opportunity', opportunityKinds],
  ]);
  const validate = (expression: string, targetFieldType: string) =>
    validateExpressionCore({
      expression,
      hostObject: 'company',
      targetField: 'result',
      targetFieldType,
      fieldKinds: (object) => kindsByObject.get(object),
      otherFormulas: [],
    });
  const validateWithoutKinds = (expression: string, targetFieldType: string) =>
    validateExpressionCore({
      expression,
      hostObject: 'company',
      targetField: 'result',
      targetFieldType,
      otherFormulas: [],
    });

  it('rejects a date field compared to a bare text literal at save', () => {
    const result = validate('IF(closeDate = "2026-01-15", 1, 0)', 'NUMBER');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/Cannot compare date with text/);
    }
  });

  it('accepts the DATE() literal form', () => {
    expect(
      validate('IF(closeDate = DATE("2026-01-15"), 1, 0)', 'NUMBER').valid,
    ).toBe(true);
  });

  it('rejects a number expression onto a TEXT target without TEXT()', () => {
    const result = validate('amount * 2', 'TEXT');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/target field holds text/);
    }
  });

  it('still rejects a bare BOOLEAN reference onto a TEXT target (H3 parity)', () => {
    expect(validate('isActive', 'TEXT').valid).toBe(false);
  });

  it('still rejects a bare LINKS reference onto a TEXT target (1d parity via opaque)', () => {
    expect(validate('myLinks', 'TEXT').valid).toBe(false);
  });

  it('skips kind checks when no kinds map is supplied (unknown-kind policy)', () => {
    expect(validateWithoutKinds('IF(mystery = "x", 1, 0)', 'NUMBER').valid).toBe(
      true,
    );
  });

  it('rejects a kind mismatch carried by a cross-record operand (D5 types them; 1b exempted them)', () => {
    const result = validate(
      'IF([opportunity:20202020-1c25-4d02-bf25-6aeccf7ea419:closeDate] = "2026-01-15", 1, 0)',
      'NUMBER',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/Cannot compare date with text/);
    }
  });
});
