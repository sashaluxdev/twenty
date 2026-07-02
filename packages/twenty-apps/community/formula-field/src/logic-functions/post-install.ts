import { CoreApiClient } from 'twenty-client-sdk/core';
import { definePostInstallLogicFunction } from 'twenty-sdk/define';
import { type InstallPayload } from 'twenty-sdk/logic-function';

// Provisions a working demo on install: one FormulaDefinition on Opportunity,
// `formulaScore = formulaInputA + formulaInputB * 2`. Creating it fires
// formulaDefinition.created, which validates, indexes, and evaluates it across
// all opportunities — so the app is demonstrably live right after install.
//
// Idempotent: on re-install we skip creation if a definition for this target
// already exists (avoids duplicates; soft-deleted rows still hold unique
// indexes, so we match on target object + field).
const handler = async (_payload: InstallPayload): Promise<void> => {
  const client = new CoreApiClient();

  const existing = await client.query({
    formulaDefinitions: {
      __args: {
        first: 1,
        filter: {
          targetObject: { eq: 'opportunity' },
          targetField: { eq: 'formulaScore' },
        },
      },
      edges: { node: { id: true } },
    },
  });

  if ((existing?.formulaDefinitions?.edges?.length ?? 0) > 0) {
    console.log('[formula-field] demo formula already present, skipping seed');
    return;
  }

  const { createFormulaDefinition } = await client.mutation({
    createFormulaDefinition: {
      __args: {
        data: {
          name: 'Opportunity score (demo)',
          targetObject: 'opportunity',
          targetField: 'formulaScore',
          expression: 'formulaInputA + formulaInputB * 2',
          enabled: true,
        },
      },
      id: true,
      name: true,
    },
  });

  console.log(
    `[formula-field] seeded demo formula ${createFormulaDefinition?.id ?? '(unknown)'}`,
  );
};

export default definePostInstallLogicFunction({
  universalIdentifier: '3351479b-730d-42a3-be1f-ca1241a08b43',
  name: 'post-install',
  description: 'Seeds a demo formula so the app is live on install.',
  timeoutSeconds: 30,
  handler,
});
