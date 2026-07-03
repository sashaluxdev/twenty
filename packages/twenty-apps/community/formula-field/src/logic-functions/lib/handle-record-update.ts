import { compileFormula } from 'src/engine';
import {
  loadAllEnabledFormulas,
  recordEvaluationHeartbeat,
} from 'src/logic-functions/lib/formula-repository';
import {
  computeFormulaValueForRecord,
  recomputeAllRecords,
  recomputeForRecord,
} from 'src/logic-functions/lib/recompute';
import {
  findOverride,
  upsertOverride,
} from 'src/logic-functions/lib/override-repository';
import {
  findCyclicTargets,
  isCyclicTarget,
} from 'src/logic-functions/lib/save-validation';
import {
  type FormulaClient,
  type RecomputeOutcome,
} from 'src/logic-functions/lib/types';
import {
  normalizeComputedValue,
  normalizeStoredValue,
} from 'src/logic-functions/lib/value-io';

// Shared body for every per-object database-event trigger. Given a record that
// changed on `objectName`, it recomputes:
//   1. formulas whose target IS this object and whose inputs on this record
//      actually changed (using the event payload's `after` — no refetch), and
//   2. formulas on ANY object that cross-reference this exact record on a field
//      that changed (recomputed across all their target records, because a
//      cross-record formula applies to every target row — ADR 0004).
//
// Consulting the dependency index means unrelated formulas are skipped, and a
// formula whose only changed field is its own value output (our previous write)
// is a no-op — the trigger-level half of the recursion guard.

// Float-tolerant equality with null handling — used to compare a written value
// against the formula's computed value.
const numbersEqual = (a: number | null, b: number | null): boolean => {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-9;
};

const safeDependencies = (expression: string) => {
  try {
    return compileFormula(expression).dependencies;
  } catch {
    return null;
  }
};

// True if the update touched at least one field the formula reads on the same
// record. When updatedFields is unknown/empty we recompute to stay safe.
const sameRecordAffected = (
  dependencyFields: string[],
  updatedFields: string[] | undefined,
): boolean => {
  if (!updatedFields || updatedFields.length === 0) {
    return true;
  }
  return dependencyFields.some((field) => updatedFields.includes(field));
};

export type HandleRecordUpdateArgs = {
  client: FormulaClient;
  objectName: string;
  recordId: string;
  after: Record<string, unknown> | null | undefined;
  updatedFields: string[] | undefined;
  // Set when the write came from a real person (not the app). Used to detect a
  // manual, direct edit of a value field and turn it into an override (#2).
  actorWorkspaceMemberId?: string | null;
};

export const handleRecordUpdate = async ({
  client,
  objectName,
  recordId,
  after,
  updatedFields,
  actorWorkspaceMemberId,
}: HandleRecordUpdateArgs): Promise<RecomputeOutcome[]> => {
  const formulas = await loadAllEnabledFormulas(client);
  // Never recompute a formula caught in a dependency cycle — that is what would
  // ping-pong forever. Save-time validation disables these, but this is the
  // runtime backstop for cyclic formulas created directly via the API.
  const cyclic = findCyclicTargets(formulas);
  const outcomes: RecomputeOutcome[] = [];

  // Manual override detection (#2). A value field changed on this record. We
  // must tell a genuine human edit apart from the app's OWN recompute write —
  // and the actor alone is not enough, because a recompute triggered by a user's
  // input edit inherits that user's identity on its event. So we compare the
  // written value to what the formula actually computes: if they match, it's the
  // app's recompute (ignore); if they differ, a human pinned a manual value.
  if (actorWorkspaceMemberId && updatedFields && updatedFields.length > 0) {
    for (const field of updatedFields) {
      const formula = formulas.find(
        (candidate) =>
          candidate.targetObject === objectName &&
          candidate.targetField === field,
      );
      if (!formula) continue; // not a formula value field
      // OFFLINE: inputs are unfetchable, so "what would the formula say?" has
      // no answer — never turn edits into overrides while broken.
      if (formula.status === 'OFFLINE') continue;

      // Composite-aware: a CURRENCY value field arrives as
      // { amountMicros, currencyCode } — its numeric value is the micros.
      const normalized = normalizeStoredValue(after?.[field]);

      const computed = await computeFormulaValueForRecord({
        client,
        formula,
        targetRecordId: recordId,
        prefetchedRecord: after ?? undefined,
      });
      const computedStored = normalizeComputedValue(
        formula.targetFieldType,
        computed.value,
      );

      // Matches the formula -> app recompute -> not an override.
      if (computed.error === null && numbersEqual(computedStored, normalized)) {
        continue;
      }
      await upsertOverride(client, objectName, field, recordId, normalized);
    }
  }

  for (const formula of formulas) {
    if (isCyclicTarget(cyclic, formula)) {
      continue;
    }

    // OFFLINE: an input field is deactivated/missing — recompute would only
    // error against unfetchable inputs. UPSTREAM formulas keep computing.
    if (formula.status === 'OFFLINE') {
      continue;
    }

    const dependencies = safeDependencies(formula.expression ?? '');
    if (!dependencies) {
      continue;
    }

    // Case 1: this object's own record changed and it feeds this formula.
    if (
      formula.targetObject === objectName &&
      sameRecordAffected(dependencies.sameRecordFields, updatedFields)
    ) {
      // Respect an ACTIVE manual override on this specific record (#2).
      const override = await findOverride(
        client,
        formula.targetObject ?? '',
        formula.targetField ?? '',
        recordId,
      );
      if (override?.active) {
        outcomes.push({
          formulaId: formula.id,
          targetRecordId: recordId,
          changed: false,
          value: override.overrideValue,
          error: null,
          overridden: true,
        });
        continue;
      }
      const outcome = await recomputeForRecord({
        client,
        formula,
        targetRecordId: recordId,
        prefetchedRecord: after ?? undefined,
      });
      outcomes.push(outcome);
      await recordEvaluationHeartbeat(client, formula, {
        value: outcome.value,
        error: outcome.error,
      });
      continue;
    }

    // Case 2: a record this formula cross-references changed on a field it reads.
    const crossImpacted = dependencies.crossRecordRefs.some(
      (ref) =>
        ref.object === objectName &&
        ref.recordId === recordId &&
        (!updatedFields ||
          updatedFields.length === 0 ||
          updatedFields.includes(ref.field)),
    );

    if (crossImpacted) {
      outcomes.push(...(await recomputeAllRecords(client, formula)));
    }
  }

  return outcomes;
};
