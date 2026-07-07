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
  cloneMirrorOptions,
  deriveFieldName,
  deriveRecordDisplayLabel,
  type FormatOptions,
  getOutputFormat,
  isValidFieldName,
  makeFormatOptions,
  type MirrorDraft,
  optionsFromSettings,
  OUTPUT_FORMATS,
  type OutputFormat,
  parseTargetFieldSettings,
  pickableMirrorSourceFields,
  seedMirrorExpression,
  serializeTargetFieldSettings,
} from 'src/front-components/lib/formula-field-formats';
import { createDynamicCoreClient } from 'src/logic-functions/lib/dynamic-client';
import {
  ChoiceChip,
  ErrText,
  HintText,
  MutedText,
  OkText,
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

// A candidate mirror SOURCE field: its kind + settings + option set, so the
// wizard can clone them onto the created target field.
type SourceFieldOption = {
  id: string;
  name: string;
  label: string;
  type: string;
  settings: Record<string, unknown> | null;
  options: unknown;
};

type TargetObjectOption = {
  id: string;
  nameSingular: string;
  labelSingular: string;
  fields: Map<string, FieldInfo>;
  // Active, non-system fields eligible as mirror sources (pre-allowlist; the
  // picker narrows to mirrorable kinds via pickableMirrorSourceFields).
  sourceFields: SourceFieldOption[];
  // The object's label-identifier field (resolved from
  // labelIdentifierFieldMetadataId) so record validation can show the record's
  // name/label. null when it can't be resolved to a known display kind.
  labelField: { name: string; type: string } | null;
};

// The record-fetch sub-selection for a label-identifier field. FULL_NAME is a
// composite (a scalar selection silently returns null through the dynamic
// client), so its sub-fields must be named explicitly. Only known display kinds
// are selected — an unexpected kind degrades to existence-only, never breaking
// the query and thus the validation gate.
const labelFieldSelection = (
  labelField: { name: string; type: string } | null,
): true | { firstName: true; lastName: true } | null => {
  if (!labelField) return null;
  if (labelField.type === 'FULL_NAME') return { firstName: true, lastName: true };
  if (labelField.type === 'TEXT') return true;
  return null;
};

type WizardMode = 'format' | 'mirror';

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

  // Mirror-mode draft, recovered once from the persisted settings (outputFormat
  // 'mirror' or a mirror block). The source object/field re-resolve against the
  // loaded objects below; sourceRecordId seeds the record input directly.
  const persistedMirror = useMemo(
    () => parseTargetFieldSettings(draft.targetFieldSettings)?.mirror ?? null,
    [draft.targetFieldSettings],
  );
  const [mode, setMode] = useState<WizardMode>(
    draft.outputFormat === 'mirror' || persistedMirror ? 'mirror' : 'format',
  );
  // The mirror SOURCE object (which object's field to copy) — distinct from the
  // step-1 target object where the mirror field is created.
  const [sourceObject, setSourceObject] = useState<TargetObjectOption | null>(
    null,
  );
  const [sourceObjectFilter, setSourceObjectFilter] = useState('');
  const [sourceField, setSourceField] = useState<SourceFieldOption | null>(null);
  const [sourceRecordId, setSourceRecordId] = useState(
    persistedMirror?.sourceRecordId ?? '',
  );
  // Source-record existence check (cross-record mirrors): 'valid' unlocks create.
  const [sourceRecordStatus, setSourceRecordStatus] = useState<
    'idle' | 'checking' | 'valid' | 'invalid'
  >('idle');
  // The validated record's display label (name), shown so the user can confirm
  // they picked the RIGHT record. null degrades to a generic "Record found".
  const [sourceRecordLabel, setSourceRecordLabel] = useState<string | null>(null);

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
                labelIdentifierFieldMetadataId: true,
                isActive: true,
                isSystem: true,
                fields: {
                  __args: { paging: { first: 500 }, filter: {} },
                  edges: {
                    node: {
                      id: true,
                      name: true,
                      label: true,
                      type: true,
                      isActive: true,
                      isSystem: true,
                      // JSON scalars: a SELECT/MULTI_SELECT option set and the
                      // field's display settings, both cloned onto a mirror.
                      options: true,
                      settings: true,
                    },
                  },
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
          .map((node: any) => {
            const fieldNodes: any[] = (node.fields?.edges ?? [])
              .map((fieldEdge: any) => fieldEdge?.node)
              .filter((fieldNode: any) => fieldNode?.name);
            // Resolve the label-identifier field (the field whose id equals
            // labelIdentifierFieldMetadataId) so record validation can show the
            // picked record's display name; only known display kinds are kept.
            const labelIdentifierField = node.labelIdentifierFieldMetadataId
              ? fieldNodes.find(
                  (fieldNode: any) =>
                    fieldNode.id === node.labelIdentifierFieldMetadataId,
                )
              : null;
            const labelField =
              labelIdentifierField &&
              typeof labelIdentifierField.name === 'string' &&
              typeof labelIdentifierField.type === 'string'
                ? {
                    name: labelIdentifierField.name,
                    type: labelIdentifierField.type,
                  }
                : null;
            return {
              id: node.id,
              nameSingular: node.nameSingular,
              labelSingular: node.labelSingular ?? node.nameSingular,
              fields: new Map<string, FieldInfo>(
                fieldNodes.map((fieldNode: any) => [
                  fieldNode.name,
                  {
                    id: fieldNode.id,
                    isActive: fieldNode.isActive !== false,
                  },
                ]),
              ),
              sourceFields: fieldNodes
                .filter(
                  (fieldNode: any) =>
                    fieldNode.isActive !== false &&
                    fieldNode.isSystem !== true &&
                    typeof fieldNode.type === 'string',
                )
                .map((fieldNode: any) => ({
                  id: fieldNode.id,
                  name: fieldNode.name,
                  label: fieldNode.label ?? fieldNode.name,
                  type: fieldNode.type,
                  settings:
                    (fieldNode.settings ?? null) as Record<string, unknown> | null,
                  options: fieldNode.options,
                }))
                .sort((a: SourceFieldOption, b: SourceFieldOption) =>
                  a.label.localeCompare(b.label),
                ),
              labelField,
            };
          })
          .sort((a: TargetObjectOption, b: TargetObjectOption) =>
            a.labelSingular.localeCompare(b.labelSingular),
          );
        setObjects(options);
        // Resume: reselect the draft's target object.
        if (draft.targetObject) {
          const saved = options.find(
            (option) => option.nameSingular === draft.targetObject,
          );
          if (saved) setSelectedObject(saved);
        }
        // Resume: re-resolve the persisted mirror source object + field.
        if (persistedMirror) {
          const savedSourceObject = options.find(
            (option) => option.nameSingular === persistedMirror.sourceObject,
          );
          if (savedSourceObject) {
            setSourceObject(savedSourceObject);
            const savedSourceField = savedSourceObject.sourceFields.find(
              (candidate) => candidate.name === persistedMirror.sourceField,
            );
            if (savedSourceField) setSourceField(savedSourceField);
          }
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

  // The mirror selection as a persistable draft — non-null only once a source
  // object AND field are chosen. An empty record input means a same-record
  // mirror, so sourceRecordId is dropped when blank.
  const mirrorDraft = useMemo<MirrorDraft | null>(() => {
    if (!sourceObject || !sourceField) return null;
    const trimmedRecordId = sourceRecordId.trim();
    return {
      sourceObject: sourceObject.nameSingular,
      sourceField: sourceField.name,
      ...(trimmedRecordId ? { sourceRecordId: trimmedRecordId } : {}),
    };
  }, [sourceObject, sourceField, sourceRecordId]);

  // Persists the current mirror selection (outputFormat 'mirror' marks the
  // definition as mirror-mode for resumability; the mirror block reseeds the
  // source object/field/record).
  const persistMirrorDraft = useCallback(
    (draftMirror: MirrorDraft | null) => {
      persistDraft({
        outputFormat: 'mirror',
        targetFieldSettings: serializeTargetFieldSettings({
          settings: null,
          ...(draftMirror ? { mirror: draftMirror } : {}),
        }),
      });
    },
    [persistDraft],
  );

  const pickMode = (nextMode: WizardMode) => {
    setMode(nextMode);
    if (nextMode === 'mirror') {
      // Entering mirror mode marks the draft immediately (resume goes to mirror).
      persistDraft({ outputFormat: 'mirror' });
      return;
    }
    // Leaving mirror mode: clear the format marker AND drop the stale mirror
    // block from targetFieldSettings. A lingering mirror block would flip the
    // initial mode back to 'mirror' on remount, losing this format choice.
    // Format options (if any) are re-serialized without the mirror key.
    persistDraft({
      outputFormat: '',
      targetFieldSettings: serializeTargetFieldSettings(
        format
          ? {
              settings: buildFieldSettings(format, options),
              ...(getOutputFormat(format).fieldType === 'CURRENCY'
                ? { currencyCode: options.currencyCode }
                : {}),
            }
          : { settings: null },
      ),
    });
  };
  const pickSourceObject = (object: TargetObjectOption) => {
    setSourceObject(object);
    // A different object's fields are unrelated — reset the field + record.
    setSourceField(null);
    setSourceRecordId('');
    setSourceRecordStatus('idle');
    setSourceRecordLabel(null);
    persistMirrorDraft(null);
  };
  const pickSourceField = (field: SourceFieldOption) => {
    setSourceField(field);
    if (sourceObject) {
      const trimmedRecordId = sourceRecordId.trim();
      persistMirrorDraft({
        sourceObject: sourceObject.nameSingular,
        sourceField: field.name,
        ...(trimmedRecordId ? { sourceRecordId: trimmedRecordId } : {}),
      });
    }
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

  // Mirror source-object list (same objects, own filter box).
  const visibleSourceObjects = useMemo(() => {
    const needle = sourceObjectFilter.trim().toLowerCase();
    if (!needle) return objects;
    return objects.filter(
      (object) =>
        object.labelSingular.toLowerCase().includes(needle) ||
        object.nameSingular.toLowerCase().includes(needle),
    );
  }, [objects, sourceObjectFilter]);

  // Only mirrorable-kind fields of the chosen source object are pickable.
  const mirrorSourceFields = useMemo(
    () =>
      sourceObject ? pickableMirrorSourceFields(sourceObject.sourceFields) : [],
    [sourceObject],
  );

  const sourceIsSameObject = Boolean(
    sourceObject && selectedObject && sourceObject.id === selectedObject.id,
  );
  // A cross-object mirror MUST name a specific source record (there is no
  // "current record" to read from); a same-object mirror may leave it blank.
  const sourceRecordRequired = Boolean(sourceObject) && !sourceIsSameObject;
  const trimmedSourceRecordId = sourceRecordId.trim();
  const mirrorRecordReady = trimmedSourceRecordId
    ? sourceRecordStatus === 'valid'
    : !sourceRecordRequired;

  // Validate a typed source-record id by fetching it (existence check). Debounced;
  // a blank id resets to idle. The dynamic client covers arbitrary/runtime objects.
  useEffect(() => {
    if (!sourceObject || !trimmedSourceRecordId) {
      setSourceRecordStatus('idle');
      setSourceRecordLabel(null);
      return;
    }
    if (!/^[0-9a-f-]{36}$/i.test(trimmedSourceRecordId)) {
      setSourceRecordStatus('invalid');
      setSourceRecordLabel(null);
      return;
    }
    let cancelled = false;
    setSourceRecordStatus('checking');
    setSourceRecordLabel(null);
    // Fetch the record's label field alongside id so validation shows the
    // record's name (composite label kinds need their sub-fields named).
    const labelField = sourceObject.labelField;
    const labelSelection = labelFieldSelection(labelField);
    const handle = setTimeout(() => {
      const client = createDynamicCoreClient();
      client
        .query({
          [sourceObject.nameSingular]: {
            __args: { filter: { id: { eq: trimmedSourceRecordId } } },
            id: true,
            ...(labelField && labelSelection
              ? { [labelField.name]: labelSelection }
              : {}),
          },
        })
        .then((response: any) => {
          if (cancelled) return;
          const record = response?.[sourceObject.nameSingular];
          const found = Boolean(record?.id);
          setSourceRecordStatus(found ? 'valid' : 'invalid');
          setSourceRecordLabel(
            found && labelField && labelSelection
              ? deriveRecordDisplayLabel(record, labelField.name, labelField.type)
              : null,
          );
          if (found) {
            persistMirrorDraft(mirrorDraft);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSourceRecordStatus('invalid');
            setSourceRecordLabel(null);
          }
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // mirrorDraft/persistMirrorDraft intentionally omitted — persistence is a
    // fire-and-forget side effect keyed on the id, not a validation input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceObject, trimmedSourceRecordId]);

  const readyToCreate =
    mode === 'mirror'
      ? Boolean(selectedObject) &&
        Boolean(sourceObject) &&
        Boolean(sourceField) &&
        mirrorRecordReady &&
        isValidFieldName(fieldName) &&
        !collision &&
        !creating
      : Boolean(selectedObject) &&
        Boolean(format) &&
        isValidFieldName(fieldName) &&
        !collision &&
        !creating &&
        (!format || areFormatOptionsValid(format, options));

  // Shared tail for both create paths: create/heal the FX Status companion, add
  // the record-page tab, hide the companion chip via layout, then write the
  // finished definition (format-specific `data`) and notify. The value field
  // itself is created by the caller (format vs mirror shapes differ).
  const finalizeCreation = useCallback(
    async ({
      metadataClient,
      valueFieldId,
      definitionData,
    }: {
      metadataClient: MetadataApiClient;
      valueFieldId: string | null;
      definitionData: Record<string, unknown>;
    }) => {
      if (!selectedObject) return;

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
          __args: { id: draft.id, data: definitionData },
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
    },
    [selectedObject, existingCompanion, fieldName, label, draft.id, onCreated],
  );

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

      await finalizeCreation({
        metadataClient,
        valueFieldId,
        definitionData: {
          targetObject: selectedObject.nameSingular,
          targetField: fieldName,
          targetFieldType: formatDefinition.targetFieldType,
          currencyCode: isCurrency ? options.currencyCode : '',
          outputFormat: format,
          targetFieldSettings: serializeTargetFieldSettings({
            settings,
            currencyCode: isCurrency ? options.currencyCode : undefined,
          }),
          // Provenance: the lifecycle machinery only deactivates / reactivates
          // fields the wizard created (ADR 0009).
          createdField: true,
        },
      });
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
    existingField,
    finalizeCreation,
  ]);

  // Mirror create: CLONE the source field (type + settings + option set) onto a
  // new target field, seed the expression, and wire the definition as a mirror.
  const createMirror = useCallback(async () => {
    if (
      !selectedObject ||
      !sourceObject ||
      !sourceField ||
      !mirrorDraft ||
      !isValidFieldName(fieldName)
    ) {
      return;
    }
    setCreating(true);
    setError('');
    try {
      const metadataClient = new MetadataApiClient();
      // Only enum kinds carry an explicit option set to clone; every other
      // mirrorable kind clones its settings verbatim (design 2026-07-06).
      const clonesOptions =
        sourceField.type === 'SELECT' || sourceField.type === 'MULTI_SELECT';
      const clonedOptions = clonesOptions
        ? cloneMirrorOptions(sourceField.options)
        : [];

      let valueFieldId = existingField?.id ?? null;
      if (!existingField) {
        const createdField = await metadataClient.mutation({
          createOneField: {
            __args: {
              input: {
                field: {
                  objectMetadataId: selectedObject.id,
                  type: sourceField.type,
                  name: fieldName,
                  label: label.trim() || fieldName,
                  description: `Mirrors ${sourceObject.nameSingular}.${sourceField.name} (Formula Field app).`,
                  icon: 'IconCopy',
                  isUIEditable: true,
                  ...(sourceField.settings
                    ? { settings: sourceField.settings }
                    : {}),
                  ...(clonedOptions.length > 0
                    ? { options: clonedOptions }
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

      await finalizeCreation({
        metadataClient,
        valueFieldId,
        definitionData: {
          targetObject: selectedObject.nameSingular,
          targetField: fieldName,
          targetFieldType: sourceField.type,
          currencyCode: '',
          outputFormat: 'mirror',
          // Expression is seeded automatically (same-record bare ref or cross-
          // record [object:id:field]); enabling triggers the first passthrough.
          expression: seedMirrorExpression(mirrorDraft),
          enabled: true,
          targetFieldSettings: serializeTargetFieldSettings({
            settings: sourceField.settings ?? null,
            mirror: mirrorDraft,
          }),
          createdField: true,
        },
      });
    } catch (createError) {
      setError((createError as Error).message ?? String(createError));
    } finally {
      setCreating(false);
    }
  }, [
    selectedObject,
    sourceObject,
    sourceField,
    mirrorDraft,
    fieldName,
    label,
    existingField,
    finalizeCreation,
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
        <StepTitle style={layout.stepTitle}>2 · Value source</StepTitle>
        <div style={layout.formatRow}>
          <ChoiceChip
            selected={mode === 'format'}
            onMouseDown={() => pickMode('format')}
          >
            Format
            <HintText as="span"> compute a value</HintText>
          </ChoiceChip>
          <ChoiceChip
            selected={mode === 'mirror'}
            onMouseDown={() => pickMode('mirror')}
          >
            Mirror another field
            <HintText as="span"> copy a field verbatim</HintText>
          </ChoiceChip>
        </div>
      </div>

      {mode === 'format' ? (
        <>
          <div style={layout.step}>
            <StepTitle style={layout.stepTitle}>2a · Output format</StepTitle>
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
        </>
      ) : (
        <>
          <div style={layout.step}>
            <StepTitle style={layout.stepTitle}>2a · Source object</StepTitle>
            <TextInput
              style={layout.filter}
              value={sourceObjectFilter}
              placeholder="Filter objects…"
              onChange={(event) => setSourceObjectFilter(event.target.value)}
            />
            <div style={layout.objectList}>
              {visibleSourceObjects.map((object) => (
                <ChoiceChip
                  key={object.id}
                  selected={sourceObject?.id === object.id}
                  onMouseDown={() => pickSourceObject(object)}
                >
                  {object.labelSingular}
                  {selectedObject?.id === object.id ? (
                    <HintText as="span"> this object</HintText>
                  ) : null}
                </ChoiceChip>
              ))}
              {visibleSourceObjects.length === 0 ? (
                <MutedText>No matching object</MutedText>
              ) : null}
            </div>
          </div>

          {sourceObject ? (
            <div style={layout.step}>
              <StepTitle style={layout.stepTitle}>2b · Source field</StepTitle>
              <div style={layout.formatRow}>
                {mirrorSourceFields.map((field) => (
                  <ChoiceChip
                    key={field.id}
                    selected={sourceField?.id === field.id}
                    onMouseDown={() => pickSourceField(field)}
                  >
                    {field.label}
                    <HintText as="span"> {field.type}</HintText>
                  </ChoiceChip>
                ))}
                {mirrorSourceFields.length === 0 ? (
                  <MutedText>
                    No mirrorable field on this object — only non-numeric kinds
                    (SELECT, MULTI_SELECT, links, full name, …) can be mirrored.
                  </MutedText>
                ) : null}
              </div>
            </div>
          ) : null}

          {sourceField ? (
            <div style={layout.step}>
              <StepTitle style={layout.stepTitle}>2c · Source record</StepTitle>
              <TextInput
                style={layout.filter}
                value={sourceRecordId}
                placeholder={
                  sourceRecordRequired
                    ? 'Source record UUID (required)'
                    : 'Source record UUID (optional)'
                }
                onChange={(event) => setSourceRecordId(event.target.value)}
              />
              {trimmedSourceRecordId ? (
                sourceRecordStatus === 'checking' ? (
                  <MutedText as="div">Checking record…</MutedText>
                ) : sourceRecordStatus === 'valid' ? (
                  <OkText as="div">{sourceRecordLabel ?? 'Record found'}</OkText>
                ) : sourceRecordStatus === 'invalid' ? (
                  <ErrText as="div">
                    No record with that id on {sourceObject?.labelSingular}
                  </ErrText>
                ) : null
              ) : sourceRecordRequired ? (
                // A cross-object mirror has no "current record" to read from, so a
                // specific source record is required before create unlocks.
                <HintText as="div">
                  A different object needs a specific source record to copy from.
                </HintText>
              ) : (
                <HintText as="div">
                  Leave blank to mirror each record’s own {sourceField.label}.
                </HintText>
              )}
            </div>
          ) : null}
        </>
      )}

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
        <PrimaryButton
          disabled={!readyToCreate}
          onMouseDown={mode === 'mirror' ? createMirror : create}
        >
          {creating
            ? 'Creating field…'
            : resumable
              ? 'Adopt fields & finish setup'
              : mode === 'mirror'
                ? 'Create mirror field'
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
