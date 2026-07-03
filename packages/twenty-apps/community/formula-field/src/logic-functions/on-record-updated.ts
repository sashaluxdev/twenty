import {
  type DatabaseEventPayload,
  defineLogicFunction,
  type ObjectRecordUpdateEvent,
} from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { handleRecordUpdate } from 'src/logic-functions/lib/handle-record-update';

// Low-latency recompute trigger for EVERY object (ADR 0004). A wildcard
// subscription replaces the per-object opportunity/company triggers so that
// formulas created by the wizard work on any target object without a redeploy:
// same-object recompute when a formula's inputs change, cross-object recompute
// when a referenced record changes, and manual-override detection (#2).
//
// The app's own objects are excluded: FormulaDefinition changes have dedicated
// validation triggers, and FormulaOverride writes are bookkeeping.
const APP_OWNED_OBJECTS = new Set(['formulaDefinition', 'formulaOverride']);

const handler = async (
  payload: DatabaseEventPayload<
    ObjectRecordUpdateEvent<Record<string, unknown>>
  >,
): Promise<Record<string, unknown>> => {
  const objectName = payload.objectMetadata?.nameSingular;
  if (!objectName || APP_OWNED_OBJECTS.has(objectName)) {
    return { skipped: true };
  }

  // Dynamic client: wizard-created value fields are not in the genql type map.
  const client = createDynamicCoreClient();
  const { after, updatedFields } = payload.properties;
  const recordId = payload.recordId ?? (after?.id as string | undefined);

  if (!recordId) {
    return { recomputed: 0 };
  }

  const outcomes = await handleRecordUpdate({
    client,
    objectName,
    recordId,
    after: after as unknown as Record<string, unknown>,
    updatedFields,
    actorWorkspaceMemberId: payload.workspaceMemberId,
  });

  const written = outcomes.filter((outcome) => outcome.changed).length;
  const errors = outcomes.filter((outcome) => outcome.error).length;

  return { evaluated: outcomes.length, written, errors };
};

export default defineLogicFunction({
  universalIdentifier: '233b6be9-0c74-4114-9a96-f09c686f6240',
  name: 'on-record-updated',
  description: 'Recompute formulas when any record changes.',
  timeoutSeconds: 30,
  handler,
  databaseEventTriggerSettings: { eventName: '*.updated' },
});
