import {
  findFields,
  type MetadataQueryClient,
} from 'src/logic-functions/lib/handle-definition-lifecycle';
import { type FormulaClient } from 'src/logic-functions/lib/types';

// "Delete Completely" (danger zone) for a VariationConfig: permanently destroy
// the config and, when this app provisioned the self-referencing relation field,
// hard-delete that field (the server cascades the ONE_TO_MANY inverse). The
// variation-shaped analogue of front-components/lib/delete-definition-completely.ts,
// driven entirely through INJECTED clients so it is fully unit-testable with
// plain fakes — no module mocking.
//
// FOUR deliberate differences from the formula precedent, all documented here:
//
//   1. NO "shared-target" guard. The formula flow keeps the value field when
//      ANOTHER definition also targets it (anotherDefinitionTargets). A
//      VariationConfig cannot collide the same way: its `name` IS the target
//      object's nameSingular and is the uniqueness anchor (one config per
//      object), so two configs can never provision the same object's relation
//      field. The guard would be vacuous, so it is omitted rather than copied —
//      provenance (createdRelationField) is the sole gate.
//   2. ONE field, not a pair. There is no FX Status companion; only the
//      MANY_TO_ONE relation field is removed. The server cascades delete +
//      isActive to the ONE_TO_MANY inverse automatically, so the inverse is
//      never looked up or mutated (mirrors handle-variation-config-lifecycle.ts).
//   3. Override rows are NEVER deleted. handleDefinitionDestroyed deletes
//      FormulaOverride rows scoped by (targetObject, targetField); a
//      VariationConfig has no single-column scope — its overrides span the same
//      (object, field, record) key space a future FormulaDefinition on this
//      object could still need. There is no safe surgical filter, so override
//      rows are left in place (same lifecycle decision as the destroyed handler).
//   4. Idempotent with the destroyed handler. A hard destroy emits ONLY the
//      `destroyed` event, so handleVariationConfigDestroyed also runs. Because
//      the field is deactivated-then-deleted BEFORE the destroy here, that
//      handler's findFields returns no relation field -> its `field && isActive`
//      guard is false -> it deactivates nothing and returns cleanly. The two
//      paths never fight.

// The metadata client also mutates (deactivate + delete the field), so it is a
// superset of the read-only MetadataQueryClient findFields accepts.
export type MetadataMutationClient = MetadataQueryClient & {
  mutation: (selection: any) => Promise<any>;
};

// Why the relation field is kept, for the confirmation panel copy.
export type KeepReason = '' | 'no-field' | 'not-created';

export type DeleteVariationConfigPlan = {
  configId: string;
  targetObject: string;
  relationFieldName: string;
  // True only when the app created the relation field for this config.
  deleteRelationField: boolean;
  keepReason: KeepReason;
};

export type DeleteVariationConfigResult = {
  destroyed: boolean;
  deleteRelationField: boolean;
  // Field names actually deactivated + deleted (the relation field, if present).
  deletedFields: string[];
};

// Re-fetches the config FRESH (never trusts widget state) and resolves whether
// its relation field is safe to hard-delete. Used both to render the warning
// panel and as the first step of the deletion itself.
export const planDeleteVariationConfig = async (
  coreClient: FormulaClient,
  configId: string,
): Promise<DeleteVariationConfigPlan> => {
  const response = await coreClient.query({
    variationConfigs: {
      __args: { first: 1, filter: { id: { eq: configId } } },
      edges: {
        node: {
          id: true,
          targetObject: true,
          relationFieldName: true,
          createdRelationField: true,
        },
      },
    },
  });
  const node = response?.variationConfigs?.edges?.[0]?.node ?? {};
  const targetObject = node.targetObject ?? '';
  const relationFieldName = node.relationFieldName ?? '';
  const createdRelationField = node.createdRelationField === true;

  let deleteRelationField = false;
  let keepReason: KeepReason = 'no-field';
  if (relationFieldName && targetObject) {
    if (!createdRelationField) {
      // Field pre-existed / was not created by this app — never remove it.
      keepReason = 'not-created';
    } else {
      deleteRelationField = true;
      keepReason = '';
    }
  }

  return {
    configId,
    targetObject,
    relationFieldName,
    deleteRelationField,
    keepReason,
  };
};

const deactivateAndDeleteField = async (
  metadataClient: MetadataMutationClient,
  fieldId: string,
): Promise<void> => {
  // Deactivate first so the column drops out of every view before removal
  // (mirrors delete-definition-completely.ts's deactivateAndDeleteField).
  await metadataClient.mutation({
    updateOneField: {
      __args: { input: { id: fieldId, update: { isActive: false } } },
      id: true,
    },
  });
  await metadataClient.mutation({
    deleteOneField: {
      __args: { input: { id: fieldId } },
      id: true,
    },
  });
};

// Executes the full permanent deletion. Order matters: the relation field is
// removed first, then the config record is destroyed — so the `destroyed`
// trigger's field-deactivation step finds nothing to do (see difference 4).
export const deleteVariationConfigCompletely = async ({
  coreClient,
  metadataClient,
  configId,
}: {
  coreClient: FormulaClient;
  metadataClient: MetadataMutationClient;
  configId: string;
}): Promise<DeleteVariationConfigResult> => {
  const plan = await planDeleteVariationConfig(coreClient, configId);
  const deletedFields: string[] = [];

  if (plan.deleteRelationField) {
    const { fields } = await findFields(
      plan.targetObject,
      [plan.relationFieldName],
      metadataClient,
    );
    // The field may already be gone from a partial prior cleanup — skip it and
    // still destroy the config (tolerated, like the destroyed-trigger precedent).
    const relationField = fields.get(plan.relationFieldName);
    if (relationField) {
      await deactivateAndDeleteField(metadataClient, relationField.id);
      deletedFields.push(plan.relationFieldName);
    }
  }

  await coreClient.mutation({
    destroyVariationConfig: { __args: { id: configId }, id: true },
  });

  return {
    destroyed: true,
    deleteRelationField: plan.deleteRelationField,
    deletedFields,
  };
};
