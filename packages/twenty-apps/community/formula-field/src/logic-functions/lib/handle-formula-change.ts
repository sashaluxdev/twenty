import { extractDependencies } from 'src/engine';
import { deepJsonEqual } from 'src/logic-functions/lib/deep-equal';
import {
  loadAllEnabledFormulas,
  updateFormulaBookkeeping,
} from 'src/logic-functions/lib/formula-repository';
import { refreshFormulaStatuses } from 'src/logic-functions/lib/formula-status';
import { targetFieldOptions } from 'src/logic-functions/lib/metadata-objects';
import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import { validateFormula } from 'src/logic-functions/lib/save-validation';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';

// Fields the app writes back as bookkeeping. An update that only touches these
// is our own write — skip re-processing to avoid a validation/recompute loop.
// `order` is the Formula tab's drag-to-reorder column: display-only, written one
// row at a time by the widget (formula-editor.tsx), so a reorder must not cost a
// validate + recompute per dropped row.
const BOOKKEEPING_FIELDS = new Set([
  'dependencies',
  'lastEvaluatedAt',
  'lastValue',
  'lastValueText',
  'lastError',
  'status',
  'statusReason',
  'scanCursor',
  'order',
]);

// Platform-owned columns that no formula can read. They ride along in a real
// event: `position` moves whenever someone drags the definition row in a table
// view, and the platform's own exclusion list is not a contract — twenty-server
// stopped stripping POSITION from the event diff (20c83e1f86) precisely so that
// position-only updates emit events instead of being dropped, which turned every
// reorder into a full validate + recompute across every target record. Treated
// as bookkeeping so a column the engine never reads cannot cost a pass.
// `updatedAt` is also load-bearing for the row-image fallback below, where it is
// the one field that ALWAYS differs.
export const PLATFORM_MANAGED_FIELDS = new Set([
  'position',
  'updatedAt',
  'createdAt',
  'createdBy',
  'searchVector',
]);

// Cosmetic/immutable definition fields the engine never reads: renames and
// description edits must not trigger validation or recompute (item 0.2).
// allowOverride (ADR 0028) is immutable after create — the wizard writes it
// once at create time and nothing ever flips it again, so the definition lane
// never needs to react to it (spec §2.3).
const INERT_FIELDS = new Set(['name', 'description', 'allowOverride']);

const isIgnorableField = (field: string): boolean =>
  BOOKKEEPING_FIELDS.has(field) ||
  PLATFORM_MANAGED_FIELDS.has(field) ||
  INERT_FIELDS.has(field);

// An empty list means "nothing the app reads changed", which is only reachable
// through the row-image fallback: the platform drops an update whose diff is
// empty before any trigger fires.
const isPureBookkeepingUpdate = (
  updatedFields: string[] | undefined,
): boolean => {
  if (!updatedFields) {
    return false;
  }
  return updatedFields.every(isIgnorableField);
};

// The changed field set the guards below judge. twenty-server delivers
// `updatedFields` on every UPDATE event (declared non-optional on
// ObjectRecordUpdateEvent, and an update with an empty diff never reaches a
// trigger), but an update event also carries both full row images — so when the
// list is missing we diff them rather than assume a real edit and pay a full
// validate + recompute. A create has no before image and keeps the safe path.
export const resolveChangedFields = (
  updatedFields: string[] | undefined,
  before: FormulaDefinitionRecord | null | undefined,
  after: FormulaDefinitionRecord,
): string[] | undefined => {
  if (updatedFields) {
    return updatedFields;
  }
  if (!before) {
    return undefined;
  }
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  // deepJsonEqual compares JSON shapes; event payloads arrive JSON-serialized,
  // so Date instances never reach it — a live Date here would diff wrongly.
  return [
    ...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]),
  ].filter((field) => !deepJsonEqual(beforeRecord[field], afterRecord[field]));
};

