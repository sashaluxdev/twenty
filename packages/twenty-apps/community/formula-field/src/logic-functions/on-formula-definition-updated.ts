import { CoreApiClient, type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordUpdateEvent,
} from 'twenty-sdk/define';

import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';

// Re-validate + re-index a formula whenever it is edited. Ignores the app's own
// bookkeeping writes to avoid a self-trigger loop (see handleFormulaChange).
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordUpdateEvent<CoreSchema.FormulaDefinition>
  >,
): Promise<Record<string, unknown>> => {
  const client = new CoreApiClient();
  const { after, updatedFields } = payload.properties;

  return handleFormulaChange({
    client,
    after: after as unknown as Parameters<
      typeof handleFormulaChange
    >[0]['after'],
    updatedFields,
  });
};

export default defineLogicFunction({
  universalIdentifier: 'b390607f-c60d-4955-862f-e922ffb281a0',
  name: 'on-formula-definition-updated',
  description: 'Re-validate, re-index and re-evaluate an edited formula.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: 'formulaDefinition.updated' },
});
