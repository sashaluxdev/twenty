import { useCallback, useEffect, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { defineFrontComponent } from 'twenty-sdk/define';
import { useRecordId } from 'twenty-sdk/front-component';

import {
  type DeleteVariationConfigPlan,
  deleteVariationConfigCompletely,
  planDeleteVariationConfig,
} from 'src/front-components/lib/delete-variation-config-completely';
import { formatRelativePast } from 'src/front-components/lib/format-relative-past';
import { POLL_INTERVAL_MS } from 'src/front-components/lib/poll-interval';
import { VariationSetupWizard } from 'src/front-components/lib/variation-setup-wizard';
import {
  BannerDanger,
  DangerButton,
  DangerPanel,
  ErrText,
  HintText,
  MutedText,
  OutlineDangerButton,
  SecondaryButton,
  SectionTitle,
  TextInput,
  ToggleKnob,
  ToggleTrack,
  WidgetRoot,
} from 'src/front-components/lib/ui';
import { TOKENS } from 'src/front-components/lib/ui-tokens';

// Config surface for the app's own VariationConfig record (a custom object, so
// the page-layout renderer IS used here — see ADR 0007). A fresh config (no
// target object or relation field yet) shows the guided opt-in wizard, which
// creates the self-referencing relation field pair via the metadata API and
// wires this config to it. A wired config shows the enable/disable toggle plus
// the last-sweep status; disabling stops Plan 1's sync engine without touching
// any fields.

type Config = {
  id: string;
  name: string;
  targetObject: string;
  relationFieldName: string;
  createdRelationField: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string;
  status: string;
  statusReason: string;
};

// Danger zone: permanently destroy the config and (when this app provisioned
// the relation field) hard-delete that self-referencing relation field —
// dropping every record's primary/variation pointer, so all records become
// plain records again. Override rows are deliberately KEPT (their (object,
// field, record) key space is shared with formula overrides). The remote-dom
// sandbox has no modal primitive, so the confirmation is an INLINE panel; the
// destructive button unlocks only once the user types "Delete". Mirrors
// formula-definition-editor.tsx's FormulaDangerZone verbatim in UX shape.
const VariationDangerZone = ({
  configId,
  onDeleted,
}: {
  configId: string;
  onDeleted: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<DeleteVariationConfigPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const openPanel = useCallback(async () => {
    setOpen(true);
    setPlanning(true);
    setError('');
    try {
      // Compute the warning from the record's ACTUAL state (fresh re-fetch), not
      // from stale widget props.
      setPlan(await planDeleteVariationConfig(new CoreApiClient(), configId));
    } catch (planError) {
      setError((planError as Error).message ?? String(planError));
    } finally {
      setPlanning(false);
    }
  }, [configId]);

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
      await deleteVariationConfigCompletely({
        coreClient: new CoreApiClient(),
        metadataClient: new MetadataApiClient(),
        configId,
      });
      onDeleted();
    } catch (deleteError) {
      setError((deleteError as Error).message ?? String(deleteError));
      setDeleting(false);
    }
  }, [configId, onDeleted]);

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
                • The variation config will be{' '}
                <span style={layout.strong}>permanently destroyed</span> (not
                moved to trash).
              </div>
              {plan.deleteRelationField ? (
                <div style={layout.dangerItem}>
                  • The relation field{' '}
                  <span style={layout.mono}>{plan.relationFieldName}</span> on{' '}
                  <span style={layout.mono}>{plan.targetObject}</span> will be{' '}
                  <span style={layout.strong}>permanently deleted</span>, so
                  every record's primary/variation link is dropped and all
                  records become plain records again.
                </div>
              ) : plan.keepReason === 'not-created' ? (
                <div style={layout.dangerItem}>
                  • The relation field{' '}
                  <span style={layout.mono}>{plan.relationFieldName}</span> will
                  be <span style={layout.strong}>kept</span> — it was not created
                  by this app. Only this config is removed.
                </div>
              ) : (
                <div style={layout.dangerItem}>
                  • No relation field is wired to this config yet — only the
                  config is removed.
                </div>
              )}
              <div style={layout.dangerItem}>
                • Manual override rows are <span style={layout.strong}>kept</span>{' '}
                — they share a key space with formula overrides on this object.
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

          <div style={layout.dangerActions}>
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

