import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { defineFrontComponent } from 'twenty-sdk/define';
import { useRecordId } from 'twenty-sdk/front-component';

import { bareReferenceOf, parse, usesToday } from 'src/engine';
import {
  type DeleteDefinitionPlan,
  deleteDefinitionCompletely,
  planDeleteDefinition,
} from 'src/front-components/lib/delete-definition-completely';
import { FieldSettingsEditor } from 'src/front-components/lib/field-settings-editor';
import { formatRelativePast } from 'src/front-components/lib/format-relative-past';
import {
  FormulaFieldInput,
  useObjectFields,
} from 'src/front-components/lib/formula-field-input';
import { POLL_INTERVAL_MS } from 'src/front-components/lib/poll-interval';
import {
  refreshStaleTodayFormulas,
  type RefreshThrottleState,
} from 'src/front-components/lib/refresh-stale-formulas';
import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { isMirrorTargetKind } from 'src/logic-functions/lib/mirror-kinds';
import { FormulaSetupWizard } from 'src/front-components/lib/formula-setup-wizard';
import { validateExpression } from 'src/front-components/lib/validate-expression';
import {
  BannerDanger,
  BannerWarning,
  BigValue,
  DangerButton,
  DangerPanel,
  ErrText,
  HintText,
  MutedText,
  OkText,
  OutlineDangerButton,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  TextInput,
  WidgetRoot,
} from 'src/front-components/lib/ui';
import { TOKENS } from 'src/front-components/lib/ui-tokens';

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
  // Parsed once at load time (staleness scoping, ADR 0015) — checking it at
  // render/refresh time would re-parse the expression every 4s poll.
  usesTodayFlag: boolean;
};

// Safe usesToday() over a possibly-invalid expression — an unparseable
// formula has no TODAY() dependency to track (same guard as
// formula-editor.tsx's local expressionUsesToday).
const expressionUsesToday = (expression: string): boolean => {
  try {
    return usesToday(parse(expression));
  } catch {
    return false;
  }
};

// Delegates to the shared record-page validator (parse + string-comparison kind
// check + mirror checks + cycle detection) so this editor and the record-page
// "Formulas" tab enforce the exact same rules. The host field kinds (name ->
// metadata type) are closed into the accessor validateExpression expects; the
// candidate's targetFieldType drives the mirror checks.
const validate = (
  candidate: Definition,
  expression: string,
  all: Definition[],
  fieldKinds?: Map<string, string>,
): string | null =>
  validateExpression(
    expression,
    candidate.targetObject,
    candidate.targetField,
    all.map((definition) => ({
      targetObject: definition.targetObject,
      targetField: definition.targetField,
      expression: definition.expression,
    })),
    fieldKinds
      ? (object) => (object === candidate.targetObject ? fieldKinds : undefined)
      : undefined,
    candidate.targetFieldType,
  );

