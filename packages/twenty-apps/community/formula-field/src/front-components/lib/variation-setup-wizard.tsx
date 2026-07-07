import { useCallback, useEffect, useMemo, useState } from 'react';
import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { enqueueSnackbar } from 'twenty-sdk/front-component';

import { ensureVariationTabOnObject } from 'src/front-components/lib/ensure-variation-tab';
import {
  checkRelationFieldName,
  countSyncableFields,
  eligibleTargetObjects,
  INVERSE_FIELD_LABEL,
  INVERSE_FIELD_NAME,
  type VariationTargetObject,
} from 'src/front-components/lib/variation-setup-logic';
import {
  ChoiceChip,
  ErrText,
  HintText,
  MutedText,
  OkText,
  PrimaryButton,
  StepTitle,
  TextInput,
} from 'src/front-components/lib/ui';
import { TOKENS } from 'src/front-components/lib/ui-tokens';

// Guided opt-in for record variations on an object (Plan 2): pick the target
// object, name the self-referencing relation field, then the wizard CREATES
// that field pair on the object via the metadata API (createOneField; the app
// role carries the DATA_MODEL permission) and wires this config to it. The
// dormant Plan 1 sync engine comes alive the moment the config is enabled.
//
// The VariationConfig record IS the draft: the object pick is persisted to it
// as it is made (name + targetObject), and the wizard seeds itself from the
// record on mount — navigating away and back resumes the object choice. The
// final create step is idempotent: if a previous attempt already created a
// relation field of the requested name, it is adopted instead of colliding.
//
// Limitation: the typed relation-field NAME is not persisted as a draft (that
// would need a draft column the VariationConfig object does not carry — the
// stored relationFieldName is only written on a successful create). A resumed
// wizard therefore always restarts the name at 'primaryRecord'.

const DEFAULT_RELATION_FIELD_NAME = 'primaryRecord';

type VariationSetupWizardProps = {
  draft: {
    id: string;
    targetObject: string;
    relationFieldName: string;
  };
  onCreated: () => void;
};

