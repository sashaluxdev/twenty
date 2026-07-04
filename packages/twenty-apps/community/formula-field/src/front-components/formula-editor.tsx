import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';
import { defineFrontComponent } from 'twenty-sdk/define';
import { useRecordId } from 'twenty-sdk/front-component';

import { parse, usesToday } from 'src/engine';
import {
  formatRelativePast,
  isStaleTimestamp,
} from 'src/front-components/lib/format-relative-past';
import { FormulaFieldInput } from 'src/front-components/lib/formula-field-input';
import {
  computeDropWrite,
  movePreview,
  sortByOrder,
} from 'src/front-components/lib/reorder-definitions';
import { validateExpression } from 'src/front-components/lib/validate-expression';
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
  order: number | null;
  lastEvaluatedAt: string | null;
  // Parsed once at load time (staleness scoping, ADR 0015) — checking it at
  // render/self-heal time would re-parse every expression on every 4s poll.
  usesTodayFlag: boolean;
};

// Safe usesToday() over a possibly-invalid expression — an unparseable
// formula has no TODAY() dependency to track (same guard as the recompute
// engine's expressionUsesTodayOf).
const expressionUsesToday = (expression: string): boolean => {
  try {
    return usesToday(parse(expression));
  } catch {
    return false;
  }
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
  // Two-step save guard: saving an expression changes the formula for EVERY
  // record of the object, so the first Save click arms this warning and a second
  // click within ~5s confirms. Editing the expression (or the timeout) disarms.
  const [armedSaveId, setArmedSaveId] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The record id never changes for a mounted widget — resolve its object once.
  const resolvedHost = useRef<string | null>(null);
  // Self-heal throttle (ADR 0015): mirrors convergeFormulaFieldLayout's 60s
  // pattern. A dead sweep means the FRONT runtime is the only thing left to
  // recompute a stale TODAY() formula for a viewed record — this bounds how
  // often that recompute fires per mounted widget.
  const lastSelfHealAtRef = useRef(0);
  // Drag-to-reorder (ADR 0014, pointer events): pointerdown only records a
  // pending gesture (id + start coordinates) in pendingDragRef — it does NOT
  // arm the drag. A row's onPointerMove arms it once the pointer has moved
  // >= 8px (draggingRef.current = true, draggingId set for render). Only an
  // armed drag previews (onPointerEnter), persists (onPointerUp), or cancels
  // (onPointerLeave/onPointerCancel — reverts via load(), writes nothing).
  // draggingRef is read synchronously inside closures (poll guard, commit/
  // cancel) where state would be stale. definitionsRef mirrors the latest
  // visual order so commit always reads the current list rather than a stale
  // one from the render that created the callback.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingRef = useRef(false);
  const definitionsRef = useRef<Definition[]>([]);
  const pendingDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
  } | null>(null);

  const disarmSave = useCallback(() => {
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setArmedSaveId(null);
  }, []);

  useEffect(() => () => disarmSave(), [disarmSave]);

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
            order: true,
            lastEvaluatedAt: true,
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
        order: edge.node.order ?? null,
        lastEvaluatedAt: edge.node.lastEvaluatedAt ?? null,
        usesTodayFlag: expressionUsesToday(edge.node.expression ?? ''),
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
    const sortedDefs = sortByOrder(defs);

    // Mid-drag, the live reorder preview owns `definitions` — the poll must
    // not clobber it with the server's (not-yet-persisted) order. Everything
    // below (values/overrides/drafts) still refreshes unconditionally.
    if (!draggingRef.current) {
      setDefinitions(sortedDefs);
      definitionsRef.current = sortedDefs;
    }

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

      // Self-heal (ADR 0015): a stale TODAY() formula on this record means the
      // sweep/worker isn't converging it — recompute it here in the front
      // runtime, throttled so a persistently-stale record doesn't re-trigger
      // on every 4s poll. With a LIVE worker the resulting write round-trips
      // through the record-update handler, refreshing lastEvaluatedAt and
      // clearing staleness. With a DEAD worker (this feature's primary case)
      // lastEvaluatedAt stays frozen, so the note persists and this re-fires
      // every 60s while the widget is open — deliberate: each pass is an
      // idempotent, write-avoidant recompute that keeps the viewed record
      // correct, and the persisting note truthfully reports pipeline health.
      const now = Date.now();
      const staleDefs = defs.filter(
        (definition) =>
          definition.enabled &&
          definition.usesTodayFlag &&
          isStaleTimestamp(definition.lastEvaluatedAt, now),
      );
      if (staleDefs.length > 0 && now - lastSelfHealAtRef.current > 60_000) {
        lastSelfHealAtRef.current = now;
        Promise.all(
          staleDefs.map((definition) =>
            recomputeForRecord({
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
            }),
          ),
        )
          .catch(() => {})
          .finally(() => {
            setTimeout(load, 1500);
          });
      }
    }

    setLoading(false);
  }, [recordId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  // Drop handler for drag-to-reorder (ADR 0014). Reads definitionsRef (not
  // `definitions`) so it always sees the live hover-preview order rather than
  // a stale render-time snapshot. Fractional-midpoint drop: ONE row's order
  // is written in steady state; computeDropWrite falls back to a full
  // reindex only when normalization is required (unnumbered rows involved,
  // duplicate/NaN neighbors, or float precision exhausted).
  const commitDrag = useCallback(async () => {
    const pending = pendingDragRef.current;
    pendingDragRef.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDraggingId(null);
    const draggedId = pending?.id;
    if (!draggedId) return;
    const writes = computeDropWrite(
      definitionsRef.current.map(({ id, order }) => ({ id, order })),
      draggedId,
    );
    if (writes.length === 0) return;
    try {
      // Dynamic client: wizard-created value fields are not in the genql type map.
      const client = createDynamicCoreClient();
      await Promise.all(
        writes.map((write) =>
          client.mutation({
            updateFormulaDefinition: {
              __args: { id: write.id, data: { order: write.order } },
              id: true,
            },
          }),
        ),
      );
      // Reflect ONLY the written rows' persisted orders locally — unwritten
      // rows keep whatever order they already had (no renumbering the whole
      // list, per ADR 0014's single-row-write model).
      const writtenOrders = new Map(writes.map((write) => [write.id, write.order]));
      setDefinitions((current) => {
        const next = current.map((definition) =>
          writtenOrders.has(definition.id)
            ? { ...definition, order: writtenOrders.get(definition.id) as number }
            : definition,
        );
        definitionsRef.current = next;
        return next;
      });
    } catch {
      // Server write failed mid-drag — re-converge from the server rather
      // than leaving the UI showing an order that never persisted.
      setTimeout(load, 500);
    }
  }, [load]);

  // Drop-outside cancel (ADR 0014): pointercancel or the pointer leaving the
  // container mid-drag disarms and reverts the preview via a reload — the
  // guard is already clear when load() runs, so it re-sorts from server
  // state. Nothing is persisted.
  const cancelDrag = useCallback(() => {
    pendingDragRef.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDraggingId(null);
    load();
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
      // First click arms the all-records warning; a second click confirms.
      if (armedSaveId !== definition.id) {
        setArmedSaveId(definition.id);
        if (armTimer.current) clearTimeout(armTimer.current);
        armTimer.current = setTimeout(() => setArmedSaveId(null), 5000);
        return;
      }
      disarmSave();
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
    [drafts, definitions, load, armedSaveId, disarmSave],
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
            // restored CURRENCY value resolves its code as
            // existing-on-record -> definition.currencyCode -> JPY fallback,
            // per buildTargetWriteData).
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
      const armed = armedSaveId === definition.id;
      const isDragging = draggingId === definition.id;
      const stale =
        definition.enabled &&
        definition.usesTodayFlag &&
        isStaleTimestamp(definition.lastEvaluatedAt, Date.now());

      return (
        <div
          key={definition.id}
          style={isDragging ? { ...styles.row, ...styles.rowDragging } : styles.row}
          onPointerMove={(event) => {
            const pending = pendingDragRef.current;
            if (!pending || draggingRef.current) return;
            // remote-dom may proxy pointer events without clientX/clientY —
            // when coordinates are unavailable, arm on this first move
            // rather than silently never arming (dead feature).
            const { clientX, clientY } = event;
            const hasCoordinates =
              typeof clientX === 'number' && typeof clientY === 'number';
            const distance = hasCoordinates
              ? Math.hypot(clientX - pending.startX, clientY - pending.startY)
              : Number.POSITIVE_INFINITY;
            if (distance >= 8) {
              draggingRef.current = true;
              setDraggingId(pending.id);
            }
          }}
          onPointerEnter={() => {
            if (
              draggingRef.current &&
              draggingId &&
              draggingId !== definition.id
            ) {
              setDefinitions((current) => {
                const next = movePreview(current, draggingId, definition.id);
                definitionsRef.current = next;
                return next;
              });
            }
          }}
        >
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
            <span
              style={
                isDragging
                  ? { ...styles.dragHandle, ...styles.dragHandleActive }
                  : styles.dragHandle
              }
              onPointerDown={(event) => {
                // Without this, the browser's native text-drag gesture can
                // hijack the pointerdown (dragstart fires), which suppresses
                // pointermove/pointerenter for the rest of the gesture and
                // silently breaks the custom reorder — most reliably when
                // dragging downward or at normal (non-careful) speeds. This
                // only records the pending gesture — it does NOT arm the
                // drag; arming happens after 8px of travel (see the row's
                // onPointerMove).
                event.preventDefault();
                pendingDragRef.current = {
                  id: definition.id,
                  startX: event.clientX,
                  startY: event.clientY,
                };
              }}
              title="Drag to reorder"
            >
              ⋮⋮
            </span>
            <span style={styles.name}>
              {definition.name || definition.targetField}
            </span>
            <span style={styles.value}>{displayValue(definition, value)}</span>
          </div>
          {stale && definition.lastEvaluatedAt ? (
            // Definition-level framing on purpose: the DEFINITION's heartbeat
            // is old (always true when this renders), whereas this row's
            // value may have just been verified correct by the self-heal —
            // and "refreshing…" would over-claim during the 60s throttle
            // window when nothing is actively running.
            <div style={styles.staleNote}>
              Formula last evaluated{' '}
              {formatRelativePast(definition.lastEvaluatedAt, Date.now())}
            </div>
          ) : null}
          <div style={styles.fieldLabel}>
            {definition.targetField}
            {!definition.enabled ? (
              <span style={styles.error}> (formula disabled)</span>
            ) : null}
          </div>

          <div style={styles.editRow}>
            <FormulaFieldInput
              value={draft}
              onChange={(next) => {
                // Editing disarms a pending all-records save confirmation.
                if (armedSaveId === definition.id) disarmSave();
                setDrafts((prev) => ({ ...prev, [definition.id]: next }));
              }}
              targetObject={definition.targetObject}
            />
            <button
              style={{
                ...styles.button,
                ...(armed ? styles.buttonArmed : {}),
                ...(dirty && !liveError ? {} : styles.buttonDisabled),
              }}
              disabled={!dirty || Boolean(liveError) || rowBusy}
              onClick={() => saveExpression(definition)}
            >
              {armed ? 'Confirm' : 'Save'}
            </button>
          </div>
          {armed ? (
            <div style={styles.confirmWarning}>
              This changes the formula for ALL {definition.targetObject} records —
              click Save again to confirm.
            </div>
          ) : null}

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
    armedSaveId,
    draggingId,
    disarmSave,
    saveExpression,
    toggleOverride,
  ]);

  return (
    <div
      style={styles.container}
      onPointerUp={commitDrag}
      onPointerLeave={cancelDrag}
      onPointerCancel={cancelDrag}
    >
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
  // rowDragging uses the same longhand border properties as `row` (not the
  // `border` shorthand) — mixing shorthand and longhand across renders makes
  // React drop the longhand value on the next render that doesn't repeat it,
  // permanently stripping the row's top separator once a drag ends.
  row: {
    borderTop: '1px solid #ecebf0',
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: 'none',
    padding: '10px 0',
  },
  // Light background tint + a strengthened (never dashed/opacity-dimmed) top
  // border — core reserves opacity-dimming for secondary multi-drag items
  // (ADR 0014 §5). Longhands on every side, matching `row`, per the
  // shorthand/longhand React bug noted above.
  rowDragging: {
    background: 'rgba(0,0,0,0.04)',
    borderTop: '2px solid #908e99',
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: 'none',
  },
  header: {
    display: 'flex',
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  dragHandle: {
    cursor: 'grab',
    userSelect: 'none',
    marginRight: 8,
    color: '#999',
    touchAction: 'none',
  },
  dragHandleActive: { cursor: 'grabbing' },
  name: { fontWeight: 600 },
  value: {
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 700,
    color: '#1b1b1f',
    marginLeft: 'auto',
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
  buttonArmed: { background: '#e0483d' },
  buttonDisabled: { background: '#c3c2c9', cursor: 'default' },
  confirmWarning: {
    background: '#fff4e5',
    border: '1px solid #e58600',
    color: '#a35c00',
    borderRadius: '4px',
    padding: '6px 8px',
    fontSize: '11px',
    marginTop: '6px',
  },
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
  // Not a banner (ADR 0015): smaller, inline, no background/border — this is
  // a self-correcting note (the front runtime is already recomputing), not an
  // actionable break like OFFLINE/UPSTREAM above. Same orange as
  // bannerUpstream's text, core's Status color convention for "attention, not
  // error".
  staleNote: {
    color: '#a35c00',
    fontSize: '10px',
    marginTop: '2px',
  },
};

export { FORMULA_EDITOR_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

export default defineFrontComponent({
  universalIdentifier: FORMULA_EDITOR_UNIVERSAL_IDENTIFIER,
  name: 'formula-editor',
  description: 'View values, edit formulas, and toggle per-record overrides.',
  component: FormulaEditor,
});
