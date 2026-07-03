import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineFrontComponent } from 'twenty-sdk/define';
import { useRecordId } from 'twenty-sdk/front-component';

import {
  detectCycle,
  extractDependenciesFromAst,
  type FormulaTarget,
  isFormulaError,
  parse,
} from 'src/engine';
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
  expression: string;
  enabled: boolean;
  lastValue: number | null;
  lastError: string;
  status: string;
  statusReason: string;
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

const FormulaDefinitionEditor = () => {
  const recordId = useRecordId();
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [allDefinitions, setAllDefinitions] = useState<Definition[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
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
            expression: true,
            enabled: true,
            lastValue: true,
            lastError: true,
            status: true,
            statusReason: true,
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
        expression: edge.node.expression ?? '',
        enabled: edge.node.enabled ?? false,
        lastValue: edge.node.lastValue ?? null,
        lastError: edge.node.lastError ?? '',
        status: edge.node.status ?? '',
        statusReason: edge.node.statusReason ?? '',
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
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

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
          }}
          onCreated={load}
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

      <div style={s.label}>Formula expression</div>
      <FormulaFieldInput
        value={draft}
        onChange={setDraft}
        targetObject={definition.targetObject}
        multiline
        placeholder="e.g. formulaInputA + formulaInputB * 2"
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
};

export const FORMULA_DEFINITION_EDITOR_UNIVERSAL_IDENTIFIER =
  '6e0adf74-0c52-41c4-89d8-1b7934dc773d';

export default defineFrontComponent({
  universalIdentifier: FORMULA_DEFINITION_EDITOR_UNIVERSAL_IDENTIFIER,
  name: 'formula-definition-editor',
  description: 'Edit and validate a formula on its FormulaDefinition record.',
  component: FormulaDefinitionEditor,
});
