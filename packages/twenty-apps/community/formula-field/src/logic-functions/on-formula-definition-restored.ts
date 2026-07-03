import { type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordRestoreEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleDefinitionRestored } from 'src/logic-functions/lib/handle-definition-lifecycle';

// Restore from trash: reactivate the app-owned value field, recompute values
// (stale from the time in the trash), and clear dependents' flags. ADR 0009.
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordRestoreEvent<CoreSchema.FormulaDefinition>
  >,
): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const after = payload.properties.after as unknown as Parameters<
    typeof handleDefinitionRestored
  >[1];
  if (!after?.id) {
    return { handled: false };
  }
  return handleDefinitionRestored(client, after);
};

export default defineLogicFunction({
  universalIdentifier: '4a8db0bc-de92-4c0c-8e90-5305c0358d9d',
  name: 'on-formula-definition-restored',
  description:
    'Reactivate the restored formula’s field, recompute, unflag dependents.',
  timeoutSeconds: 120,
  handler,
  databaseEventTriggerSettings: { eventName: 'formulaDefinition.restored' },
});