export type HandleFormulaChangeArgs = {
  client: FormulaClient;
  after: FormulaDefinitionRecord | null | undefined;
  updatedFields: string[] | undefined;
  // The update event's `before` row image. Absent on a create.
  before?: FormulaDefinitionRecord | null;
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
  before,
}: HandleFormulaChangeArgs): Promise<Record<string, unknown>> => {
  if (!after?.id) {
    return { handled: false };
  }

  const changedFields = resolveChangedFields(updatedFields, before, after);

  // Recursion guard: ignore our own bookkeeping writes.
  if (isPureBookkeepingUpdate(changedFields)) {
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
    changedFields &&
    changedFields.every(
      (field) => isIgnorableField(field) || field === 'enabled',
    )
  ) {
    return { handled: false, reason: 'disabled-bookkeeping' };
  }

  // A disabled formula is inert: never auto-clear its error or re-evaluate it.
  // Only a human re-enabling it (enabled: true) or editing its expression flows
  // past here. This keeps a cycle rejection sticky instead of being cleared when
  // the sibling cyclic formula later drops out of the enabled set.
  if (after.enabled === false && !changedFields?.includes('expression')) {
    return { handled: false, reason: 'disabled' };
  }

  // Wizard drafts have no targetField until finalizeCreation: nothing is
  // validatable yet, and validating would disable the draft with lastError
  // junk plus a workspace-wide status refresh on every draft tick (item 0.2 /
  // A'-M1). The draft still must not stay in the enabled set — the hourly
  // sweep would full-scan its target object otherwise. No status refresh
  // needed: a definition without a targetField cannot be anyone's dependency.
  if ((after.targetField ?? '') === '') {
    if (after.enabled !== false) {
      await updateFormulaBookkeeping(client, after.id, { enabled: false });
    }
    return { handled: false, reason: 'no-target-field' };
  }

  const existing = await loadAllEnabledFormulas(client);
  // Preload field kinds so save-time validation can run its kind-dependent
  // checks: the target object (the strict kind gate's own-record operands + a
  // same-record mirror's source) and every cross-referenced object the
  // expression reads (the strict kind gate can type a cross-record operand
  // anywhere in the AST, not just a bare mirror ref — step 1c still only needs
  // the bare-ref case, which is a subset of this wider set). Each fetch is
  // guarded — a client without fieldKinds, or a rejecting impl, degrades to no
  // kind check for that object (it must NOT abort save handling before cycle
  // detection).
  const kindsByObject = new Map<string, Map<string, string>>();
  const preloadKinds = async (objectName: string): Promise<void> => {
    if (!objectName || kindsByObject.has(objectName)) {
      return;
    }
    try {
      const map = await client.fieldKinds?.(objectName);
      if (map) {
        kindsByObject.set(objectName, map);
      }
    } catch {
      // Degrade to no kind check for this object.
    }
  };

  if (after.targetObject) {
    await preloadKinds(after.targetObject);
  }
  // Also preload every cross-referenced object's kinds — the strict kind gate
  // (Task 3) can read a cross-record operand anywhere in the expression, not
  // just a bare mirror ref.
  try {
    const { crossRecordRefs } = extractDependencies(after.expression ?? '');
    for (const ref of crossRecordRefs) {
      await preloadKinds(ref.object);
    }
  } catch {
    // A parse failure surfaces through validateFormula; nothing to preload.
  }

  // The membership gate's async seam (ADR 0029 tier 1a): the sync validator
  // takes options as data. Unresolvable options degrade to skip — the
  // recompute gates re-check with resolved options every pass.
  const targetOptions =
    after.targetFieldType === 'SELECT' && after.targetObject
      ? await targetFieldOptions(after.targetObject, after.targetField ?? '')
      : null;

  const result = validateFormula({
    candidate: after,
    existingFormulas: existing,
    fieldKinds: (objectName) => kindsByObject.get(objectName),
    targetOptions,
  });

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
