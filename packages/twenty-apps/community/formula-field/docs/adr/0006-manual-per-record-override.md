# ADR 0006 — Manual per-record override of a computed value

- Status: Accepted
- Date: 2026-07-02

## Context

Users need to override a computed value for a single record: the formula says 2,
but this deal is really 3. The override must (a) stop the formula from touching
that one record, (b) show a clear indicator, (c) be reversible, and (d) not lose
the override value when toggled off. Formulas are column-level (ADR 0001) but an
override is per-record, so the override state cannot live on FormulaDefinition.

## Decision

- **FormulaOverride** technical object, one row per `(targetObject, targetField,
  recordId)`, with an `overrideValue` and an `active` flag. It is a technical
  object (no navigation item, no index view) so it stays invisible to end users
  and adds nothing to their business objects.
- **The value field is editable** (ADR 0001 updated). A human editing it directly
  is recorded as an override. Detection compares the **written value to the
  formula's computed value**: if they differ it is a genuine manual edit; if they
  match it is the app's own recompute write and is ignored.
  - Why not use the event actor? A recompute triggered by a user's *input* edit
    inherits that user's `workspaceMemberId` on its write event, so actor-only
    detection produced false overrides (stale value, self-toggling). Value
    comparison is robust regardless of actor propagation.
- **Recompute skips only ACTIVE overrides** (event, cron, and cross-object paths
  all consult the active set).
- **Toggle semantics** (red/green switch in the Formulas widget — the indicator
  can't be inline, ADR 0007):
  - OFF → **deactivate** (keep the value) + recompute now. The value is retained.
  - ON → **restore** the last override value (write it back to the field) and show
    "Override value restored"; if none exists, pin the current value.

## Consequences

- Overrides are per-record and reversible; the value survives off→on cycles.
- The value field is no longer write-protected (unavoidable: `isUIEditable` is
  column-level, so we cannot lock one record). Editing = override, which matches
  the intended UX.
- Detection cost: one extra formula evaluation per value-field change event.
- The override object is app-owned data; uninstalling the app removes it.
- Implementation: `objects/formula-override.object.ts`,
  `logic-functions/lib/override-repository.ts`, the magic block +
  `computeFormulaValueForRecord` in `handle-record-update.ts` / `recompute.ts`,
  and the toggle in `front-components/formula-editor.tsx`.
