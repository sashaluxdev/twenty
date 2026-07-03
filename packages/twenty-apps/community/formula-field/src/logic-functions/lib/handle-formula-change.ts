import {
  loadAllEnabledFormulas,
  updateFormulaBookkeeping,
} from 'src/logic-functions/lib/formula-repository';
import { refreshFormulaStatuses } from 'src/logic-functions/lib/formula-status';
import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import { validateFormula } from 'src/logic-functions/lib/save-validation';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';

// Fields the app writes back as bookkeeping. An update that only touches these
// is our own write — skip re-processing to avoid a validation/recompute loop.
const BOOKKEEPING_FIELDS = new Set([
  'dependencies',
  'lastEvaluatedAt',
  'lastValue',
  'lastError',
  'status',
  'statusReason',
]);

const isPureBookkeepingUpdate = (
  updatedFields: string[] | undefined,
): boolean => {
  if (!updatedFields || updatedFields.length === 0) {
    return false;
  }
  return updatedFields.every((field) => BOOKKEEPING_FIELDS.has(field));
};

export type HandleFormulaChangeArgs = {
  client: FormulaClient;
  after: FormulaDefinitionRecord | null | undefined;
  updatedFields: string[] | undefined;
};

// Save-time validation (ADR 0005). Runs after a FormulaDefinition is created or
// updated: parses the expression, detects cycles against the whole graph, then
// either persists the dependency index + clears the error (and populates values
// via a full recompute), or disables the formula and records the error. All
// writes are write-avoidant so the trigger does not re-fire itself.
export const handleFormulaChange = async ({
  client,
  after,
  updatedFields,
}: HandleFormulaChangeArgs): Promise<Record<string, unknown>> => {
  if (!after?.id) {
    return { handled: false };
  }

  // Recursion guard: ignore our own bookkeeping writes.
  if (isPureBookkeepingUpdate(updatedFields)) {
    return { handled: false, reason: 'bookkeeping-only' };
  }

  // Second recursion guard: our own "disable on cycle" write sets
  // { enabled: false, lastError }. That update must NOT re-trigger validation —
  // otherwise, with the sibling cyclic formula now excluded (disabled), the
  // cycle appears to vanish and we would wrongly clear the error. So: if the
  // formula is already disabled and the update only touched bookkeeping/enabled
  // fields, leave it alone. A human re-enabling (enabled: true) or editing the
  // expression still flows through.
  if (
    after.enabled === false &&
    updatedFields &&
    updatedFields.length > 0 &&
    updatedFields.every(
      (field) => BOOKKEEPING_FIELDS.has(field) || field === 'enabled',
    )
  ) {
    return { handled: false, reason: 'disabled-bookkeeping' };
  }

  // A disabled formula is inert: never auto-clear its error or re-evaluate it.
  // Only a human re-enabling it (enabled: true) or editing its expression flows
  // past here. This keeps a cycle rejection sticky instead of being cleared when
  // the sibling cyclic formula later drops out of the enabled set.
  if (after.enabled === false && !updatedFields?.includes('expression')) {
    return { handled: false, reason: 'disabled' };
  }

  const existing = await loadAllEnabledFormulas(client);
  const result = validateFormula({ candidate: after, existingFormulas: existing });

  if (!result.valid) {
    // Post-save rejection: disable + record the error (the front component
    // performs the true pre-save rejection in the UI). Write-avoidant.
    const needsWrite =
      after.enabled !== false || (after.lastError ?? '') !== result.error;
    if (needsWrite) {
      await updateFormulaBookkeeping(client, after.id, {
        enabled: false,
        lastError: result.error,
      });
    }
    // The formula dropped out of the enabled set — dependents' flags change.
    await refreshFormulaStatuses(client);
    return { handled: true, valid: false, error: result.error };
  }

  // Valid: persist the dependency index and clear any stale error.
  const nextDependencies = JSON.stringify(result.dependencies);
  const prevDependencies = JSON.stringify(
    (after as { dependencies?: unknown }).dependencies ?? null,
  );
  const needsWrite =
    nextDependencies !== prevDependencies || (after.lastError ?? '') !== '';

  if (needsWrite) {
    await updateFormulaBookkeeping(client, after.id, {
      dependencies: result.dependencies,
      lastError: '',
    });
  }

  // A save can heal or break the dependency graph (re-pointed inputs, new
  // chains) — refresh operational statuses BEFORE recompute so an OFFLINE
  // formula is skipped instead of error-spamming on unfetchable inputs.
  const statusResult = await refreshFormulaStatuses(client);
  if (statusResult.byId.get(after.id)?.status === 'OFFLINE') {
    return { handled: true, valid: true, skipped: 'offline' };
  }

  // Populate/refresh values across all target records now that the formula is
  // known-good. No-op suppression keeps this cheap when nothing changed.
  const outcomes = await recomputeAllRecords(client, after);
  const written = outcomes.filter((outcome) => outcome.changed).length;

  return {
    handled: true,
    valid: true,
    recordsWritten: written,
    recordsEvaluated: outcomes.length,
  };
};