export const VariationSetupWizard = ({
  draft,
  onCreated,
}: VariationSetupWizardProps) => {
  const [objects, setObjects] = useState<VariationTargetObject[]>([]);
  const [configuredTargetObjects, setConfiguredTargetObjects] = useState<
    string[]
  >([]);
  const [objectsLoading, setObjectsLoading] = useState(true);
  const [objectFilter, setObjectFilter] = useState('');
  const [selectedObject, setSelectedObject] =
    useState<VariationTargetObject | null>(null);
  const [fieldName, setFieldName] = useState(
    draft.relationFieldName || DEFAULT_RELATION_FIELD_NAME,
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Fire-and-forget draft persistence; a failed save only costs resumability.
  const persistDraft = useCallback(
    (data: Record<string, unknown>) => {
      const client = new CoreApiClient();
      client
        .mutation({
          updateVariationConfig: {
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
    const load = async () => {
      try {
        // Load ALL objects (top-level connection looped to completion) — the
        // Task 5 eligibility filter is self-contained, so no active/system
        // pre-filter is applied here; the whole set is handed straight in.
        const metadataClient = new MetadataApiClient();
        const loadedObjects: VariationTargetObject[] = [];
        let objectsCursor: string | undefined;
        for (;;) {
          const response = await metadataClient.query({
            objects: {
              __args: {
                filter: {},
                paging: {
                  first: 500,
                  ...(objectsCursor ? { after: objectsCursor } : {}),
                },
              },
              edges: {
                node: {
                  id: true,
                  nameSingular: true,
                  labelSingular: true,
                  labelIdentifierFieldMetadataId: true,
                  isActive: true,
                  isSystem: true,
                  fields: {
                    // A per-object field count above 500 is unrealistic; the
                    // nested connection mirrors the formula wizard's shape.
                    __args: { paging: { first: 500 }, filter: {} },
                    edges: {
                      node: {
                        id: true,
                        name: true,
                        type: true,
                        isActive: true,
                        isSystem: true,
                      },
                    },
                  },
                },
              },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          });
          for (const edge of response?.objects?.edges ?? []) {
            const node = edge?.node;
            if (!node?.id || !node?.nameSingular) continue;
            const fields = (node.fields?.edges ?? [])
              .map((fieldEdge: any) => fieldEdge?.node)
              .filter((fieldNode: any) => fieldNode?.id && fieldNode?.name)
              .map((fieldNode: any) => ({
                id: fieldNode.id,
                name: fieldNode.name,
                type: fieldNode.type,
                isActive: fieldNode.isActive !== false,
                isSystem: fieldNode.isSystem === true,
              }));
            loadedObjects.push({
              id: node.id,
              nameSingular: node.nameSingular,
              labelSingular: node.labelSingular ?? node.nameSingular,
              isActive: node.isActive !== false,
              isSystem: node.isSystem === true,
              labelIdentifierFieldMetadataId:
                node.labelIdentifierFieldMetadataId ?? null,
              fields,
            });
          }
          const pageInfo = response?.objects?.pageInfo;
          if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) break;
          objectsCursor = pageInfo.endCursor;
        }

        // Existing configs (targetObject only, connection looped to completion)
        // so already-configured objects are excluded from the picker.
        const coreClient = new CoreApiClient();
        const targetObjects: string[] = [];
        let configsCursor: string | undefined;
        for (;;) {
          const response = await coreClient.query({
            variationConfigs: {
              __args: {
                first: 200,
                ...(configsCursor ? { after: configsCursor } : {}),
              },
              edges: { node: { targetObject: true } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          });
          const connection = response?.variationConfigs;
          for (const edge of connection?.edges ?? []) {
            const configuredTargetObject = edge?.node?.targetObject;
            if (configuredTargetObject) targetObjects.push(configuredTargetObject);
          }
          if (!connection?.pageInfo?.hasNextPage) break;
          configsCursor = connection.pageInfo.endCursor ?? undefined;
        }

        if (cancelled) return;
        setObjects(loadedObjects);
        setConfiguredTargetObjects(targetObjects);
        // Resume: reselect the draft's target object. Its own config row is
        // this draft, so it is excluded from the "already configured" set below
        // (via the memo) — reselect straight from the loaded objects.
        if (draft.targetObject) {
          const saved = loadedObjects.find(
            (object) => object.nameSingular === draft.targetObject,
          );
          if (saved) setSelectedObject(saved);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(`Failed to load objects: ${(loadError as Error).message}`);
        }
      } finally {
        if (!cancelled) setObjectsLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume subtlety: exclude the draft's own targetObject from the configured
  // set so its already-existing config row does not filter it out of the picker.
  const eligibleObjects = useMemo(
    () =>
      eligibleTargetObjects(
        objects,
        configuredTargetObjects.filter(
          (targetObject) => targetObject !== draft.targetObject,
        ),
      ),
    [objects, configuredTargetObjects, draft.targetObject],
  );

  const visibleObjects = useMemo(() => {
    const needle = objectFilter.trim().toLowerCase();
    if (!needle) return eligibleObjects;
    return eligibleObjects.filter(
      (object) =>
        object.labelSingular.toLowerCase().includes(needle) ||
        object.nameSingular.toLowerCase().includes(needle),
    );
  }, [eligibleObjects, objectFilter]);

  const pickObject = (object: VariationTargetObject) => {
    setSelectedObject(object);
    // Stamp the deterministic key (name = targetObject nameSingular) here so it
    // is never user-managed, and persist the object choice for resume.
    persistDraft({ name: object.nameSingular, targetObject: object.nameSingular });
  };

  const nameCheck = useMemo(
    () =>
      selectedObject ? checkRelationFieldName(fieldName, selectedObject) : null,
    [fieldName, selectedObject],
  );

  const syncableCount = useMemo(
    () =>
      selectedObject ? countSyncableFields(selectedObject, fieldName) : 0,
    [selectedObject, fieldName],
  );

  const readyToCreate = Boolean(
    selectedObject && nameCheck?.ok && !creating,
  );

  const create = useCallback(async () => {
    if (!selectedObject) return;
    const check = checkRelationFieldName(fieldName, selectedObject);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setCreating(true);
    setError('');
    try {
      const metadataClient = new MetadataApiClient();
      // The one genuinely new mutation in this plan. relationCreationPayload's
      // label/icon describe the INVERSE collection field the server creates on
      // the same (self-referencing) object; its API name derives from the label
      // ('Variations' -> 'variations', asserted in variation-setup-logic.spec).
      let relationFieldId =
        check.ok && check.resume ? check.existingFieldId : null;
      if (!relationFieldId) {
        const created = await metadataClient.mutation({
          createOneField: {
            __args: {
              input: {
                field: {
                  objectMetadataId: selectedObject.id,
                  type: 'RELATION',
                  name: fieldName,
                  label: 'Primary record',
                  description:
                    'Points at the record this one is a variation of ' +
                    '(Formula Field app — record variations).',
                  icon: 'IconGitFork',
                  isUIEditable: true,
                  relationCreationPayload: {
                    type: 'MANY_TO_ONE',
                    targetObjectMetadataId: selectedObject.id,
                    targetFieldLabel: INVERSE_FIELD_LABEL,
                    targetFieldIcon: 'IconGitFork',
                  },
                },
              },
            },
            id: true,
          },
        });
        relationFieldId = created?.createOneField?.id ?? null;
      }

      // Finalize (formula finalizeCreation structure): write the finished
      // config, place the record-page tab, nudge the user, then notify.
      // createdRelationField: !check.resume — a resumed wizard that reused a
      // pre-existing relation field must NOT claim provenance (destroy would
      // otherwise deactivate a field the app did not create).
      const coreClient = new CoreApiClient();
      await coreClient.mutation({
        updateVariationConfig: {
          __args: {
            id: draft.id,
            data: {
              name: selectedObject.nameSingular,
              targetObject: selectedObject.nameSingular,
              relationFieldName: fieldName,
              createdRelationField: !check.resume,
              enabled: true,
            },
          },
          id: true,
        },
      });

      // Give the target object a record-page "Variations" tab (idempotent).
      // Best-effort: a layout failure must not block the config itself.
      try {
        await ensureVariationTabOnObject(selectedObject.id);
      } catch {
        // The config still works; the tab can be added on a later attempt.
      }

      // Runtime-created fields/tabs propagate to already-open tabs only over
      // live SSE; there is no app-side metadata-invalidation API. Best-effort:
      // the host may not expose the snackbar bridge.
      try {
        await enqueueSnackbar({
          message:
            'Variations enabled. If the new fields or tab do not appear, ' +
            'refresh the page.',
          variant: 'info',
          dedupeKey: 'variation-config-created',
        });
      } catch {
        // No host snackbar — the status panel also surfaces the wired config.
      }
      onCreated();
    } catch (createError) {
      setError((createError as Error).message ?? String(createError));
    } finally {
      setCreating(false);
    }
  }, [selectedObject, fieldName, draft.id, onCreated]);

  return (
    <div>
      <div style={layout.step}>
        <StepTitle style={layout.stepTitle}>1 · Object</StepTitle>
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
                <MutedText>
                  No eligible object — every object either already has
                  variations, is app-owned/system, or has nothing to sync.
                </MutedText>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {selectedObject ? (
        <div style={layout.step}>
          <StepTitle style={layout.stepTitle}>2 · Relation field name</StepTitle>
          <TextInput
            style={layout.filter}
            value={fieldName}
            placeholder={DEFAULT_RELATION_FIELD_NAME}
            onChange={(event) => setFieldName(event.target.value)}
          />
          {nameCheck && !nameCheck.ok ? (
            <ErrText as="div">{nameCheck.error}</ErrText>
          ) : nameCheck?.ok && nameCheck.resume ? (
            <OkText as="div">
              A relation field named{' '}
              <span style={layout.mono}>{fieldName}</span> already exists — setup
              will resume with the existing field.
            </OkText>
          ) : null}
          <HintText as="div">
            Creating adds two fields to {selectedObject.labelSingular}:{' '}
            <span style={layout.mono}>{fieldName}</span> (each variation’s link
            to its primary) and a <span style={layout.mono}>{INVERSE_FIELD_NAME}</span>{' '}
            collection ({INVERSE_FIELD_LABEL}) on the primary.
          </HintText>
          <MutedText as="div">
            {syncableCount} field{syncableCount === 1 ? '' : 's'} will sync from
            each primary to its variations.
          </MutedText>
        </div>
      ) : null}

      <div style={layout.actions}>
        <PrimaryButton disabled={!readyToCreate} onMouseDown={create}>
          {creating
            ? 'Enabling variations…'
            : nameCheck?.ok && nameCheck.resume
              ? 'Adopt field & enable variations'
              : 'Enable variations'}
        </PrimaryButton>
        <MutedText>Your object choice is saved — you can resume anytime.</MutedText>
      </div>

      {error ? <ErrText as="div">{error}</ErrText> : null}
    </div>
  );
};

// Layout-only values (padding, gaps, margins) — every color/font-family-for-
// body-text/background/border comes from the archetypes in lib/ui.tsx or
// lib/ui-tokens instead.
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
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    margin: '12px 0 6px',
  },
  // "mono" is a mono readonly display, not a form control.
  mono: { fontFamily: 'ui-monospace, monospace', color: TOKENS.fontColorPrimary },
};
