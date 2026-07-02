# Formula Field — session context / handoff

Read this first. It captures everything a fresh session needs to continue work on
this app without re-deriving it. Written 2026-07-02.

## What this is

A Twenty **Apps SDK** application that gives any object a "chimeric" formula
field: **reading** the field returns the computed value (API, exports, table
cells, copy/paste all get the number); **editing** means editing a formula
expression, not the value. Arithmetic formulas can reference same-record fields
and (by record id) fields on other records/objects.

App lives at: `packages/twenty-apps/community/formula-field/`
Architecture rationale + decisions: `docs/adr/*.md` (read these).

## Current status (what's DONE)

- **Pure formula engine** (`src/engine/`): whitelist tokenizer → recursive-descent
  parser → tree-walking interpreter. No `eval`/`new Function`. Numbers,
  `+ - * / %`, parens, same-record field refs (`amount.amountMicros`), cross-record
  refs (`[object:uuid:field]`). Null propagation, divide-by-zero errors, DoS
  guards (max length/parse depth), runtime max eval depth. Dependency extraction
  + cycle detection.
- **FormulaDefinition object** + index view + nav item + role. One record per
  formula: targetObject, targetField (the value field), expression, dependencies
  (JSON, auto-filled), enabled, lastValue/lastEvaluatedAt/lastError heartbeat.
