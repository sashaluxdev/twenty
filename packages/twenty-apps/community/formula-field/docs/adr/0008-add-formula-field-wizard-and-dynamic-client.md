# ADR 0008 — "Add formula field" wizard: runtime field creation and the dynamic client

- Status: Accepted
- Date: 2026-07-02

## Context

Feature #1: a guided flow that adds a formula field to ANY object — pick target
object → pick output format (integer / decimal / percent / currency) → name it —
where the app **creates the value field dynamically** via the metadata API
(previously the value fields were static, hard-coded on Opportunity at deploy
time). Three platform constraints shaped the design:

1. Front components cannot invoke app logic functions (no bridge exists in the
   SDK), so the wizard either calls the metadata API itself or routes through a
   trigger-object contortion.
2. `createOneField` is guarded by the `DATA_MODEL` settings permission,
   resolved against the calling application's role.
3. The genql clients (`CoreApiClient` / generated core client) validate every
   selection against a **type map frozen into the bundle at deploy time**. A
   field created after deploy throws client-side ("type `Company` does not have
   a field `wizardBudget`") even though the server schema already knows it.

## Decision

- **Wizard placement**: the FormulaDefinition record-page editor. A fresh
  definition (no `targetField`) renders the guided setup; a wired one renders
  the expression editor. Flow: nav → "Add New" → record page walks you
  through it. No new surface, no new object.
- **The definition record IS the wizard draft.** Every selection persists to
  the record as it is made (`targetObject`, `outputFormat`, `currencyCode`,
  and the typed label → `name`, debounced), and the wizard seeds itself from
  the record on mount — navigating away mid-setup loses nothing, and an
  "orphaned" half-created record is just a resumable draft. The final create
  step is idempotent: if a previous attempt already created the value field +
  FX Status companion pair (interrupted mid-create), the pair is adopted
  instead of colliding. Drafts (targetObject set, no targetField) are
  excluded from the Formulas-tab list.
- **Direct metadata call from the front component**:
  `MetadataApiClient.createOneField` with `{ field: { objectMetadataId, type,
  name, label, settings, isUIEditable: true } }`. The app role adds
  `canUpdateAllSettings: true` to grant `DATA_MODEL`. Format mapping
  (`formula-field-formats.ts`): integer → NUMBER `{dataType:'int', decimals:0,
  type:'number'}`; decimal → NUMBER `{dataType:'float', decimals:2,
  type:'number'}`; percent → NUMBER `{..., type:'percentage'}`; currency →
  CURRENCY (no settings). `dataType` values are lowercase (verified against
  live fieldMetadata rows).
- **`FormulaDefinition.targetFieldType`** (TEXT, `'NUMBER'` default /
  `'CURRENCY'`): recompute must know the value field's shape to select, read,
  and write it. Set by the wizard alongside `targetObject`/`targetField`.
- **Currency semantics — micros end-to-end** (`value-io.ts`): the formula's
  numeric value of a currency field IS its `amountMicros` (consistent with how
  the evaluator already coerces currency inputs and cross-refs). Writes go to
  `{ amountMicros: round(value), currencyCode }` where the code is the
  record's existing code, else the definition's `currencyCode` (picked in the
  wizard, stored on FormulaDefinition, also set as the field's default), else
  **JPY**. The computed value is rounded before every comparison (no-op
  suppression, override detection) or a fractional result would never
  converge.
- **Composite dependencies need explicit sub-selections.** The record API
  does NOT error on a scalar selection of a composite field — it silently
  returns `null`. So a formula reading a CURRENCY input (`amount * 2`)
  null-propagated to nothing on activation, with no error anywhere, until a
  record edit supplied the full payload. The dynamic client therefore exposes
  `fieldKinds(objectName)` (metadata API, 60s cache — note the metadata
  `ObjectFilter` cannot filter by `nameSingular`, so all objects load in one
  query) and the record fetches sub-select every CURRENCY dependency.
- **Wildcard triggers**: `on-record-updated` (`*.updated`) and
  `on-record-created` (`*.created`) replace the per-object
  opportunity/company triggers, deriving the object from
  `payload.objectMetadata.nameSingular` and skipping the app's own objects.
  Wizard-created formulas get low-latency recompute on any object without a
  redeploy; new records compute immediately on creation.
- **Dynamic client** (`dynamic-client.ts`): a `FormulaClient` that serializes
  the engine's genql-style selections to raw GraphQL strings and sends them
  through `CoreApiClient`'s transport method
  (`executeGraphqlRequestWithOptionalRefresh` — typed private, called
  structurally), keeping its auth in both runtimes (env app token in logic
  functions, host token-refresh bridge in the browser). All recompute paths and
  the record-page formula widget use it; static-shape surfaces
  (FormulaDefinition editor, wizard, post-install) stay on the typed genql
  clients.
- **Lifecycle**: a fresh definition is auto-disabled by save-time validation
  ("targetObject is required"). The wizard's target update is inert while
  disabled; saving an expression writes `{ expression, enabled: true }` so a
  valid save (re-)activates and triggers the full recompute.

## Alternatives considered

- **Trigger-object pattern** (front component writes a request record; a
  `.created` logic function creates the field): more moving parts, async error
  reporting, and still needs the same role permission. Rejected since the
  direct call works with the host token bridge.
- **Units (not micros) for currency formulas**: friendlier ("100" means ¥100)
  but inconsistent — currency *inputs* already resolve to micros, and the
  written value would not round-trip through override detection without a
  second conversion convention. Rejected for coherence; the UI labels the
  field "currency (micros)".
- **USD as the currency fallback**: rejected — the wizard offers an explicit
  default-currency picker (JPY preselected) and JPY is the code of last
  resort, per product direction.
- **Redeploy after field creation** (regenerate the genql client): kills the
  wizard's core promise (no developer in the loop). Rejected; hence the
  dynamic client.

## Consequences

- Any object can host formula fields created entirely from the UI; recompute,
  overrides, validation and the heartbeat all work on them immediately.
- The engine no longer depends on the deploy-time genql type map for record IO;
  it does depend on the (stable) transport method of `CoreApiClient` and on
  Twenty's conventional query/mutation naming (`update<Object>`, plurals).
- The serializer only covers the selection shapes the engine emits (scalars,
  composites, `__args` with filters/paging, connections). Enum arguments are
  not supported — the engine does not use them.
- Wildcard triggers fire on every workspace event; per-event work is one
  formula-index load plus dependency checks, acceptable at demo scale and
  bounded by the no-op guards.
