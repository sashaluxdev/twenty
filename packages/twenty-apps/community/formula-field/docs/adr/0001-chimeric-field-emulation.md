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
   It was originally `isUIEditable: false` (locked); it is now **editable**
   because manual overrides (ADR 0006) let a human edit the value directly to
   pin a record. `isUIEditable` is column-level, so per-record locking is not
   possible anyway.
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
- **No write-protection; direct edits are overrides**: the value field is
  editable. A human editing it directly is intentionally treated as a manual
  override (ADR 0006), not overwritten — the formula stops touching that record
  until the override is cleared. The app's own recompute writes are distinguished
  from human edits by comparing the written value to the computed value, not by
  actor (ADR 0006).
