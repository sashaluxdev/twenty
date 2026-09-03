# Override marker arc — Task 0 platform probe results

Date run: 2026-09-03 (local dev stack, workspace `20202020-1c25-4d02-bf25-6aeccf7ea419`)

## Status: BLOCKED — no probe was determined

All three probes require the app to be deployed to the local dev workspace
(`twenty apply` / `dev --once`). The deploy cannot get past plan computation on
this environment, so P1, P2 and P3 were never exercised. None of them PASSED and
none of them FAILED — they are **not determined**. This file must not be read as
a gate pass.

- **P1 (app-token `createOneField` with `isUIEditable: false`) — NOT DETERMINED.**
  Blocked before the probe function could be deployed. See "Blocker" below.
- **P2 (where the created field is reachable on the record page) — NOT DETERMINED.**
  Depends on P1 having created the field; never reached.
- **P3 (user-token GraphQL write to an `isUIEditable: false` field) — NOT DETERMINED.**
  Depends on the field existing; never reached.

## Blocker: local DB is 4 minor versions behind the server code

`node node_modules/twenty-sdk/dist/cli.cjs dev --once -r dev` from
`packages/twenty-apps/community/formula-field` fails at the "Computing metadata
plan" step with:

```
Sync failed with error: relation "core.timelineActivityType" does not exist
```

Server-side trace (`~/.twenty-dev-logs/server.log`), error code `42P01`:

```
QueryFailedError: relation "core.timelineActivityType" does not exist
  at WorkspaceFlatTimelineActivityTypeMapCacheService.computeForCache
     (.../flat-timeline-activity-type/services/workspace-flat-timeline-activity-type-map-cache.service.ts:34:51)
  at .../workspace-cache/services/workspace-cache.service.ts:517:22
```

Root cause: the workspace cache recompute needs `core.timelineActivityType`,
which is created by the pending upgrade command
`2-33-instance-command-fast-1787352088649-add-timeline-activity-type-table.ts`.

- Server code version (`TWENTY_CURRENT_VERSION`): **2.35.0**
- Highest upgrade command recorded in `core."upgradeMigration"`: **2.31.0**
- `information_schema.tables` for `core.timelineActivityType`: **0 rows**

So the upgrade commands for 2.32 → 2.35 have never run against this database.
Plain metadata *reads* still work (the Redis cache holds valid entries and the
front loads Companies normally), which is why the stack looked healthy; only the
cache *recompute* that any metadata mutation triggers hits the missing table.

## What is needed before Task 0 can be re-run

1. Bring the local dev database up to 2.35.0 (`upgrade` command, **without**
   `--dry-run`, and not via an `nx` target — see the hazards below).
2. Restart the dev server and worker (both are down, see hazard 2).

Once metadata mutations work, Task 0 is a clean re-run: recreate
`src/logic-functions/probe-marker-field.ts` from the task brief (a fresh UUID was
generated for it: `8e8e6274-03a7-4c51-8448-38c8e32cc1ac`), deploy with
`dev --once -r dev`, and invoke it directly with
`dev:function:exec -n probe-marker-field -r dev` rather than waiting on the cron.

## Hazards discovered while diagnosing (record these)

1. **`upgrade --dry-run` is not read-only.** It suppresses only the *workspace*
   commands. Instance commands — including *slow* ones, with no `--include-slow`
   flag — execute for real and are recorded as `completed`. A dry run on this
   database applied five 2.31.0 instance commands: created
   `core.billingCreditGrant`, added columns to `core.applicationVariable` /
   `core.billingSubscription` / `core.application`, backfilled credit balances,
   and encrypted 13 empty rows in `core.applicationRegistrationVariable`.
   The run then aborted at the 2.31 → 2.32 boundary:

   ```
   Cannot run instance step: workspace 20202020-1c25-4d02-bf25-6aeccf7ea419 has not
   completed "2.31.0_TrimMessageCampaignRecordPageCommand_1786456707000"
   (cursor: "2.31.0_EncryptEmptyApplicationVariablesSlowInstanceCommand_1786533438000",
    status: "completed")
   ```

   That abort is an artifact of dry-run mode itself: workspace commands are
   skipped, so the workspace segment never completes and the next instance
   segment is refused. A real (non-dry) run should pass this gate.

2. **`npx nx run twenty-server:command` kills a running dev stack.** The target
   pulls in `build`, whose first step is `rimraf dist`. The `nest start --watch`
   server and worker both run out of `dist`, so both died instantly with
   `Cannot find module '.../dist/main'` and
   `Cannot find module '.../dist/queue-worker/queue-worker'`. `dist` was
   rebuilt by the same run, but the watchers do not re-spawn a crashed child —
   touching `src/main.ts` produced `Successfully compiled src/main.ts with swc`
   and no restart. The stack needs an explicit restart. Run server commands
   against an already-built `dist` (e.g. `yarn command:prod <cmd>` from
   `packages/twenty-server`) instead of through the `nx` target when a dev stack
   is live.

3. The local instance has **2 workspaces**, and the server warns about it:
   `2 workspaces found in database. In single-workspace mode, there should be
   only one workspace. The Apple seed workspace will be used as fallback`. The
   upgrade iterates over both.
