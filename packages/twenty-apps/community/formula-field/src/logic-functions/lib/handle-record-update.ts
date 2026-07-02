import { compileFormula } from 'src/engine';
import { loadAllEnabledFormulas } from 'src/logic-functions/lib/formula-repository';
import {
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

  // Magic override (#2): a human directly edited a value field on this object.
  // Record it as an override so the formula stops touching this record. Detected
  // by a real actor (workspaceMemberId) — the app's own recompute writes have no
  // workspaceMemberId, so they never self-trigger this.
  if (actorWorkspaceMemberId && updatedFields && updatedFields.length > 0) {
    const valueFields = new Set(
      formulas
        .filter((formula) => formula.targetObject === objectName)
        .map((formula) => formula.targetField ?? ''),
    );
    for (const field of updatedFields) {
      if (!valueFields.has(field)) continue;
      const rawValue = after?.[field];
      const value =
        typeof rawValue === 'number'
          ? rawValue
          : rawValue == null
            ? null
            : Number(rawValue);
      await upsertOverride(
        client,
        objectName,
        field,
        recordId,
        Number.isFinite(value as number) ? (value as number) : null,
      );
    }
  }

  for (const formula of formulas) {
    if (isCyclicTarget(cyclic, formula)) {
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
      // Respect a manual override on this specific record (#2).
      const override = await findOverride(
        client,
        formula.targetObject ?? '',
        formula.targetField ?? '',
        recordId,
      );
      if (override) {
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
      outcomes.push(
        await recomputeForRecord({
          client,
          formula,
          targetRecordId: recordId,
          prefetchedRecord: after ?? undefined,
        }),
      );
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
