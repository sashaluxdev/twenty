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

  it('accepts a SELECT field string comparison via the optional kinds accessor', () => {
    expect(
      validateExpression(
        'IF(stage = "QUALIFIED", 1, 0)',
        'opportunity',
        'formulaScore',
        [],
        () => new Map([['stage', 'SELECT']]),
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
        () => new Map([['tier', 'TEXT']]),
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
        () => new Map([['amount', 'NUMBER']]),
      ),
    ).toBe(
      'String comparison against "amount" is not supported (field type NUMBER; only SELECT and TEXT fields)',
    );
  });

  it('rejects a SWITCH with a string key on a NUMBER field at save-time validation', () => {
    // SWITCH(amount, "big", 1, 0) desugars to IF(amount = "big", 1, 0): a string
    // comparison against a NUMBER field. The kind check runs on the desugared
    // AST, so the sugar is rejected with the same message as the raw comparison.
    expect(
      validateExpression(
        'SWITCH(amount, "big", 1, 0)',
        'opportunity',
        'formulaScore',
        [],
        () => new Map([['amount', 'NUMBER']]),
      ),
    ).toBe(
      'String comparison against "amount" is not supported (field type NUMBER; only SELECT and TEXT fields)',
    );
  });

  it('rejects a MULTI_SELECT field string comparison with the exact message', () => {
    expect(
      validateExpression(
        'IF(tags = "vip", 1, 0)',
        'opportunity',
        'formulaScore',
        [],
        () => new Map([['tags', 'MULTI_SELECT']]),
      ),
    ).toBe(
      'String comparison against "tags" is not supported (field type MULTI_SELECT; only SELECT and TEXT fields)',
    );
  });

  it('only applies the kinds accessor to the host object', () => {
    // The accessor returns kinds for a different object; the host lookup misses,
    // so the string-comparison check is skipped (degrades gracefully).
    expect(
      validateExpression(
        'IF(amount = "big", 1, 0)',
        'opportunity',
        'formulaScore',
        [],
        (object) =>
          object === 'company' ? new Map([['amount', 'NUMBER']]) : undefined,
      ),
    ).toBeNull();
  });

  it('is null when the kinds accessor is omitted (backward compatible)', () => {
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
        () => new Map([['amount', 'NUMBER']]),
      ),
    ).toBeNull();
  });

  // Mirror validation parity with the server save-validation (adjudicated at
  // Task 1 review): the inline validator runs the same three mirror checks with
  // the exact same messages when a non-engine target field type is supplied.
  it('rejects a non-mirrorable target kind with the exact message', () => {
    expect(
      validateExpression(
        'status',
        'opportunity',
        'mirrorField',
        [],
        undefined,
        'RELATION',
      ),
    ).toBe('Field kind RELATION cannot be mirrored');
  });

  it('rejects an operator expression onto a mirrorable target', () => {
    expect(
      validateExpression(
        'status + otherField',
        'opportunity',
        'mirrorField',
        [],
        undefined,
        'SELECT',
      ),
    ).toBe('Only a plain field reference can be mirrored onto a SELECT field');
  });

  it('rejects a dotted subpath ref onto a mirrorable target', () => {
    expect(
      validateExpression(
        'amount.amountMicros',
        'opportunity',
        'mirrorField',
        [],
        undefined,
        'SELECT',
      ),
    ).toBe('Only a plain field reference can be mirrored onto a SELECT field');
  });

  it('rejects a same-record source of a different kind with the exact message', () => {
    expect(
      validateExpression(
        'sourceField',
        'opportunity',
        'mirrorField',
        [],
        (object) =>
          object === 'opportunity'
            ? new Map([['sourceField', 'TEXT']])
            : undefined,
        'SELECT',
      ),
    ).toBe(
      'Cannot mirror TEXT field "sourceField" onto a SELECT field (kinds must match)',
    );
  });

  it('rejects a cross-record source of a different kind (preloaded source object)', () => {
    expect(
      validateExpression(
        `[company:${COMPANY_ID}:name]`,
        'opportunity',
        'mirrorField',
        [],
        (object) =>
          object === 'company' ? new Map([['name', 'TEXT']]) : undefined,
        'SELECT',
      ),
    ).toBe(
      'Cannot mirror TEXT field "name" onto a SELECT field (kinds must match)',
    );
  });

  it('accepts a same-kind same-record mirror', () => {
    expect(
      validateExpression(
        'sourceField',
        'opportunity',
        'mirrorField',
        [],
        () => new Map([['sourceField', 'SELECT']]),
        'SELECT',
      ),
    ).toBeNull();
  });

  it('accepts a same-kind cross-record mirror', () => {
    expect(
      validateExpression(
        `[company:${COMPANY_ID}:name]`,
        'opportunity',
        'mirrorField',
        [],
        (object) =>
          object === 'company' ? new Map([['name', 'SELECT']]) : undefined,
        'SELECT',
      ),
    ).toBeNull();
  });

  it('leaves an engine-family target (NUMBER) on the engine path', () => {
    expect(
      validateExpression(
        'sourceField',
        'opportunity',
        'mirrorField',
        [],
        () => new Map([['sourceField', 'SELECT']]),
        'NUMBER',
      ),
    ).toBeNull();
  });

  it('degrades gracefully without an accessor: unknown source kind passes', () => {
    expect(
      validateExpression(
        'sourceField',
        'opportunity',
        'mirrorField',
        [],
        undefined,
        'SELECT',
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
