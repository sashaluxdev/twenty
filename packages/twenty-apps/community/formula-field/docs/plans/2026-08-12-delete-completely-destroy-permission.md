# Delete Completely: destroy permission spec

Status: IMPLEMENTED on feat/formula-field-fix-wave (live verification pending — plan Task 4)
Design review: DONE 2026-08-13 (plan review, opus) — both formerly-unverified claims VERIFIED
Affects: v0.4.x+ danger-zone flows (formula definition + variation config)

## Problem

Clicking "Delete completely" in either danger zone fails after ~1s with the raw server
string `Entity performing the request does not have permission`, shown inline in the
panel. It fails for every user, including the workspace owner Admin, because the entity
being denied is not the user.

## Root cause

1. The danger-zone confirm handlers run in the app's front component and call
   `deleteDefinitionCompletely` / `deleteVariationConfigCompletely`
   (`src/front-components/lib/delete-definition-completely.ts:129-170`,
   `src/front-components/lib/delete-variation-config-completely.ts:134-170`).
   Both clients (`CoreApiClient`, `MetadataApiClient`) authenticate with
   `TWENTY_APP_ACCESS_TOKEN` — an APPLICATION_ACCESS JWT carrying BOTH the acting
   user and the application id.
2. For that token shape the server resolves permissions as the INTERSECTION of the
   user's role and the app's manifest role:
   `twenty-server/src/engine/twenty-orm/utils/resolve-role-ids-for-user.util.ts`
   returns `[userRoleId, applicationRoleId]`; `checkRolesPermissions` /
   `computePermissionIntersection` AND the flags across roles.
3. The flow's earlier steps pass: field deactivate + `deleteOneField` are gated on the
   DATA_MODEL settings flag (`field-metadata.resolver.ts:255,273,291` via
   `SettingsPermissionGuard`), and the app role has `canUpdateAllSettings: true`.
4. The final step is a hard destroy of the app-object record
   (`destroyFormulaDefinition` / `destroyVariationConfig`), gated on
   `canDestroyObjectRecords` (`twenty-orm/repository/permissions.utils.ts:214-220`).
   The app role declares `canDestroyAllObjectRecords: false`
   (`src/roles/default-role.ts:32-40`, flag at `:39`, unchanged since creation), so the intersection
   denies it regardless of the user's own role. No user privilege can beat an
   intersection with a role that says no.

### Side effect: non-atomic flow orphans definitions

The destroy is the LAST call; the value field (and companion FX status field) are
hard-deleted BEFORE the failure. Every failed attempt leaves an orphaned
FormulaDefinition (or VariationConfig) row whose fields are gone. The flow re-plans on
each run (`planDeleteDefinition` re-fetches and `findFields` skips already-deleted
fields), so once the permission fix ships, re-running "Delete completely" on an
orphaned row is expected to complete it. Verify this during live check; also sweep the
2026-08-12 test workspace for orphans left by the failed attempts.

## Cost model

No hot-path change. The fix adds one `ObjectPermissionEntity` row per granted object
per workspace at install/sync time; the per-role permissions cache already merges
per-object overrides on every rebuild, so lookup cost is unchanged. Zero impact on
recompute, sweep, or widget load.

## Fix

Grant destroy scoped to exactly the two objects the danger zones hard-destroy, in
`src/roles/default-role.ts`:

```ts
import { FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER } from '../objects/formula-definition.object';
import { VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER } from '../objects/variation-config.object';

export default defineRole({
  // ...existing flags unchanged, including canDestroyAllObjectRecords: false
  objectPermissions: [
    {
      objectUniversalIdentifier: FORMULA_DEFINITION_OBJECT_UNIVERSAL_IDENTIFIER,
      canDestroyObjectRecords: true,
    },
    {
      objectUniversalIdentifier: VARIATION_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
      canDestroyObjectRecords: true,
    },
  ],
});
```

`formulaOverride` is NOT in the list: neither delete flow destroys override rows.

### Why this works (verified against source)

