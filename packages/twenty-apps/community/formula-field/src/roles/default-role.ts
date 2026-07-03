import { defineRole } from 'twenty-sdk/define';

// Role the app token runs under (logic functions + cron). Scope analysis
// (finding M1c):
//
// - canReadAllObjectRecords / canUpdateAllObjectRecords are WILDCARD BY DESIGN
//   and must stay: recompute reads formula INPUT fields on any object and writes
//   the computed value field on any TARGET object. Which objects/fields those
//   are is chosen per-formula at runtime (the wizard can target any object), so
//   the grant cannot be narrowed to a fixed object list without breaking the
//   core feature.
//
// - canSoftDeleteAllObjectRecords: the delete/destroy lifecycle soft-deletes
//   FormulaOverride rows.
//
// - canUpdateAllSettings is genuinely required by the APP token — but NOT for
//   the wizard. The wizard's createOneField runs under the USER token (a front
//   component on the host token bridge), so the user's own DATA_MODEL permission
//   gates it, not this role. The real consumer is server-side:
//   syncCompanionStatusField -> setFieldActive (fx-status-field.ts) calls the
//   metadata mutation updateOneField (isActive) under the app token to heal a
//   deactivated FX Status companion during refreshFormulaStatuses (sweep /
//   save / lifecycle). updateOneField is settings-gated, so without
//   canUpdateAllSettings that heal would be denied. Kept and documented.
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
  canUpdateAllSettings: true,
});
