import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { defineFrontComponent } from 'twenty-sdk/define';
import { useRecordId } from 'twenty-sdk/front-component';

import {
  detectCycle,
  extractDependenciesFromAst,
  type FormulaTarget,
  isFormulaError,
  parse,
} from 'src/engine';
import {
  type DeleteDefinitionPlan,
  deleteDefinitionCompletely,
  planDeleteDefinition,
} from 'src/front-components/lib/delete-definition-completely';
import { FieldSettingsEditor } from 'src/front-components/lib/field-settings-editor';
import { formatRelativePast } from 'src/front-components/lib/format-relative-past';
import { FormulaFieldInput } from 'src/front-components/lib/formula-field-input';
import { convergeFormulaFieldLayout } from 'src/logic-functions/lib/fx-status-field';
import { FormulaSetupWizard } from 'src/front-components/lib/formula-setup-wizard';

// Formula editor for the FormulaDefinition record page (a custom object, so the
// page-layout renderer IS used here — unlike standard-object record pages in this
// build; see ADR 0007). A fresh definition (no target yet) shows the guided
// "Add formula field" wizard, which creates the value field dynamically via the
// metadata API (feature #1). A wired definition shows the last computed value +
// last error and lets the expression be edited with live client-side validation
// (parse + cycle), then saved. The recompute triggers re-evaluate across
// records on save.

type Definition = {
  id: string;
  name: string;
  targetObject: string;
  targetField: string;
  targetFieldType: string;
  currencyCode: string;
  outputFormat: string;
  targetFieldSettings: string;
  expression: string;
  enabled: boolean;
  lastValue: number | null;
  lastError: string;
  status: string;
  statusReason: string;
  lastEvaluatedAt: string | null;
};

const validate = (
  candidate: Definition,
  expression: string,
  all: Definition[],
): string | null => {
  let dependencies;
  try {
    dependencies = extractDependenciesFromAst(parse(expression));
  } catch (error) {
    return isFormulaError(error)
      ? `${error.code}: ${error.message}`
      : String(error);
  }

  const others: FormulaTarget[] = all
    .filter((definition) => definition.id !== candidate.id)
    .map((definition) => {
      try {
        return {
          object: definition.targetObject,
          field: definition.targetField,
          dependencies: extractDependenciesFromAst(parse(definition.expression)),
        };
      } catch {
        return null;
      }
    })
    .filter((target): target is FormulaTarget => target !== null);

  const cycle = detectCycle([
    ...others,
    {
      object: candidate.targetObject,
      field: candidate.targetField,
      dependencies,
    },
  ]);
  return cycle.hasCycle ? `Dependency cycle: ${cycle.cycle.join(' -> ')}` : null;
};

