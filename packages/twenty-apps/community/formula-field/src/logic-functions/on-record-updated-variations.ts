import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordUpdateEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleVariationRecordUpdated } from 'src/logic-functions/lib/variation-sync';

// Separate wildcard subscription from the formula engine's on-record-updated.ts
// (design 2026-07-07): variation sync is a parallel concept, not a
// FormulaDefinition, so it gets its own trigger rather than coupling into
// handleRecordUpdate.
const APP_OWNED_OBJECTS = new Set([
  'formulaDefinition',
  'formulaOverride',
  'variationConfig',
]);

const handler = async (
  payload: DatabaseEventPayload<ObjectRecordUpdateEvent<Record<string, unknown>>>,
): Promise<Record<string, unknown>> => {
  const objectName = payload.objectMetadata?.nameSingular;
  if (!objectName || APP_OWNED_OBJECTS.has(objectName)) {
    return { skipped: true };
  }

  const client = createDynamicCoreClient();
  const { after, updatedFields } = payload.properties;
  const recordId = payload.recordId ?? (after?.id as string | undefined);
  if (!recordId) {
    return { skipped: true };
  }

  const result = await handleVariationRecordUpdated({
    client,
    objectName,
    recordId,
    after: after as unknown as Record<string, unknown>,
    updatedFields,
    actorWorkspaceMemberId: payload.workspaceMemberId,
  });

  return { role: result.role, outcomes: result.outcomes.length };
};

export default defineLogicFunction({
  universalIdentifier: '789cfc8d-e97a-44d0-a806-092c1a7d906e',
  name: 'on-record-updated-variations',
  description: 'Sync primary -> variations, or detect a diverging edit on a variation.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: '*.updated' },
});
