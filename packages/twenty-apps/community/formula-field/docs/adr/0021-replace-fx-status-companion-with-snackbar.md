# ADR 0021 — Replace the FX Status companion field with a status snackbar

- Status: Implemented
- Date: 2026-07-14

## Context

ADR 0009 gave every wizard-created formula a second field: a
`<targetField>FxStatus` SELECT, created inactive next to the value field and
activated with a red OFFLINE / orange UPSTREAM chip whenever the formula
broke. It worked, but it was expensive to keep converged:

- **One extra system field per formula**, cluttering the record-page Fields
  card and the object's schema with a column most users never touch directly.
- **Constant layout convergence.** viewField mutations reject application
  tokens, so a front component had to converge the chip's viewField
  visibility, group membership, and position on every render/poll
  (`ensureFieldLayoutVisibility`, `convergeFormulaFieldLayout`, ADR 0009's
  2026-07-03 amendment). The chip only rendered at all once a user with the
  VIEWS permission opened a page — and even then only in record-page Fields
  views, never index views.
- **Per-record value syncing.** Healing or breaking a formula meant a bulk
  write of the chip value across every record of the target object, on top of
  the value-field recompute itself.

The formula editor widget and the definition editor already show a status
banner with the reason whenever a formula is OFFLINE or UPSTREAM. The chip's
only added value over the banner was a passive, at-a-glance signal without
opening the Formulas tab — and that signal was unreliable in exactly the way
above: throttled, permission-gated, and record-page-only.

## Decision

Drop the companion field and its layout-convergence machinery; replace the
passive signal with a snackbar toast fired from the widget that is already on
the page.

1. **The wizard no longer creates a companion field.** `createOneField` for
   the value field is the only field-creation call left in the setup flow.
   Side effect: the wizard used to detect an interrupted attempt by finding an
   existing field+companion pair with the derived name and *adopting* it
   instead of colliding. With no companion to distinguish "my own interrupted
   attempt" from "an unrelated field happens to have this name," that signal
   is gone — an existing field with the derived name is now always treated as
   a collision, same as any other naming conflict.
2. **`refreshFormulaStatuses` no longer syncs chip values.** Status
   computation (`status`/`statusReason` on FormulaDefinition) is unchanged;
   only the bulk chip-value write across the target object's records is
   removed.
3. **The record-page Formulas widget fires a snackbar instead.** On widget
   mount and on every status transition, `computeStatusToasts`
   (`src/front-components/lib/status-toast.ts`) diffs each definition's
   current status against a per-definition-id map of what was last toasted
   this widget session and emits at most one toast per changed status:
   - OFFLINE → `enqueueSnackbar` variant `error`: `Formula "<label>" is
     offline — <reason or 'an input field is gone'>. Check the Formulas tab
     for details.`
   - UPSTREAM → variant `warning`: `Formula "<label>" has an upstream break —
     <reason or 'a formula earlier in the chain is broken'>. Check the
     Formulas tab for details.`
   - `dedupeKey: formula-status-<definitionId>` so the host doesn't stack
     duplicate toasts.
   A formula that heals is removed from the tracking map, so a later
   re-break toasts again; a status that hasn't changed since the last check
   never re-toasts. The call is best-effort: `enqueueSnackbar` throws
   synchronously when the front-component host bridge isn't present (e.g.
   outside the record page), and that throw is swallowed.
4. **The hourly sweep deletes surviving companions.** `cleanupCompanionFields`
   (`src/logic-functions/lib/fx-status-cleanup.ts`), wired into
   `formula-sweep.ts`, enumerates every live (any enabled state) and trashed
   FormulaDefinition, and for each `<targetField>FxStatus` field that still
   exists on its target object, deactivates it first (dropping it out of every
   view cleanly, same order as `delete-definition-completely`) then
   hard-deletes it. This is the migration path for workspaces that were
   deployed under ADR 0009/its amendment and already carry companion fields.
   Values on those fields are derived state (never user-authored), so nothing
   is lost by deleting them. The pass is idempotent — once a workspace's
   companions are gone it finds nothing on later sweeps — and isolates
   failures per field: a permission or transport error on one field leaves it
   for the next sweep instead of aborting the pass.

## Consequences

- **The passive signal now requires a record page of the affected object to
  be open.** The snackbar fires from the record-page widget's mount/poll
  cycle; there is no equivalent signal from list/index views, and there never
  was one for the chip beyond a value column a user had to notice. This is a
  narrower surface than the theoretical promise of a status column, but it
  matches how the chip actually got seen in practice (ADR 0009's amendment
  already restricted convergence to record-page Fields views).
- **Stale chips can linger on already-deployed workspaces for up to ~1 hour**
  until the hourly sweep's cleanup pass reaches them. Their values stop being
  synced immediately (change #2), so a lingering chip shows a frozen
  OFFLINE/UPSTREAM value even after the formula heals, until the sweep
  deletes the field outright.
- **If `deleteOneField` is ever denied to the app token**, `cleanupCompanionFields`
  still deactivates the field (taking it out of all views) before the delete
  attempt fails, and retries the delete on the next sweep. A workspace can
  therefore be left with deactivated-but-undeleted companion fields
  indefinitely if the permission gap is never fixed, but they are inert and
  invisible either way.
- **The "adopt an interrupted pair" wizard resume path is gone.** Re-running
  the wizard after an interrupted attempt now always hits the standard name
  collision, which surfaces the field-name conflict; it does not silently
  resume the old attempt's field.
- **`companionFieldName` and the FX Status naming convention survive** as
  legacy tolerance: the lifecycle triggers, "Delete Completely," and the
  timeline-cleanup noise sweep all still reference `<targetField>FxStatus`
  because they must keep handling fields created before this ADR shipped,
  until real-world installs fully converge. `fx-status-field.ts` keeps that
  helper plus the value-field-only layout convergence
  (`convergeTrashedDefinitionLayout`, now hiding only the value field, not a
  companion).
- **What stays:** OFFLINE/UPSTREAM detection (`status`/`statusReason` on
  FormulaDefinition, computed the same way as ADR 0009 describes), the
  in-widget status banners on both the definition editor and the record-page
  widget, and the `companionFieldName` helper for legacy-field bookkeeping.

## Alternatives considered

- **Keep the chip, fix convergence instead** (e.g. push viewField layout onto
  an index-view aware path, or find a way to converge under the app token):
  rejected — the platform fact driving the throttling and permission-gating
  (viewField mutations reject application tokens) is unchanged, so any fix
  would still be a user-token, render-triggered convergence with the same
  fundamental latency and list-view blind spot. The extra field and its
  bulk-write cost would remain for no added reliability.
- **Snackbar only, leave old companions in place forever**: rejected — a
  frozen, no-longer-synced chip showing a stale status is worse than no chip,
  and it permanently clutters the Fields card on every workspace that
  installed the app before this change.
- **A dedicated cleanup logic function instead of piggybacking the hourly
  sweep**: rejected — the sweep already runs hourly over every definition for
  status reconvergence, so folding companion cleanup into the same pass
  avoids a second cron and a second full-definition scan.
