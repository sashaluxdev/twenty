import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import {
  loadAllEnabledFormulas,
  updateFormulaBookkeeping,
} from 'src/logic-functions/lib/formula-repository';
import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';

// The convergence backstop (ADR 0004). Hourly, re-evaluate every enabled formula
// across all its target records. Event triggers give latency; this sweep gives
// eventual correctness — it repairs any value staled by a missed event, a deploy
// window, or a transient error. No-op suppression keeps it cheap: records that
// are already correct are not rewritten.
const handler = async (): Promise<Record<string, unknown>> => {
  const client = new CoreApiClient();
  const formulas = await loadAllEnabledFormulas(client);

  let evaluated = 0;
  let written = 0;
  let errored = 0;

  for (const formula of formulas) {
    const outcomes = await recomputeAllRecords(client, formula);
    evaluated += outcomes.length;
    written += outcomes.filter((outcome) => outcome.changed).length;

    // Surface the last error (if any) on the definition so failures are visible
    // in the FormulaDefinition view. Write-avoidant.
    const firstError = outcomes.find((outcome) => outcome.error)?.error ?? '';
    if ((formula.lastError ?? '') !== firstError) {
      await updateFormulaBookkeeping(client, formula.id, {
        lastError: firstError,
      });
    }
    if (firstError) {
      errored += 1;
    }
  }

  return { formulas: formulas.length, evaluated, written, errored };
};

export default defineLogicFunction({
  universalIdentifier: '5b39c341-2983-4974-be4a-b65037ffa0d1',
  name: 'formula-sweep',
  description: 'Hourly re-evaluation of all enabled formulas (convergence backstop).',
  timeoutSeconds: 120,
  handler,
  // Top of every hour.
  cronTriggerSettings: { pattern: '0 * * * *' },
});
