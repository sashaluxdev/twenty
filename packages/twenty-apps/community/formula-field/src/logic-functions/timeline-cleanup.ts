import { defineLogicFunction } from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { cleanupFormulaTimelineNoise } from 'src/logic-functions/lib/timeline-cleanup';

// Timeline rows for app writes are created by an async server-side queue job,
// so no database trigger can catch them at birth — a frequent sweep is the
// only cleanup mechanism (see ADR 0020). Rows already soft-deleted drop out
// of the query, so steady-state runs are cheap.
const handler = async (): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const counts = await cleanupFormulaTimelineNoise(client);
  return { ...counts };
};

export default defineLogicFunction({
  universalIdentifier: '9b7e5c14-2a6f-4d38-b1c9-e07a4f6d8321',
  name: 'timeline-cleanup',
  description:
    'Every 10 minutes, removes formula-app-generated noise rows from record Timelines.',
  timeoutSeconds: 120,
  handler,
  cronTriggerSettings: { pattern: '*/10 * * * *' },
});
