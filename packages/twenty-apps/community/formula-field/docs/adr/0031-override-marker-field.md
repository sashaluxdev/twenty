# ADR 0031: Override marker field

**Status: IMPLEMENTED (design approved 2026-09-01/03; implemented 2026-09-03).**
Spec: `docs/superpowers/specs/2026-09-01-override-marker-field-design.md` (v3,
repo root `docs/`). Task 0 platform probe results:
`docs/superpowers/plans/2026-09-01-probe-results.md` (repo root `docs/`).
Supersedes the approved-then-invalidated "override toast" direction described
below.

## Context

An overridden formula value is indistinguishable from a computed one
everywhere except the record-page Formulas tab. Overrides are per-record
state; the app cannot decorate Twenty's native field cells, and no
app-rendered surface mounts automatically when a record is opened.

The design that was approved before this one proposed a toast fired from the
record-page Formulas widget on mount. That direction turned out to be a dead
end: the Formulas tab does not mount on plain record open. `twenty-front`'s
`PageLayoutTabsRenderer.tsx:185-187` renders exactly one
`PageLayoutMainContent`, for `activeTabId`, and the initial active tab is
`tabs[0]` by position while the Formulas tab sits at position 1000. A widget
that only mounts on tab activation cannot fire a toast on record open, so the
one signal the toast direction promised never actually fires for the case
that matters most. This is not a correction of ADR 0021's toast (that one
still fires correctly from a widget already on the page, once it is mounted);
it is a separate, narrower claim about what mounts automatically, and it
killed the marker's original design before any of it was built.

