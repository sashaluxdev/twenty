# Record variations — design

Approved decisions (user, 2026-07-07 chat): variation-link architecture (one
per-object config + a `primaryRecord` relation, NOT one-definition-per-field);
sync rides the field-mirroring passthrough machinery (landed 2026-07-06); all
syncable fields sync by default (name/label field excluded); single level
only (no variation-of-variation); primary deletion freezes variations; one
dual-role record-page widget. Depends on: field mirroring (shipped), the
`FormulaOverride` mechanism (ADR 0006), `deepJsonEqual`, `fieldKinds`
sub-selection machinery.

## Problem

Users want to spin off a "variation" of a record: a sibling record of the
same object whose fields stay automatically synced to the original
("primary") until a field is individually edited. Edited fields diverge and
stay pinned (visible as overrides); everything else keeps following the
primary. Today the app has no per-record scoping (a FormulaDefinition writes
every record of its object) and no per-record source resolution (cross-record
mirrors embed one fixed record ID) — variations need both.

## Core concept: the variation link

A per-object opt-in creates a `primaryRecord` RELATION field (MANY_TO_ONE,
self-referencing) on that object. **Any record with a non-null
`primaryRecordId` IS a variation** of the record it points to; records with a
null pointer are primaries (or plain records) and are never written by
variation sync. The relation is simultaneously the data model, the per-record
scope, and the per-record source pointer.

Variation sync is NOT a set of FormulaDefinitions. It is a parallel per-object
concept that reuses the same plumbing: mirror-style typed raw passthrough per
field, `deepJsonEqual` no-op suppression, `FormulaOverride` rows for
per-field-per-record divergence, the wildcard record triggers, and an hourly
convergence sweep.

## Data model

New app custom object **`VariationConfig`** (one row per enabled object,
modeled on FormulaDefinition):

- `name` TEXT — deterministic key = target object name (uniqueness anchor).
- `targetObject` TEXT — object name (same convention as FormulaDefinition).
- `relationFieldName` TEXT — name of the created relation field
  (`primaryRecord` by default; stored explicitly, never re-derived).
- `createdRelationField` BOOLEAN — provenance flag (createOneField does not
  stamp the app; same pattern as `FormulaDefinition.createdField`).
- `enabled` BOOLEAN.
- `lastSyncedAt`, `lastError`, `status`/`statusReason` — heartbeat/diagnostic,
  same posture as FormulaDefinition.

Overrides reuse **`FormulaOverride` unchanged** — same
`(targetObject, targetField, recordId)` key, same `overrideValue` (engine
family) / `overrideValueText` (mirror kinds) split, same `active` toggle. An
active override means "hand-pinned, nothing touches this field on this
record" for formulas and variation sync alike; no schema change needed.

## Syncable-field set

Computed per object at sync time from `loadAllObjectsWithFields` /
`fieldKinds` (cached):

- Kind ∈ `MIRRORABLE_KINDS` ∪ engine family (NUMBER, CURRENCY, DATE,
  DATE_TIME). Copy is same-kind raw passthrough for all of them (composites
  use `selectionEntryForMirrorKind` / `value-io` sub-selections — never
  scalar-select a composite).
- EXCLUDED: the object's label-identifier (name) field — variations must stay
  distinguishable; the `primaryRecord` relation itself; all RELATION /
  MORPH_RELATION / ACTOR / RICH_TEXT / POSITION / TS_VECTOR / system /
  non-writable fields (same exclusions as the mirror allowlist);
  **any field targeted by an enabled FormulaDefinition on that object** —
  formulas apply to variations like any record and compute from the
  variation's own (synced) inputs; variation sync writing the same column
  would fight the formula. Formula wins; the two write sets are disjoint by
  construction.

New fields added to the object later are picked up automatically (the set is
recomputed from metadata, never persisted).

## Sync semantics

- **Primary updated** (`*.updated` wildcard): if the object has an enabled
  config and the record is a primary (null pointer), find its variations via
  `findMany` filter `{ [relationFieldName]Id: { eq: recordId } }` (standard
  Twenty FK filter — confirmed supported by the dynamic client's generic
  serializer). For each variation: copy the changed syncable fields whose
  override is not active, ALL in **one `update<Object>` mutation per
  variation** (unlike per-definition recompute, sync owns many columns and
  batches them). `deepJsonEqual` per field; zero changed fields → zero
  writes. This scopes fan-out to the changed primary's own variations —
  explicitly avoiding the m5 "recompute the whole object" cliff.
- **Variation created** (`*.created` with non-null pointer): full initial
  sync of all syncable fields (covers API-created variations; the widget's
  create path relies on this same handler rather than duplicating sync
  client-side).
