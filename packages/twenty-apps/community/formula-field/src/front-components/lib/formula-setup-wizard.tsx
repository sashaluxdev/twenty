import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { enqueueSnackbar } from 'twenty-sdk/front-component';

import { ensureFormulaTabOnObject } from 'src/front-components/lib/ensure-formula-tab';
import { ensureFieldLayoutVisibility } from 'src/logic-functions/lib/fx-status-field';
import { FormatOptionsFields } from 'src/front-components/lib/format-options-fields';
import {
  areFormatOptionsValid,
  buildCurrencyDefaultValue,
  buildFieldSettings,
  deriveFieldName,
  type FormatOptions,
  getOutputFormat,
  isValidFieldName,
  makeFormatOptions,
  optionsFromSettings,
  OUTPUT_FORMATS,
  type OutputFormat,
  parseTargetFieldSettings,
  serializeTargetFieldSettings,
} from 'src/front-components/lib/formula-field-formats';
import {
  ChoiceChip,
  ErrText,
  HintText,
  MutedText,
  PrimaryButton,
  StepTitle,
  TextInput,
  WarnText,
} from 'src/front-components/lib/ui';
import { TOKENS } from 'src/front-components/lib/ui-tokens';

// Guided setup for a fresh FormulaDefinition (feature #1): pick the target
// object, pick an output format, name the field — the wizard then CREATES the
// value field on the object via the metadata API (createOneField; the app role
// carries the DATA_MODEL permission) and wires this definition to it. The
// expression editor takes over once the target is set.
//
// The definition record IS the draft: every selection is persisted to it as
// it is made (targetObject / outputFormat / currencyCode / name), and the
// wizard seeds itself from the record on mount — navigating away and back
// resumes where the user left off. The final create step is idempotent: if a
// previous attempt already created the field pair, it is adopted instead of
// colliding.

// The app's own objects can't host formula fields.
const EXCLUDED_OBJECTS = new Set(['formulaDefinition', 'formulaOverride']);

// Options for the hidden "FX Status" companion SELECT created next to every
// value field (ADR 0009). Fixed option ids: the remote-dom sandbox has no
// reliable crypto.randomUUID, and options are scoped per field anyway.
const FX_STATUS_OPTIONS = [
  {
    id: '51b9f3f0-7143-41c1-9dc6-ebaf5b066409',
    label: 'Offline',
    value: 'OFFLINE',
    color: 'red',
    position: 0,
  },
  {
    id: '51b9f3f0-7143-41c1-9dc6-ebaf5b066410',
    label: 'Upstream break',
    value: 'UPSTREAM',
    color: 'orange',
    position: 1,
  },
];

type FieldInfo = { id: string; isActive: boolean };

type TargetObjectOption = {
  id: string;
  nameSingular: string;
  labelSingular: string;
  fields: Map<string, FieldInfo>;
};

export type WizardDraft = {
  id: string;
  name: string;
  targetObject: string;
  outputFormat: string;
  currencyCode: string;
  // JSON-serialized { settings, currencyCode } — the persisted format options
  // so the wizard resumes with the exact chosen decimals / format / date style.
  targetFieldSettings: string;
};

type FormulaSetupWizardProps = {
  draft: WizardDraft;
  onCreated: () => void;
};

const isOutputFormat = (value: string): value is OutputFormat =>
  OUTPUT_FORMATS.some((candidate) => candidate.key === value);

