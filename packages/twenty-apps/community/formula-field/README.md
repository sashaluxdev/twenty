# Formula Field

A Twenty **Apps SDK** application that gives any object a "chimeric" formula
field: **reading** the field returns a computed number (API reads, CSV exports,
table cells, filters, aggregations, copy/paste all get the value, because it is
a real native field); **editing** the field means editing a formula
*expression*, not the value. Arithmetic formulas can reference other fields on
the same record and — by record id — fields on other records and objects.

Deep design rationale lives in `docs/adr/*.md`; operational handoff notes live
in `context.md`. This README is the entry point for a developer evaluating or
operating the app.

## What it is

Twenty has no primitive for registering a brand-new field type with custom
read/write renderers (`defineField` can only attach an *existing*
`FieldMetadataType`). So a "chimeric" field is emulated with two real objects
(ADR 0001):

1. A **value field** — a genuine `NUMBER`, `CURRENCY`, `DATE` or `DATE_TIME`
   column on the target object. This is what the UI shows and every read returns.
2. A **FormulaDefinition** record — one per formula — holding the target
   object/field, the expression string, the extracted dependency list, an
   `enabled` flag, operational status, and a last-evaluated heartbeat.

A logic-function evaluation engine keeps the value field in sync with the
formula. "Editing the field" means editing the FormulaDefinition's expression
through a front component on the record page.

### Feature summary

- **Guided "Add formula field" wizard** — pick object → output format (integer /
  decimal / percent / currency / date / datetime) → name; the value field is
  created at runtime via the metadata API, no redeploy (ADR 0008).
- **Output formats** — integer, decimal, percent (all `NUMBER`), currency
  (`CURRENCY`, stored and computed in **micros**, ×1e6), and date / datetime
  (`DATE` / `DATE_TIME`, the Excel serial-date model — **epoch-days**, ADR 0011).
- **Same-record and cross-record references** — read another field on the same
  record, or a field on a specific record of any object by uuid.
- **Manual per-record overrides** — a human editing the value directly pins that
  record; recompute leaves it alone until the override is cleared (ADR 0006).
- **Operational status + FX Status chips** — when an input field is
  deactivated/missing a formula goes OFFLINE; downstream formulas go UPSTREAM.
  A companion SELECT chip surfaces the status right next to the value (ADR 0009).
- **Definition lifecycle** — trashing a definition deactivates its
  wizard-created field (data kept, reversible); restore reactivates and
  recomputes; purge keeps the column deactivated forever (ADR 0009).

## Formula grammar

The engine (`src/engine/`) is a whitelist tokenizer → recursive-descent parser →
tree-walking interpreter. There is no `eval` / `new Function` anywhere. Only the
characters that make up the grammar below are accepted; everything else (`;`,
quotes, backslashes, unicode homoglyph operators, …) is rejected at the exact
offset where it appears.

```
expression := term (('+' | '-') term)*
term       := unary (('*' | '/' | '%') unary)*
unary      := ('+' | '-') unary | primary
primary    := NUMBER | FIELD | CROSSREF | IF | '(' expression ')'
IF         := 'IF' '(' condition ',' expression ',' expression ')'
condition  := expression (compareOp expression)?
compareOp  := '>' | '<' | '>=' | '<=' | '=' | '==' | '!='

NUMBER   := digits ['.' digits]              // e.g. 42, 3.14, .5
FIELD    := ident ('.' ident)*               // same-record dotted path
CROSSREF := '[' object ':' uuidV4 ':' fieldPath ']'
ident    := (letter | '_') (letter | digit | '_')*
```

Binary operators are left-associative; `*` `/` `%` bind tighter than `+` `-`;
unary `+`/`-` bind tighter than binary but looser than parentheses. Arithmetic
binds tighter than comparison: `a + b > c * 2` groups as `(a + b) > (c * 2)`.

### Examples

