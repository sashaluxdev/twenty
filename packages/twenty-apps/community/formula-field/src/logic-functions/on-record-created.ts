import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordCreateEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';

// Computes formula values for a freshly created record immediately, instead of
// waiting for its first input edit or the hourly sweep. Passing undefined
// updatedFields makes handleRecordUpdate recompute every formula targeting the
// object (the safe path); override detection is skipped for creates.
const APP_OWNED_OBJECTS = new Set(['formulaDefinition', 'formulaOverride']);

const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordCreateEvent<Record<string, unknown>>
  >,
): Promise<Record<string, unknown>> => {
  const objectName = payload.objectMetadata?.nameSingular;
  if (!objectName || APP_OWNED_OBJECTS.has(objectName)) {
    return { skipped: true };
  }

  // Dynamic client: wizard-created value fields are not in the genql type map.
  const client = createDynamicCoreClient();
  const after = payload.properties.after;
  const recordId = payload.recordId ?? (after?.id as string | undefined);

  if (!recordId) {
    return { recomputed: 0 };
  }

  const outcomes = await handleRecordUpdate({
    client,
    objectName,
    recordId,
    after: after as unknown as Record<string, unknown>,
    updatedFields: undefined,
  });

  const written = outcomes.filter((outcome) => outcome.changed).length;
  const errors = outcomes.filter((outcome) => outcome.error).length;

  return { evaluated: outcomes.length, written, errors };
};

export default defineLogicFunction({
  universalIdentifier: '7465056d-6530-40ce-889e-c94ace7854a4',
  name: 'on-record-created',
  description: 'Compute formulas for newly created records.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: '*.created' },
});
