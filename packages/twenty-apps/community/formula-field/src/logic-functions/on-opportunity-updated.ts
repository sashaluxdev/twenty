import { CoreApiClient, type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordUpdateEvent,
} from 'twenty-sdk/define';

import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';

// Low-latency recompute trigger for Opportunity records (ADR 0004). Fires on
// every opportunity.updated event and recomputes only the formulas whose inputs
// actually changed, plus any cross-object formulas that read this opportunity.
const handler = async (
  payload: DatabaseEventPayload<ObjectRecordUpdateEvent<CoreSchema.Opportunity>>,
): Promise<Record<string, unknown>> => {
  const client = new CoreApiClient();
  const { after, updatedFields } = payload.properties;
  const recordId = payload.recordId ?? (after?.id as string | undefined);

  if (!recordId) {
    return { recomputed: 0 };
  }

  const outcomes = await handleRecordUpdate({
    client,
    objectName: 'opportunity',
    recordId,
    after: after as unknown as Record<string, unknown>,
    updatedFields,
  });

  const written = outcomes.filter((outcome) => outcome.changed).length;
  const errors = outcomes.filter((outcome) => outcome.error).length;

  return { evaluated: outcomes.length, written, errors };
};

export default defineLogicFunction({
  universalIdentifier: '175ef609-9fbf-4552-a9f4-ec407d63aa2b',
  name: 'on-opportunity-updated',
  description: 'Recompute formulas when an opportunity changes.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: 'opportunity.updated' },
});
