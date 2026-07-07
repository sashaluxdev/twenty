import { useCallback, useEffect, useRef, useState } from 'react';
import { AppPath } from 'twenty-shared';
import { defineFrontComponent } from 'twenty-sdk/define';
import { enqueueSnackbar, navigate, useRecordId } from 'twenty-sdk/front-component';

import { VARIATION_WIDGET_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';
import {
  ErrText,
  HintText,
  MutedText,
  PrimaryButton,
  RowDivider,
  SectionTitle,
  WidgetRoot,
} from 'src/front-components/lib/ui';
import { TOKENS } from 'src/front-components/lib/ui-tokens';
import {
  buildVariationLabelData,
  loadVariationList,
  resolveLabelField,
  resolveWidgetRole,
  type LabelFieldInfo,
  type VariationListEntry,
  type WidgetRole,
} from 'src/front-components/lib/variation-widget-data';
import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import { selectionEntryForMirrorKind } from 'src/logic-functions/lib/mirror-kinds';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { loadAllEnabledVariationConfigs } from 'src/logic-functions/lib/variation-config-repository';

// Record-page "Variations" tab (object-agnostic — ensureVariationTabOnObject
// attaches it to any object with an enabled VariationConfig, design 2026-07-07).
// A PRIMARY record (no primaryRecordId pointer) lists its variations and can
// spawn new ones; a VARIATION record's own management view is Plan 3 Task 4
// (this task renders only a placeholder for that branch). All list/create data
// logic lives in variation-widget-data.ts (Plan 3 Task 1) — this component is a
// thin shell over it.
//
// The execution context exposes only the record id, not which object's page
// the widget is on — exactly the same gap formula-editor.tsx has for its own
// host object, so the host is resolved the SAME way: probe the record id
// against each distinct candidate object (here, every enabled VariationConfig's
// targetObject) with one cheap query each, once per mount, caching the winner.

// Local copy (see recompute.ts / variation-sync.ts's private capitalize) — a
// shared export would be a gratuitous cross-module edit for a one-line helper.
const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

// Kind-aware label-field read for the create path. Mirrors variation-widget-
// data.ts's module-private labelSelectionArgs (not exported — deliberately
// module-private there) — a small local duplicate rather than a cross-module
// export for one private helper, same call as capitalize above.
const fetchPrimaryLabelFields = async (
  client: FormulaClient,
  objectName: string,
  primaryRecordId: string,
  labelField: LabelFieldInfo | null,
): Promise<Record<string, unknown>> => {
  if (!labelField || (labelField.kind !== 'TEXT' && labelField.kind !== 'FULL_NAME')) {
    return {};
  }
  const selection =
    labelField.kind === 'FULL_NAME'
      ? { [labelField.name]: selectionEntryForMirrorKind('FULL_NAME') }
      : { [labelField.name]: true };
  const response = await client.query({
    [objectName]: {
      __args: { filter: { id: { eq: primaryRecordId } } },
      id: true,
      ...selection,
    },
  });
  return (response?.[objectName] as Record<string, unknown>) ?? {};
};

const VariationWidget = () => {
  const recordId = useRecordId();
  const [role, setRole] = useState<WidgetRole | null>(null);
  const [variations, setVariations] = useState<VariationListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  // The record id never changes for a mounted widget — resolve its host object
  // once (formula-editor.tsx's exact pattern).
  const resolvedHost = useRef<string | null>(null);

  const load = useCallback(async () => {
    // Dynamic client: variation objects and their fields are outside the
    // genql type map (runtime-created, per every precedent widget call site).
    const client = createDynamicCoreClient();

    if (!resolvedHost.current && recordId) {
      const configs = await loadAllEnabledVariationConfigs(client);
      const candidates = Array.from(
        new Set(configs.map((config) => config.targetObject).filter(Boolean)),
      ) as string[];
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

    if (!host || !recordId) {
      // No enabled config claims this object (or the app's own objects, which
      // never appear in the candidate list above) — degrade to invisible.
      setRole({ kind: 'hidden' });
      setVariations([]);
      setLoading(false);
      return;
    }

    const nextRole = await resolveWidgetRole(client, host, recordId);
    setRole(nextRole);
    setVariations(
      nextRole.kind === 'primary'
        ? await loadVariationList(client, nextRole.config, recordId)
        : [],
    );
    setLoading(false);
  }, [recordId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  const handleOpenVariation = useCallback(async (variationRecordId: string) => {
    const host = resolvedHost.current;
    if (!host) return;
    try {
      // navigate throws when the host bridge is absent — never let it bubble
      // into the widget (record-link decision, Plan 3 Task 2).
      await navigate(AppPath.RecordShowPage, {
        objectNameSingular: host,
        objectRecordId: variationRecordId,
      });
    } catch {
      try {
        await enqueueSnackbar({
          message: 'Unable to open this variation — navigation is unavailable.',
          variant: 'error',
        });
      } catch {
        // Snackbar bridge unavailable too — nothing left to degrade to.
      }
    }
  }, []);

  const createVariation = useCallback(async () => {
    if (!recordId || role?.kind !== 'primary') return;
    const host = resolvedHost.current;
    if (!host) return;

    setCreating(true);
    setCreateError('');
    try {
      // Dynamic client: wizard-created value/relation fields are not in the
      // genql type map.
      const client = createDynamicCoreClient();
      const labelField = await resolveLabelField(host);
      const primaryRecord = await fetchPrimaryLabelFields(
        client,
        host,
        recordId,
        labelField,
      );
      const existingLabels = variations.map((entry) => entry.label);

      // Initial field sync happens SERVER-side via the *.created trigger
      // (handleVariationRecordCreated) — creating with just the pointer + label
      // is deliberately the whole client-side job.
      await client.mutation({
        [`create${capitalize(host)}`]: {
          __args: {
            data: {
              [`${role.config.relationFieldName}Id`]: recordId,
              ...buildVariationLabelData(labelField, primaryRecord, existingLabels),
            },
          },
          id: true,
        },
      });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
      setTimeout(load, 1000);
    }
  }, [recordId, role, variations, load]);

  if (loading) {
    return (
      <WidgetRoot style={layout.container}>
        <MutedText as="div">Loading…</MutedText>
      </WidgetRoot>
    );
  }

  if (!role || role.kind === 'hidden') {
    return null;
  }

  if (role.kind === 'variation') {
    // Task 4 replaces this branch with the variation's own management view
    // (diverged fields, re-sync, primary link).
    return (
      <WidgetRoot style={layout.container}>
        <MutedText as="div">
          This record is a variation. The variation view arrives with the next
          app update.
        </MutedText>
      </WidgetRoot>
    );
  }

  // role.kind === 'primary' from here — this branch itself IS the design-doc's
  // single-level creation guard: a variation record never reaches this render
  // path, so its Create button is HIDDEN (not disabled) by construction. The
  // server-side single-level guard (Plan 1) only backstops API races.
  return (
    <WidgetRoot style={layout.container}>
      <SectionTitle style={layout.title}>Variations</SectionTitle>
      {variations.length === 0 ? (
        <HintText as="div">No variations yet.</HintText>
      ) : (
        variations.map((entry) => (
          <div key={entry.id} style={{ ...layout.row, ...RowDivider.base }}>
            <button
              type="button"
              style={{ ...layout.linkButton, color: TOKENS.colorBlue }}
              onClick={() => handleOpenVariation(entry.id)}
            >
              {entry.label !== null ? entry.label : <MutedText>(unnamed)</MutedText>}
            </button>
            {entry.divergedCount > 0 ? (
              <MutedText style={layout.diverged}>
                {entry.divergedCount} diverged
              </MutedText>
            ) : null}
          </div>
        ))
      )}
      <PrimaryButton
        style={layout.createButton}
        disabled={creating}
        onClick={createVariation}
      >
        {creating ? 'Creating…' : 'Create variation'}
      </PrimaryButton>
      {createError ? (
        <ErrText as="div" style={layout.error}>
          {createError}
        </ErrText>
      ) : null}
    </WidgetRoot>
  );
};

// Layout-only values (flex, gap, margins, widths) — every color/font/border/
// radius/background comes from the archetypes in lib/ui.tsx or lib/ui-tokens
// instead (same convention as formula-editor.tsx's layout object). The one
// inline TOKENS.colorBlue reference above (link affordance) mirrors formula-
// editor.tsx's OverrideToggle, which also reaches into TOKENS directly for a
// semantic state color no archetype covers.
const layout: Record<string, React.CSSProperties> = {
  container: { padding: '12px 16px', boxSizing: 'border-box', height: '100%' },
  title: { marginBottom: '10px' },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 0',
  },
  linkButton: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    font: 'inherit',
    padding: 0,
    textAlign: 'left',
  },
  diverged: { marginLeft: '10px', whiteSpace: 'nowrap' },
  createButton: { marginTop: '12px' },
  error: { marginTop: '8px' },
};

export { VARIATION_WIDGET_UNIVERSAL_IDENTIFIER } from 'src/front-components/lib/front-component-ids';

export default defineFrontComponent({
  universalIdentifier: VARIATION_WIDGET_UNIVERSAL_IDENTIFIER,
  name: 'variation-widget',
  description: 'Create and manage variations of this record.',
  component: VariationWidget,
});
