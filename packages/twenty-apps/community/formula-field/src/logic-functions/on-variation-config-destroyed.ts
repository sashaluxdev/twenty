import { type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordDestroyEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleVariationConfigDestroyed } from 'src/logic-functions/lib/handle-variation-config-lifecycle';

// Permanent destroy (trash purge or direct destroy): deactivate the relation
// field this config provisioned (never delete it or its data), and leave
// override rows alone. See handle-variation-config-lifecycle.ts for the WHY.
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordDestroyEvent<CoreSchema.VariationConfig>
  >,
): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const before = payload.properties.before as unknown as Parameters<
    typeof handleVariationConfigDestroyed
  >[1];
  if (!before?.id) {
    return { handled: false };
  }
  return handleVariationConfigDestroyed(client, before);
};

export default defineLogicFunction({
  universalIdentifier: '0a703f52-97df-4063-a996-ea20539aaee0',
  name: 'on-variation-config-destroyed',
  description:
    'Deactivate the provisioned relation field when a variation config is destroyed.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: 'variationConfig.destroyed' },
});
