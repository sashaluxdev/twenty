import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { ensureFormulaTabOnObject } from 'src/front-components/lib/ensure-formula-tab';
import { ensureFieldLayoutVisibility } from 'src/logic-functions/lib/fx-status-field';
import {
  deriveFieldName,
  getOutputFormat,
  isValidFieldName,
  OUTPUT_FORMATS,
  type OutputFormat,
} from 'src/front-components/lib/formula-field-formats';

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

// Codes offered for CURRENCY fields; JPY is the default when the user does not
// intervene. The chosen code becomes the field's default currency and the code
// recompute writes on records that have none.
const CURRENCY_CODES = ['JPY', 'USD', 'EUR', 'GBP', 'CHF', 'CAD'];
const DEFAULT_CURRENCY_CODE = 'JPY';

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
  const [format, setFormat] = useState<OutputFormat | null>(
    isOutputFormat(draft.outputFormat) ? draft.outputFormat : null,
  );
  const [currencyCode, setCurrencyCode] = useState(
    draft.currencyCode || DEFAULT_CURRENCY_CODE,
  );
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

  const pickObject = (object: TargetObjectOption) => {
    setSelectedObject(object);
    persistDraft({ targetObject: object.nameSingular });
  };
  const pickFormat = (key: OutputFormat) => {
    setFormat(key);
    persistDraft({ outputFormat: key });
  };
  const pickCurrency = (code: string) => {
    setCurrencyCode(code);
    persistDraft({ currencyCode: code });
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
    !creating;

  const create = useCallback(async () => {
    if (!selectedObject || !format || !isValidFieldName(fieldName)) return;
    setCreating(true);
    setError('');
    try {
      const formatDefinition = getOutputFormat(format);
      const isCurrency = formatDefinition.targetFieldType === 'CURRENCY';
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
                  ...(formatDefinition.settings
                    ? { settings: formatDefinition.settings }
                    : {}),
                  // String defaults use the server's quoted-literal convention.
                  ...(isCurrency
                    ? {
                        defaultValue: {
                          amountMicros: null,
                          currencyCode: `'${currencyCode}'`,
                        },
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
              currencyCode: isCurrency ? currencyCode : '',
              outputFormat: format,
              // Provenance: the lifecycle machinery only deactivates /
              // reactivates fields the wizard created (ADR 0009).
              createdField: true,
            },
          },
          id: true,
        },
      });
      onCreated();
    } catch (createError) {
      setError((createError as Error).message ?? String(createError));
    } finally {
      setCreating(false);
    }
  }, [
    selectedObject,
    format,
    currencyCode,
    fieldName,
    label,
    draft.id,
    existingField,
    existingCompanion,
    onCreated,
  ]);

  return (
    <div>
      <div style={w.step}>
        <div style={w.stepTitle}>1 · Target object</div>
        {objectsLoading ? (
          <div style={w.muted}>Loading objects…</div>
        ) : (
          <div>
            <input
              style={w.filter}
              value={objectFilter}
              placeholder="Filter objects…"
              onChange={(event) => setObjectFilter(event.target.value)}
            />
            <div style={w.objectList}>
              {visibleObjects.map((object) => (
                <button
                  key={object.id}
                  style={{
                    ...w.chip,
                    ...(selectedObject?.id === object.id ? w.chipSelected : {}),
                  }}
                  onMouseDown={() => pickObject(object)}
                >
                  {object.labelSingular}
                </button>
              ))}
              {visibleObjects.length === 0 ? (
                <span style={w.muted}>No matching object</span>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div style={w.step}>
        <div style={w.stepTitle}>2 · Output format</div>
        <div style={w.formatRow}>
          {OUTPUT_FORMATS.map((candidate) => (
            <button
              key={candidate.key}
              style={{
                ...w.chip,
                ...(format === candidate.key ? w.chipSelected : {}),
              }}
              onMouseDown={() => pickFormat(candidate.key)}
            >
              {candidate.label}
              <span style={w.formatHint}> {candidate.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {format === 'currency' ? (
        <div style={w.step}>
          <div style={w.stepTitle}>2b · Default currency</div>
          <div style={w.formatRow}>
            {CURRENCY_CODES.map((code) => (
              <button
                key={code}
                style={{
                  ...w.chip,
                  ...(currencyCode === code ? w.chipSelected : {}),
                }}
                onMouseDown={() => pickCurrency(code)}
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div style={w.step}>
        <div style={w.stepTitle}>3 · Field name</div>
        <input
          style={w.filter}
          value={label}
          placeholder="e.g. Deal score"
          onChange={(event) => {
            labelTouched.current = true;
            setLabel(event.target.value);
          }}
        />
        {fieldName ? (
          <div style={w.muted}>
            API name: <span style={w.mono}>{fieldName}</span>
            {collision ? (
              <span style={w.err}>
                {' '}
                — already exists on {selectedObject?.labelSingular}
              </span>
            ) : null}
            {resumable ? (
              <span style={w.resume}>
                {' '}
                — fields from an interrupted attempt found; creating will adopt
                them
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div style={w.actions}>
        <button
          style={{ ...w.create, ...(readyToCreate ? {} : w.createDisabled) }}
          disabled={!readyToCreate}
          onMouseDown={create}
        >
          {creating
            ? 'Creating field…'
            : resumable
              ? 'Adopt fields & finish setup'
              : 'Create formula field'}
        </button>
        <span style={w.muted}>
          Progress is saved — you can leave and resume anytime.
        </span>
      </div>

      {error ? <div style={w.err}>{error}</div> : null}
    </div>
  );
};

const w: Record<string, React.CSSProperties> = {
  step: { marginBottom: '14px' },
  stepTitle: { fontSize: '11px', color: '#908e99', marginBottom: '6px' },
  filter: {
    width: '100%',
    padding: '6px 8px',
    border: '1px solid #d6d5db',
    borderRadius: '4px',
    fontSize: '13px',
    boxSizing: 'border-box',
    marginBottom: '6px',
  },
  objectList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    maxHeight: '96px',
    overflowY: 'auto',
  },
  formatRow: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  chip: {
    padding: '4px 10px',
    borderRadius: '12px',
    border: '1px solid #d6d5db',
    background: '#fff',
    color: '#1b1b1f',
    cursor: 'pointer',
    fontSize: '12px',
  },
  chipSelected: {
    border: '1px solid #1961ed',
    background: '#eef3fe',
    color: '#1961ed',
  },
  formatHint: { color: '#b0aeb8', fontSize: '11px' },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    margin: '12px 0 6px',
  },
  create: {
    padding: '6px 14px',
    borderRadius: '4px',
    border: 'none',
    background: '#1961ed',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
  },
  createDisabled: { background: '#c3c2c9', cursor: 'default' },
  muted: { color: '#908e99', fontSize: '12px' },
  mono: { fontFamily: 'ui-monospace, monospace' },
  err: { color: '#e0483d', fontSize: '12px', marginTop: '6px' },
  resume: { color: '#a35c00', fontSize: '12px' },
};
