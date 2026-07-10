# ADR 0019: Variation sync mirrors MANY_TO_ONE relations via join column

**Status: IMPLEMENTED (2026-07-10).** Companion plan:
`docs/plans/2026-07-10-relation-mirroring.md`. Extends the record-variations
sync engine (ADR 0009 lifecycle family; sync engine designed 2026-07-07) — it
does NOT touch the formula mirror allowlist (ADR 0006/mirror-kinds).

## Context

Record-variations sync copies a primary record's fields onto its variation
records (design 2026-07-07). Its syncable set (`computeSyncableFields` in
`src/logic-functions/lib/syncable-fields.ts`) was `MIRRORABLE ∪ ENGINE_FAMILY`
kinds minus the label identifier, the config's own pointer relation, and unique
fields. RELATION fields were **silently excluded** — not by an explicit
decision, but because `RELATION` was in neither kind set. A user who set the
account owner on a primary saw it stay stale on every variation, with no error
and no health hint explaining why. DATE mirroring was separately confirmed
working (user ruled its one report a one-off config issue, out of scope here).

The excluded case that matters is the **MANY_TO_ONE owning side**: the record
row physically stores a foreign-key scalar column (`accountOwnerId`) that the
record API reads and writes like any other scalar. The relation itself
(`accountOwner`) is a virtual field with no column of its own. So the mirror
target is not the relation — it is the join column.

### Server evidence (twenty-server, the 2.19 platform line Cloud runs)

Verified in this repo, not assumed from local convenience:

- **`updatedFields` carries BOTH names.**
  `computeUpdatedFieldsFromDiff` (`packages/twenty-server/src/engine/core-modules/event-emitter/utils/object-record-changed-values.ts:47-78`)
  maps a MANY_TO_ONE relation diff key to `[relationName, joinColumnName]`.
  Pinned by `object-record-changed-values.spec.ts:309` ("computes updatedFields
  with both relation field name and join column name" → `['company',
  'companyId', 'name']`). So a relation change on the primary reports e.g.
  `['accountOwner', 'accountOwnerId']`, and the join column is a first-class
  member of `updatedFields` that our event matching already tests against.
- **`properties.diff` keys the RELATION NAME with an `{ id }` shape.**
  `objectRecordChangedValues` (same file, `:80-167`) skips the relation/join
  column in its scalar-diff pass and re-adds it under `field.name` as
  `{ before: { id }, after: { id } }`. We deliberately do **not** consume
  `diff` — sync fresh-fetches the primary — so this shape is irrelevant to us.
- **`properties.after`/`before` carry the raw join-column scalar** (the full
  record after-image includes the FK column), which is exactly what the
  divergence path reads for its echo-race comparison.
- **`joinColumnName` lives under `field.settings`** (a JSON metadata scalar) and
  is present ONLY on the MANY_TO_ONE owning side; the ONE_TO_MANY inverse has
  `joinColumnName: null` (Cloud metadata probed read-only 2026-07-10).

## Decision

**Treat an eligible relation's join column as an ordinary scalar syncable
entry.** `computeSyncableFields` emits, for a `RELATION` field whose metadata
`settings` shows `relationType === 'MANY_TO_ONE'` AND a non-empty
`joinColumnName`, a syncable entry `{ name: '<joinColumnName>', kind:
'RELATION' }` — `name` IS the join column (`accountOwnerId`), not the relation
name. The metadata loader (`metadata-objects.ts`) pulls `settings` and exposes
`relationType`/`joinColumnName` on `MetadataFieldInfo`.

Everything downstream in `variation-sync.ts` then works **unchanged**, because
every path already operates on the FK scalar:

- **GraphQL selection**: `selectionEntryForMirrorKind('RELATION')` falls through
  to the `default` scalar `true` (mirror-kinds.ts untouched), so the join column
  is read as a plain scalar.
- **Event matching**: the join column is a literal member of `updatedFields`
  (server evidence above).
- **Diff / write**: `deepJsonEqual` on the FK string, written back in the batch
  `data` like any scalar.
- **Divergence**: a human re-pointing the relation makes the join column diverge
  from the primary → a pin.
- **Override slot**: `overrideSlotFor` routes every non-`NUMBER` kind to
  `overrideValueText`; an id string JSON-encodes fine.

This was proven end-to-end: five specs (primary-update mirror, null-clear,
override-pin, divergence text-slot, new-variation copy) pass with **zero**
changes to `variation-sync.ts`. The `*.updated` trigger
(`on-record-updated-variations.ts:53`) carries no `updatedFields` filter — it
subscribes to `{ eventName: '*.updated' }` and passes `updatedFields` through
untouched — so join-column names reach the handler unfiltered.

### Why not the formula mirror allowlist (`MIRRORABLE_KINDS`)?

That set is shared with formula mirror-mode via `isMirrorTargetKind`; adding
`RELATION` there would let a formula target a relation field. RELATION support
is confined to `computeSyncableFields` (ADR-level invariant from the plan's
Global Constraints).

## Consequences

- **MANY_TO_ONE relations now mirror** primary → variation by copying the FK
  join column; a cleared relation (`null`) clears on variations too.
- **Override rows for a pinned relation show the COLUMN name** (e.g.
  `accountOwnerId`, not `accountOwner`) in `targetField`, using the JSON text
  slot. This is the same key space the formula feature uses — rows are never
  deleted, and this naming is a deliberate, documented consequence.
- **ONE_TO_MANY inverses stay excluded** (no local FK column —
  `joinColumnName: null`), as does a MANY_TO_ONE relation with an absent join
  column (defensive guard). The config's own pointer relation
  (`primaryRecord`) remains excluded by the existing `relationFieldName` guard —
  a variation is never re-pointed.
- **MORPH_RELATION stays excluded** — its discriminator column needs separate
  handling; deferred backlog. **RICH_TEXT** is a separate latent gap (same
  silent-exclusion mechanism) also left as backlog.
- The join-column name is taken from metadata `settings.joinColumnName`; the
  server derives the same name from the field name
  (`computeMorphOrRelationFieldJoinColumnName`), so event matching and our
  syncable entry agree.

## Not in scope (backlog)

- MORPH_RELATION mirroring (discriminator column).
- RICH_TEXT mirroring.
- Surfacing in the wizard/health hint WHY a field is excluded from sync.
- Cloud deploy (user-gated; Cloud stays on v0.1.4 until approved).
