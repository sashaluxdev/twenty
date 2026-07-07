import { defineLogicFunction } from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import {
  loadAllEnabledVariationConfigs,
  updateVariationConfigBookkeeping,
} from 'src/logic-functions/lib/variation-config-repository';
import { sweepVariationConfig } from 'src/logic-functions/lib/variation-sync';

// The convergence backstop for variations, mirroring formula-sweep.ts: hourly,
// re-sync every enabled config's variations. Repairs anything staled by a
// missed event, a deploy window, or a transient error.
const handler = async (): Promise<Record<string, unknown>> => {
  const client = createDynamicCoreClient();
  const configs = await loadAllEnabledVariationConfigs(client);

  let evaluated = 0;
  let written = 0;
  let errored = 0;
  let frozen = 0;

  for (const config of configs) {
    // Per-config fault isolation: one config throwing (e.g. a metadata load
    // failure) must not kill the whole hour's sweep for every remaining
    // config. This deliberately hardens beyond formula-sweep.ts's sibling,
    // which loops without a guard. Best-effort persist the error to the
    // config's lastError, itself guarded so bookkeeping can never kill the loop.
    try {
      const outcome = await sweepVariationConfig(client, config);
      evaluated += outcome.evaluated;
      written += outcome.written;
      errored += outcome.errored;
      frozen += outcome.frozen;
    } catch (error) {
      errored += 1;
      try {
        await updateVariationConfigBookkeeping(client, config.id, {
          lastError: String(error),
        });
      } catch {
        // Swallow: surfacing the error is best-effort; the sweep must continue.
      }
    }
  }

  return { configs: configs.length, evaluated, written, errored, frozen };
};

export default defineLogicFunction({
  universalIdentifier: 'd6e19796-a375-4ba0-ace6-b218094c632e',
  name: 'variation-sweep',
  description: 'Hourly re-sync of all enabled variation configs (convergence backstop).',
  timeoutSeconds: 120,
  handler,
  cronTriggerSettings: { pattern: '0 * * * *' },
});
