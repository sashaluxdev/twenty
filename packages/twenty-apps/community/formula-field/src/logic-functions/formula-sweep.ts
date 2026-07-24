import { defineLogicFunction } from 'twenty-sdk/define';

import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import {
  loadAllEnabledFormulas,
  updateFormulaBookkeeping,
} from 'src/logic-functions/lib/formula-repository';
import { refreshFormulaStatuses } from 'src/logic-functions/lib/formula-status';
import {
  cleanupCompanionFields,
  type CompanionCleanupResult,
} from 'src/logic-functions/lib/fx-status-cleanup';
import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import {
  findCyclicTargets,
  isCyclicTarget,
} from 'src/logic-functions/lib/save-validation';

// The function's declared timeoutSeconds is 120; leave headroom for the
// bookkeeping writes that follow the scans.
const SWEEP_BUDGET_MS = 100_000;

// The convergence backstop (ADR 0004). Hourly, re-evaluate every enabled formula
// across all its target records. Event triggers give latency; this sweep gives
// eventual correctness — it repairs any value staled by a missed event, a deploy
// window, or a transient error. No-op suppression keeps it cheap: records that
// are already correct are not rewritten.
const handler = async (): Promise<Record<string, unknown>> => {
  const startedAt = Date.now();
  // Dynamic client: wizard-created value fields are not in the genql type map.
  const client = createDynamicCoreClient();
  // Refresh operational statuses first, then load the definitions fresh so
  // the OFFLINE skip below sees current verdicts.
  const statusResult = await refreshFormulaStatuses(client);
  // Legacy FX Status companion removal (ADR 0021) — no-op once converged.
  // Optional cleanup must never abort the convergence backstop below, so a
  // top-level failure (defs query dead after retries) is swallowed and the
  // pass retries next hour.
  let companionCleanup: CompanionCleanupResult = {
    companions: 0,
    deactivated: 0,
    deleted: 0,
    failed: 0,
  };
  try {
    companionCleanup = await cleanupCompanionFields(client);
  } catch {
    // Counters stay zeroed; the cron result still reports the pass ran.
  }
  const formulas = await loadAllEnabledFormulas(client);
  const cyclic = findCyclicTargets(formulas);

  let evaluated = 0;
  let written = 0;
  let errored = 0;
  let skippedCyclic = 0;
  let skippedOffline = 0;

  for (const formula of formulas) {
    if (statusResult.byId.get(formula.id)?.status === 'OFFLINE') {
      skippedOffline += 1;
      continue;
    }
    // A cyclic formula never converges — record the problem and skip it rather
    // than spin (mirrors the runtime guard in handleRecordUpdate).
    if (isCyclicTarget(cyclic, formula)) {
      skippedCyclic += 1;
      const cycleError = 'Skipped: formula participates in a dependency cycle';
      if ((formula.lastError ?? '') !== cycleError) {
        await updateFormulaBookkeeping(client, formula.id, {
          lastError: cycleError,
        });
      }
      continue;
    }

    const outcomes = await recomputeAllRecords(client, formula, {
      deadlineAt: startedAt + SWEEP_BUDGET_MS,
      // Only the sweep participates in the scan-cursor protocol: resume from a
      // stored cursor here, and clear it on completion. Event-driven callers
      // must full-scan (default false), so this flag is scoped to the sweep.
      resumeFromStoredCursor: true,
    });
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

  return {
    formulas: formulas.length,
    evaluated,
    written,
    errored,
    skippedCyclic,
    skippedOffline,
    offline: statusResult.offline,
    upstream: statusResult.upstream,
    companionCleanup,
  };
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
