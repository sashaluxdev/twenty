import { describe, expect, it } from 'vitest';

import defaultRole from 'src/roles/default-role';
import { FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/objects/formula-definition.object';
import { VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/objects/variation-config.object';

// Delete-completely destroy permission (spec 2026-08-12): the danger zones'
// final hard-destroy is gated on canDestroyObjectRecords, and the app-role
// intersection denies it for every user unless the role grants destroy on
// exactly its two objects. defineRole validates only the PRESENCE of
// objectUniversalIdentifier, so a typo'd identifier silently creates a useless
// permission row — the identifiers are asserted against the imported
// constants, never inline UUIDs.
describe('default role destroy permissions', () => {
  it('builds without validation errors', () => {
    expect(defaultRole.success).toBe(true);
  });

  it('keeps role-wide destroy denied', () => {
    expect(defaultRole.config.canDestroyAllObjectRecords).toBe(false);
  });

  it('grants per-object destroy on exactly the two danger-zone objects', () => {
    const destroyGrants = (defaultRole.config.objectPermissions ?? []).filter(
      (permission) => permission.canDestroyObjectRecords === true,
    );
    expect(
      destroyGrants.map((grant) => grant.objectUniversalIdentifier).sort(),
    ).toEqual(
      [
        FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER,
        VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
      ].sort(),
    );
  });
});
