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
import {
  activateOverride,
  deactivateOverride,
  upsertOverride,
} from 'src/logic-functions/lib/override-repository';
import { recomputeForRecord } from 'src/logic-functions/lib/recompute';

// Opportunity record-page "Formulas" tab. For each formula field, for THIS
// record, it shows the value, the editable shared expression (with autocomplete),
// and a red/green "Override" toggle (#2):
//   - green = the formula controls this record's value,
//   - red   = manually overridden; the formula leaves this record alone.
// Turning Override on pins the current value; turning it off resets the record to
// the formula. Because the value field is editable, a human editing it directly
// is ALSO auto-detected as an override server-side — the toggle reflects that.

const TARGET_OBJECT = 'opportunity';

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

type Definition = {
  id: string;
  name: string;
  targetField: string;
  expression: string;
  enabled: boolean;
  lastError: string;
};

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
  return cycle.hasCycle ? `Dependency cycle: ${cycle.cycle.join(' -> ')}` : null;
};

const OverrideToggle = ({
  on,
  busy,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) => (
  <div style={styles.toggleWrap}>
    <span style={styles.toggleLabel}>Override</span>
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChange(!on)}
      style={{
        ...styles.toggleTrack,
        background: on ? '#e0483d' : '#3ba55d',
        opacity: busy ? 0.6 : 1,
      }}
      title={
        on
          ? 'Overridden — click to reset this record to the formula'
          : 'Formula-controlled — click to override this record'
      }
    >
      <span
        style={{
          ...styles.toggleKnob,
          transform: on ? 'translateX(18px)' : 'translateX(0px)',
        }}
      />
    </button>
    <span style={{ ...styles.toggleState, color: on ? '#e0483d' : '#3ba55d' }}>
      {on ? 'on' : 'off'}
    </span>
  </div>
);