- `RoleConfig`/`RoleManifest` already carry `objectPermissions[].canDestroyObjectRecords`
  (`twenty-shared/src/application/roleManifestType.ts:8-14`,
  `twenty-sdk/src/sdk/define/roles/role-config.ts:6-14`).
- Manifest sync threads them into real `ObjectPermissionEntity` rows generically
  (`compute-application-manifest-all-universal-flat-entity-maps.service.ts:264-352`).
- Per-object flags are nullable overrides merged with `overrideValue ?? defaultValue`
  (`workspace-roles-permissions-cache.service.ts:176-201`): role-wide false + per-object
  true resolves to destroy allowed on exactly those objects. The intersection check
  consumes the merged per-object value, so the override survives it.
- Shipped precedent for the mechanism: `twenty-apps/public/slack/src/roles/slack-assistant.role.ts:27-52`
  flips role-wide false to per-object true for read/update/soft-delete.

### Alternatives rejected

- `canDestroyAllObjectRecords: true`: works but grants the app destroy on every
  workspace object; unnecessary blast radius for an app whose role is otherwise
  deliberately least-privilege on destroy.
- Switch the final call to soft delete (`deleteFormulaDefinition`): passes under the
  current role, but "Delete completely" semantics promise hard removal; a soft delete
  would run the `.deleted` handler, whose semantics are reversible-trash (ADR 0009)
  and would leave a trash row; only destroy emits `formulaDefinition.destroyed`,
  whose handler performs the terminal cleanup.

## Risks and caveats

- No shipped app sets `canDestroyObjectRecords: true` per object (repo-wide grep: zero
  matches). The merge code path is shared with the proven read/update/soft-delete
  flags, but we are first through this gate. Mitigation: local live check before cloud.
- No sync-time validator checks per-object rows for INTENT: a typo'd
  `objectUniversalIdentifier` is caught, but loudly — the platform's flat
  object-permission validator (`FlatObjectPermissionValidatorService`) raises
  `OBJECT_METADATA_NOT_FOUND` and fails the whole migration build, so a typo is
  a hard install failure, not a silent no-op. Mitigation (kept for
  maintainability, not for this failure mode): import the constants, never
  inline the UUIDs; assert the built `.twenty/output/manifest.json` contains
  both rows before deploy.
- Intersection semantics remain: a non-admin member whose own role lacks destroy on
  these objects still cannot "Delete completely". This is correct least-privilege
  behavior; document it in README troubleshooting.
- Pure app-context callers (logic functions, cron) also gain destroy on these two
  objects (single-role resolution). Acceptable: lifecycle cleanup may legitimately
  need it; no current logic function destroys records.
- SDK line: `package.json` pins `twenty-sdk 2.19.0` but the repo resolves the local
  workspace SDK (2.31.0-alpha.1); the built manifest already emits the
  `objectPermissions` key. For cloud publish, confirm the npm SDK matching the platform
  line serializes `objectPermissions` identically (per the standing SDK/platform
  version-matching rule).

## Test plan

1. Unit: extend the delete-flow specs' fake clients? No — they never exercise the real
   permission layer (documented gap; that is why this shipped). Instead add a manifest
   assertion test: built role manifest contains exactly two objectPermissions rows with
   `canDestroyObjectRecords: true` and the correct universal identifiers.
2. Live (local stack): fresh sync (`twenty dev --once`), then as Admin run "Delete
   completely" on a definition WITH a live value field: expect field + companion +
   definition all gone, no error. Repeat for a variation config.
3. Live: re-run on a pre-existing orphaned definition (fields already gone): expect the
   destroy to complete (idempotent re-plan claim above).
4. Live: as a member role without destroy on the app objects, confirm the action still
   denies (intersection working as intended) and the inline error renders.
5. Confirm via Postgres MCP that the `objectPermission` rows exist for the app role
   after sync.

## Deploy

Version bump required (failed installs burn version numbers). Local first; cloud
publish blocked anyway until the v0.5.0 live-test wave completes (see
`verification-reports/2026-08-12-select-live/HANDOVER.md` — git-excluded, not
committed) and the F1 backfill rate-limit no-go is resolved.
