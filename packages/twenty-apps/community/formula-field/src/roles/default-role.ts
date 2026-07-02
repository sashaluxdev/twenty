import { defineRole } from 'twenty-sdk/define';

// Role the app runs under. It needs to read the objects that formulas reference
// and write the value fields + FormulaDefinition bookkeeping fields. We grant a
// broad object permission for the demo; a production deploy would scope this
// down to exactly the target objects.
export const DEFAULT_ROLE_UNIVERSAL_IDENTIFIER =
  'ac4d683d-f20b-4728-9ab0-7d52938dd36b';

export default defineRole({
  universalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  label: 'Formula Field',
  description: 'Reads formula inputs and writes computed value fields.',
  canReadAllObjectRecords: true,
  canUpdateAllObjectRecords: true,
  canSoftDeleteAllObjectRecords: true,
  canDestroyAllObjectRecords: false,
});
