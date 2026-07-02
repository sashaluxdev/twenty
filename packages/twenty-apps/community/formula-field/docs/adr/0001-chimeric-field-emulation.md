# ADR 0001 — Emulate a chimeric field with a real value field + FormulaDefinition object

- Status: Accepted
- Date: 2026-07-02

## Context

The goal is a "chimeric" field: **reading** it returns the computed number
(so API reads, CSV exports, table cells, and copy/paste all yield the value),
while **editing** it edits a formula expression. Twenty's Apps SDK
(`twenty-sdk` 2.18.0) exposes `defineField`, which can only attach a field of an
**existing** `FieldMetadataType` (NUMBER, TEXT, …). There is no SDK primitive to
register a brand-new first-class field type with custom read/write renderers.
(Verified against the SDK source in this monorepo: `defineField` takes a
`FieldManifest` whose `type` is a `FieldMetadataType` enum member.)

## Decision

Emulate the chimeric field with two real objects:

1. A **value field** — a genuine `NUMBER` field attached to the target object via
   `defineField`. This is what the UI shows and every API read returns. Native
   read/copy/export semantics come for free because it is an ordinary field.
   It is marked `isUIEditable: false` so the generic UI will not let a human
   overwrite the computed value.
2. A **FormulaDefinition** object (one record per formula) holding the target
   object/field, the expression string, the parsed dependency list, an enabled
   flag, and the last-evaluated timestamp / value / error.

An evaluation engine (logic functions) keeps the value field in sync with the
formula. Editing "the field" means editing the FormulaDefinition's expression,
done through a front component on the record page (and the FormulaDefinition
index view as a fallback editor).

## Consequences

- **Reads are perfect**: the value lives in a native field, so exports, filters,
  aggregations, and copy/paste need zero special-casing.
- **The value field is column-level, not row-level**: one FormulaDefinition
  applies to every record of its target object (like a computed column). This is
  the natural fit for "give an object a formula field."
- **Not truly in-cell editable**: Twenty renders the value field with its native
  NUMBER editor. We cannot replace that cell renderer with a formula editor (no
  SDK hook for it), so in-place table-cell formula editing is **not achievable**;
  the record-page front component + FormulaDefinition view are the edit surfaces.
  Documented as a known limitation.
- **Write-protection is best-effort**: `isUIEditable: false` hides the generic UI
  editor, but a direct API write to the value field is still possible and will be
  overwritten on the next evaluation. Documented.
