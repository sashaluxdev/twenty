# Architecture Decision Records

Short, dated records of the load-bearing decisions behind the Formula Field app.
Each ADR captures the context, the decision, and the consequences so the design
is maintainable without re-deriving the reasoning.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-chimeric-field-emulation.md) | Emulate a chimeric field with value-field + FormulaDefinition | Accepted |
| [0002](0002-safe-expression-engine.md) | Hand-written tokenizer → AST → interpreter, never `eval` | Accepted |
| [0003](0003-null-and-error-policy.md) | Null propagation, div-by-zero errors, coercion rules | Accepted |
| [0004](0004-recompute-triggers-and-noop-suppression.md) | Event triggers + cron sweep + no-op write suppression | Accepted |
| [0005](0005-cycle-detection-field-granularity.md) | Field-granular cycle detection ignoring record ids | Accepted |
| [0006](0006-manual-per-record-override.md) | Manual per-record override (FormulaOverride, value-based detection, restore) | Accepted |
| [0007](0007-editor-ux-autocomplete-and-ui-constraints.md) | Editor UX: field autocomplete + front-component UI constraints | Accepted |
| [0008](0008-add-formula-field-wizard-and-dynamic-client.md) | "Add formula field" wizard: runtime field creation, currency micros, wildcard triggers, dynamic client | Accepted |
| [0009](0009-definition-lifecycle-and-operational-status.md) | Definition lifecycle: field deactivation on delete/restore, OFFLINE/UPSTREAM status, FX Status companions | Accepted |
| [0010](0010-if-conditionals.md) | IF conditionals with condition-confined transient comparisons | Accepted |
| [0011](0011-excel-serial-dates.md) | Dates as Excel serial numbers (epoch-days), UTC-only, engine untouched | Accepted |
| [0012](0012-today-function.md) | TODAY() as an injected, caller-supplied value | Accepted |
| [0013](0013-drag-to-reorder.md) | Drag-to-reorder formula fields via pointer events, not native DnD | Accepted |
| [0014](0014-pointer-gesture-midpoint-positions.md) | Pointer-event gesture + fractional midpoint positions (amends ADR 0013) | Accepted |
| [0015](0015-today-staleness-self-heal.md) | TODAY() staleness: self-healing widget + truthful heartbeat | Accepted |
| [0016](0016-sum-function.md) | SUM() variadic function with all-null → null | Accepted |
| [0017](0017-boolean-condition-functions.md) | Boolean condition functions — AND, OR, NOT, ISBLANK, IFBLANK | Implemented |
| [0018](0018-ifs-switch-sugar.md) | IFS and SWITCH as parser-level sugar | Implemented |
| [0019](0019-relation-mirroring-via-join-column.md) | Variation sync mirrors MANY_TO_ONE relations via join column | Implemented |
