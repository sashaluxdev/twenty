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
