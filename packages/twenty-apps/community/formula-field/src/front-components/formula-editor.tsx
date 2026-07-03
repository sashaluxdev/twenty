import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';
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
import {
  epochDaysToDateString,
  epochDaysToIsoDateTime,
} from 'src/logic-functions/lib/date-serial';
import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { convergeFormulaFieldLayout } from 'src/logic-functions/lib/fx-status-field';
import { recomputeForRecord } from 'src/logic-functions/lib/recompute';
import {
  buildTargetWriteData,
  normalizeStoredValue,
  selectionEntryForFieldKind,
} from 'src/logic-functions/lib/value-io';

// Record-page "Formulas" tab (object-agnostic — the wizard attaches it to any
// object that gets a formula field). For each formula field, for THIS record,
// it shows the value, the editable shared expression (with autocomplete), and
// a red/green "Override" toggle (#2):
//   - green = the formula controls this record's value,
//   - red   = manually overridden; the formula leaves this record alone.
// Turning Override on pins the current value; turning it off resets the record to
// the formula. Because the value field is editable, a human editing it directly
// is ALSO auto-detected as an override server-side — the toggle reflects that.
//
// The execution context exposes only the record id, not which object's page
// the widget is on — so the host object is resolved by probing the record id
// against the distinct target objects of existing formulas (one cheap query
// each, once per mount).

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

type Definition = {
  id: string;
  name: string;
  targetObject: string;
  targetField: string;
  targetFieldType: string;
  currencyCode: string;
  expression: string;
  enabled: boolean;
  lastError: string;
  status: string;
  statusReason: string;
};

// Values are handled in micros for CURRENCY fields (like the engine); shown to
// the user in currency units.
const displayValue = (
  definition: Definition,
  value: number | null | undefined,
): string => {
  if (value === null || value === undefined) return '—';
  if (definition.targetFieldType === 'CURRENCY') {
    return `${(value / 1_000_000).toFixed(2)}`;
  }
  // DATE / DATE_TIME values are epoch-days (Excel serial model, ADR 0011) —
  // show them as their calendar/ISO scalar rather than a raw day count.
  if (definition.targetFieldType === 'DATE') {
    return epochDaysToDateString(value);
  }
  if (definition.targetFieldType === 'DATE_TIME') {
    return epochDaysToIsoDateTime(value);
  }
  return String(value);
};

