# Field Mirroring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A formula whose expression is a single bare field reference onto a non-numeric target field copies the source value verbatim — select→select, links→links, etc. — per `docs/superpowers/specs/2026-07-06-field-mirroring-design.md` (approved, incl. 2026-07-06 contradiction fixes).

**Architecture:** Mirror mode = bare whole-field ref AST + target kind outside the engine family (NUMBER/CURRENCY/DATE/DATE_TIME keep today's engine path byte-for-byte). Mirror recompute is raw passthrough: kind-aware fetch (composite sub-selections), structural deep-equal no-op suppression, verbatim write — bypassing all numeric normalization. Two new system-managed TEXT columns carry non-numeric bookkeeping (`lastValueText` on FormulaDefinition, `overrideValueText` on FormulaOverride). The wizard gains a "Mirror another field" branch that clones the source field's type/settings/options. EXECUTION ORDER: after the string-literals plan completes (this plan refactors the `validateFormula` metadata param that SL Task 3 introduces).

**Tech Stack:** app `packages/twenty-apps/community/formula-field`; vitest, oxlint. Paths relative to app root.

## Global Constraints

- v1 kind allowlist (single constant): TEXT, SELECT, MULTI_SELECT, BOOLEAN, RATING, LINKS, FULL_NAME, ADDRESS, EMAILS, PHONES, ARRAY, RAW_JSON. Strict same-kind rule. Everything else rejected at save: `Field kind ${kind} cannot be mirrored`.
- Engine family byte-for-byte unchanged; mirror branch forks AFTER the override skip in recomputeForRecord.
- Missing cross-record source → null write, NO error (silent-null parity — spec resolution 2026-07-06).
- Write-avoidance: structural deep-equal (recursive, key-order-insensitive) before every write; heartbeat writes only on change; `lastValueText` truncated to 500 chars; `lastValue` stays null for mirrors.
- New object fields: fresh `universalIdentifier` UUIDs, `isUIEditable: false` for both TEXT columns; `lastValueText` added to ALL THREE twins: object definition, `BOOKKEEPING_FIELDS` (handle-formula-change.ts:15-22 — omitting it makes the app loop), `FORMULA_FIELDS` projection (formula-repository.ts:11-27).
- Composite sub-selection shapes must be verified against Twenty server's composite-type definitions (packages/twenty-server/src/engine/metadata-modules/field-metadata/composite-types/*.ts) — the record API silently returns null for a scalar selection of a composite, so wrong shapes are invisible without the `querySelections` assertions mandated below.
- Repo conventions as ever (named exports, no any, // WHY comments); tests `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run [file]` from app dir; oxlint clean; conventional commits.

---

### Task 1: Mirror detection, kind tables, save-time validation

**Files:**
- Modify: `src/engine/dependencies.ts` + `src/engine/index.ts` (export `bareReferenceOf`)
- Create: `src/logic-functions/lib/mirror-kinds.ts`
- Modify: `src/logic-functions/lib/save-validation.ts`, `src/logic-functions/lib/handle-formula-change.ts`, `src/front-components/lib/validate-expression.ts`
- Create: `src/logic-functions/lib/__tests__/mirror-kinds.spec.ts`; Modify: save-validation/handlers spec, `validate-expression.spec.ts`

**Interfaces:**
- Produces: engine `bareReferenceOf(ast): { kind: 'same'; field: string } | { kind: 'cross'; ref: CrossRefValue } | null` — non-null iff the ENTIRE AST is one FieldNode whose path has no `.` or one CrossRefNode (whole-field). Pure.
- Produces: `mirror-kinds.ts`: `MIRRORABLE_KINDS: ReadonlySet<string>` (allowlist above); `ENGINE_FAMILY_KINDS: ReadonlySet<string>` ({'NUMBER','CURRENCY','DATE','DATE_TIME'} — value-io's family); `isMirrorTargetKind(kind)`; `selectionEntryForMirrorKind(kind): true | Record<string, boolean>` (scalars → true; composite shapes per server composite types — LINKS/FULL_NAME/ADDRESS/EMAILS/PHONES; CURRENCY delegates to value-io's existing entry); `isMirrorDefinition(ast, targetFieldType): boolean` = `bareReferenceOf(ast) !== null && isMirrorTargetKind(targetFieldType)`.
- Produces: `validateFormula`'s metadata param generalized from SL's single map to `fieldKinds?: (objectName: string) => Map<string, string> | undefined` (sync accessor over caller-preloaded maps; update SL's string-comparison check to use it — same behavior). New mirror step: when `targetFieldType` is NOT engine-family: (a) not in allowlist → `Field kind ${targetFieldType} cannot be mirrored`; (b) allowlisted but AST is not a bare whole-field ref → `Only a plain field reference can be mirrored onto a ${targetFieldType} field`; (c) source kind known via accessor and ≠ target kind → `Cannot mirror ${sourceKind} field "${name}" onto a ${targetFieldType} field (kinds must match)`; unknown source kind (accessor gap) passes. `handle-formula-change` preloads the target object's kinds AND, when the expression is a cross-ref, that object's kinds (guarded `client.fieldKinds?.`).

- [ ] **Step 1: Failing tests.** `bareReferenceOf` matrix (bare field ✓, bare crossref ✓, dotted path ✗, `a + 0` ✗, IF ✗, literal ✗). mirror-kinds: allowlist membership; selection entries (assert LINKS/FULL_NAME/ADDRESS/EMAILS/PHONES shapes exactly as verified from server composite types; SELECT/TEXT/BOOLEAN/RATING/MULTI_SELECT/ARRAY/RAW_JSON → true). Validation: each error case verbatim ((a),(b),(c)); same-kind pass; engine-family target unaffected; accessor omitted → mirror kind checks degrade gracefully (only (a)/(b) run — they need no metadata). Front validate-expression parity.
- [ ] **Step 2: Verify failures. Step 3: Implement. Step 4: Full suite + lint. Step 5: Commit** — `feat(formula-field): mirror detection, kind allowlist, save validation`

---

### Task 2: Mirror recompute + heartbeat text column

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts`, `src/logic-functions/lib/value-io.ts` (only if delegation requires), `src/logic-functions/lib/formula-repository.ts` (:11-27 projection, `recordEvaluationHeartbeat` :135-240), `src/logic-functions/lib/handle-formula-change.ts` (BOOKKEEPING_FIELDS), `src/logic-functions/lib/types.ts` (FormulaDefinitionRecord), `src/objects/formula-definition.object.ts` (new field + uuid map)
- Create: `src/logic-functions/lib/__tests__/mirror-target.spec.ts`; Create: `src/logic-functions/lib/deep-equal.ts` (+ tests in mirror-target.spec or own spec)

**Interfaces:**
- Produces: `deepJsonEqual(a: unknown, b: unknown): boolean` — recursive structural equality, key-order-insensitive, arrays ordered, null ≠ undefined treated equal only if both nullish (document choice in a comment: fetched missing composites arrive as null).
- Produces: `computeMirrorValueForRecord({client, formula, targetRecordId, prefetchedRecord}): Promise<{ rawValue: unknown; error: string | null; sameRecord: Record<string, unknown> | null }>` — resolves the bare ref: same-record → fetch with `selectionEntryForMirrorKind(sourceKind)` for the source field + target field; cross-record → grouped fetch as engine path does; missing record → `rawValue: null, error: null`.
- Produces: mirror branch in `recomputeForRecord` (after override skip :340-342): compute raw → read current target raw from the same fetch → `deepJsonEqual` no-op check → write `{ [targetField]: rawValue }` verbatim. `RecomputeOutcome` unchanged shape-wise except its `value` field may be null for mirrors (heartbeat handles text separately).
- Produces: heartbeat for mirrors — `recordEvaluationHeartbeat` gains awareness: mirror formulas compare/write `lastValueText = truncate(JSON.stringify(rawValue), 500)` (null rawValue → null text) instead of `lastValue`; write-avoidance intact (text unchanged + error unchanged + not TODAY-stale → zero writes). `lastValueText` TEXT field on FormulaDefinition (`isUIEditable: false`, fresh universalIdentifier), added to FORMULA_FIELDS + BOOKKEEPING_FIELDS + FormulaDefinitionRecord.
- Source field kind at compute time: via `client.fieldKinds(objectName)` (already cached 60s) — needed to pick the sub-selection; a mirror formula whose source kind can't be resolved computes `rawValue: null` with `error` naming the field (fail-visible, not silent-wrong).

- [ ] **Step 1: Failing tests** (FakeClient, `setFieldKinds`, `querySelections` assertions): per-kind passthrough — SELECT string, TEXT, BOOLEAN, RATING number, MULTI_SELECT array, LINKS realistic composite `{primaryLinkUrl, primaryLinkLabel, secondaryLinks}`, FULL_NAME, RAW_JSON nested object; sub-selection asserted present in `querySelections` for each composite; no-op suppression with key-order-shuffled equal composite (zero writes); value change → exactly one write, verbatim payload; null source → null write once then no-op; missing cross record → null, `error: null`; heartbeat: lastValueText written on change, truncated at 500, untouched on no-op; engine-family regression — run the existing `currency-target.spec.ts`/`date-target.spec.ts` untouched and green.
- [ ] **Step 2: Verify failures. Step 3: Implement. Step 4: Full suite + lint. Step 5: Commit** — `feat(formula-field): mirror recompute passthrough + lastValueText heartbeat`

---

### Task 3: Overrides for mirror targets

**Files:**
- Modify: `src/objects/formula-override.object.ts` (new TEXT field + uuid), `src/logic-functions/lib/override-repository.ts` (:12-19 type, :27-34 selection, `upsertOverride` :103-144), `src/logic-functions/lib/handle-record-update.ts` (:104-154 funnel), `src/front-components/formula-editor.tsx` (restore path :580-627, value display :411/:422)
- Modify: `src/logic-functions/lib/__tests__/handlers.spec.ts` (+ mirror override cases), override-repository spec if present

**Interfaces:**
- Produces: `overrideValueText` TEXT on FormulaOverride; `OverrideRecord` gains `overrideValueText: string | null`; `upsertOverride(client, targetObject, targetField, recordId, value: { numeric?: number | null; text?: string | null })` — REFACTOR of the existing numeric positional param; update ALL existing call sites (handle-record-update :152, formula-editor fallback :615-622) to `{ numeric: … }`.
- Produces: mirror fork in the human-edit funnel, BEFORE `normalizeStoredValue` (:120): when the matched formula is a mirror — event raw = `after?.[field]`; fresh `computeMirrorValueForRecord`; current raw from fresh read; superseded-write skip via `!deepJsonEqual(currentRaw, eventRaw)`; echo check `deepJsonEqual(mirrorRaw, currentRaw)` → ignore; else `upsertOverride(..., { text: JSON.stringify(currentRaw) })`. Numeric path untouched.
- Produces: restore path branch in formula-editor.tsx — mirror definitions restore by `JSON.parse(overrideValueText)` (parse failure → treat as no stored value, fall back to pinning current) written verbatim; display renders mirror values as: string → as-is, number/boolean → String(v), object/array → compact JSON, null → existing empty rendering. Recompute-skip for active overrides already keys on the override row — unchanged.

- [ ] **Step 1: Failing tests.** Funnel: app echo (event raw deep-equals mirror value) → no override row; human edit (differs) → row created with `overrideValueText` JSON and `overrideValue` null; superseded write skipped; numeric formulas' behavior byte-identical (existing cases untouched and green). Restore: round trip through JSON text (composite value); corrupted text → pin-current fallback; toggle-off → deactivate + mirror recompute restores source value.
- [ ] **Step 2: Verify failures. Step 3: Implement. Step 4: Full suite + lint. Step 5: Commit** — `feat(formula-field): mirror-aware overrides via overrideValueText`

---

### Task 4: Wizard "Mirror another field" branch + editor surface

**Files:**
- Modify: `src/front-components/lib/formula-setup-wizard.tsx` (mode choice at step 2 :494-507, `loadObjects` :149-224 selection, `create()` :300-459, draft persistence), `src/front-components/lib/formula-field-formats.ts` (mirror draft serialization in `TargetFieldSettings` :227-254), `src/front-components/formula-definition-editor.tsx` ("Field settings" section: mirrors show read-only `Mirrors {object}.{field}` line instead of format options)
- Modify: `src/front-components/lib/__tests__/formula-field-formats.spec.ts` (+ new pure-helper tests)

**Interfaces:**
- Consumes: `MIRRORABLE_KINDS` / `isMirrorTargetKind` from Task 1.
- Produces: wizard mode toggle at step 2: `Format` (existing flow untouched) vs `Mirror another field`. Mirror flow: source object picker (existing objects list) → source field picker (requires extending `loadObjects` field selection with `type` and `options { label value color position }` and `settings`; only allowlisted kinds listed) → source record: REQUIRED text input for a record UUID when source object ≠ target object (validated by fetching the record and showing its name/label; invalid → inline error, create disabled); OPTIONAL when equal (empty = same-record mirror). Field creation CLONES the source: `type` = source kind, `settings` = source settings verbatim, SELECT/MULTI_SELECT `options` copied `{label, value, color, position}`. Option `id`s: FIRST verify whether `createOneField` accepts options without ids (the server may assign); if ids are required, generate v4-style ids (Math.random acceptable in the front sandbox — document with a WHY comment; `crypto.randomUUID` is NOT reliably available in remote-dom). Expression seeded automatically: same-record → `sourceField`; cross → `[sourceObject:recordId:sourceField]`. Definition written with `targetFieldType` = source kind, `outputFormat: 'mirror'`, mirror draft persisted in `targetFieldSettings` for resumability (extend `TargetFieldSettings` with an optional `mirror: { sourceObject; sourceField; sourceRecordId? }`).
- `isIntegerBackedFormat('mirror')` is false (value-io :68-70) — confirm no engine-path leakage in tests.
- FxStatus companion + tab + layout convergence: identical to format flow (mirror value fields get chips/status like any formula).

- [ ] **Step 1: Failing tests** (pure helpers only — the wizard has no component harness): mirror draft serialize/parse round trip in `TargetFieldSettings`; expression seeding helper (same-record vs cross-record forms, exact bracket syntax); option-clone mapping helper (label/value/color/position copied, ids handled per the verified server behavior); allowlist filtering of pickable source fields.
- [ ] **Step 2: Verify failures. Step 3: Implement** (extract the seeding/clone logic as pure exported helpers so the tests above are real). **Step 4: Full suite + lint. Step 5: Commit** — `feat(formula-field): wizard mirror branch with source-field cloning`

---

### Task 5: Deploy + live verification (both features together)

No repo files. Deploy `dev --once` from the app dir (NOTE: bump the app package.json version if the registry rejects re-deploys — see integration-test precedent), hard-refresh browser, then verify live on the local stack (login tim@apple.dev):
- String literals: create a SELECT-condition formula via autocomplete end-to-end (type `stage = ` → options dropdown → pick → save → values correct on matching/non-matching records); NUMBER-field comparison rejected at save with the kind message; case-sensitivity spot check.
- Mirroring: wizard-create a select→select mirror (options cloned — verify in field settings UI), values copy + update propagation on source edit; a links→links or fullName→fullName mirror on a cross-record source; human-edit override on a mirror (edit target → override chip; toggle off → recomputes back); naive-delete a mirror definition → hide behavior still works; lastValueText populated, lastValue null (API read).
- Regression: one numeric formula + one TODAY() formula still compute; drag reorder; expression save confirm flow.
Report per-item PASS/FAIL with evidence; bugs found are reported, not fixed inline; clean up test artifacts (Delete Completely), keep everything out of the repo root.
