# Formula Field — session context / handoff

Read this first. It captures everything a fresh session needs to continue work on
this app without re-deriving it. Written 2026-07-02; updated 2026-07-04 after
the build-pipeline roadmap completed (TODAY() ADR 0012 + drag-to-reorder ADR
0013 landed, whole-branch audit clean).

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
- **Demo value fields on Opportunity — REMOVED 2026-07-03** (production-clean
  install for the live-workspace dry run): the static `formulaInputA`/
  `formulaInputB` inputs and `formulaScore`/`formulaCrossScore` value fields
  (`src/fields/opportunity-*.field.ts`) and their static "Formulas" page-layout
  tab are gone. A fresh install now creates NO fields on any workspace object;
  value fields are created at runtime by the wizard (#1), which also adds the
  record-page "Formulas" tab dynamically via `ensure-formula-tab.ts`. Test
  fixtures still use those field names as arbitrary strings.
- **Feature #1 — guided "Add formula field" wizard** (fully working, verified
  live in the browser AND via scripted E2E; see ADR 0008):
  - Lives in `formula-definition-editor.tsx`: a fresh definition (no target
    field) renders `lib/formula-setup-wizard.tsx` — pick object → format
    (integer / decimal / percent / currency) → name (camelCase API name
    derived live, collision-checked) → **creates the value field at runtime**
    via
  - **Resumable**: the definition record IS the draft — selections persist as
    made (targetObject / outputFormat / currencyCode / name), the wizard seeds
    from the record on mount, and the create step adopts an existing
    field+companion pair from an interrupted attempt instead of colliding.
    `MetadataApiClient.createOneField` (role now has `canUpdateAllSettings`
    for the DATA_MODEL guard), wires targetObject/targetField/targetFieldType,
    then the expression editor takes over.
  - Format mapping in `lib/formula-field-formats.ts` (lowercase `dataType`:
    'int'/'float'; percent = `type:'percentage'`; currency = CURRENCY field,
    no settings). New FormulaDefinition field: `targetFieldType`
    ('NUMBER' default | 'CURRENCY').
  - **Currency = micros end-to-end** (`lib/value-io.ts`): read composite →
    amountMicros; write `{amountMicros: round(v), currencyCode}` with code
    fallback existing-on-record → FormulaDefinition.currencyCode (wizard
    picker, **JPY default**; also the created field's defaultValue) → JPY;
    computed values are rounded before ALL comparisons (convergence + override
    detection). Unit-tested incl. fake-client currency recompute.
  - **Composite (CURRENCY) dependency fields need sub-selections when
    fetching**: the record API silently returns NULL (no error!) for a scalar
    selection of a composite — formulas reading currency inputs computed
    nothing on activation until this was fixed. The dynamic client exposes
    `fieldKinds(objectName)` (metadata API, 60s cache); recompute sub-selects
    CURRENCY deps in same-record and cross-record fetches.
  - **Dynamic client** (`lib/dynamic-client.ts`): genql clients validate
    selections against a type map FROZEN at deploy — fields created after
    deploy throw client-side. So all record IO (logic functions + the
    formula-editor widget) goes through a raw-GraphQL serializer over
    `CoreApiClient`'s private-but-callable transport
    (`executeGraphqlRequestWithOptionalRefresh`), which keeps auth in both
    runtimes. Static-shape surfaces (definition editor, wizard, post-install)
    stay on typed genql.
- **Definition lifecycle + operational status (ADR 0009, verified live)**:
  - Delete (trash) a definition → its wizard-created value field + FX Status
    companion are DEACTIVATED (data kept; guard: `createdField: true`
    provenance on the definition + no other definition targets the field).
    Restore → reactivate + recompute + auto-heal. Destroy/purge → fields stay
    deactivated forever, override rows cleaned up. Triggers:
    `on-formula-definition-{deleted,restored,destroyed}.ts`, shared lib
    `lib/handle-definition-lifecycle.ts`.
  - `status`/`statusReason` on FormulaDefinition (system-managed, recomputed
    from scratch by `lib/formula-status.ts` after every lifecycle/save/sweep):
    OFFLINE = input field dead → recompute + override detection SKIP it;
    UPSTREAM = a formula up the chain is broken → keeps computing, flagged.
    Reasons name the dead input / the break location.
  - FX Status companion (`<field>FxStatus` SELECT, red OFFLINE / orange
    UPSTREAM): companion field stays ALWAYS ACTIVE; what toggles is LAYOUT
    visibility of its viewField rows (`lib/fx-status-field.ts`). Server-side
    sync only bulk-writes chip VALUES (null when healthy) to all records; the
    front widgets converge layout (`convergeFormulaFieldLayout`, throttled 60s)
    because viewField mutations reject application tokens. Layout convergence
    now includes GROUP MEMBERSHIP: the companion viewField is slotted into the
    anchor value field's viewFieldGroup (float position anchor+0.5), healing
    null/wrong groups; without a group the row never renders (see gotchas).
    **Verified live rendering**: chips appear under their anchor value fields in
    the record-page Fields card (Level 2 → "Offline", Level 3 → "Upstream
    break"). Both widgets also show status banners.
  - **`createOneField` does NOT stamp our app** — runtime-created fields get
    the workspace custom application id (wizard runs under the user token), so
    app uninstall will NOT remove them and metadata ownership can't gate
    anything; provenance lives in `FormulaDefinition.createdField`.
- **Recompute triggers**: wildcard `*.updated` (`on-record-updated`) and
  `*.created` (`on-record-created`) — any object, incl. wizard targets; the
  old per-object opportunity/company triggers are DELETED. Object name comes
  from `payload.objectMetadata.nameSingular`; app-owned objects are skipped.
  Plus hourly `formula-sweep` cron (convergence backstop) and no-op write
  suppression (recursion guard). Cross-object recompute when a referenced
  record changes.
- **Save-time validation triggers**: `formulaDefinition.created`/`.updated`
  parse + extract deps + reject cycles (disable + clear error). Runtime cyclic
  exclusion prevents ping-pong storms.
- **post-install — REMOVED 2026-07-03** (production-clean install for the
  live-workspace dry run): the hook only seeded a demo formula, so with the
  demo fields gone it had no legitimate job. The trigger + `post-install.ts` +
  its manifest wiring are deleted; the SDK does not require a post-install hook.
  A fresh install now writes NO record data. First formula = the wizard.
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
- **Wizard format parity + safely-editable config + hardening (2026-07-03,
  verified live)**: wizard exposes every native field option (number/short/
  percent decimals; currency Short/Full + decimals + code; date/datetime
  display format incl. Custom Unicode) — shapes match the native settings UI
  exactly (server does NO settings validation for these types, so parity =
  editability later). All choices persist on `targetFieldSettings` (TEXT JSON)
  for wizard resumability. Definition editor gains a "Field settings" section:
  label editable (always writes `isLabelSyncedWithName:false` so the API name
  can't drift), API name locked, format options editable. Record-page
  expression save is now a two-step all-records confirm (host
  openCommandConfirmationModal can't gate — it discards the result — so it's
  inline). Post-create snackbar nudges refresh (SSE-staleness mitigation;
  README documents the platform limit; GH issue drafted at
  ~/twenty-metadata-staleness-issue-draft.md).
  **Audit fixes** (independent Fable review, graded B→ addressed): M1 GraphQL
  identifier-injection guard in dynamic-client serializer + save-validation
  target-name check (role canUpdateAllSettings KEPT — needed server-side by
  setFieldActive); M2 integer-format rounding (was: `x/3` on an int field
  errored forever); M3 heartbeat write-avoidance (no-op recompute = zero
  definition writes); m1 override echo-race hardening (fresh re-read +
  superseded-write guard); m2 UI cycle-check now keys on object+field
  (validate-expression.ts helper); m3 metadata paging via fieldsList (no
  false-OFFLINE truncation); m4 fieldKinds cache workspace-keyed. Remaining
  known: m5 cross-referenced-record recompute recomputes the whole object
  (scaling cliff, not blocking — future batching).
- **Tests**: 301 unit/fuzz tests (`*.spec.ts`) + a fetch-based install
  integration suite (`src/__tests__/app-install.integration-test.ts`). Lint clean.
- **Roadmap COMPLETE as of 2026-07-04** (items 1-5 below all DONE; branch
  audited whole — final review verdict READY TO MERGE, no Critical/Important
  findings).
- **HARDENING PASS (2026-07-04, ADR 0014 + 0015, spec in repo
  docs/superpowers/specs/, final audit READY TO CLOSE, 10/11 gauntlet PASS)**,
  cross-referenced against core twenty-front's design philosophy:
  - **Drag gesture**: pointer events replace mouse events (touch/pen unified);
    8px activation distance (core's DndKitSensors constant — clicks never
    write); drop-outside/pointercancel = SILENT CANCEL, zero writes, load()
    revert (core's no-destination semantics; supersedes commit-on-leave);
    **fractional midpoint positions** — a drop writes ONE row
    (`computeDropWrite`: (prev+next)/2, edge±1), full 0..N−1 reindex demoted
    to normalization fallback (null/duplicate/NaN neighbors, float precision
    exhaustion). `order` is now an opaque float line — nothing may assume
    contiguous integers. Core-language visuals (tint+border while dragging,
    muted ⋮⋮ grip, grab/grabbing cursors).
  - **TODAY() staleness**: engine `usesToday` walker; heartbeat carve-out
    (no-op outcome + TODAY formula + lastEvaluatedAt >1h → refresh
    lastEvaluatedAt alone; NaN-safe parse; M3 write-avoidance intact
    otherwise); widget shows muted orange `Formula last evaluated {relative}`
    (definition-level framing, `formatRelativePast` replicates core's
    beautifyPastDateRelativeToNow format) when enabled + usesTodayFlag +
    >2.5h, and SELF-HEALS the viewed record via front-runtime
    recomputeForRecord (60s throttle) — **verified live with the worker
    DEAD**: value corrected in ~1-2s, zero worker involvement. Note persists
    while the pipeline is down (deliberate: it reports definition-level
    health; other records stay stale until the sweep returns).
  - **Lockdown**: `isUIEditable: false` on the 8 system-managed
    FormulaDefinition fields (order, dependencies, lastValue, lastError,
    lastEvaluatedAt, status, statusReason, createdField) — UI read-only,
    API/logic-function writes unaffected.
  - **KNOWN LIMITATION (user-accepted 2026-07-04): touch drag is
    non-functional** — remote-dom SerializedEventData exposes no
    `event.target`, so implicit touch pointer capture can't be released from
    app code; touch arms but the preview never moves, zero writes (safe).
    Mouse/pen fully verified. Real fix = renderer-package change. See ADR
    0014's corrected Consequences.
  Awaiting user verification + next design inputs.

## What is NOT done (next work)

**Build pipeline (user-approved order, 2026-07-03):**

1. ~~**"Delete Completely"**~~ DONE (committed 0fa3051aae, verified live):
   danger-zone button in the definition editor destroys the definition record
   AND its wizard-created value/companion fields (guards: `createdField`
   provenance + no other definition targets the field; type-"Delete"
   confirmation; `lib/delete-definition-completely.ts`, injectable clients).
   Platform facts: `deleteOneField` needs no isActive precondition; hard
   destroy emits ONLY the `destroyed` event; destroyed-trigger tolerates
   pre-deleted fields.
2. ~~**IF/THEN conditionals**~~ DONE (ADR 0010, 35 new tests): `IF(cond,
   then, else)` function-call form, keyword case-insensitive (`if` is now a
   reserved word). Comparisons (`> < >= <= = == !=`, `==` normalized to `=`
   at tokenize time) are TRANSIENT — legal ONLY at the condition's top level
   (even `IF((a > b), 1, 0)` is rejected: parens are a value context), so the
   engine value domain stays `number | null` and the write/convergence/
   override stack is untouched. Excel truthiness for numeric conditions
   (0 = false, nonzero = true); null condition or null comparison operand →
   whole IF result null (ADR 0003 consistency; deliberate deviation from
   Excel's blank=0). Lazy branch evaluation (untaken-branch errors never
   fire), EAGER dependency extraction (condition + both branches); cycle
   detection unchanged. Editor autocomplete suggests `IF(`.
3. ~~**Date handling — Excel serial-number model**~~ DONE (ADR 0011, 29 new
   tests, verified live): dates ARE numbers (fractional days since Unix epoch
   1970 UTC, NOT Excel's 1900). Engine untouched; `lib/date-serial.ts` is the
   single conversion chokepoint; coercion parses DATE `"yyyy-MM-dd"` /
   DATE_TIME ISO → epoch-days BY PATTERN (naive datetimes without a tz
   designator are REJECTED — Date.parse would read them as local time);
   value-io serializes per targetFieldType, FLOORING to whole UTC days for
   DATE targets. The comparison sites needed NO edits — both already funnel
   through normalizeStoredValue/normalizeComputedValue (the micros funnel).
   Wizard offers Date / Date & time formats; autocomplete suggests date
   fields; widget renders dates not serials. `overrideValue` NUMBER column
   stores epoch-days as-is. Verified live: `closeDate + 30` correct and
   convergence-stable on real opportunities, null propagation, human-edit
   override on a date target (create/skip/toggle-off-recompute), and Delete
   Completely cleanup (note: destroyed-trigger override cleanup is a
   SOFT-delete of override rows). `date * 2` is silently-wrong Excel-style
   (documented tradeoff). Duration helpers like `days(n)` remain optional
   polish.
4. ~~**Drag to reorder Formula-tab fields**~~ DONE (ADR 0013, 13 new tests,
   verified live incl. Playwright drag both directions + poll-race hold):
   pointer-event sortable list in `formula-editor.tsx` — native HTML5 DnD is
   NOT in the remote-dom allowlist, so: handle `onMouseDown` arms
   `draggingRef` (sync) + `draggingId` (render), row `onMouseEnter` live-
   reorders the preview, container `onMouseUp`/`onMouseLeave` persists.
   New nullable `order` NUMBER field on FormulaDefinition; sort via pure
   helpers in `lib/reorder-definitions.ts` (`sortByOrder` null→+Infinity
   stable, `movePreview`, `computeReorderWrites` reindex 0..N-1 writing only
   changed rows — all-null lists heal lazily on first drop). The 4s poll
   skips ONLY the definitions write mid-drag (values/overrides keep
   refreshing). Ordering is per-target-object; two-tab concurrent reorder can
   transiently duplicate `order` values (stable sort keeps render
   deterministic; next drop heals — accepted).
5. ~~**TODAY() current-date function**~~ DONE (ADR 0012, 16 new tests,
   verified live: `TODAY() + 100` exact epoch-day match + `IF(closeDate >
   TODAY() + 100, 1, 0)` both branches): reserved nullary function like `IF`
   (bare `today` = parse error; `today.x` dotted paths and `[...:today]`
   crossrefs unaffected). Engine stays PURE: evaluating a today node returns
   caller-supplied `EvaluateOptions.todayEpochDay` (omitted while AST has one
   → UNKNOWN_VARIABLE error); the ONLY production clock read is
   `currentEpochDay()` in `date-serial.ts`, called from
   `computeFormulaValueForRecord`. Dependency-extraction no-op → freshness
   rides the hourly sweep (day rollover caught ≤1h after midnight UTC, no new
   trigger machinery). Autocomplete suggests `TODAY()`.

Then:

5. **Production deploy** is explicitly out of scope (local-only). Prod would need
   `twenty remote:add --url <cloud> && twenty app deploy --private` — do NOT run.
6. Possible polish: surface wizard-created VALUE fields in table (index) views
   automatically — new fields are hidden in views by default, and layout
   convergence currently only touches record-page Fields views;
   currency-in-units input option; duration helpers (`days(n)`) once IF lands.
7. **FUTURE (user-approved concept 2026-07-03, explicitly NOT now): per-record
   formula overrides** — a record-specific expression (e.g. `x * 3` while the
   definition says `x * 2`), marked as unique in the widget. Sketch: add
   `overrideExpression` to FormulaOverride; recompute evaluates it when an
   active row has one; validate at save; UNION per-record expressions' deps
   into the definition's dependency set (over-triggering is safe, no-op writes
   suppressed); precedence rule: value override wins over formula override.
   Est. 2-4 focused agent-days.


README (formula grammar, architecture diagram, limitations, runbook) is now
written at the app root (`README.md`).

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

- **Never name a CLI remote `local`.** The SDK's ConfigService always lists
  `local` as an existing remote (DEFAULT_REMOTE_NAME) even when the config
  file has none, so `remote:add --as local --url ...` takes the
  RE-AUTHENTICATE path, silently DISCARDS `--url`, and falls back to the
  baked-in default `http://localhost:2020` → `ECONNREFUSED` ("Cannot connect
  to Twenty server"). It only ever worked here because the old config.json
  already carried remotes.local with the right :3000 URL. Use any other name
  (e.g. `dev`) and pass `-r dev` to app:publish/app:install.
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
- **The record-page Fields card renders viewFields BY GROUP.** The Fields
  widget buckets viewFields into their `viewFieldGroup` (frontend
  `viewsSelector` matches `viewField.viewFieldGroupId === group.id`; a null
  group matches nothing, and the backend `ViewFieldGroup.viewFields`
  dataloader also drops null-group rows). Record-page views are seeded with
  groups (Deal / Relations / System), so the ungrouped-fallback branch is
  unreachable — **a viewField with `viewFieldGroupId` null is silently
  dropped, however visible/positioned it is.** This is why the FX Status chips
  existed in the DB, positioned correctly, yet never rendered. Two more facts:
  **`position` is GROUP-scoped, not view-global** (it sorts within a group, so
  group membership must be resolved before position means anything); and the
  platform **parks custom fields in the view's last visible group** (e.g.
  "System"), which is the fallback group when there is no anchor to copy from.
  Fix in `ensureFieldLayoutVisibility`: select `viewFieldGroupId`, resolve a
  desired group (anchor field's group → the row's own existing group →
  last-visible group), pass it on create, and heal wrong/null groups on update.
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
- **Native HTML5 drag can still START inside remote-dom** even though the
  drag event family isn't allowlisted for handlers: mousedown-dragging an
  element/text selection fires the browser's native dragstart, which then
  SUPPRESSES mousemove/mouseenter for the whole gesture — silently breaking
  pointer-event drag interactions (most reliably when dragging downward).
  Fix: `event.preventDefault()` in the handle's `onMouseDown`. The
  `draggable` prop is NOT in HtmlCommonProperties and is silently dropped —
  passing `draggable={false}` is documentation, not the fix.
- **remote-dom events carry NO `target`** (`SerializedEventData` in
  packages/twenty-front-component-renderer): anything needing the event's
  element handle — `releasePointerCapture`, `setPointerCapture`,
  `closest()` — is unreachable from app code. Consequence: implicit TOUCH
  pointer capture cannot be released, so touch-drag interactions built on
  cross-element pointerenter are dead on arrival (mouse is unaffected — no
  implicit capture). `clientX/clientY` ARE populated (live-verified) for
  both mouse and touch.
- **Never mix the `border` SHORTHAND with `borderTop`-style LONGHANDS across
  merged React style objects**: React warns and permanently strips the
  border after style switches (e.g. a drag-highlight style reverting to the
  base style). Use 4-side longhands in BOTH styles so every side is
  explicitly overridden and restored.
- **genql clients** build queries at runtime from the selection object, so
  referencing a not-yet-synced object/field doesn't fail typecheck — BUT the
  runtime validates against the type map frozen at deploy, so it THROWS on
  fields created after deploy ("type `Company` does not have a field `x`").
  That's why record IO uses `lib/dynamic-client.ts` (raw GraphQL, ADR 0008).
- **Metadata `Object` type has no `isCustom`** field on the /metadata GraphQL
  API (querying it errors) — use nameSingular/label/isActive/isSystem. And
  the metadata `ObjectFilter` cannot filter by `nameSingular` — fetch all
  objects and filter client-side.
- **Scalar selection of a composite field returns NULL silently** on the
  record API (no GraphQL validation error). Any dynamically built selection
  must know field kinds; never assume an error will surface the mistake.
- **API-key writes carry no `workspaceMemberId`** on their events, so
  override DETECTION never fires for script edits (by design, human-only).
  Verify override mechanics by creating the FormulaOverride row directly.
- **createOneField input**: `{ input: { field: { objectMetadataId, type,
  name, label, settings?, ... } } }`; `settings` is a JSON scalar with
  LOWERCASE `dataType` ('int'|'float'); CURRENCY needs no settings/default.
- CURRENCY fields are micros (×1e6). Soft-deleted records keep unique indexes.
- **`twenty-sdk/ui` crashes the front-component sandbox at runtime**:
  `"Dynamic require of \"react\" is not supported"` — it builds and typechecks
  cleanly, but every reload in both light and dark theme fails to mount the
  whole widget tree (not just the sdk/ui markup), reproduced via a spike
  (`.superpowers/sdd/ui-spike-verdict.md`). Avoid importing `twenty-sdk/ui`
  from any front component; use `@emotion/styled` replicas driven by
  `var(--t-*)` tokens instead (see `src/front-components/lib/ui.ts(x)` and the
  call-recorder app's `recording-theme-css-variables.ts` pattern) — emotion's
  `<style>` tags stream to the host fine (`:hover`/`:focus`/transitions work)
  and CSS vars repaint on theme toggle with zero JS.

## Key files (by area)

- Engine: `src/engine/{tokenizer,parser,ast,evaluator,dependencies,cycle-detection,errors,index}.ts`
- Objects: `src/objects/{formula-definition,formula-override}.object.ts`
- Value/input fields: created at runtime by the wizard, not in the repo (the
  static `src/fields/opportunity-*.field.ts` demo fields were removed 2026-07-03)
- Recompute + data access: `src/logic-functions/lib/{recompute,handle-record-update,
  handle-formula-change,handle-definition-lifecycle,formula-status,fx-status-field,
  formula-repository,override-repository,save-validation,coercion,value-io,
  dynamic-client,with-retry,types}.ts`
- Triggers: `src/logic-functions/{on-record-updated,on-record-created,
  on-formula-definition-created,on-formula-definition-updated,
  on-formula-definition-deleted,on-formula-definition-restored,
  on-formula-definition-destroyed,formula-sweep}.ts`
- Front: `src/front-components/{formula-editor,formula-definition-editor}.tsx`,
  `src/front-components/lib/{formula-field-input,formula-setup-wizard}.tsx`,
  `src/front-components/lib/{formula-field-formats,reorder-definitions}.ts`
- Views/layouts: `src/views/`, `src/page-layouts/`, `src/navigation-menu-items/`
- Tests: `src/engine/__tests__/`, `src/logic-functions/lib/__tests__/`,
  `src/__tests__/` (integration). Fake client: `.../lib/__tests__/fake-client.ts`

## Demo data (local, Apple workspace)

- **Environment was RESET to a fresh seed slate on 2026-07-02** (user request:
  clear accumulated test byproducts). Old demo records/fields
  (Fleet budget, Pet care budget, Fuel efficiency, Formula Demo Deal ids) are
  GONE. Current state: seed data + app installed + one demo formula
  "Opportunity score (demo)" = `formulaInputA + formulaInputB * 2` on
  opportunity.formulaScore (verified: inputs 5/10 → 25 on "Enterprise iPad
  Deployment").
- **`dev --once` does NOT fire the post-install logic function** (only a real
  install does, e.g. the integration test's app:install). After a DB reset +
  dev sync, seed the demo formula manually via createFormulaDefinition (the
  handler's idempotent equivalent).
- After a DB reset the CLI API key dies with the DB. Re-mint via the auth
  mutations on /metadata (getLoginTokenFromCredentials tim@apple.dev /
  tim@apple.dev → getAuthTokensFromLoginToken → getRoles (Admin id; createApiKey
  now REQUIRES roleId) → createApiKey → generateApiKeyToken) and write it to
  `~/.twenty/config.json` remotes.local.apiKey. Script pattern in scratchpad
  (`mint-api-key.mjs`); current key "claude-dev (post-reset)" expires end 2027.

## FX Status chip rendering — RESOLVED (2026-07-03)

The FX Status layout redesign (always-active companion + layout-based
visibility, `lib/fx-status-field.ts`: `ensureFieldLayoutVisibility` +
`convergeFormulaFieldLayout`, called from BOTH front widgets, throttled 60s,
because viewField mutations reject application tokens so the worker can't touch
layout) is complete and the chips now render live. The final bug — chip
viewField rows existed and were positioned but never appeared in the Fields
card — was **null `viewFieldGroupId`**: the Fields widget only renders
viewFields bucketed into a viewFieldGroup, so group-less rows are silently
dropped (see the group-rendering gotcha under "Platform facts & gotchas").
`ensureFieldLayoutVisibility` now resolves and heals the group (anchor field's
group → own group → last-visible group) alongside visibility and position.
Verified live: rows converged from null to the anchor group on first widget
render; chips render under their anchor fields (Level 2 → "Offline", Level 3 →
"Upstream break") with no console errors. The earlier `isUIEditable`/
`isUIReadOnly` experiment on level2/3FxStatus is reverted in the DB (both
false; wizard default `isUIEditable: false` stands). Test chain on opportunity:
Level 1 (deleted, field deactivated) → Level 2 OFFLINE → Level 3 UPSTREAM;
banners + chip values + statuses all verified correct.

## Resuming tips

- Verify green before changing anything: unit tests + lint (commands above).
- Small scratch Node scripts against `/graphql` with the config.json api key are
  the fastest way to verify recompute/override behavior deterministically (the UI
  cache makes browser checks flaky). Keep them in the scratchpad, not the repo.
- After any deploy, hard-refresh the browser before judging UI behavior.
