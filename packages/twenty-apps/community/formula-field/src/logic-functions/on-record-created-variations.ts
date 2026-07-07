import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordCreateEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleVariationRecordCreated } from 'src/logic-functions/lib/variation-sync';

const APP_OWNED_OBJECTS = new Set([
  'formulaDefinition',
  'formulaOverride',
  'variationConfig',
]);

const handler = async (
  payload: DatabaseEventPayload<ObjectRecordCreateEvent<Record<string, unknown>>>,
): Promise<Record<string, unknown>> => {
  const objectName = payload.objectMetadata?.nameSingular;
  if (!objectName || APP_OWNED_OBJECTS.has(objectName)) {
    return { skipped: true };
  }

  const client = createDynamicCoreClient();
  const after = payload.properties.after;
  const recordId = payload.recordId ?? (after?.id as string | undefined);
  if (!recordId) {
    return { skipped: true };
  }

  const outcome = await handleVariationRecordCreated({
    client,
    objectName,
    recordId,
    after: after as unknown as Record<string, unknown>,
  });

  return { synced: outcome !== null, changed: outcome?.changed ?? false };
};

export default defineLogicFunction({
  universalIdentifier: '4e55d4a5-45aa-4adc-a60f-6f8c3c11bade',
  name: 'on-record-created-variations',
  description: 'Full initial sync when a record is created as a variation.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: '*.created' },
});
