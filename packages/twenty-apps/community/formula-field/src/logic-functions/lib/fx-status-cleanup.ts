import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { loadTrashedFormulas } from 'src/logic-functions/lib/formula-repository';
import {
  companionFieldName,
  loadObjectFieldIndex,
  type ObjectFieldIndex,
} from 'src/logic-functions/lib/fx-status-field';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

export type CompanionCleanupResult = {
  companions: number;
  deactivated: number;
  deleted: number;
  failed: number;
};

type MetadataMutationClient = { mutation: (selection: any) => Promise<any> };

// Removal of the legacy per-record "FX Status" companion fields (ADR 0021
// replaced the chip with a snackbar; the wizard no longer creates them, but
// previously-deployed workspaces still carry one per formula). Enumerates
// every definition — live (any enabled state) AND trashed, since a trashed
// definition's field pair stays active — and, for each <targetField>FxStatus
// field that still exists on its target object, deactivates it (dropping its
// viewField rows) and hard-deletes it. Values are derived state, so nothing
// user-authored is lost. Runs from the hourly sweep: idempotent (once the
// fields are gone the pass finds nothing), and each field is wrapped in its
// own try/catch so a permission or transport failure leaves that field for
// the next sweep instead of halting the pass.
export const cleanupCompanionFields = async (
  client: FormulaClient,
  deps?: {
    loadIndex?: () => Promise<Map<string, ObjectFieldIndex>>;
    metadataClient?: MetadataMutationClient;
  },
): Promise<CompanionCleanupResult> => {
  const loadIndex = deps?.loadIndex ?? loadObjectFieldIndex;

  // object nameSingular -> companion field names owned by some definition.
  const companionsByObject = new Map<string, Set<string>>();
  const add = (targetObject?: string | null, targetField?: string | null) => {
    if (!targetObject || !targetField) return;
    const names = companionsByObject.get(targetObject) ?? new Set<string>();
    names.add(companionFieldName(targetField));
    companionsByObject.set(targetObject, names);
  };

  // No filter -> live (non-trashed) definitions of any enabled state; the
  // default deletedAt-null scope excludes trashed rows, which are gathered
  // separately below via loadTrashedFormulas.
  const response = await withRetry(() =>
    client.query({
      formulaDefinitions: {
        __args: { first: 200 },
        edges: { node: { targetObject: true, targetField: true } },
      },
    }),
  );
  for (const edge of response?.formulaDefinitions?.edges ?? []) {
    add(edge?.node?.targetObject, edge?.node?.targetField);
  }
  for (const trashed of await loadTrashedFormulas(client)) {
    add(trashed.targetObject, trashed.targetField);
  }

  const result: CompanionCleanupResult = {
    companions: 0,
    deactivated: 0,
    deleted: 0,
    failed: 0,
  };
  // Nothing to reconcile -> skip the (potentially expensive) field index load
  // entirely rather than fetch it and discard the result.
  if (companionsByObject.size === 0) return result;

  const index = await loadIndex();
  const metadata = deps?.metadataClient ?? new MetadataApiClient();

  for (const [objectName, names] of companionsByObject) {
    const objectIndex = index.get(objectName);
    if (!objectIndex) continue;
    for (const name of names) {
      const field = objectIndex.fields.get(name);
      if (!field) continue;
      result.companions += 1;
      try {
        // Deactivate first so the column leaves every view cleanly (same
        // order as delete-definition-completely).
        if (field.isActive) {
          await metadata.mutation({
            updateOneField: {
              __args: { input: { id: field.id, update: { isActive: false } } },
              id: true,
            },
          });
          result.deactivated += 1;
        }
        await metadata.mutation({
          deleteOneField: {
            __args: { input: { id: field.id } },
            id: true,
          },
        });
        result.deleted += 1;
      } catch {
        // Left for the next sweep; a deactivated-but-not-deleted companion is
        // already out of every view.
        result.failed += 1;
      }
    }
  }

  return result;
};