export const FormulaSetupWizard = ({
  draft,
  onCreated,
}: FormulaSetupWizardProps) => {
  const [objects, setObjects] = useState<TargetObjectOption[]>([]);
  const [objectsLoading, setObjectsLoading] = useState(true);
  const [objectFilter, setObjectFilter] = useState('');
  const [selectedObject, setSelectedObject] =
    useState<TargetObjectOption | null>(null);
  const initialFormat = isOutputFormat(draft.outputFormat)
    ? draft.outputFormat
    : null;
  const [format, setFormat] = useState<OutputFormat | null>(initialFormat);
  // Format options (decimals / currency Short-Full + code / date display style)
  // seeded from the persisted targetFieldSettings so a resumed draft restores
  // exactly what the user chose.
  const [options, setOptions] = useState<FormatOptions>(() => {
    const parsed = parseTargetFieldSettings(draft.targetFieldSettings);
    if (initialFormat) {
      return optionsFromSettings(
        initialFormat,
        parsed?.settings ?? null,
        draft.currencyCode || parsed?.currencyCode,
      );
    }
    return makeFormatOptions('integer');
  });
  const [label, setLabel] = useState(draft.name);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  // Suppresses the label-persist debounce until the user actually types.
  const labelTouched = useRef(false);

  // Fire-and-forget draft persistence; a failed save only costs resumability.
  const persistDraft = useCallback(
    (data: Record<string, unknown>) => {
      const client = new CoreApiClient();
      client
        .mutation({
          updateFormulaDefinition: {
            __args: { id: draft.id, data },
            id: true,
          },
        })
        .catch(() => {});
    },
    [draft.id],
  );

  useEffect(() => {
    let cancelled = false;
    const loadObjects = async () => {
      try {
        const client = new MetadataApiClient();
        const response = await client.query({
          objects: {
            __args: { filter: {}, paging: { first: 500 } },
            edges: {
              node: {
                id: true,
                nameSingular: true,
                labelSingular: true,
                isActive: true,
                isSystem: true,
                fields: {
                  __args: { paging: { first: 500 }, filter: {} },
                  edges: { node: { id: true, name: true, isActive: true } },
                },
              },
            },
          },
        });
        if (cancelled) return;
        const options: TargetObjectOption[] = (response?.objects?.edges ?? [])
          .map((edge: any) => edge?.node)
          .filter(
            (node: any) =>
              node &&
              node.isActive &&
              !node.isSystem &&
              !EXCLUDED_OBJECTS.has(node.nameSingular),
          )
          .map((node: any) => ({
            id: node.id,
            nameSingular: node.nameSingular,
            labelSingular: node.labelSingular ?? node.nameSingular,
            fields: new Map<string, FieldInfo>(
              (node.fields?.edges ?? [])
                .filter((fieldEdge: any) => fieldEdge?.node?.name)
                .map((fieldEdge: any) => [
                  fieldEdge.node.name,
                  {
                    id: fieldEdge.node.id,
                    isActive: fieldEdge.node.isActive !== false,
                  },
                ]),
            ),
          }))
          .sort((a: TargetObjectOption, b: TargetObjectOption) =>
            a.labelSingular.localeCompare(b.labelSingular),
          );
        setObjects(options);
        // Resume: reselect the draft's object.
        if (draft.targetObject) {
          const saved = options.find(
            (option) => option.nameSingular === draft.targetObject,
          );
          if (saved) setSelectedObject(saved);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(`Failed to load objects: ${(loadError as Error).message}`);
        }
      } finally {
        if (!cancelled) {
          setObjectsLoading(false);
        }
      }
    };
    loadObjects();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the typed label into the definition name (debounced) so the field
  // name survives navigation too.
  useEffect(() => {
    if (!labelTouched.current) return;
    const handle = setTimeout(() => {
      persistDraft({ name: label });
    }, 800);
    return () => clearTimeout(handle);
  }, [label, persistDraft]);

  // Serializes and persists the current format + options as the resumable draft.
  const persistFormatOptions = useCallback(
    (formatKey: OutputFormat, nextOptions: FormatOptions) => {
      const settings = buildFieldSettings(formatKey, nextOptions);
      const isCurrency = getOutputFormat(formatKey).fieldType === 'CURRENCY';
      persistDraft({
        outputFormat: formatKey,
        currencyCode: nextOptions.currencyCode,
        targetFieldSettings: serializeTargetFieldSettings({
          settings,
          currencyCode: isCurrency ? nextOptions.currencyCode : undefined,
        }),
      });
    },
    [persistDraft],
  );

  const pickObject = (object: TargetObjectOption) => {
    setSelectedObject(object);
    persistDraft({ targetObject: object.nameSingular });
  };
  const pickFormat = (key: OutputFormat) => {
    // Reset options to the new format's defaults but keep the chosen currency.
    const nextOptions = {
      ...makeFormatOptions(key),
      currencyCode: options.currencyCode,
    };
    setFormat(key);
    setOptions(nextOptions);
    persistFormatOptions(key, nextOptions);
  };
  const changeOptions = (nextOptions: FormatOptions) => {
    setOptions(nextOptions);
    if (format) persistFormatOptions(format, nextOptions);
  };

  const fieldName = useMemo(() => deriveFieldName(label), [label]);
  const existingField = selectedObject?.fields.get(fieldName);
  const existingCompanion = selectedObject?.fields.get(`${fieldName}FxStatus`);
  // Both halves already exist -> a previous attempt got interrupted after
  // field creation; adopt the pair instead of colliding.
  const resumable = Boolean(fieldName && existingField && existingCompanion);
  const collision = Boolean(
    fieldName && !resumable && (existingField || existingCompanion),
  );

  const visibleObjects = useMemo(() => {
    const needle = objectFilter.trim().toLowerCase();
    if (!needle) return objects;
    return objects.filter(
      (object) =>
        object.labelSingular.toLowerCase().includes(needle) ||
        object.nameSingular.toLowerCase().includes(needle),
    );
  }, [objects, objectFilter]);

  const readyToCreate =
    Boolean(selectedObject) &&
    Boolean(format) &&
    isValidFieldName(fieldName) &&
    !collision &&
    !creating &&
    (!format || areFormatOptionsValid(format, options));

  const create = useCallback(async () => {
    if (!selectedObject || !format || !isValidFieldName(fieldName)) return;
    setCreating(true);
    setError('');
    try {
      const formatDefinition = getOutputFormat(format);
      const isCurrency = formatDefinition.targetFieldType === 'CURRENCY';
      const settings = buildFieldSettings(format, options);
      const metadataClient = new MetadataApiClient();

      let valueFieldId = existingField?.id ?? null;
      if (!existingField) {
        const createdField = await metadataClient.mutation({
          createOneField: {
            __args: {
              input: {
                field: {
                  objectMetadataId: selectedObject.id,
                  type: formatDefinition.fieldType,
                  name: fieldName,
                  label: label.trim() || fieldName,
                  description: `Computed by the Formula Field app (${format}).`,
                  icon: 'IconMathFunction',
                  isUIEditable: true,
                  ...(settings ? { settings } : {}),
                  // String defaults use the server's quoted-literal convention.
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
            name: true,
          },
        });
        valueFieldId = createdField?.createOneField?.id ?? null;
      }

      // Companion "FX Status" SELECT: always ACTIVE (values stay writable and
      // accurate); it is hidden/shown purely via record-page LAYOUT, slotted
      // right under its parent value field (ADR 0009).
      let companionId = existingCompanion?.id ?? null;
      if (!companionId) {
        const companion = await metadataClient.mutation({
          createOneField: {
            __args: {
              input: {
                field: {
                  objectMetadataId: selectedObject.id,
                  type: 'SELECT',
                  name: `${fieldName}FxStatus`,
                  label: `${label.trim() || fieldName} FX Status`,
                  description:
                    'System-managed formula health flag (Formula Field app). ' +
                    'Hidden while the formula is healthy.',
                  icon: 'IconHeartbeat',
                  isUIEditable: false,
                  options: FX_STATUS_OPTIONS,
                },
              },
            },
            id: true,
          },
        });
        companionId = companion?.createOneField?.id ?? null;
      }
      // Heal a companion left inactive by the old design or an interrupted
      // attempt — companions are always-active now.
      if (companionId && existingCompanion?.isActive === false) {
        await metadataClient.mutation({
          updateOneField: {
            __args: { input: { id: companionId, update: { isActive: true } } },
            id: true,
          },
        });
      }

      // Hide the chip via layout, parked directly under its value field.
      if (companionId) {
        try {
          await ensureFieldLayoutVisibility({
            objectMetadataId: selectedObject.id,
            fieldMetadataId: companionId,
            visible: false,
            anchorFieldMetadataId: valueFieldId ?? undefined,
          });
        } catch {
          // Cosmetic only — the status sync re-converges layout later.
        }
      }

      // Give the target object a record-page "Formulas" tab (idempotent).
      // Best-effort: a layout failure must not block the formula itself.
      try {
        await ensureFormulaTabOnObject(selectedObject.id);
      } catch {
        // The formula still works; the tab can be added on a later create.
      }

      const coreClient = new CoreApiClient();
      await coreClient.mutation({
        updateFormulaDefinition: {
          __args: {
            id: draft.id,
            data: {
              targetObject: selectedObject.nameSingular,
              targetField: fieldName,
              targetFieldType: formatDefinition.targetFieldType,
              currencyCode: isCurrency ? options.currencyCode : '',
              outputFormat: format,
              targetFieldSettings: serializeTargetFieldSettings({
                settings,
                currencyCode: isCurrency ? options.currencyCode : undefined,
              }),
              // Provenance: the lifecycle machinery only deactivates /
              // reactivates fields the wizard created (ADR 0009).
              createdField: true,
            },
          },
          id: true,
        },
      });

      // Runtime-created fields/tabs propagate to already-open tabs only over
      // live SSE; there is no app-side metadata-invalidation API. Nudge the user
      // to refresh if the new field does not show up. Best-effort: the host may
      // not expose the snackbar bridge.
      try {
        await enqueueSnackbar({
          message:
            'Formula field created. If it does not appear in views or tabs, ' +
            'refresh the page.',
          variant: 'info',
          dedupeKey: 'formula-field-created',
        });
      } catch {
        // No host snackbar — the expression editor also shows an inline note.
      }
      onCreated();
    } catch (createError) {
      setError((createError as Error).message ?? String(createError));
    } finally {
      setCreating(false);
    }
  }, [
    selectedObject,
    format,
    options,
    fieldName,
    label,
    draft.id,
    existingField,
    existingCompanion,
    onCreated,
  ]);

  return (
    <div>
      <div style={layout.step}>
        <StepTitle style={layout.stepTitle}>1 · Target object</StepTitle>
        {objectsLoading ? (
          <MutedText as="div">Loading objects…</MutedText>
        ) : (
          <div>
            <TextInput
              style={layout.filter}
              value={objectFilter}
              placeholder="Filter objects…"
              onChange={(event) => setObjectFilter(event.target.value)}
            />
            <div style={layout.objectList}>
              {visibleObjects.map((object) => (
                <ChoiceChip
                  key={object.id}
                  selected={selectedObject?.id === object.id}
                  onMouseDown={() => pickObject(object)}
                >
                  {object.labelSingular}
                </ChoiceChip>
              ))}
              {visibleObjects.length === 0 ? (
                <MutedText>No matching object</MutedText>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div style={layout.step}>
        <StepTitle style={layout.stepTitle}>2 · Output format</StepTitle>
        <div style={layout.formatRow}>
          {OUTPUT_FORMATS.map((candidate) => (
            <ChoiceChip
              key={candidate.key}
              selected={format === candidate.key}
              onMouseDown={() => pickFormat(candidate.key)}
            >
              {candidate.label}
              <HintText as="span"> {candidate.hint}</HintText>
            </ChoiceChip>
          ))}
        </div>
      </div>

      {format ? (
        <div style={layout.step}>
          <StepTitle style={layout.stepTitle}>2b · Format options</StepTitle>
          <FormatOptionsFields
            format={format}
            options={options}
            onChange={changeOptions}
          />
        </div>
      ) : null}

      <div style={layout.step}>
        <StepTitle style={layout.stepTitle}>3 · Field name</StepTitle>
        <TextInput
          style={layout.filter}
          value={label}
          placeholder="e.g. Deal score"
          onChange={(event) => {
            labelTouched.current = true;
            setLabel(event.target.value);
          }}
        />
        {fieldName ? (
          <MutedText as="div">
            API name: <span style={layout.mono}>{fieldName}</span>
            {collision ? (
              <ErrText>
                {' '}
                — already exists on {selectedObject?.labelSingular}
              </ErrText>
            ) : null}
            {resumable ? (
              <WarnText>
                {' '}
                — fields from an interrupted attempt found; creating will adopt
                them
              </WarnText>
            ) : null}
          </MutedText>
        ) : null}
      </div>

      <div style={layout.actions}>
        <PrimaryButton disabled={!readyToCreate} onMouseDown={create}>
          {creating
            ? 'Creating field…'
            : resumable
              ? 'Adopt fields & finish setup'
              : 'Create formula field'}
        </PrimaryButton>
        <MutedText>
          Progress is saved — you can leave and resume anytime.
        </MutedText>
      </div>

      {error ? <ErrText as="div">{error}</ErrText> : null}
    </div>
  );
};

// Layout-only values (padding, gaps, margins) — every color/font-family-for-
// body-text/background/border comes from the archetypes in lib/ui.tsx or
// lib/ui-tokens instead (spec: docs/superpowers/specs/
// 2026-07-04-formula-field-ui-polish-design.md).
const layout: Record<string, React.CSSProperties> = {
  step: { marginBottom: '14px' },
  stepTitle: { marginBottom: '6px' },
  filter: { width: '100%', boxSizing: 'border-box', marginBottom: '6px' },
  objectList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    maxHeight: '96px',
    overflowY: 'auto',
  },
  formatRow: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    margin: '12px 0 6px',
  },
  // "mono" is a mono readonly display, not a form control — spec: "mono/
  // readonly → keep ui-monospace, color primary".
  mono: { fontFamily: 'ui-monospace, monospace', color: TOKENS.fontColorPrimary },
};
