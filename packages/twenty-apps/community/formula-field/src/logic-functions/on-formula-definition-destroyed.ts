import { type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordDestroyEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleDefinitionDestroyed } from 'src/logic-functions/lib/handle-definition-lifecycle';

// Permanent destroy (trash purge or direct destroy): the field pair stays
// deactivated forever (a purge must never drop a data column); now-orphaned
// override rows are cleaned up. ADR 0009.
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordDestroyEvent<CoreSchema.FormulaDefinition>
  >,
): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const before = payload.properties.before as unknown as Parameters<
    typeof handleDefinitionDestroyed
  >[1];
  if (!before?.id) {
    return { handled: false };
  }
  return handleDefinitionDestroyed(client, before);
};

export default defineLogicFunction({
  universalIdentifier: 'ead518d3-34e1-4cb3-9dbf-3461844d06c5',
  name: 'on-formula-definition-destroyed',
  description:
    'Clean up override rows when a formula definition is destroyed.',
  timeoutSeconds: 120,
  handler,
  databaseEventTriggerSettings: { eventName: 'formulaDefinition.destroyed' },
});