```
formulaInputA + formulaInputB * 2          same-record fields, precedence
(amount + tax) / 12                        parentheses
amount.amountMicros * 1.1                   dotted path into a CURRENCY composite
100 - discountPercent % 100                 modulo
[company:6a1b…-uuid:employees] * 1000       cross-record ref by record id
amount.amountMicros + [company:…:budget]    mixing same- and cross-record
IF(formulaInputA > 9, formulaInputA + formulaInputB, formulaInputA)
IF(discount, price - discount, price)       numeric condition (0 = false)
IF(a >= 10, 1, IF(a >= 5, 0.5, 0))          nested IF (tiering)
```

A same-record path like `amount.amountMicros` reaches into a composite field;
dependency tracking keys on the **root** segment (`amount`), because update
events report changes at field granularity. A cross-record reference is
`[object:recordId:fieldPath]` where `recordId` must be a UUID v4; it applies to
that specific record.

### IF conditionals (ADR 0010)

`IF(condition, then, else)` — function-call form, exactly 3 arguments, keyword
case-insensitive (`IF` / `if` / `If`). Rules:

- **Comparisons are transient.** `> < >= <= = !=` (`==` is an alias of `=`) are
  legal **only** at the top level of IF's condition slot. A comparison anywhere
  a value is expected — top level, inside arithmetic, in a then/else branch,
  inside a parenthesised comparison operand — is a parse error. Formulas always
  produce `number | null`, never a boolean.
- **Chained comparisons** (`a > b > c`) are a parse error.
- **Truthiness (Excel-style).** A comparison yields true/false; a plain numeric
  condition is allowed with `0` = false and any nonzero value (including
  negatives) = true.
- **Null rules (ADR 0003 consistency).** A null condition, or a null in either
  comparison operand, makes the **entire IF result null**. This deliberately
  deviates from Excel (where a blank cell compares as 0) to match the app's
  null-propagation policy — an empty input never silently becomes a 0.
- **Lazy evaluation.** Only the taken branch is evaluated: an error in the
  untaken branch (e.g. division by zero) never fires. The condition is always
  evaluated.
