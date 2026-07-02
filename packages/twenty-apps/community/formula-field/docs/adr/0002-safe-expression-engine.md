# ADR 0002 — Hand-written tokenizer → AST → interpreter, never `eval`

- Status: Accepted
- Date: 2026-07-02

## Context

Formula expressions are user-supplied strings that run inside logic functions
(server-side, under the app's identity). Any use of `eval`, `new Function`, or
template-string tricks would be a remote code execution vector. We need
arithmetic (`+ - * / %`, parentheses, numeric literals) plus variable references
to fields on the same record and on other records/objects.

## Decision

Implement a three-stage pipeline, all pure and I/O-free:

1. **Tokenizer** (`tokenizer.ts`) — a whitelist scanner. It accepts only digits,
   `+ - * / % ( )`, ASCII identifiers (with dotted sub-paths), and bracketed
   cross-record references `[object:uuid:fieldPath]`. Every other byte — `;`,
   quotes, backticks, `$`, `{`, `}`, `\`, unicode homoglyph operators (U+2212,
   fullwidth `＋`), fullwidth digits, control chars — is rejected at its exact
   offset. Identifier segments `constructor`, `prototype`, `__proto__` are
   rejected as prototype-pollution vectors.
2. **Parser** (`parser.ts`) — recursive descent producing a tiny AST with only
   number / field / crossref / unary / binary nodes. There is deliberately no
   call node and no member-access node, so the grammar cannot express code
   execution. Guarded against stack-overflow DoS by a max source length (2000)
   and max parse depth (200).
3. **Interpreter** (`evaluator.ts`) — walks the AST, delegating all variable
   resolution to a caller-supplied `VariableResolver`. No dynamic dispatch, no
   property access on attacker-controlled keys (the resolver decides how to look
   values up; the engine hands it a typed reference).

## Consequences

- **No RCE surface**: even a syntactically valid variable like
  `constructor.constructor` cannot execute anything — it is rejected at tokenize
  time, and even if it weren't, it would only be a resolver lookup, never a call.
- **Testable in isolation**: the engine has zero dependencies on the Twenty API,
  so tokenizer/parser/evaluator/dependency/cycle logic are covered by fast unit
  tests plus a 9000-iteration fuzz suite that asserts the pipeline only ever
  throws typed `FormulaError`s and always terminates.
- **Extensible**: adding a function (e.g. `min`, `round`) later means adding a
  token, a parse rule, and an interpreter case — without ever reaching for
  `eval`.
