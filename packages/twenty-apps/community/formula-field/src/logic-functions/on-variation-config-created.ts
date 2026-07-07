import { type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordCreateEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleVariationConfigChange } from 'src/logic-functions/lib/handle-variation-config-change';

// Validate a VariationConfig the moment it is created, and converge its
// variations immediately if valid.
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordCreateEvent<CoreSchema.VariationConfig>
  >,
): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const after = payload.properties.after as unknown as Parameters<
    typeof handleVariationConfigChange
  >[0]['after'];

  return handleVariationConfigChange({ client, after, updatedFields: undefined });
};

export default defineLogicFunction({
  universalIdentifier: 'e6fc9bab-a0d3-4cfa-9dd5-104977b38afb',
  name: 'on-variation-config-created',
  description: 'Validate a newly created variation config and converge it.',
  timeoutSeconds: 120,
  handler,
  databaseEventTriggerSettings: { eventName: 'variationConfig.created' },
});
