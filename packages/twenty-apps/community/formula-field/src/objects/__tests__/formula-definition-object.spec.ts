import { describe, expect, it } from 'vitest';

import formulaDefinitionObject, {
  FORMULA_DEFINITION_FIELDS,
} from 'src/objects/formula-definition.object';

describe('allowOverride manifest declaration (A-prime I2)', () => {
  it('is BOOLEAN, defaults true, and is not UI-editable', () => {
    const field = formulaDefinitionObject.config.fields.find(
      (candidate) => candidate.name === 'allowOverride',
    );
    expect(field).toMatchObject({
      universalIdentifier: FORMULA_DEFINITION_FIELDS.allowOverride,
      name: 'allowOverride',
      defaultValue: true,
      isUIEditable: false,
    });
    expect(FORMULA_DEFINITION_FIELDS.allowOverride).toBe(
      '436befd0-e824-4d85-a79f-2b02460c43e3',
    );
  });
});
