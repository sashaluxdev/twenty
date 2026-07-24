import { beforeEach, describe, expect, it } from 'vitest';

import { buildScanSelection } from 'src/logic-functions/lib/scan-selection';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

const definition = (
  overrides: Partial<FormulaDefinitionRecord>,
): FormulaDefinitionRecord => ({
  id: 'formula-1',
  targetObject: 'opportunity',
  targetField: 'score',
  targetFieldType: 'NUMBER',
  expression: 'amount + 1',
  enabled: true,
  ...overrides,
});

describe('buildScanSelection', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setFieldKinds('opportunity', {
      amount: 'CURRENCY',
      score: 'NUMBER',
      stage: 'SELECT',
      name: 'TEXT',
    });
  });

  it('selects the dependency fields plus the target field for an engine formula', async () => {
    const scan = await buildScanSelection(client, definition({}));

    expect(scan).not.toBeNull();
    expect(scan?.fields).toEqual(['amount']);
    // CURRENCY dependency needs a sub-selection; a scalar selection would
    // silently read null.
    expect(scan?.overrides.amount).toEqual({ amountMicros: true, currencyCode: true });
    // NUMBER target needs no sub-selection.
    expect(scan?.overrides.score).toBe(true);
  });

  it('selects source and target through the mirror vocabulary for a same-record mirror', async () => {
    const scan = await buildScanSelection(
      client,
      definition({
        expression: 'stage',
        targetField: 'stageCopy',
        targetFieldType: 'SELECT',
      }),
    );

    expect(scan?.fields).toEqual(['stage', 'stageCopy']);
    expect(scan?.overrides.stage).toBe(true);
    expect(scan?.overrides.stageCopy).toBe(true);
  });

  it('selects only the target field for a cross-record mirror', async () => {
    client.setFieldKinds('company', { name: 'TEXT' });
    const scan = await buildScanSelection(
      client,
      definition({
        expression: '[company:11111111-1111-4111-8111-111111111111:name]',
        targetField: 'companyName',
        targetFieldType: 'TEXT',
      }),
    );

    expect(scan?.fields).toEqual(['companyName']);
  });

  it('returns null when the expression does not parse', async () => {
    expect(await buildScanSelection(client, definition({ expression: '((' }))).toBeNull();
  });

  it('returns null when a mirror source field kind cannot be resolved', async () => {
    const scan = await buildScanSelection(
      client,
      definition({
        expression: 'unknownField',
        targetField: 'copy',
        targetFieldType: 'TEXT',
      }),
    );

    // Parity with computeMirrorValueForRecord: an unresolvable kind must fail
    // visibly per record, never be guessed at page level.
    expect(scan).toBeNull();
  });

  it('returns null when the definition has no target object or field', async () => {
    expect(await buildScanSelection(client, definition({ targetObject: null }))).toBeNull();
    expect(await buildScanSelection(client, definition({ targetField: null }))).toBeNull();
  });
});