- **Demo value fields on Opportunity**: `formulaInputA`, `formulaInputB` (inputs),
  `formulaScore`, `formulaCrossScore` (value fields, **editable** — see #2).
- **Recompute triggers**: `opportunity.updated`, `company.updated` (event, low
  latency), hourly `formula-sweep` cron (convergence backstop), no-op write
  suppression (recursion guard). Cross-object recompute when a referenced record
  changes.
- **Save-time validation triggers**: `formulaDefinition.created`/`.updated`
  parse + extract deps + reject cycles (disable + clear error). Runtime cyclic
  exclusion prevents ping-pong storms.
- **post-install**: seeds a demo formula (`formulaScore = formulaInputA +
  formulaInputB * 2`). Idempotent.
- **Front components**:
  - `formula-editor.tsx` — Opportunity record "Formulas" tab: per formula field,
    shows value, editable expression (with autocomplete), and a red/green
    **Override** toggle (feature #2).
  - `formula-definition-editor.tsx` — FormulaDefinition record page editor.
  - `formula-field-input.tsx` — reusable input with **same-record field
    autocomplete** (metadata-driven; label + API name + type; suppressed inside
    `[...]` cross-refs).
- **Feature #2 — manual per-record override** (fully working, verified live):
  - `FormulaOverride` technical object (hidden: no nav/index view) with an
    `active` flag; one row per (targetObject, targetField, recordId).
  - Value fields are **editable**; a HUMAN direct edit is detected by comparing
    the written value to the formula result (NOT actor alone — see the bug note
    below) and recorded as an override. The app's own recompute writes match the
    formula, so they are ignored.
  - Recompute skips **active** overrides. Toggle OFF **deactivates** (keeps the
    value) + recomputes; toggle ON **restores** the last override value and shows
    an "Override value restored" hint.
- **Tests**: 77 unit/fuzz tests (`*.spec.ts`) + a fetch-based install
  integration suite (`src/__tests__/app-install.integration-test.ts`). Lint clean.

## What is NOT done (next work)

1. **#1 — Guided "Add formula field" wizard** (agreed scope, not started):
   a front component to add a formula: pick target object → pick output format
   (**integer / decimal / currency / percent**; NO date handling) → name → the
   app **creates the value field dynamically** via the metadata API (today the
   value fields are static, hard-coded on Opportunity). Formats map to
   `defineField` NUMBER `universalSettings` (`dataType: INT|FLOAT`, `decimals`,
   `type: 'number'|'percentage'`) or a CURRENCY field. Dynamic field creation is
   the enabler and the main new capability.
2. **README** (formula grammar, architecture diagram, limitations, runbook) —
   not written yet (only ADRs + this file exist).
3. **Final acceptance report** demonstrating each mission criterion.
4. **Production deploy** is explicitly out of scope (local-only). Prod would need
   `twenty remote:add --url <cloud> && twenty app deploy --private` — do NOT run.

## How to build / deploy / test (local)

- Server runs on **`http://127.0.0.1:3000`** (NOT the SDK default 2020). Frontend
  on `:3001`. Start: `npx nx start twenty-server`, `npx nx run twenty-server:worker`,
  `npx nx start twenty-front`. Postgres `postgres://postgres:postgres@localhost:5432/default`.
- CLI: run via `node <repo>/node_modules/twenty-sdk/dist/cli.cjs <cmd>` (the
  `.bin/twenty` symlink hit a perms issue in this env).
- **Deploy/sync** from the app dir: `... cli.cjs dev --once` (build + typecheck +
  register + sync + regenerate client). Uninstall: `echo y | ... app:uninstall`.
- **Unit tests**: from the app dir, `node <repo>/node_modules/vitest/vitest.mjs run`.
  (Redirect to a file and `tail` it — background runs sometimes swallow stdout.)
- **Lint**: `<repo>/node_modules/.bin/oxlint -c .oxlintrc.json .`
- **Integration tests**: `... vitest.mjs run --config vitest.integration.config.ts`
  (does a real install → criteria → uninstall; bumps package.json version per run).
- **API key** for scripts: in `~/.twenty/config.json` under `remotes.local.apiKey`
  (workspace-scoped API_KEY JWT for the Apple workspace, valid to 2027). Read it
  in Node scripts; never mint/forge tokens.

## Platform facts & gotchas (learned the hard way)

- **Auth mutations are on `/metadata`, not `/graphql`** (`getLoginTokenFrom...`,
  `createApiKey`, `generateApiKeyToken`). `/graphql` is core (workspace records).
  Errors come back HTTP 200 in `errors[]`.
- **Frontend caches metadata in IndexedDB** (`twenty-front-metadata-store`),
  including which front-component checksum to load. After a `dev --once` deploy, an
  already-open browser tab shows a STALE widget ("No Data" or old code). Fix:
  hard refresh / clear site data, or delete the IndexedDB DB. This caused several
  "it doesn't work" red herrings.
- **Apps cannot decorate a native field cell** (no hook to put a pill/badge next
  to a value in the grid or detail panel). Field rendering is a fixed internal
  `FieldDisplay` switch. So the override indicator is a toggle **inside the
  widget**, not inline. (Verified in frontend source.)
- **`isUIEditable` is column-level, not per-record.** We can't lock/unlock one
  record. Value fields are globally editable; override state is managed via the
  toggle + human-edit detection.
- **Human-edit detection must compare value, not actor.** A recompute write
  triggered by a user's input edit INHERITS that user's `workspaceMemberId` on its
  event, so actor-only detection wrongly created overrides. Fix: on a value-field
  change, only create an override if the written value ≠ the formula's computed
  value (`handle-record-update.ts` magic block + `computeFormulaValueForRecord`).
- **App page-layout tab on a STANDARD object**: use `definePageLayoutTab`
  appended to the standard layout's universal id (`STANDARD_PAGE_LAYOUT
  .opportunityRecordPage`), NOT a competing `definePageLayout` (which isn't
  adopted). Custom objects (FormulaDefinition) use `definePageLayout` directly.
- **Front-component build is lenient**: it did NOT catch an undefined identifier
  (`capitalize`) at typecheck — it surfaced only at runtime. Watch for this.
- **remote-dom sandbox** (front components): `Date` is fine (server logic
  functions too). `input.setSelectionRange`/`focus` may be proxied and throw —
  guard + try/catch. There's a benign React-internal `setSelectionRange` console
  warning on controlled inputs; it doesn't break functionality.
- **genql clients** build queries at runtime from the selection object, so
  referencing a not-yet-synced object/field doesn't fail typecheck.
- CURRENCY fields are micros (×1e6). Soft-deleted records keep unique indexes.

## Key files (by area)

- Engine: `src/engine/{tokenizer,parser,ast,evaluator,dependencies,cycle-detection,errors,index}.ts`
- Objects: `src/objects/{formula-definition,formula-override}.object.ts`
- Value/input fields: `src/fields/opportunity-*.field.ts`
- Recompute + data access: `src/logic-functions/lib/{recompute,handle-record-update,
  handle-formula-change,formula-repository,override-repository,save-validation,
  coercion,with-retry,types}.ts`
- Triggers: `src/logic-functions/{on-opportunity-updated,on-company-updated,
  on-formula-definition-created,on-formula-definition-updated,formula-sweep,
  post-install}.ts`
- Front: `src/front-components/{formula-editor,formula-definition-editor}.tsx`,
  `src/front-components/lib/formula-field-input.tsx`
- Views/layouts: `src/views/`, `src/page-layouts/`, `src/navigation-menu-items/`
- Tests: `src/engine/__tests__/`, `src/logic-functions/lib/__tests__/`,
  `src/__tests__/` (integration). Fake client: `.../lib/__tests__/fake-client.ts`

## Demo data (local, Apple workspace)

- Demo opportunity "Formula Demo Deal" id `910fa0e5-3e7f-465f-8982-251deb902347`
  (used in scratch verification scripts). Demo formula "Opportunity score (demo)"
  = `formulaInputA + formulaInputB * 2` on opportunity.formulaScore.

## Resuming tips

- Verify green before changing anything: unit tests + lint (commands above).
- Small scratch Node scripts against `/graphql` with the config.json api key are
  the fastest way to verify recompute/override behavior deterministically (the UI
  cache makes browser checks flaky). Keep them in the scratchpad, not the repo.
- After any deploy, hard-refresh the browser before judging UI behavior.
