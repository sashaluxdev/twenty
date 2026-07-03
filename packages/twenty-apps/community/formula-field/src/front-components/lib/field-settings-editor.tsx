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
const formatKeyForType = (
  targetFieldType: string,
  outputFormat: string,
): OutputFormat => {
  switch (targetFieldType) {
    case 'CURRENCY':
      return 'currency';
    case 'DATE':
      return 'date';
    case 'DATE_TIME':
      return 'datetime';
    default:
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
  const isCurrency = getOutputFormat(format).fieldType === 'CURRENCY';

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fieldId, setFieldId] = useState<string | null>(null);
  const [labelSynced, setLabelSynced] = useState<boolean | null>(null);
  const [label, setLabel] = useState('');
  const [options, setOptions] = useState<FormatOptions>(() =>
    makeFormatOptions(format),
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
      setOptions(
        optionsFromSettings(
          format,
          (fieldNode.settings ?? null) as Record<string, unknown> | null,
          currencyCode,
        ),
      );
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
      const settings = buildFieldSettings(format, options);
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

  const canSave = loaded && !saving && areFormatOptionsValid(format, options);

  return (
    <div style={s.section}>
      <button
        type="button"
        style={s.sectionHeader}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span style={s.caret}>{open ? '▾' : '▸'}</span> Field settings
      </button>

      {open ? (
        <div style={s.body}>
          {loading && !loaded ? (
            <div style={s.muted}>Loading field settings…</div>
          ) : (
            <>
              <div style={s.field}>
                <div style={s.fieldLabel}>Target object</div>
                <div style={s.readonly}>{targetObject}</div>
              </div>
              <div style={s.field}>
                <div style={s.fieldLabel}>Field API name</div>
                <div style={s.readonly}>{targetField}</div>
                <div style={s.lock}>
                  API name is locked — formulas reference it.
                </div>
              </div>
              <div style={s.field}>
                <div style={s.fieldLabel}>Field label</div>
                <input
                  style={s.input}
                  value={label}
                  placeholder={targetField}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setSaved(false);
                  }}
                />
                {labelSynced ? (
                  <div style={s.lock}>
                    The API name currently follows the label — saving unlinks
                    them so the API name stays fixed.
                  </div>
                ) : null}
              </div>

              {loaded ? (
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

              <div style={s.actions}>
                <button
                  type="button"
                  style={{ ...s.save, ...(canSave ? {} : s.saveDisabled) }}
                  disabled={!canSave}
                  onClick={save}
                >
                  {saving ? 'Saving…' : 'Save field settings'}
                </button>
                {saved ? <span style={s.ok}>Saved</span> : null}
              </div>
              {error ? <div style={s.err}>{error}</div> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  section: {
    marginTop: '18px',
    paddingTop: '12px',
    borderTop: '1px solid #eeedf0',
  },
  sectionHeader: {
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '12px',
    fontWeight: 600,
    color: '#474451',
    cursor: 'pointer',
  },
  caret: { color: '#908e99' },
  body: { marginTop: '10px' },
  field: { marginBottom: '10px' },
  fieldLabel: { fontSize: '11px', color: '#908e99', marginBottom: '4px' },
  readonly: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: '13px',
    color: '#1b1b1f',
  },
  lock: { fontSize: '11px', color: '#b0aeb8', marginTop: '2px' },
  input: {
    width: '100%',
    padding: '6px 8px',
    border: '1px solid #d6d5db',
    borderRadius: '4px',
    fontSize: '13px',
    boxSizing: 'border-box',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginTop: '8px',
  },
  save: {
    padding: '6px 14px',
    borderRadius: '4px',
    border: 'none',
    background: '#1961ed',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
  },
  saveDisabled: { background: '#c3c2c9', cursor: 'default' },
  muted: { color: '#908e99', fontSize: '12px' },
  ok: { color: '#3ba55d', fontSize: '12px' },
  err: { color: '#e0483d', fontSize: '12px', marginTop: '6px' },
};
