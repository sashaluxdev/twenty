# String Literals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `IF(stage = "QUALIFIED", 100, 0)` works — string literals as transient comparison operands, raw-value case-sensitive matching, SELECT option autocomplete.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-06-string-literals-design.md` (approved). Strings enter the grammar as a token + AST node legal ONLY as a direct operand of `=`/`!=` at an IF condition's top level. The evaluator gains a string-mode comparison branch fed by a new optional `resolveRaw` in `EvaluateOptions` (the existing numeric `VariableResolver` is untouched, so no existing resolver or test changes shape). The compute path populates `resolveRaw` from the same record fetches already performed. Save validation gains an optional metadata-injected field-kind check. Autocomplete gains SELECT/TEXT fields, SELECT `options` metadata, and an after-`=` option-suggestion context.

**Tech Stack:** app `packages/twenty-apps/community/formula-field`; vitest, oxlint. All paths below relative to the app root unless absolute.

## Global Constraints

- Engine purity: no clock, metadata, or IO in `src/engine/` — raw values arrive via caller-supplied `resolveRaw`.
- Matching is exact, case-sensitive, raw stored value (SELECT option `value`, TEXT raw) — core-filter semantics. Null/absent/mismatch → condition `null` → IF result `null` (ADR 0003).
- Error construction: `throw new FormulaError('TOKENIZE_ERROR' | 'PARSE_ERROR', message, position)` — position always supplied. Exact messages are specified per task below; use them verbatim.
- `MAX_STRING_LITERAL_LENGTH = 100` (tokenizer-local constant, joins the DoS-guard family).
- Double quotes only; no escape sequences; `'` remains an illegal character.
- Repo conventions: named exports; types over interfaces; no `any`; kebab-case files; `//` WHY comments. No re-parsing expressions inside 4s poll loops.
- Backward compat is absolute: any formula valid today parses/evaluates identically (numeric comparisons byte-for-byte unchanged).
- Tests: from the app dir, `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run [file]` (redirect to a file and tail). Lint: `/home/sasha_shin/twenty/node_modules/.bin/oxlint -c .oxlintrc.json .`.
- Commit per task, conventional messages (`feat(formula-field): …`).

---

### Task 1: Engine grammar — STRING token, StringNode, placement rules

**Files:**
- Modify: `src/engine/tokenizer.ts` (token union :10-28, `Token` :36-47, main loop — add `"` branch before the catch-all throw at :372)
- Modify: `src/engine/ast.ts` (union :69-77)
- Modify: `src/engine/parser.ts` (`parsePrimary` :163-243, `parseCondition` :317-344)
- Modify: `src/engine/dependencies.ts` (`walk` :33-89, `usesToday` :96-126)
- Modify: `src/engine/__tests__/tokenizer.spec.ts`, `parser.spec.ts`, `dependencies.spec.ts`, `fuzz.spec.ts`

**Interfaces:**
- Produces: `TokenType` gains `'STRING'`; `Token` gains `stringValue?: string` (lexeme includes the quotes, `stringValue` excludes them). AST gains `StringNode = { type: 'string'; value: string }` in the `AstNode` union. `ComparisonNode` may now hold a `StringNode` operand. Tasks 2-4 rely on the node type name `'string'`.