- **Eager dependencies.** Dependency extraction collects references from the
  condition AND both branches (the untaken branch's inputs can flip the
  condition's outcome next time), so recompute triggers and cycle detection see
  the whole conditional.
- **`if` is a reserved word.** A bare same-record field named `if` is no longer
  expressible (dotted paths like `if.x` still are).

### Dates (Excel serial model, ADR 0011)

Dates are not a separate type — a date simply **is** a number, exactly like
Excel. The internal representation is **fractional days since the Unix epoch**
(1970-01-01 UTC): a `DATE` is a whole epoch-day integer, a `DATE_TIME` is
fractional (`epochMs / 86 400 000`). Everything is plain arithmetic:

```
closeDate + 30                    30 days after the close date
renewalDate - closeDate           the number of days between two dates
startAt + 1 / 24                  one hour after startAt (DATE_TIME target)
IF(signedDate > closeDate,        dates compare as numbers, so ordering
   signedDate, closeDate)         works in an IF condition — picks the later
```

- **Reading.** A `DATE` field (`"yyyy-MM-dd"`) parses to whole epoch-days; a
  `DATE_TIME` field (ISO UTC) parses to fractional epoch-days. Parsing is by
  pattern, so a date-shaped value is understood regardless of its declared type.
  An impossible date (`2026-13-45`) is a `NON_NUMERIC_VALUE` error, never a
  silent NaN.
- **Writing.** A `DATE` **target floors to the whole UTC day** (a date has no
  time) and serializes to `"yyyy-MM-dd"`; a `DATE_TIME` target rounds to the
  whole millisecond and serializes to ISO UTC. So `closeDate + 0.5` on a DATE
  target still writes the same calendar day — use a DATE_TIME target to keep the
  half-day.
- **UTC only.** All conversion is UTC (`Date.UTC` / `toISOString`), never
  local-time math — this is DST-immune and timezone-independent. Near midnight
  this can surprise: `2026-07-03T23:30:00Z` and `2026-07-04T01:30:00+02:00` are
  the **same instant** and floor to the same DATE (the 3rd), even though one
  local wall-clock date reads as the 4th.
- **Silently-wrong types (the honest tradeoff).** Because a date is just a
  number, nonsensical operations are *not* rejected: `birthDate * 2` computes a
  meaningless serial number and, on a DATE target, writes it as some far-future
  date. There is no type system to catch this — the identical tradeoff Excel
  makes, and the price of keeping the engine number-only.

### Value & error semantics (ADR 0003)

- **Field kinds coerce to numbers** (`coercion.ts`): numbers pass through;
  booleans → 0/1; a CURRENCY composite referenced without a sub-path → its
  `amountMicros`; numeric strings parse; DATE / DATE_TIME strings parse to
  epoch-days (Excel serial model, ADR 0011).
- **Null propagates.** A field that exists but is empty resolves to `null`; any
  sub-expression touching a null yields null, and the whole result is null (the
  value field is cleared). This distinguishes "empty input" from "computed 0".
- **Unknown variable** (a field the record does not have) → `UNKNOWN_VARIABLE`
  error (fails loud; likely a typo).
- **Division or modulo by zero** → `DIVISION_BY_ZERO` error; the value is left
  unchanged and the error is surfaced on `lastError`.
- **Non-finite result** (Infinity/NaN) → `NON_NUMERIC_VALUE` error.
- **Cycles are rejected at save time** (ADR 0005). Cycle detection is
  field-granular (object.field nodes, record ids ignored — conservative, can
  only over-report). A cyclic formula is disabled with `CYCLE_DETECTED`.

Error codes: `TOKENIZE_ERROR`, `PARSE_ERROR`, `DIVISION_BY_ZERO`,
`UNKNOWN_VARIABLE`, `NON_NUMERIC_VALUE`, `MAX_DEPTH_EXCEEDED`, `CYCLE_DETECTED`.

### Limits (DoS guards)

Read from `src/engine/parser.ts` and `src/engine/evaluator.ts`:

| Limit | Value | Where |
| --- | --- | --- |
| Max expression length | 2000 chars | `MAX_EXPRESSION_LENGTH` (parser) |
| Max parse recursion depth | 200 | `MAX_PARSE_DEPTH` (parser) |
| Max evaluation depth | 64 | `DEFAULT_MAX_DEPTH` (evaluator) |

The parser caps source length and nesting before the JS call stack can overflow;
the evaluator independently caps AST depth at runtime.

## Architecture

```
                         ┌─────────────────────────────────────────────┐
                         │  FormulaDefinition object (one per formula)  │
                         │  targetObject/Field, expression, deps (JSON),│
                         │  enabled, status/statusReason, heartbeat     │
                         └───────────────┬─────────────────────────────┘
                                         │ save (.created/.updated)
                                         ▼
   pure engine  ◄──── compileFormula ──── save-validation: parse, extract deps,
   (src/engine)      (parse + deps)        reject cycles, (re)enable
        ▲                                        │
        │ evaluate(ast, resolver)                │ recompute
        │                                        ▼
   ┌────┴───────────┐   record IO   ┌────────────────────────────┐
   │  recompute.ts  │◄─────────────►│  dynamic-client.ts (raw    │
   │  value-io      │  (micros)     │  GraphQL over CoreApiClient)│
   └────┬───────────┘               └────────────────────────────┘
        │ writes value field                ▲            ▲
        ▼                                    │ app token  │ user token
   target object records          logic functions      front components
        ▲                                    │            │
        │ triggers                           │            │
   ┌────┴──────────────────────────┐    ┌────┴────────────┴───────────────┐
   │ *.updated / *.created (wildcard)│    │ formula-editor.tsx (record tab) │
   │ formulaDefinition.{created,      │    │ formula-definition-editor.tsx   │
   │   updated,deleted,restored,      │    │   + setup wizard                │
   │   destroyed}                     │    │ convergeFormulaFieldLayout ────►│ viewFields
   │ formula-sweep (hourly cron)      │    └─────────────────────────────────┘
   └──────────────────────────────────┘
                    FormulaOverride object (hidden) — one row per pinned record
                    FX Status companion field (<field>FxStatus SELECT chip)
```

- **Pure engine** (`src/engine/`, ADR 0002) — tokenizer, parser, AST, evaluator,
  dependency extraction, cycle detection, typed errors. I/O-free: all data
  access is delegated to a caller-supplied `VariableResolver`, which makes it
  100% unit-testable and guarantees no dynamic code path.
- **FormulaDefinition object** (`src/objects/formula-definition.object.ts`) — the
  formula record: target object/field/type, currency code, expression, extracted
  dependencies (JSON), `enabled`, `outputFormat`, `createdField` provenance,
  `status`/`statusReason`, and `lastValue`/`lastEvaluatedAt`/`lastError`.
- **Recompute engine** (`src/logic-functions/lib/recompute.ts`, `value-io.ts`,
  ADR 0004) — resolves same- and cross-record inputs, evaluates, and writes the
  value field. Currency reads/writes go through micros; computed values are
  rounded before every comparison so convergence and override detection are
  stable. No-op writes are suppressed (recursion guard).
- **Wildcard record triggers** (`on-record-updated`, `on-record-created`, ADR
  0008) — fire on `*.updated` / `*.created` for any object (object name from
  `payload.objectMetadata.nameSingular`); the app's own objects are skipped.
  Cross-object formulas recompute when a referenced record changes.
- **Definition-lifecycle triggers** (`on-formula-definition-{created,updated,
  deleted,restored,destroyed}`, ADR 0009) — save-time validation on
  create/update; deactivate/reactivate the wizard-created field on trash/restore;
  keep it deactivated and clean up override rows on destroy. Status is always
  recomputed from scratch, so event reordering under retries is harmless.
- **Hourly sweep** (`formula-sweep.ts`) — cron backstop that reconverges every
  enabled formula and its status (catches missed events).
- **Front widgets** — `formula-editor.tsx` (record-page tab: value + editable
  expression with autocomplete + Override toggle) and
  `formula-definition-editor.tsx` (FormulaDefinition record page: setup wizard
  for a fresh draft, else the expression editor). ADR 0007.
- **Dynamic raw-GraphQL client** (`dynamic-client.ts`, ADR 0008) — genql clients
  validate selections against a type map frozen at deploy, so a field created
  after deploy throws client-side. All record IO instead serializes selections
  to raw GraphQL over `CoreApiClient`'s transport, which keeps auth in both the
  logic-function runtime (app token) and the browser (host token bridge).
- **FormulaOverride object** (`src/objects/formula-override.object.ts`, ADR 0006)
  — hidden technical object, one row per (targetObject, targetField, recordId)
  with an `active` flag. Recompute skips active overrides.
- **FX Status companions + layout convergence** (`fx-status-field.ts`, ADR 0009 +
  its 2026-07-03 amendment) — a `<field>FxStatus` SELECT chip next to each value
  field, always active, its VALUE bulk-written server-side (null when healthy,
  OFFLINE/UPSTREAM when broken). Its record-page **visibility** is a viewField
  layout flip converged from the front components (`convergeFormulaFieldLayout`,
  throttled 60s) because viewField mutations reject application tokens. The chip
  viewField is slotted into the anchor value field's `viewFieldGroup` — a
  group-less viewField never renders when the view has groups.

## Limitations (honest)

- **Per-record edit-lock is impossible.** `isUIEditable` is column-level, not
  per-record. Value fields are globally editable; a direct human edit is treated
  as a manual override (detected by comparing the written value to the computed
  value, not by actor — a recompute write inherits the triggering user's id).
- **No inline cell badge.** Apps cannot decorate a native field cell
  (`FieldDisplay` is a fixed internal switch). The override indicator is a toggle
  *inside the widget*, and status surfaces via the separate FX Status column.
- **Layout convergence needs a user-token front-component render.** viewField
  mutations reject application tokens, so the worker can never touch view layout;
  chips become visible only after a widget renders under a user with the VIEWS
  permission. Convergence currently touches record-page Fields views only, not
  index (table) views.
- **Runtime-created fields are not app-owned.** `createOneField` stamps the
  workspace custom application, not this app (the wizard runs under the user
  token). App uninstall will NOT remove wizard-created fields; provenance is
  tracked on `FormulaDefinition.createdField` instead.
- **Recompute is event-driven + hourly sweep, not transactional.** Values
  converge after the triggering event (or within the hour via the sweep); there
  is no read-your-write guarantee inside a single transaction.
- **Currency is stored as micros** (×1e6) end-to-end. Formula math on a currency
  field operates on `amountMicros`; the field is labelled "currency (micros)".

## Runbook

### Local dev environment

- Server on **`http://127.0.0.1:3000`** (not the SDK default 2020); frontend on
  `:3001`. Start: `npx nx start twenty-server`,
  `npx nx run twenty-server:worker`, `npx nx start twenty-front`. Postgres at
  `postgres://postgres:postgres@localhost:5432/default`.
- The CLI runs via the vendored entrypoint (the `.bin/twenty` symlink hit a
  perms issue in this env):
  `node <repo>/node_modules/twenty-sdk/dist/cli.cjs <cmd>`.

### Deploy / build / test

Run from the app dir (`packages/twenty-apps/community/formula-field/`):

```bash
# Deploy/sync to local (build + typecheck + register + sync + regenerate client)
node <repo>/node_modules/twenty-sdk/dist/cli.cjs dev --once

# Uninstall
echo y | node <repo>/node_modules/twenty-sdk/dist/cli.cjs app:uninstall

# Unit + fuzz tests
node <repo>/node_modules/vitest/vitest.mjs run
# (redirect to a file and tail it — background runs sometimes swallow stdout)

# Integration tests (real install → criteria → uninstall; bumps version per run)
node <repo>/node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts

# Lint
<repo>/node_modules/.bin/oxlint -c .oxlintrc.json .
```

Production deploy is out of scope here (local-only). Prod would need
`twenty remote:add --url <cloud> && twenty app deploy --private`.

### API key for scripts

Stored in `~/.twenty/config.json` under `remotes.local.apiKey` (a
workspace-scoped API_KEY JWT). Read it in Node scripts; never mint/forge tokens.

### Common operational situations

- **A formula shows OFFLINE.** An input field it reads was deactivated or is
  missing (`statusReason` names the dead input). Recompute AND override detection
  skip it. Reactivate the input field (or restore the definition that owns it) —
  status heals automatically on the next event or the hourly sweep.
- **A formula shows UPSTREAM.** It reads the target field of an OFFLINE/UPSTREAM
  formula; it keeps computing on frozen inputs but is flagged. `statusReason`
  names where the chain broke. Fix the root OFFLINE formula; UPSTREAM clears on
  reconvergence.
- **FX Status chips written but not visible.** The chip's viewField needs a
  `viewFieldGroupId` (the Fields card only renders grouped viewFields) and a
  front component under a user with the VIEWS permission must render to converge
  layout. Open the record page as such a user; convergence is throttled 60s.
- **Override toggle behavior.** Editing a value field directly pins that record
  (an active FormulaOverride row). Toggle OFF deactivates the override (keeps the
  value) and recomputes; toggle ON restores the last override value and shows an
  "Override value restored" hint. Recompute skips active overrides.
- **Stale widget after a deploy ("No Data" / old code).** The frontend caches
  metadata (including which front-component checksum to load) in IndexedDB
  (`twenty-front-metadata-store`). After `dev --once`, hard-refresh / clear site
  data, or delete that IndexedDB database. This causes most "it doesn't work"
  red herrings — always hard-refresh before judging UI behavior.
- **Re-mint the API key after a DB reset.** The CLI key dies with the DB.
  Re-mint via the auth mutations on `/metadata` (they are on `/metadata`, not
  `/graphql`): `getLoginTokenFromCredentials` → `getAuthTokensFromLoginToken` →
  `getRoles` (Admin id; `createApiKey` requires a `roleId`) → `createApiKey` →
  `generateApiKeyToken`, then write the token to `~/.twenty/config.json`
  `remotes.local.apiKey`. `dev --once` does NOT fire the post-install function
  (only a real install does), so after a reset seed the demo formula manually.
