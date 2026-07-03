# ADR 0009 — Definition lifecycle: field deactivation, OFFLINE/UPSTREAM status, FX Status companions

- Status: Accepted
- Date: 2026-07-02

## Context

"Formula columns are holy": a computed column's values are only meaningful
while its formula lives. Before this ADR, deleting a FormulaDefinition left
the wizard-created value field behind as an ordinary editable column frozen at
stale values — indistinguishable from real data. Administration of computed
fields is centralized, so some blast radius on delete is acceptable, but the
easy action of creating a formula field must stay easy to reverse, and
everything affected by a break must be visibly flagged.

## Decision

A three-step lifecycle ladder plus a two-tier flagging system:

- **Pause** (`enabled: false`, pre-existing): recompute stops, field stays
  visible with frozen values. No flags — pausing is a deliberate user act.
- **Delete (trash)** → the definition's value field + FX Status companion are
  **deactivated** (hidden everywhere, data retained), IF the wizard created
  them (`createdField: true` provenance on the definition) and no other
  definition targets the same field. Fully reversible.
- **Restore** → field reactivated, values recomputed (stale from the time in
  the trash), flags cleared automatically — symmetric with the knockout.
- **Destroy (purge)** → fields stay deactivated forever (the trash
  auto-purges; a purge must never drop a data column); the target's override
  rows are cleaned up (they can never apply again).

**Operational status** (`status` + `statusReason` on FormulaDefinition,
system-managed, recomputed from scratch after every lifecycle event / save /
sweep as a pure function of the dependency graph + field liveness —
`formula-status.ts`):

- **OFFLINE** — an input field is deactivated or missing: inputs are
  physically unfetchable, so recompute AND override detection skip the
  formula. Reason names the dead input (`input company.x is deactivated or
  missing`).
- **UPSTREAM** — the formula reads the target field of an OFFLINE/UPSTREAM
  formula: its inputs exist (frozen), so it KEEPS computing, but it is flagged
  as not working as designed. Reason names where the chain broke (`reads
  company.fb, computed by "B" which is OFFLINE (…)`), nesting one level per
  hop (capped at 400 chars).

**FX Status companion field** (`<field>FxStatus`, SELECT with red OFFLINE /
orange UPSTREAM chips): created inactive (hidden) by the wizard next to every
value field. When a formula breaks, the companion is activated and the status
chip is bulk-written to every record — the warning sits right next to the
stale number in tables and record pages. On recovery, values are cleared and
the field is deactivated again. `isActive` is Twenty's only hide/unhide
primitive, and an inactive field is unwritable, so activation precedes the
bulk write. Both widgets (definition editor, Formulas tab) additionally show a
status banner with the reason.

## Platform facts that shaped the implementation

- **`createOneField` does NOT stamp the calling app**: fields created at
  runtime get the workspace custom application's id (even from the wizard —
  the front-component token resolves to the user), so metadata ownership
  cannot gate the lifecycle. Hence the explicit `createdField` provenance
  flag on FormulaDefinition.
- Soft delete emits `formulaDefinition.deleted` with a full `properties.before`;
  restore emits `.restored`; purge/direct destroy emits `.destroyed`. Three
  dedicated triggers handle them; statuses converge because they are always
  recomputed from current state (event reordering under queue retries is
  harmless).
- Status writes are bookkeeping (added to the recursion guard in
  `handleFormulaChange`) so refreshes never self-trigger.

## Alternatives considered

- **Leave fields active after delete** (status quo): violates "holy" —
  stale computed data masquerades as real. Rejected.
- **Delete fields on destroy**: the trash auto-purges; a background purge
  silently dropping a column is unacceptable. Rejected.
- **Transitive OFFLINE** (cascade the hard status downstream): turns one
  delete into a status storm with hairy recovery ordering; UPSTREAM as a
  distinct advisory tier keeps OFFLINE crisp ("inputs physically gone") while
  still flagging every affected formula. Chosen instead.
- **One shared status field per object**: less schema noise but loses the 1:1
  adjacency between a value column and its flag. Rejected — centralized
  administration accepts the two-fields-per-formula tax.

## Consequences

- Deleting a definition has schema-level blast radius (its column vanishes
  from views/API until restore) — accepted deliberately; reversible.
- Reactivation may not restore a field's position in user views (platform
  behavior); data always survives.
- Formulas pointing at PRE-EXISTING fields (`createdField` false/unset) get
  the full status/flagging treatment but their fields are never touched.
- Each status flip costs one field activation + a bulk write over the target
  object's records (write-avoidant on re-runs).
- Verified live: chain A→B→C; deleting A deactivated its field, flagged B
  OFFLINE + C UPSTREAM (with chain reasons), surfaced chips on all records;
  restoring A healed everything and re-hid the companions.

## Amendment (2026-07-03) — FX Status chips must carry a viewFieldGroupId

The companion chips were bulk-written and their viewField rows were created
visible and correctly positioned, yet they never rendered in the record-page
Fields card. Cause: **the Fields widget renders only viewFields that belong to a
`viewFieldGroup`.** Record-page views are seeded with groups (Deal / Relations /
System); the frontend buckets each viewField by `viewFieldGroupId` and the
backend dataloader drops null-group rows, so a viewField with a null group
matches no bucket and is silently dropped — the ungrouped-fallback path is
unreachable once the view has any group. `position` is also group-scoped (it
sorts within a group), so group membership must be resolved before position is
meaningful.

`ensureFieldLayoutVisibility` (`lib/fx-status-field.ts`) now selects
`viewFieldGroupId` on `getViewFields` and resolves a **desired group** with this
precedence: the anchor value field's group → the row's own existing group → the
view's last visible viewFieldGroup by position (`resolveFallbackGroupId`, where
the platform parks custom fields, e.g. "System"). It passes `viewFieldGroupId`
on `createViewField` and heals wrong/null groups via `updateViewField`. The
companion chip is thus slotted into the same group as its anchor value field at
`anchor.position + 0.5`. Rationale, one line: **a group-less viewField never
renders when the view has groups**, so converging visibility and position is not
enough — group membership must be converged too. Verified live: rows converged
from null to the anchor group on first widget render and the chips render under
their anchor fields.
