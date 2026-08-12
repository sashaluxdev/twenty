import { useCallback, useEffect, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { FormatOptionsFields } from 'src/front-components/lib/format-options-fields';
import {
  areFormatOptionsValid,
  buildCurrencyDefaultValue,
  buildFieldSettings,
  type FormatOptions,
  getOutputFormat,
  makeFormatOptions,
  optionsFromSettings,
  OUTPUT_FORMATS,
  type OutputFormat,
  serializeTargetFieldSettings,
} from 'src/front-components/lib/formula-field-formats';
import { isMirrorTargetKind } from 'src/logic-functions/lib/mirror-kinds';
import {
  ErrText,
  HintText,
  MutedText,
  OkText,
  PrimaryButton,
  SectionTitle,
  TextInput,
} from 'src/front-components/lib/ui';
import { TOKENS } from 'src/front-components/lib/ui-tokens';

// Persistent, safely-editable configuration for a completed formula's value
// field, shown as a collapsible section on the FormulaDefinition record page.
// The target object and field API NAME are read-only (formulas reference the API
// name); the field LABEL and the display settings (decimals, number/currency
// format, date display) are editable. Field TYPE is never changeable.
//
// Label gotcha: a field with isLabelSyncedWithName = true renames its API name
// when the label changes. We ALWAYS write isLabelSyncedWithName: false alongside
// the label so the API name stays fixed and formulas keep resolving.

type FieldSettingsEditorProps = {
  definitionId: string;
  targetObject: string;
  targetField: string;
  targetFieldType: string;
  outputFormat: string;
  currencyCode: string;
};

const isOutputFormat = (value: string): value is OutputFormat =>
  OUTPUT_FORMATS.some((candidate) => candidate.key === value);

// Any format key with the right fieldType works — FormatOptionsFields drives the
// number display type from the select, not from the format key's default.
// Returns null for mirror-kind targets (BOOLEAN/MULTI_SELECT/RATING/LINKS…):
// mirror rows have no display settings to edit here, and defaulting them into
// the NUMBER form below would write NUMBER settings onto a non-number field.
const formatKeyForType = (
  targetFieldType: string,
  outputFormat: string,
): OutputFormat | null => {
  switch (targetFieldType) {
    case 'CURRENCY':
      return 'currency';
    case 'DATE':
      return 'date';
    case 'DATE_TIME':
      return 'datetime';
    case 'TEXT':
      return 'text';
    // Legacy deployed SELECT mirrors still carry outputFormat 'mirror' and
    // reach this branch by targetFieldType alone — without it they'd fall
    // through to the NUMBER 'integer' form below.
    case 'SELECT':
      return 'select';
    default:
      if (isMirrorTargetKind(targetFieldType)) return null;
      return isOutputFormat(outputFormat) &&
        getOutputFormat(outputFormat).fieldType === 'NUMBER'
        ? outputFormat
        : 'integer';
  }
};

export const FieldSettingsEditor = ({
  definitionId,
  targetObject,
  targetField,
  targetFieldType,
  outputFormat,
  currencyCode,
}: FieldSettingsEditorProps) => {
  const format = formatKeyForType(targetFieldType, outputFormat);
  const isCurrency =
    format !== null && getOutputFormat(format).fieldType === 'CURRENCY';

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fieldId, setFieldId] = useState<string | null>(null);
  const [labelSynced, setLabelSynced] = useState<boolean | null>(null);
  const [label, setLabel] = useState('');
  // Mirror-kind targets (format === null) have no settings form, so this seed
  // is never read — 'integer' is an arbitrary placeholder, not a NUMBER write.
  const [options, setOptions] = useState<FormatOptions>(() =>
    makeFormatOptions(format ?? 'integer'),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Lazily fetch the live value-field metadata (label + settings) on first open,
  // so the form reflects what is actually on the field, not a stale draft.
  const loadField = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const metadataClient = new MetadataApiClient();
      const response = await metadataClient.query({
        objects: {
          __args: { filter: {}, paging: { first: 500 } },
          edges: {
            node: {
              nameSingular: true,
              fields: {
                __args: { paging: { first: 500 }, filter: {} },
                edges: {
                  node: {
                    id: true,
                    name: true,
                    label: true,
                    settings: true,
                    isLabelSyncedWithName: true,
                  },
                },
              },
            },
          },
        },
      });
      const objectNode = (response?.objects?.edges ?? [])
        .map((edge: any) => edge?.node)
        .find((node: any) => node?.nameSingular === targetObject);
      const fieldNode = (objectNode?.fields?.edges ?? [])
        .map((edge: any) => edge?.node)
        .find((node: any) => node?.name === targetField);
      if (!fieldNode) {
        setError('Value field not found — it may have been deleted.');
        return;
      }
      setFieldId(fieldNode.id);
      setLabel(fieldNode.label ?? targetField);
      setLabelSynced(fieldNode.isLabelSyncedWithName ?? null);
      // Mirror-kind targets (format === null) have no settings to read — the
      // seeded options state is never rendered or saved.
      if (format !== null) {
        setOptions(
          optionsFromSettings(
            format,
            (fieldNode.settings ?? null) as Record<string, unknown> | null,
            currencyCode,
          ),
        );
      }
      setLoaded(true);
    } catch (loadError) {
      setError((loadError as Error).message ?? String(loadError));
    } finally {
      setLoading(false);
    }
  }, [targetObject, targetField, format, currencyCode]);

  useEffect(() => {
    if (open && !loaded && !loading) loadField();
  }, [open, loaded, loading, loadField]);

  const save = useCallback(async () => {
    if (!fieldId) return;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      // Mirror-kind targets (format === null) have no settings to build —
      // send no settings key and no currency defaultValue (isCurrency is
      // already false for a null format).
      const settings = format !== null ? buildFieldSettings(format, options) : null;
      const metadataClient = new MetadataApiClient();
      await metadataClient.mutation({
        updateOneField: {
          __args: {
            input: {
              id: fieldId,
              update: {
                label: label.trim() || targetField,
                // Keep the API name locked when the label changes.
                isLabelSyncedWithName: false,
                ...(settings ? { settings } : {}),
                ...(isCurrency
                  ? {
                      defaultValue: buildCurrencyDefaultValue(
                        options.currencyCode,
                      ),
                    }
                  : {}),
              },
            },
          },
          id: true,
        },
      });

      const coreClient = new CoreApiClient();
      await coreClient.mutation({
        updateFormulaDefinition: {
          __args: {
            id: definitionId,
            data: {
              currencyCode: isCurrency ? options.currencyCode : '',
              targetFieldSettings: serializeTargetFieldSettings({
                settings,
                currencyCode: isCurrency ? options.currencyCode : undefined,
              }),
            },
          },
          id: true,
        },
      });
      setLabelSynced(false);
      setSaved(true);
    } catch (saveError) {
      setError((saveError as Error).message ?? String(saveError));
    } finally {
      setSaving(false);
    }
  }, [
    fieldId,
    format,
    options,
    label,
    targetField,
    isCurrency,
    definitionId,
  ]);

  // SELECT has no editable settings here (options are native-owned, ADR 0029
  // D7); mirror-kind targets (format === null) likewise have no settings form.
  // Neither case should veto label editing.
  const canSave =
    loaded &&
    !saving &&
    (format === null || format === 'select' || areFormatOptionsValid(format, options));

  return (
    <div style={layout.section}>
      <SectionTitle
        as="button"
        type="button"
        style={layout.sectionHeader}
        onClick={() => setOpen((previous) => !previous)}
      >
        <HintText
          style={{
            ...layout.caret,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▸
        </HintText>{' '}
        Field settings
      </SectionTitle>

      {open ? (
        <div style={layout.body}>
          {loading && !loaded ? (
            <MutedText as="div">Loading field settings…</MutedText>
          ) : (
            <>
              <div style={layout.field}>
                <MutedText as="div">Target object</MutedText>
                <div style={layout.readonly}>{targetObject}</div>
              </div>
              <div style={layout.field}>
                <MutedText as="div">Field API name</MutedText>
                <div style={layout.readonly}>{targetField}</div>
                <HintText as="div">
                  API name is locked — formulas reference it.
                </HintText>
              </div>
              <div style={layout.field}>
                <MutedText as="div">Field label</MutedText>
                <TextInput
                  style={layout.input}
                  value={label}
                  placeholder={targetField}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setSaved(false);
                  }}
                />
                {labelSynced ? (
                  <HintText as="div">
                    The API name currently follows the label — saving unlinks
                    them so the API name stays fixed.
                  </HintText>
                ) : null}
              </div>

              {loaded && format !== null ? (
                <FormatOptionsFields
                  format={format}
                  options={options}
                  showNumberTypeSelect
                  onChange={(next) => {
                    setOptions(next);
                    setSaved(false);
                  }}
                />
              ) : null}
              {targetFieldType === 'SELECT' ? (
                <HintText as="div">
                  Options are managed in Twenty's data model settings, not here.
                </HintText>
              ) : null}

              <div style={layout.actions}>
                <PrimaryButton type="button" disabled={!canSave} onClick={save}>
                  {saving ? 'Saving…' : 'Save field settings'}
                </PrimaryButton>
                {saved ? <OkText>Saved</OkText> : null}
              </div>
              {error ? <ErrText as="div">{error}</ErrText> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};

// Layout-only values (padding, gaps, margins) — every color/font-family-for-
// body-text/background/border comes from the archetypes in lib/ui.tsx or
// lib/ui-tokens instead (spec: docs/superpowers/specs/
// 2026-07-04-formula-field-ui-polish-design.md).
const layout: Record<string, React.CSSProperties> = {
  section: {
    marginTop: '18px',
    paddingTop: '12px',
    borderTop: `1px solid ${TOKENS.borderLight}`,
  },
  // Button-reset styles preserved on top of SectionTitle per the mapping.
  sectionHeader: { background: 'none', border: 'none', padding: 0, cursor: 'pointer' },
  // Accordion caret: 150ms ease transform rotate (spec §Motion) — a single
  // glyph rotates rather than swapping characters on toggle.
  caret: { display: 'inline-block', transition: 'transform 150ms ease' },
  body: { marginTop: '10px' },
  field: { marginBottom: '10px' },
  // "readonly" is a mono readonly display, not a form control — spec: "mono/
  // readonly → keep ui-monospace, color primary".
  readonly: { fontFamily: 'ui-monospace, monospace', color: TOKENS.fontColorPrimary },
  input: { width: '100%', boxSizing: 'border-box' },
  actions: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' },
};