const validateExpression = (
  expression: string,
  hostObject: string,
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
    { object: hostObject, field: targetField, dependencies },
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
  // The record id never changes for a mounted widget — resolve its object once.
  const resolvedHost = useRef<string | null>(null);

  const load = useCallback(async () => {
    // Dynamic client: wizard-created value fields are not in the genql type map.
    const client = createDynamicCoreClient();

    const defsResponse = await client.query({
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
            expression: true,
            enabled: true,
            lastError: true,
            status: true,
            statusReason: true,
          },
        },
      },
    });

    const allDefs: Definition[] = (defsResponse?.formulaDefinitions?.edges ?? [])
      // Wizard drafts persist targetObject before a field exists — not
      // renderable rows yet.
      .filter((edge: any) => (edge?.node?.targetField ?? '') !== '')
      .map(
      (edge: any) => ({
        id: edge.node.id,
        name: edge.node.name ?? '',
        targetObject: edge.node.targetObject ?? '',
        targetField: edge.node.targetField ?? '',
        targetFieldType: edge.node.targetFieldType ?? 'NUMBER',
        currencyCode: edge.node.currencyCode ?? '',
        expression: edge.node.expression ?? '',
        enabled: edge.node.enabled ?? false,
        lastError: edge.node.lastError ?? '',
        status: edge.node.status ?? '',
        statusReason: edge.node.statusReason ?? '',
      }),
    );

    // Resolve which object's record page hosts this widget: probe the record
    // id against each distinct target object (the context has no object name).
    if (!resolvedHost.current && recordId) {
      const candidates = Array.from(
        new Set(allDefs.map((definition) => definition.targetObject)),
      ).filter(Boolean);
      const probes = await Promise.all(
        candidates.map((candidate) =>
          client
            .query({
              [candidate]: {
                __args: { filter: { id: { eq: recordId } } },
                id: true,
              },
            })
            .then((response: any) => (response?.[candidate] ? candidate : null))
            .catch(() => null),
        ),
      );
      resolvedHost.current = probes.find(Boolean) ?? null;
    }
    const host = resolvedHost.current;

    const defs = host
      ? allDefs.filter((definition) => definition.targetObject === host)
      : [];

    setDefinitions(defs);

    // Converge chip visibility/position in the record-page layout (throttled;
    // must run client-side — view mutations reject the app's server token).
    for (const definition of defs) {
      convergeFormulaFieldLayout({
        objectNameSingular: definition.targetObject,
        targetField: definition.targetField,
        statusVisible: definition.status !== '',
      });
    }

    setDrafts((previous) => {
      const next = { ...previous };
      for (const definition of defs) {
        if (!(definition.id in next)) next[definition.id] = definition.expression;
      }
      return next;
    });

    if (host && recordId && defs.length > 0) {
      const selection: Record<string, unknown> = { id: true };
      for (const definition of defs) {
        // CURRENCY value fields are composite and need a sub-selection.
        selection[definition.targetField] = selectionEntryForFieldKind(
          definition.targetFieldType,
        );
      }
      const recordResponse = await client.query({
        [host]: {
          __args: { filter: { id: { eq: recordId } } },
          ...selection,
        },
      });
      const record = recordResponse?.[host] ?? {};
      const nextValues: Record<string, number | null> = {};
      for (const definition of defs) {
        nextValues[definition.targetField] = normalizeStoredValue(
          record[definition.targetField],
        );
      }
      setValues(nextValues);

      const overrideResponse = await client.query({
        formulaOverrides: {
          __args: {
            first: 100,
            filter: {
              targetObject: { eq: host },
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
      const error = validateExpression(
        expression,
        definition.targetObject,
        definition.targetField,
        definitions,
      );
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
        // Dynamic client: wizard-created value fields are not in the genql type map.
    const client = createDynamicCoreClient();
        // enabled: true — saving a valid expression (re-)activates a formula
        // that save-time validation had disabled (fresh or previously invalid).
        await client.mutation({
          updateFormulaDefinition: {
            __args: { id: definition.id, data: { expression, enabled: true } },
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
        // Dynamic client: wizard-created value fields are not in the genql type map.
    const client = createDynamicCoreClient();
        if (turnOn) {
          // Restore a previously-set override value if one exists, otherwise pin
          // the current value.
          const restored = await activateOverride(
            client,
            definition.targetObject,
            definition.targetField,
            recordId,
          );
          if (restored) {
            // Write the retained value back to the field (composite-aware; a
            // restored CURRENCY value defaults its code to USD).
            await client.mutation({
              [`update${capitalize(definition.targetObject)}`]: {
                __args: {
                  id: recordId,
                  data: buildTargetWriteData(
                    definition.targetField,
                    definition.targetFieldType,
                    restored.overrideValue,
                    undefined,
                    definition.currencyCode,
                  ),
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
              definition.targetObject,
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
            definition.targetObject,
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
              targetObject: definition.targetObject,
              targetField: definition.targetField,
              targetFieldType: definition.targetFieldType,
              currencyCode: definition.currencyCode,
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
      const liveError = validateExpression(
        draft,
        definition.targetObject,
        definition.targetField,
        definitions,
      );
      const overrideEntry = overrides[definition.targetField];
      const isOverridden = overrideEntry?.active ?? false;
      const value = isOverridden
        ? overrideEntry.value
        : values[definition.targetField];
      const rowBusy = busy === definition.id;

      return (
        <div key={definition.id} style={styles.row}>
          {definition.status === 'OFFLINE' ? (
            <div style={styles.bannerOffline}>
              OFFLINE — {definition.statusReason || 'an input field is gone'}
            </div>
          ) : definition.status === 'UPSTREAM' ? (
            <div style={styles.bannerUpstream}>
              UPSTREAM BREAK — {definition.statusReason ||
                'a formula earlier in the chain is broken'}
            </div>
          ) : null}
          <div style={styles.header}>
            <span style={styles.name}>
              {definition.name || definition.targetField}
            </span>
            <span style={styles.value}>{displayValue(definition, value)}</span>
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
              targetObject={definition.targetObject}
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
  bannerOffline: {
    background: '#fdecea',
    border: '1px solid #e0483d',
    color: '#b3271e',
    borderRadius: '4px',
    padding: '6px 8px',
    fontSize: '11px',
    marginBottom: '8px',
  },
  bannerUpstream: {
    background: '#fff4e5',
    border: '1px solid #e58600',
    color: '#a35c00',
    borderRadius: '4px',
    padding: '6px 8px',
    fontSize: '11px',
    marginBottom: '8px',
  },
};

export { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

export default defineFrontComponent({
  universalIdentifier: FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
  name: 'formula-editor',
  description: 'View values, edit formulas, and toggle per-record overrides.',
  component: FormulaEditor,
});
