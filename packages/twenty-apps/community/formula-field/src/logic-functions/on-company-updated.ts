import { CoreApiClient, type CoreSchema } from 'twenty-client-sdk/core';
import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordUpdateEvent,
} from 'twenty-sdk/define';

import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';

// Recompute trigger for Company records. Its main job is CROSS-OBJECT recompute:
// when a company an opportunity's formula references (e.g. [company:id:employees])
// changes, the referencing formulas are recomputed across their target records.
const handler = async (
  payload: DatabaseEventPayload<ObjectRecordUpdateEvent<CoreSchema.Company>>,
): Promise<Record<string, unknown>> => {
  const client = new CoreApiClient();
  const { after, updatedFields } = payload.properties;
  const recordId = payload.recordId ?? (after?.id as string | undefined);

  if (!recordId) {
    return { recomputed: 0 };
  }

  const outcomes = await handleRecordUpdate({
    client,
    objectName: 'company',
    recordId,
    after: after as unknown as Record<string, unknown>,
    updatedFields,
  });

  const written = outcomes.filter((outcome) => outcome.changed).length;
  const errors = outcomes.filter((outcome) => outcome.error).length;

  return { evaluated: outcomes.length, written, errors };
};

export default defineLogicFunction({
  universalIdentifier: '14105f30-694c-4efc-9dd4-dd374dbdddc1',
  name: 'on-company-updated',
  description: 'Recompute cross-object formulas when a company changes.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: 'company.updated' },
});
