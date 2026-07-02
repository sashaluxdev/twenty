# ADR 0007 — Editor UX: field autocomplete and front-component UI constraints

- Status: Accepted
- Date: 2026-07-02

## Context

Authoring a formula requires knowing the target object's field **API names**
(e.g. `formulaInputA`), which users don't see — the UI shows labels. And several
desired UI affordances run into hard platform limits.

## Decision

- **Same-record field autocomplete** (`front-components/lib/formula-field-input.tsx`):
  while typing an identifier, a dropdown lists the target object's numeric fields
  (NUMBER/NUMERIC/CURRENCY/BOOLEAN) via the metadata API, showing **label + API
  name + type**, narrowing live; selecting inserts the API name. Autocomplete is
  suppressed inside a `[object:uuid:field]` cross-record reference.
- **Cross-record references stay ID-based** (`[object:uuid:field]`). Relation-
  following (`company.employees`) and record-picker/aggregate syntaxes were
  considered and deferred — cross-record is niche and `.`/`/` collide with the
  composite-subpath and division syntaxes.

## Platform constraints that shaped the UI (verified against frontend source)

- **No inline field-cell decoration.** Apps cannot put a pill/badge next to a
  native field value; field rendering is a fixed internal `FieldDisplay` switch
  with no plugin hook. So the override indicator is a red/green **toggle inside
  the Formulas widget**, not an inline pill.
- **Page-layout tab on a standard object** must be added with
  `definePageLayoutTab` appended to the standard layout's universal id
  (`STANDARD_PAGE_LAYOUT.opportunityRecordPage`); a competing full
  `definePageLayout` on a standard object is not adopted. Custom objects use
  `definePageLayout` directly.
- **remote-dom sandbox**: `input.setSelectionRange`/`focus` may be proxied and
  throw; all such calls are feature-detected and wrapped in try/catch. A benign
  React-internal `setSelectionRange` console warning on controlled inputs remains
  but does not affect behavior.
- **Metadata cache**: the frontend caches metadata (incl. front-component
  checksums) in IndexedDB, so a redeploy needs a hard refresh to show new widget
  code. This is a dev-loop caveat, not a product issue.

## Consequences

- Discoverability is solved for same-record fields; cross-record remains explicit
  and ID-based (documented).
- The override/formula UX lives entirely in the record-page widget, which is the
  only app-controllable surface.