// The "{object}.{field}" a mirror definition copies from, for the read-only
// Field-settings line. Same-record mirrors read from the target object itself;
// cross-record mirrors name the referenced object. Null when the expression is
// not a bare whole-field reference (not a mirror).
const mirrorSourceRef = (
  expression: string,
  targetObject: string,
): string | null => {
  let bare;
  try {
    bare = bareReferenceOf(parse(expression));
  } catch {
    return null;
  }
  if (bare === null) return null;
  return bare.kind === 'same'
    ? `${targetObject}.${bare.field}`
    : `${bare.ref.object}.${bare.ref.fieldPath}`;
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
    <div style={layout.dangerZone}>
      <SectionTitle style={{ ...layout.dangerTitle, color: TOKENS.colorRed }}>
        Danger zone
      </SectionTitle>
      {!open ? (
        <OutlineDangerButton onClick={openPanel}>
          Delete Completely…
        </OutlineDangerButton>
      ) : (
        <DangerPanel>
          {planning ? (
            <MutedText as="div">Checking what will be removed…</MutedText>
          ) : plan ? (
            <div style={{ ...layout.dangerList, color: TOKENS.fontColorPrimary }}>
              <div style={layout.dangerItem}>
                • The formula definition will be{' '}
                <span style={layout.strong}>permanently destroyed</span> (not moved to
                trash).
              </div>
              {plan.deleteValueField ? (
                <>
                  <div style={layout.dangerItem}>
                    • The value field{' '}
                    <span style={layout.mono}>{plan.targetField}</span> on{' '}
                    <span style={layout.mono}>{plan.targetObject}</span> will be{' '}
                    <span style={layout.strong}>permanently deleted</span>, including all
                    stored computed values on every record.
                  </div>
                  <div style={layout.dangerItem}>
                    • The FX status field{' '}
                    <span style={layout.mono}>{plan.companionField}</span> will be
                    permanently deleted too.
                  </div>
                </>
              ) : plan.keepReason === 'shared' ? (
                <div style={layout.dangerItem}>
                  • The value field{' '}
                  <span style={layout.mono}>{plan.targetField}</span> will be{' '}
                  <span style={layout.strong}>kept</span> — another formula
                  definition also targets it. Only this definition and its
                  overrides are removed.
                </div>
              ) : plan.keepReason === 'not-created' ? (
                <div style={layout.dangerItem}>
                  • The value field{' '}
                  <span style={layout.mono}>{plan.targetField}</span> will be{' '}
                  <span style={layout.strong}>kept</span> — it was not created by
                  this app. Only this definition and its overrides are removed.
                </div>
              ) : (
                <div style={layout.dangerItem}>
                  • No value field is wired to this draft yet — only the definition
                  is removed.
                </div>
              )}
              <div style={layout.dangerItem}>
                • Any manual override rows for this formula will be removed.
              </div>
            </div>
          ) : null}

          <MutedText as="div" style={layout.confirmLabel}>
            Type <span style={layout.strong}>Delete</span> to confirm
          </MutedText>
          <TextInput
            style={{ ...layout.confirmInput, borderColor: TOKENS.borderDanger }}
            value={confirmText}
            placeholder="Delete"
            onChange={(event) => setConfirmText(event.target.value)}
          />

          <div style={layout.actions}>
            <DangerButton disabled={!canConfirm} onClick={confirm}>
              {deleting ? 'Deleting…' : 'Delete completely'}
            </DangerButton>
            <SecondaryButton onClick={cancel} disabled={deleting}>
              Cancel
            </SecondaryButton>
          </div>
          {error ? <ErrText as="div">{error}</ErrText> : null}
        </DangerPanel>
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
  // Refresh-on-view throttle/in-flight state (ADR 0015) — own ref per widget,
  // since this widget refreshes only its own definition (no viewed record).
  const refreshStateRef = useRef<RefreshThrottleState>({
    lastRefreshAt: 0,
    inFlight: false,
  });
  // Bumped by refreshStaleTodayFormulas' onStateChange to re-render and show
  // "Refreshing formula…" — this component isn't memoized, so a plain re-
  // render is enough (unlike formula-editor.tsx's memoized row list).
  const [, setRefreshTick] = useState(0);

  // Target object's field kinds (name -> metadata type), so pre-save validation
  // rejects a string comparison against a field that can't hold a string —
  // shown inline before Save, matching the server's save-time check.
  const { kindsByName: targetFieldKinds } = useObjectFields(
    definition?.targetObject,
  );

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
        usesTodayFlag: expressionUsesToday(edge.node.expression ?? ''),
      }),
    );

    setAllDefinitions(list);
    const current = list.find((entry) => entry.id === recordId) ?? null;
    setDefinition(current);
    // Trashed-definition field hiding is NOT done here: this widget's own record
    // being trashed drops it from the (non-withDeleted) list above, so `current`
    // is null and the target object/field are unknown — the record-page
    // formula-editor is the convergence surface that hides trashed fields.
    if (current?.targetObject && current?.targetField) {
      // Refresh-on-view (ADR 0015): this widget IS the definition's own page
      // (no viewed record) — the honest recomputeAllRecords refresh fixes
      // every record and advances lastEvaluatedAt, clearing the stale note.
      refreshStaleTodayFormulas({
        // Dynamic client: the refresh recomputes runtime-created value fields
        // that aren't in the static genql type map, unlike this load()'s query.
        client: createDynamicCoreClient(),
        definitions: [current],
        now: Date.now(),
        state: refreshStateRef.current,
        onStateChange: () => setRefreshTick((tick) => tick + 1),
      }).then((refreshedIds) => {
        if (refreshedIds.length > 0) {
          setTimeout(load, 1500);
        }
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
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load, deleted]);

  const save = useCallback(async () => {
    if (!definition) return;
    const error = validate(definition, draft, allDefinitions, targetFieldKinds);
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
  }, [definition, draft, allDefinitions, targetFieldKinds, load]);

  const liveError = useMemo(
    () =>
      definition
        ? validate(definition, draft, allDefinitions, targetFieldKinds)
        : null,
    [definition, draft, allDefinitions, targetFieldKinds],
  );

  if (deleted) {
    return (
      <WidgetRoot style={layout.container}>
        <MutedText as="div">This formula was deleted.</MutedText>
      </WidgetRoot>
    );
  }
  if (loading) {
    return (
      <WidgetRoot style={layout.container}>
        <MutedText as="div">Loading…</MutedText>
      </WidgetRoot>
    );
  }
  if (!definition) {
    return (
      <WidgetRoot style={layout.container}>
        <MutedText as="div">Formula not found.</MutedText>
      </WidgetRoot>
    );
  }

  // A definition without a target FIELD is a fresh record or a resumed draft:
  // run the guided setup, seeded from the persisted draft selections.
  if (!definition.targetField) {
    return (
      <WidgetRoot style={layout.container}>
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
      </WidgetRoot>
    );
  }

  const dirty = draft !== definition.expression;
  const awaitingExpression = !definition.expression && !dirty;
  // Mirror provenance line: shown when the value field's kind is a mirror kind
  // AND the SAVED expression is a bare whole-field reference. Uses the saved
  // expression (not the in-progress draft) so the section reflects what is live.
  const mirrorSource =
    isMirrorTargetKind(definition.targetFieldType) && definition.expression
      ? mirrorSourceRef(definition.expression, definition.targetObject)
      : null;

  return (
    <WidgetRoot style={layout.container}>
      {definition.status === 'OFFLINE' ? (
        <BannerDanger style={layout.banner}>
          OFFLINE — {definition.statusReason || 'an input field is gone'}.
          Values are frozen; recompute is paused.
        </BannerDanger>
      ) : definition.status === 'UPSTREAM' ? (
        <BannerWarning style={layout.banner}>
          UPSTREAM BREAK — {definition.statusReason || 'a formula earlier in the chain is broken'}.
          Still computing, but inputs may be stale.
        </BannerWarning>
      ) : null}
      <div style={layout.header}>
        <div>
          <div style={layout.target}>
            {definition.targetObject}.{definition.targetField}
            {definition.targetFieldType === 'CURRENCY' ? (
              <HintText> currency (micros)</HintText>
            ) : null}
            {!definition.enabled ? <ErrText> (disabled)</ErrText> : null}
          </div>
          <MutedText as="div">Current value</MutedText>
        </div>
        <BigValue style={layout.value}>
          {definition.lastValue === null ? '—' : definition.lastValue}
        </BigValue>
      </div>
      {definition.lastEvaluatedAt ? (
        <HintText as="div">
          Last evaluated{' '}
          {formatRelativePast(definition.lastEvaluatedAt, Date.now())}
        </HintText>
      ) : null}
      {refreshStateRef.current.inFlight ? (
        <MutedText as="div">Refreshing formula…</MutedText>
      ) : null}

      <MutedText as="div">Formula expression</MutedText>
      <FormulaFieldInput
        value={draft}
        onChange={setDraft}
        targetObject={definition.targetObject}
        multiline
        placeholder="e.g. amount.amountMicros * 1.1"
      />

      <div style={layout.actions}>
        <PrimaryButton
          disabled={!dirty || Boolean(liveError) || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save formula'}
        </PrimaryButton>
        <HintText>
          fields by name · cross-record as [object:uuid:field]
        </HintText>
      </div>

      {awaitingExpression ? (
        <HintText as="div">
          Field created — write the formula expression and save to activate.
        </HintText>
      ) : liveError ? (
        <ErrText as="div">{liveError}</ErrText>
      ) : definition.lastError ? (
        <ErrText as="div">{definition.lastError}</ErrText>
      ) : (
        <OkText as="div">Valid</OkText>
      )}

      {mirrorSource ? (
        // A mirror copies its source field verbatim (type + settings + options
        // cloned at creation); there are no display-format options to tune, so
        // the Field-settings section is a read-only provenance line instead.
        <div style={layout.mirrorSection}>
          <SectionTitle style={layout.mirrorTitle}>Field settings</SectionTitle>
          <MutedText as="div">
            Mirrors <span style={layout.mono}>{mirrorSource}</span>
          </MutedText>
          <HintText as="div">
            Cloned, not linked — later changes to the source field’s options do
            not propagate.
          </HintText>
        </div>
      ) : (
        <FieldSettingsEditor
          definitionId={definition.id}
          targetObject={definition.targetObject}
          targetField={definition.targetField}
          targetFieldType={definition.targetFieldType}
          outputFormat={definition.outputFormat}
          currencyCode={definition.currencyCode}
        />
      )}

      <FormulaDangerZone
        definitionId={definition.id}
        onDeleted={() => setDeleted(true)}
      />
    </WidgetRoot>
  );
};

// Layout-only values (padding, gaps, margins, weights) — every color/font-
// family-for-body-text/background/border comes from the archetypes in
// lib/ui.tsx or lib/ui-tokens instead (spec: docs/superpowers/specs/
// 2026-07-04-formula-field-ui-polish-design.md).
const layout: Record<string, React.CSSProperties> = {
  container: { padding: '16px', width: '100%', height: '100%', boxSizing: 'border-box' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '14px',
  },
  // "target" is a mono readonly display, not a form control — spec: "mono/
  // readonly → keep ui-monospace, color primary".
  target: {
    fontWeight: 600,
    fontFamily: 'ui-monospace, monospace',
    color: TOKENS.fontColorPrimary,
  },
  value: { fontVariantNumeric: 'tabular-nums' },
  actions: { display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0' },
  banner: { marginBottom: '12px' },
  dangerZone: {
    marginTop: '20px',
    paddingTop: '12px',
    borderTop: `1px solid ${TOKENS.borderLight}`,
  },
  dangerTitle: {
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '8px',
  },
  dangerList: { marginBottom: '10px', lineHeight: 1.5 },
  dangerItem: { marginBottom: '4px' },
  strong: { fontWeight: 700 },
  mono: { fontFamily: 'ui-monospace, monospace', color: TOKENS.fontColorPrimary },
  confirmLabel: { marginBottom: '6px' },
  confirmInput: { width: '100%', marginBottom: '8px', boxSizing: 'border-box' },
  mirrorSection: {
    marginTop: '18px',
    paddingTop: '12px',
    borderTop: `1px solid ${TOKENS.borderLight}`,
  },
  mirrorTitle: { marginBottom: '6px' },
};

export const FORMULA_DEFINITION_EDITOR_UNIVERSAL_IDENTIFIER =
  '6e0adf74-0c52-41c4-89d8-1b7934dc773d';

export default defineFrontComponent({
  universalIdentifier: FORMULA_DEFINITION_EDITOR_UNIVERSAL_IDENTIFIER,
  name: 'formula-definition-editor',
  description: 'Edit and validate a formula on its FormulaDefinition record.',
  component: FormulaDefinitionEditor,
});
