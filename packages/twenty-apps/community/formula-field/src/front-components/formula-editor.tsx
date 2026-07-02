import { useCallback, useEffect, useMemo, useState } from 'react';
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

// The "edit the formula, not the value" surface (ADR 0001). Rendered on the
// Opportunity record page, it lists every formula field on this object showing:
//   - the CURRENT VALUE for this record (read straight from the real value
//     field — the same number the API/exports/cell return), and
//   - the FORMULA EXPRESSION, editable in place with live validation.
//
// Editing here updates the shared FormulaDefinition.expression (a formula is
// column-level), which the update trigger re-evaluates across records. Client-
// side validation gives instant feedback; the server-side trigger is the
// authority (defense in depth).

const TARGET_OBJECT = 'opportunity';

type Definition = {
  id: string;
  name: string;
  targetField: string;
  expression: string;
  enabled: boolean;
  lastError: string;
};

// Validates a candidate expression for a given target field against the current
// set of definitions (so cycles are caught before saving). Pure — uses only the
// bundled engine, never eval.
const validateExpression = (
  expression: string,
  targetField: string,
  allDefinitions: Definition[],
): string | null => {
  let dependencies;
  try {
    dependencies = extractDependenciesFromAst(parse(expression));
  } catch (error) {
    return isFormulaError(error)
      ? `${error.code}: ${error.message}`
      : String(error);
  }

  const others: FormulaTarget[] = allDefinitions
    .filter((definition) => definition.targetField !== targetField)
    .map((definition) => {
      try {
        return {
          object: TARGET_OBJECT,
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
    { object: TARGET_OBJECT, field: targetField, dependencies },
  ]);

  if (cycle.hasCycle) {
    return `Dependency cycle: ${cycle.cycle.join(' -> ')}`;
  }

  return null;
};

const FormulaEditor = () => {
  const recordId = useRecordId();
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const client = new CoreApiClient();

    const defsResponse = await client.query({
      formulaDefinitions: {
        __args: {
          first: 100,
          filter: { targetObject: { eq: TARGET_OBJECT } },
        },
        edges: {
          node: {
            id: true,
            name: true,
            targetField: true,
            expression: true,
            enabled: true,
            lastError: true,
          },
        },
      },
    });

    const defs: Definition[] = (
      defsResponse?.formulaDefinitions?.edges ?? []
    ).map((edge: any) => ({
      id: edge.node.id,
      name: edge.node.name ?? '',
      targetField: edge.node.targetField ?? '',
      expression: edge.node.expression ?? '',
      enabled: edge.node.enabled ?? false,
      lastError: edge.node.lastError ?? '',
    }));

    setDefinitions(defs);
    // Initialise a draft for any formula we have not seen yet, but NEVER
    // overwrite a draft the user is actively editing — otherwise the 4s refresh
    // below snaps their typing back to the stored expression.
    setDrafts((previous) => {
      const next = { ...previous };
      for (const definition of defs) {
        if (!(definition.id in next)) {
          next[definition.id] = definition.expression;
        }
      }
      return next;
    });

    // Read the current value of each formula field on this record.
    if (recordId && defs.length > 0) {
      const selection: Record<string, unknown> = { id: true };
      for (const definition of defs) {
        selection[definition.targetField] = true;
      }
      const recordResponse = await client.query({
        [TARGET_OBJECT]: {
          __args: { filter: { id: { eq: recordId } } },
          ...selection,
        },
      });
      const record = recordResponse?.[TARGET_OBJECT] ?? {};
      const nextValues: Record<string, number | null> = {};
      for (const definition of defs) {
        nextValues[definition.targetField] =
          (record[definition.targetField] as number | null) ?? null;
      }
      setValues(nextValues);
    }

    setLoading(false);
  }, [recordId]);

  useEffect(() => {
    load();
    // Light polling so recomputed values appear without a manual refresh.
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  const save = useCallback(
    async (definition: Definition) => {
      const expression = drafts[definition.id] ?? '';
      const error = validateExpression(
        expression,
        definition.targetField,
        definitions,
      );
      if (error) {
        // Client-side rejection: do not save an invalid formula.
        setDefinitions((prev) =>
          prev.map((entry) =>
            entry.id === definition.id ? { ...entry, lastError: error } : entry,
          ),
        );
        return;
      }

      setSaving(definition.id);
      try {
        const client = new CoreApiClient();
        await client.mutation({
          updateFormulaDefinition: {
            __args: { id: definition.id, data: { expression } },
            id: true,
          },
        });
      } finally {
        setSaving(null);
        // Give the recompute trigger a moment, then refresh.
        setTimeout(load, 1500);
      }
    },
    [drafts, definitions, load],
  );

  const content = useMemo(() => {
    if (loading) {
      return <div style={styles.muted}>Loading formulas…</div>;
    }
    if (definitions.length === 0) {
      return (
        <div style={styles.muted}>
          No formulas target this object yet. Create one in the “Formula
          definitions” view.
        </div>
      );
    }
    return definitions.map((definition) => {
      const draft = drafts[definition.id] ?? '';
      const dirty = draft !== definition.expression;
      const liveError = validateExpression(
        draft,
        definition.targetField,
        definitions,
      );
      const value = values[definition.targetField];
      return (
        <div key={definition.id} style={styles.row}>
          <div style={styles.header}>
            <span style={styles.name}>{definition.name || definition.targetField}</span>
            <span style={styles.value}>
              {value === null || value === undefined ? '—' : value}
            </span>
          </div>
          <div style={styles.fieldLabel}>
            {definition.targetField}
            {!definition.enabled ? (
              <span style={styles.disabled}> (disabled)</span>
            ) : null}
          </div>
          <div style={styles.editRow}>
            <FormulaFieldInput
              value={draft}
              onChange={(next) =>
                setDrafts((prev) => ({ ...prev, [definition.id]: next }))
              }
              targetObject={TARGET_OBJECT}
            />
            <button
              style={{
                ...styles.button,
                ...(dirty && !liveError ? {} : styles.buttonDisabled),
              }}
              disabled={!dirty || Boolean(liveError) || saving === definition.id}
              onClick={() => save(definition)}
            >
              {saving === definition.id ? '…' : 'Save'}
            </button>
          </div>
          {liveError ? (
            <div style={styles.error}>{liveError}</div>
          ) : definition.lastError ? (
            <div style={styles.error}>{definition.lastError}</div>
          ) : null}
        </div>
      );
    });
  }, [loading, definitions, drafts, values, saving, save]);

  return (
    <div style={styles.container}>
      <div style={styles.title}>Formula fields</div>
      {content}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '12px 16px',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: '13px',
    color: '#1b1b1f',
    boxSizing: 'border-box',
    width: '100%',
    height: '100%',
  },
  title: {
    fontWeight: 600,
    fontSize: '13px',
    marginBottom: '10px',
    color: '#474451',
  },
  muted: { color: '#908e99', fontSize: '12px' },
  row: {
    borderTop: '1px solid #ecebf0',
    padding: '8px 0',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  name: { fontWeight: 600 },
  value: { fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: '#1961ed' },
  fieldLabel: { fontSize: '11px', color: '#908e99', marginBottom: '4px' },
  disabled: { color: '#e0483d' },
  editRow: { display: 'flex', gap: '6px' },
  input: {
    flex: 1,
    padding: '5px 8px',
    border: '1px solid #d6d5db',
    borderRadius: '4px',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '12px',
    minWidth: 0,
  },
  button: {
    padding: '5px 12px',
    borderRadius: '4px',
    border: 'none',
    background: '#1961ed',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
  },
  buttonDisabled: { background: '#c3c2c9', cursor: 'default' },
  error: { color: '#e0483d', fontSize: '11px', marginTop: '4px' },
};

export const FORMULA_EDITOR_UNIVERSAL_IDENTIFIER =
  '37e2574e-615a-499d-b6e2-38241cc31cc3';

export default defineFrontComponent({
  universalIdentifier: FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
  name: 'formula-editor',
  description: 'Edit the formula for each formula field on this record.',
  component: FormulaEditor,
});
