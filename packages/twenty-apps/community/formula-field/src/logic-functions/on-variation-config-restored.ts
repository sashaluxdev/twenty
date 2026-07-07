import { type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordRestoreEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleVariationConfigRestored } from 'src/logic-functions/lib/handle-variation-config-lifecycle';

// Restore from trash: heal the relation field if it was left deactivated, then
// sweep once to converge values that drifted stale while trashed. See
// handle-variation-config-lifecycle.ts for the WHY.
const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordRestoreEvent<CoreSchema.VariationConfig>
  >,
): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const after = payload.properties.after as unknown as Parameters<
    typeof handleVariationConfigRestored
  >[1];
  if (!after?.id) {
    return { handled: false };
  }
  return handleVariationConfigRestored(client, after);
};

export default defineLogicFunction({
  universalIdentifier: '81411c2b-80e5-4dfb-b725-70adccf9e0bf',
  name: 'on-variation-config-restored',
  description:
    'Heal the relation field and sweep to converge a restored variation config.',
  timeoutSeconds: 120,
  handler,
  databaseEventTriggerSettings: { eventName: 'variationConfig.restored' },
});