The only per-record surface visible on record open, and in list views, is
record data itself. This ADR's decision: one app-managed, view-only TEXT
field per target object, label `Overrides`, holding the comma-joined labels of
the formula fields currently overridden on that record (for example, "Deal
Score, Tier"), blank when none. It renders as an ordinary field in the record
page Fields card, is addable as a list-view column, and is filterable, so
"records with overrides" views come free.

This is not a revival of ADR 0021's FxStatus chip. That chip cost three
things: one field per formula, render-time layout convergence (viewField
mutations reject application tokens, so the chip's visibility and position had
to be re-converged from a front component on every render or poll), and a
bulk value sync across every record of the target object on each status flip.
The marker is different on all three axes: it is one field per object, not
per formula; it gets no layout convergence at all, since the app does not try
to reveal or position it, the user does that once, like any custom field; and
its value is per-record state that changes only on pin transitions, which are
human-paced, not a bulk sweep triggered by a status change.

## Decision

### Field contract

- API name `fxOverrides`, label `Overrides`, type TEXT, icon `IconPinned`, one
  per target object.
- Created when the object's first override-allowed definition
  (`allowOverride !== false`) is created, not on the object's first pin, so a
  user can position the field in the Fields card before any override exists
  (2026-09-03 user ruling, see "Write paths" below). An object whose formulas
  are all locked (`allowOverride: false`) never receives the field, from
  either the creation path or the sweep.
- `isUIEditable: false` set at creation. This flag is create-time-only:
  `updateOneField` whitelist-drops it (ADR 0028), so it has to be in the
  `createOneField` input, the same convention the app already uses for its
  other system-managed fields.
- Description: "Formula fields currently overridden on this record. Managed
  by the Formula Field app."
- Not a formula target, never appears in any definition's dependency set, and
  invisible to override detection, since detection iterates formula target
  fields only.
- Excluded by name from variation sync's syncable-field set
  (`computeSyncableFields`, server-side, and its front replica
  `countSyncableFields` in `variation-setup-logic.ts`). Without this
  exclusion the marker would qualify on every other test (active, non-system,
  TEXT is in the syncable kind union, not a formula target), and a
  variation's primary-update sync would copy the primary's marker onto every
  variation, overwriting each variation's own correct value; a
  diverging-edit detection pass on it would then mint a stray
  `FormulaOverride` pin keyed on `fxOverrides` itself.
- Counted as formula-managed by timeline cleanup (`loadFormulaManagedByObject`
  in `timeline-cleanup.ts`), alongside `targetField` and
  `companionFieldName`. Without this, every marker write would leave a
  permanent "Overrides changed" timeline row, since the marker is neither a
  formula target nor in the (just-excluded) variation set. Accepted residue:
  that loader only registers objects that still have at least one
  definition, so the final blank-out writes on an object whose definitions
  were all destroyed leave one transient timeline row per record until the
  sweep's cleanup arm deletes the field. Self-limiting, not worth building
  around.
- Derived state, never user-authored: safe to delete or rewrite wholesale.

### Value semantics

The expected marker for a record is computed as:

1. Take the object's **enabled** `FormulaDefinition`s with
   `allowOverride !== false` (a legacy null reads as allowed, matching the
   widget). Enabled-only is deliberate: it lets all three write lanes share
   one definition set at zero extra query cost, since the server lanes'
   loaders already hard-filter `enabled: { eq: true }`
   (`formula-repository.ts`) and the widget already filters its rows to
   `enabled` for its own marker math. Consequence: disabling a definition
   drops its label from markers until it is re-enabled, even though its pins
   still exist and the Formulas tab still shows them; a trashed definition is
   excluded the same way. Gate/frozen status is ignored: a pin on a frozen
   definition is still a pin.
2. Keep the ones whose `targetField` has an active `FormulaOverride` row for
   this record. Joining through definitions this way automatically excludes
   variation-sync pins, which have no backing definition, and stray pins on
   locked definitions, which the server already ignores and reverts (ADR
   0028), so the marker must not report them either.
3. Dedupe by `targetField`, since a delete/recreate can leave two definitions
   targeting one column. Label each as `definition.name || definition.targetField`,
   the app's existing labeling rule (`status-toast.ts`).
4. Sort by `order` ascending, nulls last, then by label, matching the
   Formulas tab's display order. `order` was not previously selected
   server-side; it was added to `FORMULA_FIELDS` in `formula-repository.ts`,
   one extra scalar on a selection that already runs.
5. Join with ", ". An empty set produces `''`, which the platform stores as
   SQL NULL (ADR 0030); the convergence rule below (see "Convergence and
   loop safety") makes that safe.

No truncation: a record cannot have more overridden fields than the object
has override-allowed formulas, and TEXT has no practical limit at that scale.

Known ceiling, documented and not fixed here: the widget loads `first: 100`
definitions unpaginated, while server lanes paginate fully. Past 100
definitions on one object the widget's marker math, and its tab display
already, diverges. A workspace with more than 100 formula definitions on a
single object already has a broken Formulas tab regardless of this feature.

### Write paths

Marker writes always follow the same shape: compute the expected value,
compare it against the current stored value with the TEXT-widened equality
rule (ADR 0030), and write only on a diff. Server-side lanes write under the
app token; the widget lane writes after an explicit user action, under the
user token.

**Field creation (server-side, on first override-allowed definition).**
`upsertOverride` was changed from `Promise<void>` to report whether it
created, updated, or no-opped a pin; that signal is the event lane's gate
(below). Field creation itself hooks the definition **creation** path in
`handle-formula-change.ts`: creation events arrive with
`updatedFields === undefined`, and when that holds, `after.allowOverride !==
false`, and `after.targetObject` is set, the handler calls the ensure helper
(`ensureMarkerFieldExists` in `ensure-marker-field.ts`) before validation
runs. That helper does an uncached `findFields` lookup, since a mutation
needs live state rather than the 60-second catalog, then issues
`createOneField` under the app token. Locked definitions never create the
field, since a locked definition can never carry a pin (ADR 0028 makes the
lock create-time-only). Failure is non-fatal: the hourly sweep's ensure arm
retries the creation for any object that has at least one enabled
override-allowed definition but no marker field, which also migrates
workspaces whose definitions predate this release.

The 2026-09-03 user ruling that produced this design point (creating on
first override-allowed definition rather than first pin) exists so the field
can be positioned in the Fields card up front, before a user ever triggers an
override.

App-token metadata mutation has precedent elsewhere in the app
(`fx-status-cleanup.ts` already runs `updateOneField` and `deleteOneField`
from the sweep, under a role that carries `canUpdateAllSettings: true`), but
no in-app call had exercised `createOneField` specifically under the app
token before this work. Task 0 probed it directly (see below) rather than
assuming.

**Event lane** (`handle-record-update.ts`). The handler has exactly one
return; every skip point is a `continue`, so a marker step appended at the
end runs for both the mirror and engine sub-lanes. The step runs only when:

- this invocation's `upsertOverride` calls report at least one created or
  updated pin, meaning pin state actually changed here, or
- `updatedFields` contains `fxOverrides`, meaning either a direct tamper or
  the echo of the marker's own last write.

The gate never consults `actorWorkspaceMemberId`. An app recompute write can
inherit the triggering user's member id on its event (ADR 0006 observed this
live), so actor presence or absence proves nothing here and is used nowhere
in this gate. Everything else skips free: an app recompute echo upserts
nothing, a human edit that did not pin anything upserts nothing, an edit to
an unrelated field upserts nothing.

When the step runs, it calls `loadActiveOverridesForRecord` (one query,
after the handler's own upserts, so a just-created pin is included) and
computes the expected string from the definitions already in memory. The
current value is read from the event's `after` payload: a `null` key
normalizes to blank; a key **absent** from `after` is treated as unknown, not
assumed blank, and triggers a fetch before comparing. Assuming blank would
fix the expected-blank case but invert the loop in the expected-non-blank
case (blank compared against "Deal Score" writes, the echo still lacks the
key, and it writes forever). This fetch is a defensive cold path: the engine
lane already records TEXT as a plain scalar it trusts from `after`, so the
absent-key case is not expected to be reachable in practice. A missing
marker field on the object (creation still lagging, or the object has only
locked definitions) makes the step skip entirely; the event lane never
creates the field itself.

All of this runs through the shared helper in `marker-converge.ts`
(`convergeMarkerAfterEvent`, calling into `convergeMarkersForRecords`), which
is also what the lifecycle lanes and the sweep call, so the diff-and-write
logic exists in exactly one place. A direct API edit of `fxOverrides` lands
in the second gate arm and is reverted to the computed string.
`on-record-created.ts` never detects overrides, since it passes no actor, so
record creation needs no marker step of its own: a new record has no pins.

**Widget toggle lane** (`marker-toggle.ts`'s `writeMarkerAfterToggle`, called
from `toggleOverride` in `formula-editor.tsx`). Toggling an override off can
converge with no record-value write at all: deactivating the pin, then
recomputing, can produce the same value the pin already held, which the
no-op guard in `recompute.ts` then suppresses, leaving no event for the
marker step to react to. Left alone, that would leave the marker stale for
up to an hour. So after a successful activate or deactivate, the widget
computes the expected marker directly from state it already holds (the
`definitions` filtered to `enabled`, and the current `overrides`, just
mutated) and writes it itself under the user token, with the same diff
guard, then refreshes local display state. All override toggles on the
widget are disabled while any one toggle is in flight (`busy !== null`
gates every row, not just the row being toggled): two concurrent toggles
writing the marker at once would race, and the last writer could drop the
other row's just-created pin from the marker string.

**Definition disable, trash, and destroy** (`handle-formula-change.ts` for
disable; `handle-definition-lifecycle.ts` for trash and destroy). A plain
disable (`changedFields = ['enabled']`, `after.enabled === false`) returns
from `handleFormulaChange` at the earliest disabled-bookkeeping guard,
before any record work runs, so a disabled definition's label would
otherwise sit in markers with no event-lane repair. The marker convergence
hook sits **above** that guard, gated on `after.enabled === false &&
changedFields?.includes('enabled')`, and calls `convergeMarkersForColumn` for
the definition's target column. This deliberately also fires on the app's
own disable-on-cycle write, which is semantically correct since the
definition did leave the enabled set, while the `includes('enabled')` gate
keeps pure bookkeeping writes, which the guard below it exists to absorb,
from paying for the step.

Soft-trash (`handleDefinitionDeleted`) keeps a trashed definition's pins,
since "formula columns are holy," but the definition itself leaves the
enabled set, so its label must leave markers the same way disable does: the
trash handler runs the same enumerate-and-converge step via
`convergeMarkersForColumn`, without deleting anything. A restore brings the
label back on its own next recompute.

Destroy (`handleDefinitionDestroyed`) is where the marker's correctness
requirements exposed three pre-existing defects in the destroy path, which
this work fixed as prerequisites:

- the pin enumeration now selects `recordId`, not only `id`, since the
  convergence step needs record ids in scope;
- the enumeration is paginated (`first: 200` with cursor pagination to
  exhaustion) instead of a single unpaginated page, since more than 200 pins
  on one destroyed column previously under-deleted the rest silently;
- before deleting anything, the handler checks `anotherDefinitionTargets`: if
  another live definition still targets the same column, its pins are
  spared entirely (the handler converges that column's markers instead of
  deleting), since destroying one of two definitions sharing a target field
  must not erase the survivor's pins.

Pin deletion here is Twenty's soft delete (`canDestroyAllObjectRecords:
false` is not grantable for this object), which is why the sweep's dirty-marker
arm (below) still needs to see these records. When the column is not shared,
the handler collects the record ids of every pin it deletes and converges
the marker for exactly those records, using a fresh object-wide pin load, so
the same record's pins on other columns keep counting correctly.

**Hourly sweep backstop** (`marker-sweep.ts`'s `convergeAllMarkers`, wired
into `formula-sweep.ts`). This pass runs after `cleanupCompanionFields` and
before the per-definition recompute loop, with its own 15-second slice of
the sweep's 100-second budget (`MARKER_BUDGET_MS`), so the recompute loop,
which may consume the whole remaining budget, cannot starve the marker pass
and vice versa. The pass is best-effort with no cursor: since the candidate
set shrinks to zero as markers converge, a truncated pass simply finishes
over successive hourly runs.

The pass runs for every object that already has a marker field (from the
60-second-cached catalog), plus objects with at least one enabled
override-allowed definition but no marker field yet, which is the ensure
arm, retrying field creation for objects whose create-on-definition attempt
failed or that predate this release. For an object with the field, two
candidate sources are unioned: record ids from an object-scoped pin query in
**any** active state, since a deactivated row still marks a record that lost
its last active pin, and record ids from a dirty-marker query
(`{ fxOverrides: { is: NOT_NULL } }`, expressible today with precedent in
`variation-sync.ts`; ADR 0030 already establishes that blank TEXT stores as
SQL NULL, so NOT_NULL means "has something to check"). The pin arm alone is
gated on the object having at least one override-allowed enabled definition,
since only such an object can have a non-blank expected marker; the
dirty-marker arm is never gated on definitions, because its entire purpose
is finding records whose marker outlived its cause, including the case where
an object's last enabled definition was disabled or trashed and the
expected marker is now blank for every record on that object. Two record
classes are reachable **only** through the dirty-marker arm: records whose
pins were soft-deleted by a destroy (out of the pin query's scope entirely),
and records on an object with no remaining enabled definitions at all (no
pins to hang the pin arm on).

After the candidate set is built, the pass batch-reads current marker
values, computes the expected value per definition, and writes only on a
diff, through the same shared helper the other lanes use. Finally, a cleanup
arm handles the opposite end of the field's life: an object with zero
definitions left in any state, live or trashed, but a surviving `fxOverrides`
field, gets that field deactivated then deleted, mirroring
`fx-status-cleanup`'s ordering and per-field try/catch. Field discovery here
also rides the shared 60-second-cached catalog, so this arm costs nothing
extra on an object with no definitions at all.

### Convergence and loop safety

The diff guard, not actor detection or any explicit cutoff, is the sole
recursion terminator here, the same argument ADR 0004 makes for value
writes. A marker write refires both wildcard `*.updated` triggers, since the
object is not excluded from them. On the formula lane, the echo's
`updatedFields = [fxOverrides]` passes the event-lane gate, recomputes the
marker from unchanged pin state, compares equal, and stops: one bounded echo
per real marker change, never a cascade. Actor inheritance (ADR 0006) is
irrelevant here because nothing in the gate consults the actor at all. On
the variation lane, the marker is excluded from the syncable set by name, so
`fxOverrides` appearing in `updatedFields` matches nothing there.

The marker is TEXT, so it inherits the same F3 hazard ADR 0030 fixed for
value fields: the platform stores `''` as SQL NULL, and an event payload may
omit the key entirely. Every comparison in this feature goes through
`textValuesConverged` (blank compares equal to blank); `null` normalizes to
blank, and an absent payload key is treated as unknown and fetched, never
assumed, as described above. A converged marker must never rewrite, in
either the blank or the non-blank case.

Override detection cannot mint a pin for the marker itself, since detection
only iterates formula target fields and the marker is never one. A user
**can** write a formula that reads `fxOverrides`, since it is an ordinary
TEXT field; that formula recomputes whenever the marker changes, converging
rather than cycling, since the marker step's own gate ignores value-write
echoes. This is documented as an oddity, not defended against.

## Consequences

- **Enabled-only semantics.** A disabled or trashed definition's overrides
  disappear from the marker until the definition is re-enabled, even though
  its pins and the Formulas tab's own display are unaffected. This was
  chosen so all three write lanes could share one definition set at zero
  extra query cost; the alternative (any-live semantics) would need a new
  unfiltered loader in both server lanes.
- **One echo per marker write.** Every real marker change produces exactly
  one refired event that recomputes to the same value and write-avoids. This
  is bounded and by design, not a defect, but it is a real, recurring cost
  the feature pays on every override toggle and every lifecycle transition
  that moves a definition's label in or out of a marker.
- **The dirty-marker sweep arm is unconditional.** It scans every
  marker-bearing object's NOT_NULL markers regardless of whether that object
  still has any enabled override-allowed definitions, because it is the only
  path that can repair a record left over after a definition was destroyed
  or an object's last definition was disabled. This is deliberate, not an
  oversight: gating it on live definitions would make exactly the markers it
  exists to fix permanently unrepairable.
- **Accepted timeline residue on definition-less objects.** `timeline-cleanup.ts`'s
  formula-managed classifier only registers objects that still have at least
  one definition, so the marker's own final blank-out writes on an object
  whose last definition was just destroyed are not classified as
  formula-managed and can leave one transient "Overrides changed" timeline
  row per affected record, until the sweep's cleanup arm deletes the field
  on a later pass. Self-limiting and not worth building a special case for.
- **The widget's 100-definition ceiling.** Past 100 formula definitions on
  one object, the widget's own marker computation, like its tab display
  already, diverges from the server lanes, which paginate fully. Documented,
  not fixed, since a workspace in that state already has a broken Formulas
  tab for reasons unrelated to this feature.
- **Field metadata is not attributed to this app.** `createOneField` stamps a
  created field with the workspace's Custom application, not the Formula
  Field application (the same attribution the wizard's own value fields
  already carry), so uninstalling the app does not remove the marker field.
  Removal is only ever the sweep's own cleanup arm, once an object has no
  definitions left in any state.

## Alternatives considered

- **A toast from the record-page Formulas widget, fired on mount.** This was
  the originally approved direction and is what this design supersedes. It
  died on a platform fact, not a preference: the Formulas widget only mounts
  when its tab is the active one, and the Formulas tab is not the initial
  tab on record open (`PageLayoutTabsRenderer.tsx`, see Context above). A
  toast from a widget that does not mount cannot fire on the case that
  matters, plain record open, so the direction was abandoned before
  implementation began.
- **A per-formula chip, in the shape of ADR 0021's retired FxStatus
  companion.** Rejected on the same grounds ADR 0021 already retired that
  design for: one extra field per formula rather than per object,
  render-time layout convergence that the platform makes expensive (viewField
  mutations reject application tokens), and a bulk value sync across every
  record on every status change. The marker's per-object, pin-paced design
  avoids all three costs.
- **Embedding override state in the value field itself**, for example a
  sentinel or suffix on the computed value. Rejected outright: this would
  corrupt the very data the app exists to keep faithful (a computed NUMBER,
  CURRENCY, or DATE value cannot carry a side-channel marker without
  becoming a different, wrong value), and it would conflict with the SELECT
  output gate (ADR 0029), which requires a formula's output to name an
  actual option.
- **MULTI_SELECT chips instead of a comma-joined TEXT string.** Rejected:
  this would need option-membership machinery (defining, syncing, and
  cleaning up one option per formula field) for no extra information over
  the plain text the user actually asked for.

## Task 0 platform probe results

Quoted verbatim, unchanged wording, from
`docs/superpowers/plans/2026-09-01-probe-results.md` (repo root `docs/`,
dated 2026-09-03):

```
# Override marker arc: Task 0 platform probe results

Probed 2026-09-03 against a fresh local 2.35.0 seed (workspace "Apple"), formula-field 0.5.1 installed via `dev --once -r dev`. Attempt 1 the same day was inconclusive because the local database was four minor versions behind the server code; the database was reset before attempt 2.

- **P1 PASS** (2026-09-03): app-token `createOneField` succeeded from a temporary cron logic function using `MetadataApiClient`. `core.fieldMetadata` shows `company.fxOverrides`, label `Overrides`, type TEXT, `isUIEditable = false`, `isActive = true`. Note: the created field's `applicationId` is the workspace "Custom" application, not the Formula Field application, so an app uninstall does not remove it (same attribution as the wizard-created value fields).
- **P2 PASS, case (a)** (2026-09-03): on the Google company record page the `Overrides` field appears directly in the Fields card with no user reveal needed (not in a hidden-fields section). (c) held: the field cell is rendered disabled, and a click attempt times out with "element is not enabled", while an ordinary TEXT field (Tagline) opens an editor on click.
- **P3 PASS** (2026-09-03): from the authenticated page context (user Bearer token from the front's `tokenPairState`), `updateCompany(id, data: { fxOverrides: "probe" })` on http://localhost:3000/graphql returned `fxOverrides: "probe"`; a follow-up read confirmed it; resetting with `fxOverrides: null` returned `fxOverrides: ""` (TEXT null normalizes to blank, ADR 0030).

Consequences for the plan: no fallbacks triggered. The §5.1 front-side creation fallback is not needed, Task 9's user-token widget write is viable, and README wording for Task 10 can say the field appears in the Fields card without a reveal step.

Cleanup: probe function deleted and the app redeployed so the probe cron is gone; the probe field on Company was deactivated and deleted after the probes so Task 11's live checklist observes lazy creation.
```