const FormulaEditor = () => {
  const recordId = useRecordId();
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [values, setValues] = useState<Record<string, number | null>>({});
  // targetField -> { value, active }. Rows may exist but be inactive (the value
  // is retained so it can be restored when the toggle is turned back on).
  const [overrides, setOverrides] = useState<
    Record<string, { value: number | null; active: boolean }>
  >({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Transient per-formula hint, e.g. "Override value restored".
  const [restoredHint, setRestoredHint] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const client = new CoreApiClient();

    const defsResponse = await client.query({
      formulaDefinitions: {
        __args: { first: 100, filter: { targetObject: { eq: TARGET_OBJECT } } },
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

    const defs: Definition[] = (defsResponse?.formulaDefinitions?.edges ?? []).map(
      (edge: any) => ({
        id: edge.node.id,
        name: edge.node.name ?? '',
        targetField: edge.node.targetField ?? '',
        expression: edge.node.expression ?? '',
        enabled: edge.node.enabled ?? false,
        lastError: edge.node.lastError ?? '',
      }),
    );

    setDefinitions(defs);
    setDrafts((previous) => {
      const next = { ...previous };
      for (const definition of defs) {
        if (!(definition.id in next)) next[definition.id] = definition.expression;
      }
      return next;
    });

    if (recordId && defs.length > 0) {
      const selection: Record<string, unknown> = { id: true };
      for (const definition of defs) selection[definition.targetField] = true;
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

      const overrideResponse = await client.query({
        formulaOverrides: {
          __args: {
            first: 100,
            filter: {
              targetObject: { eq: TARGET_OBJECT },
              recordId: { eq: recordId },
            },
          },
          edges: {
            node: { targetField: true, overrideValue: true, active: true },
          },
        },
      });
      const nextOverrides: Record<
        string,
        { value: number | null; active: boolean }
      > = {};
      for (const edge of overrideResponse?.formulaOverrides?.edges ?? []) {
        if (edge?.node?.targetField) {
          nextOverrides[edge.node.targetField] = {
            value: edge.node.overrideValue ?? null,
            active: edge.node.active ?? false,
          };
        }
      }
      setOverrides(nextOverrides);
    }

    setLoading(false);
  }, [recordId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  const saveExpression = useCallback(
    async (definition: Definition) => {
      const expression = drafts[definition.id] ?? '';
      const error = validateExpression(expression, definition.targetField, definitions);
      if (error) {
        setDefinitions((prev) =>
          prev.map((entry) =>
            entry.id === definition.id ? { ...entry, lastError: error } : entry,
          ),
        );
        return;
      }
      setBusy(definition.id);
      try {
        const client = new CoreApiClient();
        await client.mutation({
          updateFormulaDefinition: {
            __args: { id: definition.id, data: { expression } },
            id: true,
          },
        });
      } finally {
        setBusy(null);
        setTimeout(load, 1500);
      }
    },
    [drafts, definitions, load],
  );

  const toggleOverride = useCallback(
    async (definition: Definition, turnOn: boolean) => {
      if (!recordId) return;
      setBusy(definition.id);
      setRestoredHint((prev) => ({ ...prev, [definition.id]: false }));
      try {
        const client = new CoreApiClient();
        if (turnOn) {
          // Restore a previously-set override value if one exists, otherwise pin
          // the current value.
          const restored = await activateOverride(
            client,
            TARGET_OBJECT,
            definition.targetField,
            recordId,
          );
          if (restored) {
            // Write the retained value back to the field.
            await client.mutation({
              [`update${capitalize(TARGET_OBJECT)}`]: {
                __args: {
                  id: recordId,
                  data: { [definition.targetField]: restored.overrideValue },
                },
                id: true,
              },
            });
            setRestoredHint((prev) => ({ ...prev, [definition.id]: true }));
            setOverrides((prev) => ({
              ...prev,
              [definition.targetField]: {
                value: restored.overrideValue,
                active: true,
              },
            }));
          } else {
            const current = values[definition.targetField] ?? null;
            await upsertOverride(
              client,
              TARGET_OBJECT,
              definition.targetField,
              recordId,
              current,
            );
            setOverrides((prev) => ({
              ...prev,
              [definition.targetField]: { value: current, active: true },
            }));
          }
        } else {
          // Turn off but KEEP the value; hand the record back to the formula.
          await deactivateOverride(
            client,
            TARGET_OBJECT,
            definition.targetField,
            recordId,
          );
          setOverrides((prev) => {
            const entry = prev[definition.targetField];
            return {
              ...prev,
              [definition.targetField]: {
                value: entry?.value ?? null,
                active: false,
              },
            };
          });
          await recomputeForRecord({
            client,
            formula: {
              id: definition.id,
              targetObject: TARGET_OBJECT,
              targetField: definition.targetField,
              expression: definition.expression,
              enabled: definition.enabled,
            },
            targetRecordId: recordId,
          });
        }
      } finally {
        setBusy(null);
        setTimeout(load, 1000);
      }
    },
    [recordId, values, load],
  );

  const content = useMemo(() => {
    if (loading) return <div style={styles.muted}>Loading formulas…</div>;
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
      const liveError = validateExpression(draft, definition.targetField, definitions);
      const overrideEntry = overrides[definition.targetField];
      const isOverridden = overrideEntry?.active ?? false;
      const value = isOverridden
        ? overrideEntry.value
        : values[definition.targetField];
      const rowBusy = busy === definition.id;

      return (
        <div key={definition.id} style={styles.row}>
          <div style={styles.header}>
            <span style={styles.name}>
              {definition.name || definition.targetField}
            </span>
            <span style={styles.value}>
              {value === null || value === undefined ? '—' : value}
            </span>
          </div>
          <div style={styles.fieldLabel}>
            {definition.targetField}
            {!definition.enabled ? (
              <span style={styles.error}> (formula disabled)</span>
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
              disabled={!dirty || Boolean(liveError) || rowBusy}
              onClick={() => saveExpression(definition)}
            >
              Save
            </button>
          </div>

          <div style={styles.overrideRow}>
            <OverrideToggle
              on={isOverridden}
              busy={rowBusy}
              onChange={(next) => toggleOverride(definition, next)}
            />
            {isOverridden ? (
              restoredHint[definition.id] ? (
                <span style={styles.restored} title="Override value restored">
                  Override value restored
                </span>
              ) : (
                <span style={styles.overrideHint}>
                  Edit the “{definition.name || definition.targetField}” field
                  directly to change this record’s value.
                </span>
              )
            ) : null}
          </div>

          {liveError ? (
            <div style={styles.error}>{liveError}</div>
          ) : definition.lastError ? (
            <div style={styles.error}>{definition.lastError}</div>
          ) : null}
        </div>
      );
    });
  }, [
    loading,
    definitions,
    drafts,
    values,
    overrides,
    restoredHint,
    busy,
    saveExpression,
    toggleOverride,
  ]);

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
  title: { fontWeight: 600, marginBottom: '10px', color: '#474451' },
  muted: { color: '#908e99', fontSize: '12px' },
  row: { borderTop: '1px solid #ecebf0', padding: '10px 0' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  name: { fontWeight: 600 },
  value: {
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 700,
    color: '#1b1b1f',
  },
  fieldLabel: { fontSize: '11px', color: '#908e99', margin: '2px 0 6px' },
  editRow: { display: 'flex', gap: '6px', alignItems: 'flex-start' },
  overrideRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginTop: '8px',
    flexWrap: 'wrap',
  },
  toggleWrap: { display: 'flex', alignItems: 'center', gap: '8px' },
  toggleLabel: { fontSize: '12px', fontWeight: 600, color: '#474451' },
  toggleTrack: {
    position: 'relative',
    width: '38px',
    height: '20px',
    borderRadius: '10px',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    transition: 'background 0.15s ease',
  },
  toggleKnob: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    background: '#fff',
    transition: 'transform 0.15s ease',
  },
  toggleState: { fontSize: '11px', fontWeight: 600 },
  overrideHint: { fontSize: '11px', color: '#908e99' },
  restored: { fontSize: '11px', color: '#3ba55d', fontWeight: 600 },
  button: {
    padding: '6px 12px',
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
  description: 'View values, edit formulas, and toggle per-record overrides.',
  component: FormulaEditor,
});