const VariationConfigEditor = () => {
  const recordId = useRecordId();
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  // Once the config is destroyed the page points at a dead record: stop polling
  // and show a terminal state so the widget never crashes or retry-loops.
  const [deleted, setDeleted] = useState(false);

  const load = useCallback(async () => {
    if (!recordId) return;
    const client = new CoreApiClient();
    // Fetch every config (static object, genql-safe) and pick the current one;
    // the connection is looped to completion.
    const configs: Config[] = [];
    let after: string | undefined;
    for (;;) {
      const response = await client.query({
        variationConfigs: {
          __args: { first: 200, ...(after ? { after } : {}) },
          edges: {
            node: {
              id: true,
              name: true,
              targetObject: true,
              relationFieldName: true,
              createdRelationField: true,
              enabled: true,
              lastSyncedAt: true,
              lastError: true,
              status: true,
              statusReason: true,
            },
          },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
      });
      const connection = response?.variationConfigs;
      for (const edge of connection?.edges ?? []) {
        const node = edge?.node;
        if (!node?.id) continue;
        configs.push({
          id: node.id,
          name: node.name ?? '',
          targetObject: node.targetObject ?? '',
          relationFieldName: node.relationFieldName ?? '',
          createdRelationField: node.createdRelationField ?? false,
          enabled: node.enabled ?? false,
          lastSyncedAt: node.lastSyncedAt ?? null,
          lastError: node.lastError ?? '',
          status: node.status ?? '',
          statusReason: node.statusReason ?? '',
        });
      }
      if (!connection?.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor ?? undefined;
    }

    setConfig(configs.find((entry) => entry.id === recordId) ?? null);
    setLoading(false);
  }, [recordId]);

  useEffect(() => {
    if (deleted) return;
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load, deleted]);

  const toggleEnabled = useCallback(
    async (next: boolean) => {
      if (!config) return;
      setToggling(true);
      try {
        const client = new CoreApiClient();
        await client.mutation({
          updateVariationConfig: {
            __args: { id: config.id, data: { enabled: next } },
            id: true,
          },
        });
      } finally {
        setToggling(false);
        setTimeout(load, 1000);
      }
    },
    [config, load],
  );

  if (deleted) {
    return (
      <WidgetRoot style={layout.container}>
        <MutedText as="div">This variation config was deleted.</MutedText>
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
  if (!config) {
    return (
      <WidgetRoot style={layout.container}>
        <MutedText as="div">Variation config not found.</MutedText>
      </WidgetRoot>
    );
  }

  // A config without a target object OR relation field is a fresh record or a
  // resumed draft: run the guided opt-in wizard, seeded from the persisted draft.
  if (!config.targetObject || !config.relationFieldName) {
    return (
      <WidgetRoot style={layout.container}>
        <VariationSetupWizard
          draft={{
            id: config.id,
            targetObject: config.targetObject,
            relationFieldName: config.relationFieldName,
          }}
          onCreated={load}
        />
      </WidgetRoot>
    );
  }

  return (
    <WidgetRoot style={layout.container}>
      {config.lastError ? (
        <BannerDanger style={layout.banner}>{config.lastError}</BannerDanger>
      ) : config.statusReason ? (
        <BannerDanger style={layout.banner}>{config.statusReason}</BannerDanger>
      ) : null}

      <div style={layout.row}>
        <MutedText>Target object</MutedText>
        <span style={layout.mono}>{config.targetObject}</span>
      </div>
      <div style={layout.row}>
        <MutedText>Relation field</MutedText>
        <span style={layout.mono}>{config.relationFieldName}</span>
      </div>
      <div style={layout.row}>
        <MutedText>Last synced</MutedText>
        <span>
          {config.lastSyncedAt
            ? formatRelativePast(config.lastSyncedAt, Date.now())
            : 'never'}
        </span>
      </div>

      <div style={layout.toggleWrap}>
        <SectionTitle>{config.enabled ? 'Enabled' : 'Disabled'}</SectionTitle>
        <ToggleTrack
          type="button"
          role="switch"
          aria-checked={config.enabled}
          disabled={toggling}
          on={config.enabled}
          onClick={() => toggleEnabled(!config.enabled)}
          style={{ opacity: toggling ? 0.6 : 1 }}
          title={
            config.enabled
              ? 'Enabled — click to stop variation sync for this object'
              : 'Disabled — click to resume variation sync'
          }
        >
          <ToggleKnob on={config.enabled} />
        </ToggleTrack>
        <span
          style={{
            ...layout.toggleState,
            color: config.enabled ? TOKENS.colorGreen : TOKENS.fontColorTertiary,
          }}
        >
          {config.enabled ? 'on' : 'off'}
        </span>
      </div>

      <HintText as="div" style={layout.hint}>
        Disabling stops sync but keeps the relation field, its values, and every
        override. Deleting this config from the index view behaves the same —
        only a permanent destroy deactivates the relation field.
      </HintText>

      <VariationDangerZone
        configId={config.id}
        onDeleted={() => setDeleted(true)}
      />
    </WidgetRoot>
  );
};

// Layout-only values (padding, gaps, margins) — every color/font-family-for-
// body-text/background/border comes from the archetypes in lib/ui.tsx or
// lib/ui-tokens instead.
const layout: Record<string, React.CSSProperties> = {
  container: { padding: '16px', width: '100%', height: '100%', boxSizing: 'border-box' },
  banner: { marginBottom: '12px' },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: '10px',
    marginBottom: '6px',
  },
  mono: { fontFamily: 'ui-monospace, monospace', color: TOKENS.fontColorPrimary },
  toggleWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    margin: '14px 0 8px',
  },
  toggleState: { fontWeight: 500 },
  hint: { lineHeight: 1.5 },
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
  confirmLabel: { marginBottom: '6px' },
  confirmInput: { width: '100%', marginBottom: '8px', boxSizing: 'border-box' },
  dangerActions: { display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0' },
};

export const VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER =
  '171d0c3a-f1dc-4005-909e-d94d5fda377b';

export default defineFrontComponent({
  universalIdentifier: VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER,
  name: 'variation-config-editor',
  description: 'Enable and manage record variations on its VariationConfig record.',
  component: VariationConfigEditor,
});
