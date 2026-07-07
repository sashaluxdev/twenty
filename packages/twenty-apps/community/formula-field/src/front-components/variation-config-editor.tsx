import { useCallback, useEffect, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineFrontComponent } from 'twenty-sdk/define';
import { useRecordId } from 'twenty-sdk/front-component';

import { formatRelativePast } from 'src/front-components/lib/format-relative-past';
import { VariationSetupWizard } from 'src/front-components/lib/variation-setup-wizard';
import {
  BannerDanger,
  HintText,
  MutedText,
  SectionTitle,
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

const VariationConfigEditor = () => {
  const recordId = useRecordId();
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

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
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

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
};

export const VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER =
  '171d0c3a-f1dc-4005-909e-d94d5fda377b';

export default defineFrontComponent({
  universalIdentifier: VARIATION_CONFIG_EDITOR_UNIVERSAL_IDENTIFIER,
  name: 'variation-config-editor',
  description: 'Enable and manage record variations on its VariationConfig record.',
  component: VariationConfigEditor,
});
