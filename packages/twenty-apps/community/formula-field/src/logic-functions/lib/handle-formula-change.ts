import {
  loadAllEnabledFormulas,
  updateFormulaBookkeeping,
} from 'src/logic-functions/lib/formula-repository';
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
