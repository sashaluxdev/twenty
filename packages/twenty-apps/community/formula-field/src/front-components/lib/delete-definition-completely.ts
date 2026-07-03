import { companionFieldName } from 'src/logic-functions/lib/fx-status-field';
import {
  anotherDefinitionTargets,
  findFields,
  type MetadataQueryClient,
} from 'src/logic-functions/lib/handle-definition-lifecycle';
import { type FormulaClient } from 'src/logic-functions/lib/types';

// "Delete Completely" (danger zone): permanently destroy a FormulaDefinition and,
// when this app owns the value field and no other definition shares it, hard-delete
// the value field + its FX Status companion (including every record's stored value).
// Everything is driven through INJECTED clients so it is fully unit-testable with
// plain fakes — no module mocking. Platform facts this relies on (verified in
// twenty-server source):
//   - deleteOneField (metadata) hard-deletes a field; it has NO isActive
//     precondition (only standard/system fields are rejected). We still deactivate
//     first so the column leaves views cleanly before removal.
//   - destroy<Object> hard-deletes the record (no prior soft delete required) and
//     emits ONLY the `destroyed` event, so on-formula-definition-destroyed runs and
//     cleans up the now-orphaned override rows (it tolerates the fields being gone).

// The metadata client also needs to mutate (deactivate + delete fields), so it is
// a superset of the read-only MetadataQueryClient used by findFields.
export type MetadataMutationClient = MetadataQueryClient & {
  mutation: (selection: any) => Promise<any>;
};

// Why the value field will be kept, for the confirmation panel copy.
export type KeepReason = '' | 'no-field' | 'not-created' | 'shared';

export type DeleteDefinitionPlan = {
  definitionId: string;
  targetObject: string;
  targetField: string;
  // Companion field name (<targetField>FxStatus); '' when there is no target field.
  companionField: string;
  // True only when the app created the field AND no other definition targets it.
  deleteValueField: boolean;
  keepReason: KeepReason;
};

export type DeleteDefinitionResult = {
  destroyed: boolean;
  deleteValueField: boolean;
  // Field names actually deactivated + deleted (companion first, then value).
  deletedFields: string[];
};

// Re-fetches the definition FRESH (never trusts widget state) and resolves whether
// its value field is safe to hard-delete. Used both to render the warning panel and
// as the first step of the deletion itself.
export const planDeleteDefinition = async (
  coreClient: FormulaClient,
  definitionId: string,
): Promise<DeleteDefinitionPlan> => {
  const response = await coreClient.query({
    formulaDefinitions: {
      __args: { first: 1, filter: { id: { eq: definitionId } } },
      edges: {
        node: {
          id: true,
          targetObject: true,
          targetField: true,
          createdField: true,
        },
      },
    },
  });
  const node = response?.formulaDefinitions?.edges?.[0]?.node ?? {};
  const targetObject = node.targetObject ?? '';
  const targetField = node.targetField ?? '';
  const createdField = node.createdField === true;
  const companionField = targetField ? companionFieldName(targetField) : '';

  let deleteValueField = false;
  let keepReason: KeepReason = 'no-field';
  if (targetField) {
    if (!createdField) {
      // Field pre-existed / was not created by this app — never remove it.
      keepReason = 'not-created';
    } else if (
      await anotherDefinitionTargets(coreClient, {
        id: definitionId,
        targetObject,
        targetField,
      })
    ) {
      // Another definition still computes into this column — keep it.
      keepReason = 'shared';
    } else {
      deleteValueField = true;
      keepReason = '';
    }
  }

  return {
    definitionId,
    targetObject,
    targetField,
    companionField,
    deleteValueField,
    keepReason,
  };
};

const deactivateAndDeleteField = async (
  metadataClient: MetadataMutationClient,
  fieldId: string,
): Promise<void> => {
  // Deactivate first so the field drops out of every view before it is removed.
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

// Executes the full permanent deletion. Order matters: fields are removed first
// (companion, then value field), then the definition record is destroyed — so the
// `destroyed` trigger's field-deactivation step finds nothing to do and only the
// override cleanup runs.
export const deleteDefinitionCompletely = async ({
  coreClient,
  metadataClient,
  definitionId,
}: {
  coreClient: FormulaClient;
  metadataClient: MetadataMutationClient;
  definitionId: string;
}): Promise<DeleteDefinitionResult> => {
  const plan = await planDeleteDefinition(coreClient, definitionId);
  const deletedFields: string[] = [];

  if (plan.deleteValueField) {
    const { fields } = await findFields(
      plan.targetObject,
      [plan.targetField, plan.companionField],
      metadataClient,
    );
    // Companion first (an anchored dependent of the value field). It may already
    // be gone from a partial cleanup — skip it, still delete the value field.
    const companion = fields.get(plan.companionField);
    if (companion) {
      await deactivateAndDeleteField(metadataClient, companion.id);
      deletedFields.push(plan.companionField);
    }
    const valueField = fields.get(plan.targetField);
    if (valueField) {
      await deactivateAndDeleteField(metadataClient, valueField.id);
      deletedFields.push(plan.targetField);
    }
  }

  await coreClient.mutation({
    destroyFormulaDefinition: { __args: { id: definitionId }, id: true },
  });

  return {
    destroyed: true,
    deleteValueField: plan.deleteValueField,
    deletedFields,
  };
};
