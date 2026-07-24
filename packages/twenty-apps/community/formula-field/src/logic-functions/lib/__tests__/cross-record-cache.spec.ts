import { beforeEach, describe, expect, it } from 'vitest';

import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// Real grammar is `[object:uuid:fieldPath]` with a strict UUID v4 recordId
// (see src/engine/tokenizer.ts's UUID_V4_REGEX) — not the bracket-suffix
// literal a plain-language description might suggest.
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

describe('cross-record reads within one pass', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('opportunity', { score: 'NUMBER' });
    client.setFieldKinds('company', { employees: 'NUMBER' });
    client.seed('company', [{ id: COMPANY_ID, employees: 10 }]);
    client.seed(
      'opportunity',
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `opp-${index + 1}`,
        score: null,
      })),
    );
  });

  it('fetches a referenced record once per pass, not once per target record', async () => {
    const formula: FormulaDefinitionRecord = {
      id: 'formula-1',
      targetObject: 'opportunity',
      targetField: 'score',
      targetFieldType: 'NUMBER',
      outputFormat: 'integer',
      expression: `[company:${COMPANY_ID}:employees] + 1`,
      enabled: true,
    };

    const outcomes = await recomputeAllRecords(client, formula, { pageSize: 10 });

    expect(outcomes).toHaveLength(5);
    expect(client.get('opportunity', 'opp-1')?.score).toBe(11);

    const companyReads = client.querySelections.filter(
      (selection) => selection.company !== undefined,
    );
    expect(companyReads).toHaveLength(1);
  });
});
