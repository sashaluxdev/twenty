import { type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordDeleteEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleDefinitionDeleted } from 'src/logic-functions/lib/handle-definition-lifecycle';

// Soft delete of a definition (trash): deactivate its app-owned value field
// pair and re-flag dependents (OFFLINE/UPSTREAM). Fully reversible via
// restore. ADR 0009.
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordDeleteEvent<CoreSchema.FormulaDefinition>
  >,
): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const before = payload.properties.before as unknown as Parameters<
    typeof handleDefinitionDeleted
  >[1];
  if (!before?.id) {
    return { handled: false };
  }
  return handleDefinitionDeleted(client, before);
};

export default defineLogicFunction({
  universalIdentifier: '2112e28b-3dd1-4cb8-8dc7-a816a91ed4af',
  name: 'on-formula-definition-deleted',
  description:
    'Deactivate the deleted formula’s app-owned field and flag dependents.',
  timeoutSeconds: 120,
  handler,
  databaseEventTriggerSettings: { eventName: 'formulaDefinition.deleted' },
});