**Placement enforcement (the design's key mechanism):** `parseCondition` consumes a STRING token directly as a comparison operand (each side: if the next token is STRING, consume it into a `StringNode`; otherwise `parseExpression` as today). `parsePrimary` gets a `case 'STRING'` that ALWAYS throws — this makes "direct operand only" structural: `("a") = x`, `1 + "a"`, `IF(c, "a", 0)`, bare `"a"` all route through `parsePrimary` and reject. After parsing both operands, if the operator is NOT `=`/`!=` and either operand is a `StringNode`, reject at the operator's position.

**Exact messages:**
- Unterminated (EOF or newline before closing `"`): `Unterminated string literal`
- Over-length: `String literal exceeds ${MAX_STRING_LITERAL_LENGTH} characters`
- parsePrimary rejection: `String literals are only allowed beside = or != inside an IF condition`
- Ordering-operator rejection: `Strings support only = and != comparisons`

- [ ] **Step 1: Failing tests.** Tokenizer: `"QUALIFIED"` → one STRING token, `stringValue === 'QUALIFIED'`; `""` → empty stringValue; internal spaces/`[`/`.` preserved verbatim; 100-char literal ok, 101-char → TOKENIZE_ERROR over-length message; unterminated at EOF and at newline → TOKENIZE_ERROR; `'` still throws the illegal-character error. Parser: legal — `IF(stage = "X", 1, 0)`, literal on the left, `!=`, both-literal condition; illegal (each asserting its verbatim message + PARSE_ERROR) — `stage < "X"` (ordering), `1 + "a"`, `IF(c, "a", 0)`, bare `"a"`, `("a") = stage`, `IF(("a") = stage, 1, 0)`. Dependencies: `IF(status = "X", a, b)` → sameRecordFields {status, a, b}; `usesToday` false with strings present. Fuzz: remove `"` from the `forbidden` string (fuzz.spec.ts:65 — keep `'`); extend the grammar-directed generator's condition production to sometimes emit a quoted operand.
- [ ] **Step 2: Run engine specs, verify new cases fail.**
- [ ] **Step 3: Implement.** String reader in the main tokenize loop; AST node; parser per the enforcement mechanism above; `walk`/`usesToday` get a no-op `case 'string'`.
- [ ] **Step 4: Full engine test dir green** (`vitest run src/engine`), then full suite (nothing else should move), lint.
- [ ] **Step 5: Commit** — `feat(formula-field): string literal grammar (comparison operands only)`

---

### Task 2: Evaluator — string-mode comparisons via resolveRaw

**Files:**
- Modify: `src/engine/evaluator.ts` (`EvaluateOptions` :38-45, `evaluateConditionTruth` :50-89)
- Modify: `src/engine/index.ts` (re-export any new type)
- Modify: `src/engine/__tests__/evaluator.spec.ts`

**Interfaces:**
- Produces: `EvaluateOptions` gains `resolveRaw?: (reference: VariableReference) => unknown`. `VariableResolver` (numeric) is UNTOUCHED. Task 3 supplies `resolveRaw` in production; validation/tests may omit it.

**String-mode rule (verbatim semantics):** `evaluateConditionTruth` enters string mode iff either operand node is a `StringNode`. Each side resolves to `string | null`: `StringNode` → its value; `field`/`crossref` node → `options.resolveRaw?.(reference)` if the result is a string, else `null` (missing `resolveRaw` ⇒ `null`); ANY other node shape (number, binary, unary, if, today) → `null` (runtime type mismatch). Either side `null` → condition result `null` (IF yields null). Both strings → `===` for `=`, `!==` for `!=`. Numeric mode (no StringNode operand) is byte-for-byte unchanged.

- [ ] **Step 1: Failing tests.** Match → then-branch; mismatch → else-branch; `!=` both ways; literal vs null field raw → IF result null; literal vs numeric-raw field (resolveRaw returns 42) → null; literal vs arithmetic operand (`IF("a" = 1 + 2, 1, 0)`) → null; both-literal `"A" = "A"` → then, `"A" = "B"` → else; crossref raw string via resolveRaw; `resolveRaw` omitted entirely → null; regression: numeric comparisons with resolveRaw present but unused behave exactly as before.
- [ ] **Step 2: Verify failures. Step 3: Implement. Step 4: Engine dir + full suite + lint. Step 5: Commit** — `feat(formula-field): evaluate string comparisons via resolveRaw`

---

### Task 3: Compute path + save-time field-kind validation

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts` (`buildResolver` :163-191 area, `evaluate` call sites :300-305)
- Modify: `src/engine/dependencies.ts` + `src/engine/index.ts` (new exported walker, see Interfaces)
- Modify: `src/logic-functions/lib/save-validation.ts` (`validateFormula` :111-171)
- Modify: `src/logic-functions/lib/handle-formula-change.ts` (validation call :85)
- Modify: `src/front-components/lib/validate-expression.ts` (parity check, optional fields param)
- Modify: `src/logic-functions/lib/__tests__/recompute.spec.ts`, `handlers.spec.ts` (or the save-validation spec if separate), `src/front-components/lib/__tests__/validate-expression.spec.ts`

**Interfaces:**
- Produces: `buildRawResolver(sameRecord, crossRecords)` alongside `buildResolver` in recompute.ts — same navigation (`navigatePath`, cross-record map lookup), NO `coerceToNumber`: returns the value when `typeof === 'string'`, else `null`; missing cross record → `null` (existing silent-null parity). Passed as `resolveRaw` in the `evaluate(...)` options at both call sites.
- Produces: engine walker `collectStringComparisonRefs(ast): { sameRecordPaths: string[]; crossRefs: CrossRefValue[] }` — the refs that appear as the non-literal side of a string-mode comparison (exported from `src/engine`).
- Produces: `validateFormula` gains optional `targetObjectFieldKinds?: Map<string, string>` (field name → metadata type, e.g. 'SELECT'). New step between dependency extraction and cycle detection: for each same-record path in `collectStringComparisonRefs` whose ROOT field has a known kind NOT in `{'SELECT','TEXT'}` → invalid with error exactly: `String comparison against "${field}" is not supported (field type ${kind}; only SELECT and TEXT fields)`. Unknown fields and cross-refs pass (runtime-null semantics). Fully backward compatible when the map is omitted.
- SELECT/TEXT are scalar selections — the existing dependency fetch needs NO sub-selection changes.

- [ ] **Step 1: Failing tests.** recompute.spec (FakeClient + `setFieldKinds`): SELECT-backed condition — record `{stage: 'QUALIFIED', a: 1, b: 2}` with `IF(stage = "QUALIFIED", a, b)` on a NUMBER target computes 1, non-matching record computes 2; null stage → null result + no write (no-op suppression path); TEXT field comparison; cross-record string comparison (seed second object). Validation: SELECT ok; TEXT ok; NUMBER field → invalid with the verbatim message; kinds map omitted → valid; cross-ref comparison → valid. validate-expression front parity (same cases through its optional param).
- [ ] **Step 2: Verify failures. Step 3: Implement** (handle-formula-change preloads the kinds map via `client.fieldKinds?.(after.targetObject)` guarded — absence degrades to no kind check). **Step 4: Full suite + lint. Step 5: Commit** — `feat(formula-field): string comparisons end-to-end + save-time kind validation`

---

### Task 4: Autocomplete — SELECT/TEXT fields + quoted option suggestions

**Files:**
- Modify: `src/front-components/lib/formula-field-input.tsx` (`NUMERIC_FIELD_TYPES` :49-56, `useObjectFields` query :80-86, `FieldOption` :20-26, `computeSuggestions` :153-178, `insert` :237-249, row rendering :313-327)
- Create: `src/front-components/lib/__tests__/compute-suggestions.spec.ts`

**Interfaces:**
- Consumes: caret behavior from the caret fix (unchanged); `identifierBeforeCaret`, `isInsideCrossRef` (unchanged).
- Produces: `FieldOption` gains `options?: Array<{ value: string; label: string }>` and suggestions may carry `insertText` (already exists). `useObjectFields` selection adds `type` (already there) plus `options { value label }` on the field node; the type filter becomes `SUGGESTIBLE_FIELD_TYPES = NUMERIC set ∪ {'SELECT','TEXT'}` (rename the constant; SELECT/TEXT rows render their type like other rows).
- Produces: option-suggestion context in `computeSuggestions`: when the text before the caret matches `/([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=)\s*("?[^"]*)?$/` AND the captured identifier resolves to a SELECT field with options AND the caret is not inside `[...]`: return that field's options (filtered case-insensitively by the partial text after the optional opening quote), each as `{ name: option.value, label: option.label, type: 'OPTION', insertText: '"' + option.value + '"' }`, capped at 8 like fields. `insert()` must replace from the start of the partial INCLUDING an already-typed opening quote (so accepting a suggestion never yields doubled quotes). Field suggestions elsewhere unchanged.

- [ ] **Step 1: Failing tests** (pure, through the exported `computeSuggestions` + any extracted replace-range helper): after `stage = ` with a SELECT field carrying options → options returned, quoted insertText; partial `stage = "QU` filters to QUALIFIED; partial without quote `stage = QU` also filters and insertText still carries both quotes with replace-range covering the partial; `stage != ` works; a TEXT field after `=` → no option suggestions (empty); non-existent field → none; inside `[...]` → none; regression: identifier context still suggests fields, and SELECT/TEXT fields now appear in field suggestions with their type.
- [ ] **Step 2: Verify failures. Step 3: Implement. Step 4: Full suite + lint. Step 5: Commit** — `feat(formula-field): SELECT option autocomplete for string comparisons`