- **Variation updated by a human**: per changed syncable field, mirror-style
  divergence detection (same compare-value-not-actor rule and echo-race guard
  as `handle-record-update`'s mirror branch): fresh-fetch the primary's
  value; written value equals it → app echo, ignore; differs and
  `actorWorkspaceMemberId` present → `upsertOverride` (numeric or text slot
  by kind family). API-key writes never create overrides (existing posture).
- **Hourly sweep**: per enabled config, page variations
  (`{ [relationFieldName]Id: { is: NOT_NULL } }`), re-sync all fields
  skipping active overrides, per-record fault isolation, one heartbeat at the
  end — the formula-sweep pattern.
- **Re-sync a diverged field**: deactivate the override (keep value) and
  immediately re-copy from primary — the existing toggle-OFF flow, driven
  from the variation widget.

## Freeze on primary delete (NEW semantic — not null-propagation)

Existing precedent for a missing cross-ref record is silent null-propagation.
Variations deliberately deviate: if the primary is trashed or destroyed
(fetch returns null, or `deletedAt` set), sync **skips the variation
entirely** — no writes, values stay as they were. The widget shows a
"primary deleted" state (queries the primary including trashed). Restoring
the primary resumes sync on the next trigger/sweep, converging naturally.
No status machinery beyond the config heartbeat; freeze is a per-fetch
decision, not stored state.

## Single level only

A variation cannot be a primary:

- Creation guard: the widget hides "Create variation" on records with a
  non-null pointer; the create path re-checks server-side (reject if the
  chosen primary itself has a non-null pointer).
- Sync guard: when handling a primary update, records that themselves have a
  non-null pointer are never treated as primaries (the variation lookup
  already only matches direct children); if a variation's primary turns out
  to have its own pointer (data raced in via API), sync skips it and records
  a statusReason on the config.
- Self-reference (`primaryRecordId == id`) rejected at creation and skipped
  in sync.

## Per-object opt-in flow

Follows the FormulaDefinition pattern: `VariationConfig` gets a nav item,
index view, and its own record-page editor front component (deploy-time
`definePageLayout`, same as formula-definition-editor). Creating a config =
a small wizard: pick target object → the app `createOneField`s the
`primaryRecord` RELATION field (via `relationCreationPayload` — same
MetadataApiClient mutation shape the formula wizard already uses three
times) → sets `createdRelationField: true` → places the variation widget on
that object's record page via the `ensure-formula-tab` runtime pattern
(idempotent tab-by-title check, resolve runtime front-component id from its
universal identifier, `createPageLayoutTab` + `createPageLayoutWidget`).

Disable (`enabled: false`) → sync stops, relation + values + overrides stay.
Trash → same as disable (no field mutation; matches definition lifecycle).
Destroy → deactivate the relation field only if `createdRelationField` and
nothing else uses it. Override rows are left in place: they are keyed per
`(object, field, record)` with shared pin semantics, and a formula created
later may legitimately own the same key, so surgical deletion is unsafe
(documented consequence; matches the "shared-target" caution in the
definition lifecycle).

## Widget (dual-role, one front component)

`variation-widget.tsx`, placed on the enabled object's record page:

- **On a primary** (null pointer): "Create variation" button + list of this
  record's variations (name + diverged-field count, links). Create = one
  `create<Object>` via the dynamic client with `primaryRecordId` set and
  name `"<primary name> (variation)"` (numbered on collision); the
  `*.created` handler performs the initial sync.
- **On a variation**: link to the primary (or "primary deleted" frozen
  state), the diverged-field list (active `FormulaOverride` rows for this
  record intersected with the syncable set), and a per-field re-sync action
  (toggle-OFF + immediate copy). Field-level "this is diverged" badges in the
  native grid/detail panel are impossible (apps cannot decorate native field
  cells) — the widget is the sole surface, same constraint the override
  toggle lives with today.
- Role detection: read the current record's pointer via the dynamic client;
  unconfigured objects never get the widget placed.

## Validation & edge cases

- Config save validation: target object exists, no existing config for it,
  relation field name is a safe identifier and doesn't collide with an
  existing field (unless resuming), object actually has ≥1 syncable field.
- Echo race on rapid primary edits: same superseded-write guard as mirror
  detection (compare stored vs event value before acting).
- IndexedDB metadata cache: after opt-in, the relation field/widget needs a
  hard refresh in already-open tabs — reuse the wizard's snackbar nudge.
- Frontend cannot lock diverged/synced fields (`isUIEditable` is
  column-level) — editing synced fields on a variation is allowed and simply
  creates an override; that IS the feature.

## Testing

- Unit (vitest, fake-client fixtures like recompute tests): syncable-set
  computation (kind matrix, name-field/formula-target/relation exclusions);
  sync planner (primary change → per-variation batched write set, override
  skips, no-op suppression); initial-sync-on-create; divergence detection
  branches (echo, superseded write, human edit, api-key actor); single-level
  and self-reference guards; freeze on trashed primary (no writes); sweep
  pagination + fault isolation.
- Live verify (dev instance, seeded workspace): enable variations on
  Company; create a variation from the widget; edit primary → variation
  follows; edit variation field → override row appears, widget lists it;
  re-sync toggle converges; trash primary → variation frozen, widget state;
  restore primary → sync resumes.

## Out of scope (explicit)

Variation chains (variation-of-variation); cross-object variations; per-field
sync opt-in/opt-out configuration; syncing RELATION/ACTOR/RICH_TEXT fields;
merging a variation back into its primary; bulk "create N variations";
native-grid divergence badges (platform constraint); per-record formula
overrides (separate backlog item in context.md — shares the FormulaOverride
substrate but is an independent feature).