// Danger zone: permanently destroy the definition and (when this app owns the
// value field and no other definition shares it) hard-delete the value field +
// its FX Status companion, including every record's stored computed value. The
// remote-dom sandbox has no modal primitive, so the confirmation is an INLINE
// panel; the destructive button unlocks only once the user types "Delete".
const FormulaDangerZone = ({
  definitionId,
  onDeleted,
}: {
  definitionId: string;
  onDeleted: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<DeleteDefinitionPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const openPanel = useCallback(async () => {
    setOpen(true);
    setPlanning(true);
    setError('');
    try {
      // Compute the warning from the record's ACTUAL state (fresh re-fetch +
      // shared-target guard), not from stale widget props.
      setPlan(await planDeleteDefinition(new CoreApiClient(), definitionId));
    } catch (planError) {
      setError((planError as Error).message ?? String(planError));
    } finally {
      setPlanning(false);
    }
  }, [definitionId]);

  const cancel = useCallback(() => {
    setOpen(false);
    setConfirmText('');
    setPlan(null);
    setError('');
  }, []);

  const confirm = useCallback(async () => {
    setDeleting(true);
    setError('');
    try {
      await deleteDefinitionCompletely({
        coreClient: new CoreApiClient(),
        metadataClient: new MetadataApiClient(),
        definitionId,
      });
      onDeleted();
    } catch (deleteError) {
      setError((deleteError as Error).message ?? String(deleteError));
      setDeleting(false);
    }
  }, [definitionId, onDeleted]);

  const canConfirm = confirmText === 'Delete' && !deleting;

  return (
    <div style={s.dangerZone}>
      <div style={s.dangerTitle}>Danger zone</div>
      {!open ? (
        <button style={s.dangerButton} onClick={openPanel}>
          Delete Completely…
        </button>
      ) : (
        <div style={s.dangerPanel}>
          {planning ? (
            <div style={s.muted}>Checking what will be removed…</div>
          ) : plan ? (
            <div style={s.dangerList}>
              <div style={s.dangerItem}>
                • The formula definition will be{' '}
                <span style={s.strong}>permanently destroyed</span> (not moved to
                trash).
              </div>
              {plan.deleteValueField ? (
                <>
                  <div style={s.dangerItem}>
                    • The value field <span style={s.mono}>{plan.targetField}</span>{' '}
                    on <span style={s.mono}>{plan.targetObject}</span> will be{' '}
                    <span style={s.strong}>permanently deleted</span>, including all
                    stored computed values on every record.
                  </div>
                  <div style={s.dangerItem}>
                    • The FX status field{' '}
                    <span style={s.mono}>{plan.companionField}</span> will be
                    permanently deleted too.
                  </div>
                </>
              ) : plan.keepReason === 'shared' ? (
                <div style={s.dangerItem}>
                  • The value field <span style={s.mono}>{plan.targetField}</span>{' '}
                  will be <span style={s.strong}>kept</span> — another formula
                  definition also targets it. Only this definition and its
                  overrides are removed.
                </div>
              ) : plan.keepReason === 'not-created' ? (
                <div style={s.dangerItem}>
                  • The value field <span style={s.mono}>{plan.targetField}</span>{' '}
                  will be <span style={s.strong}>kept</span> — it was not created by
                  this app. Only this definition and its overrides are removed.
                </div>
              ) : (
                <div style={s.dangerItem}>
                  • No value field is wired to this draft yet — only the definition
                  is removed.
                </div>
              )}
              <div style={s.dangerItem}>
                • Any manual override rows for this formula will be removed.
              </div>
            </div>
          ) : null}

          <div style={s.label}>
            Type <span style={s.strong}>Delete</span> to confirm
          </div>
          <input
            style={s.confirmInput}
            value={confirmText}
            placeholder="Delete"
            onChange={(event) => setConfirmText(event.target.value)}
          />

          <div style={s.actions}>
            <button
              style={{
                ...s.dangerConfirm,
                ...(canConfirm ? {} : s.buttonDisabled),
              }}
              disabled={!canConfirm}
              onClick={confirm}
            >
              {deleting ? 'Deleting…' : 'Delete completely'}
            </button>
            <button style={s.cancelButton} onClick={cancel} disabled={deleting}>
              Cancel
            </button>
          </div>
          {error ? <div style={s.err}>{error}</div> : null}
        </div>
      )}
    </div>
  );
};

const FormulaDefinitionEditor = () => {
  const recordId = useRecordId();
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [allDefinitions, setAllDefinitions] = useState<Definition[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  // Once the record is destroyed the page points at a dead record: stop polling
  // and show a terminal state so the widget never crashes or retry-loops.
  const [deleted, setDeleted] = useState(false);
  // Tracks which record's draft we have already seeded, so the 4s refresh below
  // never overwrites the expression the user is actively editing.
  const seededRecordId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!recordId) return;
    const client = new CoreApiClient();

    const all = await client.query({
      formulaDefinitions: {
        __args: { first: 100 },
        edges: {
          node: {
            id: true,
            name: true,
            targetObject: true,
            targetField: true,
            targetFieldType: true,
            currencyCode: true,
            outputFormat: true,
            targetFieldSettings: true,
            expression: true,
            enabled: true,
            lastValue: true,
            lastError: true,
            status: true,
            statusReason: true,
            lastEvaluatedAt: true,
          },
        },
      },
    });

    const list: Definition[] = (all?.formulaDefinitions?.edges ?? []).map(
      (edge: any) => ({
        id: edge.node.id,
        name: edge.node.name ?? '',
        targetObject: edge.node.targetObject ?? '',
        targetField: edge.node.targetField ?? '',
        targetFieldType: edge.node.targetFieldType ?? 'NUMBER',
        currencyCode: edge.node.currencyCode ?? '',
        outputFormat: edge.node.outputFormat ?? '',
        targetFieldSettings: edge.node.targetFieldSettings ?? '',
        expression: edge.node.expression ?? '',
        enabled: edge.node.enabled ?? false,
        lastValue: edge.node.lastValue ?? null,
        lastError: edge.node.lastError ?? '',
        status: edge.node.status ?? '',
        statusReason: edge.node.statusReason ?? '',
        lastEvaluatedAt: edge.node.lastEvaluatedAt ?? null,
      }),
    );

    setAllDefinitions(list);
    const current = list.find((entry) => entry.id === recordId) ?? null;
    setDefinition(current);
    if (current?.targetObject && current?.targetField) {
      // Converge chip visibility/position in the target object's record-page
      // layout (throttled; view mutations require this user-token context).
      convergeFormulaFieldLayout({
        objectNameSingular: current.targetObject,
        targetField: current.targetField,
        statusVisible: current.status !== '',
      });
    }
    // Seed the editable draft only once per record — subsequent refreshes update
    // the displayed value/error but leave the user's in-progress text alone.
    if (current && seededRecordId.current !== recordId) {
      setDraft(current.expression);
      seededRecordId.current = recordId;
    }
    setLoading(false);
  }, [recordId]);

  useEffect(() => {
    if (deleted) return;
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load, deleted]);

  const save = useCallback(async () => {
    if (!definition) return;
    const error = validate(definition, draft, allDefinitions);
    if (error) {
      setDefinition({ ...definition, lastError: error });
      return;
    }
    setSaving(true);
    try {
      const client = new CoreApiClient();
      // enabled: true — a fresh definition is auto-disabled by save-time
      // validation until it has a target + expression; saving a valid
      // expression (re-)activates it and triggers the full recompute.
      await client.mutation({
        updateFormulaDefinition: {
          __args: {
            id: definition.id,
            data: { expression: draft, enabled: true },
          },
          id: true,
        },
      });
    } finally {
      setSaving(false);
      setTimeout(load, 1500);
    }
  }, [definition, draft, allDefinitions, load]);

  const liveError = useMemo(
    () => (definition ? validate(definition, draft, allDefinitions) : null),
    [definition, draft, allDefinitions],
  );

  if (deleted) {
    return <div style={s.muted}>This formula was deleted.</div>;
  }
  if (loading) return <div style={s.muted}>Loading…</div>;
  if (!definition) return <div style={s.muted}>Formula not found.</div>;

  // A definition without a target FIELD is a fresh record or a resumed draft:
  // run the guided setup, seeded from the persisted draft selections.
  if (!definition.targetField) {
    return (
      <div style={s.container}>
        <FormulaSetupWizard
          draft={{
            id: definition.id,
            name: definition.name,
            targetObject: definition.targetObject,
            outputFormat: definition.outputFormat,
            currencyCode: definition.currencyCode,
            targetFieldSettings: definition.targetFieldSettings,
          }}
          onCreated={load}
        />
        {/* Render even for wizard drafts: an interrupted wizard may already
            have created the value field, so it must be removable. */}
        <FormulaDangerZone
          definitionId={definition.id}
          onDeleted={() => setDeleted(true)}
        />
      </div>
    );
  }

  const dirty = draft !== definition.expression;
  const awaitingExpression = !definition.expression && !dirty;

  return (
    <div style={s.container}>
      {definition.status === 'OFFLINE' ? (
        <div style={s.bannerOffline}>
          OFFLINE — {definition.statusReason || 'an input field is gone'}.
          Values are frozen; recompute is paused.
        </div>
      ) : definition.status === 'UPSTREAM' ? (
        <div style={s.bannerUpstream}>
          UPSTREAM BREAK — {definition.statusReason || 'a formula earlier in the chain is broken'}.
          Still computing, but inputs may be stale.
        </div>
      ) : null}
      <div style={s.header}>
        <div>
          <div style={s.target}>
            {definition.targetObject}.{definition.targetField}
            {definition.targetFieldType === 'CURRENCY' ? (
              <span style={s.hint}> currency (micros)</span>
            ) : null}
            {!definition.enabled ? <span style={s.err}> (disabled)</span> : null}
          </div>
          <div style={s.label}>Current value</div>
        </div>
        <div style={s.value}>
          {definition.lastValue === null ? '—' : definition.lastValue}
        </div>
      </div>
      {definition.lastEvaluatedAt ? (
        <div style={s.hint}>
          Last evaluated{' '}
          {formatRelativePast(definition.lastEvaluatedAt, Date.now())}
        </div>
      ) : null}

      <div style={s.label}>Formula expression</div>
      <FormulaFieldInput
        value={draft}
        onChange={setDraft}
        targetObject={definition.targetObject}
        multiline
        placeholder="e.g. amount.amountMicros * 1.1"
      />

      <div style={s.actions}>
        <button
          style={{
            ...s.button,
            ...(dirty && !liveError ? {} : s.buttonDisabled),
          }}
          disabled={!dirty || Boolean(liveError) || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save formula'}
        </button>
        <span style={s.hint}>
          fields by name · cross-record as [object:uuid:field]
        </span>
      </div>

      {awaitingExpression ? (
        <div style={s.hint}>
          Field created — write the formula expression and save to activate.
        </div>
      ) : liveError ? (
        <div style={s.err}>{liveError}</div>
      ) : definition.lastError ? (
        <div style={s.err}>{definition.lastError}</div>
      ) : (
        <div style={s.ok}>Valid</div>
      )}

      <FieldSettingsEditor
        definitionId={definition.id}
        targetObject={definition.targetObject}
        targetField={definition.targetField}
        targetFieldType={definition.targetFieldType}
        outputFormat={definition.outputFormat}
        currencyCode={definition.currencyCode}
      />

      <FormulaDangerZone
        definitionId={definition.id}
        onDeleted={() => setDeleted(true)}
      />
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '13px',
    color: '#1b1b1f',
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '14px',
  },
  target: { fontWeight: 600, fontFamily: 'ui-monospace, monospace' },
  value: {
    fontSize: '22px',
    fontWeight: 700,
    color: '#1961ed',
    fontVariantNumeric: 'tabular-nums',
  },
  label: { fontSize: '11px', color: '#908e99', marginBottom: '4px' },
  textarea: {
    width: '100%',
    padding: '8px',
    border: '1px solid #d6d5db',
    borderRadius: '4px',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '13px',
    resize: 'none',
    boxSizing: 'border-box',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    margin: '10px 0',
  },
  button: {
    padding: '6px 14px',
    borderRadius: '4px',
    border: 'none',
    background: '#1961ed',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
  },
  buttonDisabled: { background: '#c3c2c9', cursor: 'default' },
  hint: { fontSize: '11px', color: '#b0aeb8' },
  muted: { padding: '16px', color: '#908e99' },
  err: { color: '#e0483d', fontSize: '12px' },
  ok: { color: '#3ba55d', fontSize: '12px' },
  bannerOffline: {
    background: '#fdecea',
    border: '1px solid #e0483d',
    color: '#b3271e',
    borderRadius: '4px',
    padding: '8px 10px',
    fontSize: '12px',
    marginBottom: '12px',
  },
  bannerUpstream: {
    background: '#fff4e5',
    border: '1px solid #e58600',
    color: '#a35c00',
    borderRadius: '4px',
    padding: '8px 10px',
    fontSize: '12px',
    marginBottom: '12px',
  },
  dangerZone: {
    marginTop: '20px',
    paddingTop: '12px',
    borderTop: '1px solid #eeedf0',
  },
  dangerTitle: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#b3271e',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '8px',
  },
  dangerButton: {
    padding: '6px 14px',
    borderRadius: '4px',
    border: '1px solid #e0483d',
    background: '#fff',
    color: '#b3271e',
    cursor: 'pointer',
    fontSize: '13px',
  },
  dangerPanel: {
    border: '1px solid #e0483d',
    background: '#fdecea',
    borderRadius: '4px',
    padding: '12px',
  },
  dangerList: {
    marginBottom: '10px',
    fontSize: '12px',
    color: '#5c1a15',
    lineHeight: 1.5,
  },
  dangerItem: { marginBottom: '4px' },
  strong: { fontWeight: 700 },
  mono: { fontFamily: 'ui-monospace, monospace' },
  confirmInput: {
    width: '100%',
    padding: '6px 8px',
    border: '1px solid #e0483d',
    borderRadius: '4px',
    fontSize: '13px',
    boxSizing: 'border-box',
    marginBottom: '8px',
  },
  dangerConfirm: {
    padding: '6px 14px',
    borderRadius: '4px',
    border: 'none',
    background: '#e0483d',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
  },
  cancelButton: {
    padding: '6px 14px',
    borderRadius: '4px',
    border: '1px solid #d6d5db',
    background: '#fff',
    color: '#1b1b1f',
    cursor: 'pointer',
    fontSize: '13px',
  },
};

export const FORMULA_DEFINITION_EDITOR_UNIVERSAL_IDENTIFIER =
  '6e0adf74-0c52-41c4-89d8-1b7934dc773d';

export default defineFrontComponent({
  universalIdentifier: FORMULA_DEFINITION_EDITOR_UNIVERSAL_IDENTIFIER,
  name: 'formula-definition-editor',
  description: 'Edit and validate a formula on its FormulaDefinition record.',
  component: FormulaDefinitionEditor,
});
