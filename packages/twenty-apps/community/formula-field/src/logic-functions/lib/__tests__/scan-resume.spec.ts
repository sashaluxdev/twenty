import { describe, expect, it } from 'vitest';

import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('scanCursor bookkeeping', () => {
  it('does not re-enter formula handling when only the scan cursor changed', async () => {
    const client = new FakeClient();
    const after = {
      id: 'formula-1',
      targetObject: 'opportunity',
      targetField: 'score',
      targetFieldType: 'NUMBER',
      expression: 'amount + 1',
      enabled: true,
      scanCursor: 'opp-100',
    };

    const result = await handleFormulaChange({
      client,
      after,
      updatedFields: ['scanCursor'],
    });

    expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
    expect(client.mutations).toBe(0);
  });
});
