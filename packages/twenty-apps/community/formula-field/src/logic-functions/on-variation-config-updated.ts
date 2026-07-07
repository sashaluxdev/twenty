import { type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordUpdateEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleVariationConfigChange } from 'src/logic-functions/lib/handle-variation-config-change';

// Re-validate + re-converge a variation config whenever it is edited. Ignores
// the app's own bookkeeping writes to avoid a self-trigger loop (see
// handleVariationConfigChange).
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordUpdateEvent<CoreSchema.VariationConfig>
  >,
): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const { after, updatedFields } = payload.properties;

  return handleVariationConfigChange({
    client,
    after: after as unknown as Parameters<
      typeof handleVariationConfigChange
    >[0]['after'],
    updatedFields,
  });
};

export default defineLogicFunction({
  universalIdentifier: 'a7e1ae01-88ed-451a-b635-f6dea328b1ed',
  name: 'on-variation-config-updated',
  description: 'Re-validate and re-converge an edited variation config.',
  timeoutSeconds: 120,
  handler,
  databaseEventTriggerSettings: { eventName: 'variationConfig.updated' },
});
