import { CoreApiClient, type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordCreateEvent,
} from 'twenty-sdk/define';

import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';

// Validate + index a formula the moment it is created.
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordCreateEvent<CoreSchema.FormulaDefinition>
  >,
): Promise<Record<string, unknown>> => {
  const client = new CoreApiClient();
  const after = payload.properties.after as unknown as Parameters<
    typeof handleFormulaChange
  >[0]['after'];

  return handleFormulaChange({ client, after, updatedFields: undefined });
};

export default defineLogicFunction({
  universalIdentifier: 'fcfab50b-4942-499c-9f02-f37b25f007c6',
  name: 'on-formula-definition-created',
  description: 'Validate, index and evaluate a newly created formula.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: 'formulaDefinition.created' },
});
