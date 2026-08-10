# SELECT Output Design (formula-field v0.5.0 arc)

Date: 2026-08-10
Status: DRAFT, awaiting user review.
App: `packages/twenty-apps/community/formula-field`, v0.4.0 on disk (cloud runs v0.3.0; v0.4.0 cloud deploy is a separate gated step).
Consumer: the implementation-planning session for the SELECT output arc. ADR 0029 derives from this spec.
This document is a design spec; it contains NO implementation plan.
Standing rules in force: efficiency-first (every operation pays rent; cost model in section 5) and the design-step review pass (opus code-cross-reference before the user gate).

## 1 · Scope and standing commitment

ADR 0026's closing section commits this arc verbatim: "SELECT joins the expressible bucket as a text-kind target with one extra write-time step (the computed string must match a defined option value, else standard eval-error doctrine applies). Storage, convergence, and override detection already ride the text columns built here. The remaining work is almost entirely the wizard: an options editor (values, labels, colors) mirroring Twenty's native SELECT creation, plus post-creation settings editing." (docs/adr/0026-string-values-and-concatenation.md:327-338, restated in ADR 0027:320-321 and the v0.4.0 spec section 7 backlog item 4.)

This spec honors that contract and sharpens it in one place: membership checking is two-tier (static where decidable, per-record only where it is not), because a runtime-only check violates the efficiency doctrine for the most common formula shape (section 2, approach A).

**In scope**
1. SELECT becomes an engine target: moves out of `MIRRORABLE_KINDS` into `ENGINE_FAMILY`, exactly the TEXT/ADR-0026 lane move replayed (D1, D2).
2. Option-membership gating, two-tier: a static literal-set gate at save time and per pass, plus a per-record membership check at the write boundary (D3).
3. Blank/null normalization for SELECT targets (D4) and option-set plumbing through the existing cache (D5).
4. New error surfaces: one save/static gate message with a did-you-mean hint, one runtime `NOT_AN_OPTION` eval error (D6).
5. Wizard: a 9th `select` output format with an options editor; settings-editor support; the mirror flow reroutes SELECT sources to the engine lane (D7, D8).

**Out of scope**
- MULTI_SELECT output (stays `opaque` input and mirror-lane target). RATING likewise.
- Language changes: no new functions, no new syntax, no new kinds. The kind lattice is untouched.
- Automatic option creation or deletion from formula literals (see section 8; a user-gated "add missing options" affordance is backlog polish).
- Label-based matching (formulas match option values only, D6).
- The F1-empty-string investigation and the DATE-cast arc (separate queued arcs; sequencing note in section 9).

## 2 · Approaches considered

**A. Runtime-only membership (ADR 0026's literal wording).** Every SELECT write gets a per-record membership check; violations follow eval-error doctrine. Simple, but it fails the rent test for the dominant formula shape. `IF(amount > 50000000000, "HOT", "COLD")` with a typo'd literal ("Hot") would save cleanly, then error on every record on every hourly sweep forever: per-record eval errors do not disable a definition, so the sweep re-evaluates all N records each pass with zero convergence. The typo also surfaces minutes after save instead of in the editor. Rejected as the sole mechanism.

**B. Two-tier gate: static where decidable, runtime where not (chosen).** A tiny pure walker computes the formula's possible literal text outputs. When that set is closed (every output leaf is a string literal, the common case for SELECT formulas: IF/IFS/SWITCH label ladders), membership is fully decidable statically: the editor and save gate reject typos before they cost anything, and the per-pass static gate catches post-save option drift as a whole-definition, write-avoidant freeze (zero record scans, ADR 0027 D6 doctrine). When the set is open (field refs, `&`, `TEXT()` in output positions), the per-record runtime check covers it. This matches the house pattern exactly: "per-definition static gate, per-record errors only where statics can't decide" (ADR 0027 D6 header). No new kinds, no `ExpressionKind` changes; the walker is a sibling analysis, not a lattice extension.

**C. Closed-set required (DATE-literal doctrine applied to SELECT).** Only statically closed formulas allowed on SELECT targets. Rejected: it makes the bare-ref passthrough (`stage`) and blank-defaulting (`IFBLANK(stage, "NEW")`) inexpressible, which regresses the existing SELECT mirror capability unless SELECT stays dual-lane, and dual lanes are precisely what ADR 0026 eliminated ("the two sets are now disjoint again", mirror-kinds.ts:33-36). Option values are workspace data, not language literals; a hard literal-only rule buys no additional safety over B's static tier while costing expressiveness.

## 3 · Design decisions

### D1 · Lane move: SELECT leaves the mirror lane, joins the engine family

- `ENGINE_FAMILY` (value-io.ts:33-39) gains `'SELECT'`; `MIRRORABLE_KINDS` (mirror-kinds.ts:18-30) drops it. The sets stay disjoint; `SYNCABLE_KINDS` (the union, syncable-fields.ts:14-17) is unchanged, same invariant the TEXT move pinned (syncable-fields.spec.ts:16).
- `EXPECTED_KIND_BY_TARGET` gains `SELECT: 'text'`. TypeScript forces this entry the moment `TargetFieldKind` grows (kind-inference.ts:314-320), and the `ENGINE_FAMILY_KINDS.has()` guard in `strictKindGateError` (kind-inference.ts:334-340) flips SELECT targets from always-skip to gated automatically.
- `fieldTypeToKind` is untouched: SELECT stays kind `'text'` as an input (kind-inference.ts:43-45). A SELECT target accepts any text-kind expression at the kind tier; membership is the extra gate (D3).
- Bare-ref-onto-SELECT stops being a mirror definition (`isMirrorDefinition` returns false once SELECT leaves `MIRRORABLE_KINDS`) and becomes a one-term engine formula. Same verbatim string write, better failure modes (D3, D6). The mirror lane keeps MULTI_SELECT, BOOLEAN, RATING, LINKS, FULL_NAME, ADDRESS, EMAILS, PHONES, ARRAY, RAW_JSON.

### D2 · Text-domain consolidation: one predicate, not a second literal

The readers found four places that hard-code `'TEXT'` as "the string-domain target" and would silently corrupt SELECT data if missed: `tagEngineValue` (value-io.ts:147-153, a SELECT string would fall into the number lane and null out), `overrideSlotForKind` (override-repository.ts:182-188, pin misrouted to the numeric column), `pinnedOverrideValue` (handle-record-update.ts:80-89, pinned SELECT read from the wrong column), and `usesTextSlot`/`pinnedEngineOverrideValue` (override-slot.ts:25-26, 54-59).

Decision: introduce a single predicate in value-io.ts, `usesTextDomain(kind: TargetFieldKind | 'raw'): boolean` (true for `'TEXT' | 'SELECT' | 'raw'`), and rewrite every literal `kind === 'TEXT'` domain check through it (the four above plus the TEXT arms of `normalizeStoredValue`, `normalizeComputedValue`, `buildTargetWriteData`). The `'raw'` arm is load-bearing: two call sites take `OverrideSlotKind = TargetFieldKind | 'raw'`, and `'raw'` carries every deployed mirror override (MULTI_SELECT, LINKS, ...), so it must stay true; the drift-guard test pins all three members. Note `pinnedEngineOverrideValue`'s guard is `slot !== 'TEXT'` (override-slot.ts:58), not a `usesTextSlot` call: a third edit in that file, not covered by rewriting `usesTextSlot`. This kills the whole "second text-domain target" trap class structurally instead of patching call sites one by one. `ComputedValue` keeps its existing `'number' | 'text' | 'raw'` tags: a SELECT result is tagged `'text'`, so the heartbeat lane (formula-repository.ts:443-479) works unchanged.

### D3 · Membership gating, two-tier

**The walker.** A new pure function in the engine, `staticTextOutputs(ast): ReadonlySet<string> | null`, where `null` means "open set". Semantics, complete:
- `string` node: singleton of its value.
- `if` node: union of `then` and `else` results (the condition subtree never contributes; it cannot be the output). IFS/SWITCH already desugar to `if` ladders at parse time (parser.ts:692-706), so ladders come for free; a defaultless ladder's synthesized `null` node contributes nothing.
- `ifblank` node: union of both arguments.
- Everything else in a value position (field ref, crossref, `&`, `TEXT()`, `NUMBER()`, arithmetic, `SUM`, `TODAY`, number literal): open, poisoning the whole result to `null`.
The walker runs only for SELECT targets, after the kind gate has already passed (so the tree is text-kind at the root). It is O(nodes), save-time and pass-time only, never per record.

**Tier 1a, save gate.** `validateExpressionCore` gains an optional `targetOptions` input (D5). For a SELECT target with options in hand and a closed literal set: every literal must be a member of the option value set, except blank literals (empty/whitespace-only), which normalize to null (D4) and are legal. Violation message with did-you-mean, per D6. Open set: accepted (tier 2 covers it). Options not resolvable: skipped, never rejected (the standing posture, ADR 0027 D1/D5). A save-time violation follows the standard save posture: the definition saves but is disabled with the error on `lastError` (handle-formula-change.ts:213-227). This is deliberately harsher than tier 1b's freeze-but-enabled, the same save-vs-recompute asymmetry the kind gate already has. Because validation-core is the single shared dispatch, the editor's live check gets this for free; the editor already holds every host-object field's options (formula-field-input.tsx:193-199, metadata-objects.ts:210-214).

**Tier 1b, per-pass static re-gate.** The recompute paths already re-run the static gates once per definition per pass before any record work (recompute.ts:1056-1081 for the sweep; the single-record entry `recomputeForRecord` re-confirms at recompute.ts:911-949). A new `selectMembershipGateError(compiled, targetOptions)` runs alongside `strictKindGateError` and `blankTargetTypeError` there: for closed sets, it re-validates against the current option set, so deleting an option that a formula's literal names freezes the whole definition write-avoidantly via the existing `refuseWholeDefinition` funnel (recompute.ts:383-393): zero record scans, error on the definition row, zero repeat-pass writes. This is where approach B structurally beats A: option drift on the common formula shape costs one static check per pass instead of N failed evaluations per pass.

Blast radius of a freeze, disclosed: on the event path the gate map (`gateErrorByFormulaId`, handle-record-update.ts:258-273) is also consulted by override detection (skip at handle-record-update.ts:295) and by the recompute loop that carries the v0.4.0 locked-definition revert (handle-record-update.ts:436, 448-451). If the membership gate joins that map, a frozen definition records no overrides and performs no lock reverts while frozen; outside writes stick until the options are fixed, then the next pass corrects them. Whether the membership gate joins the event-path map (full freeze, kind-gate doctrine) or stays sweep-only (events stay per-record live via tier 2, so the lock keeps holding under option drift) is user question 3 in section 9.

**Tier 2, per-record membership check.** At the normalize-then-write choke point: inside `planRecomputeForRecord`, thrown from within the existing try around `normalizeComputedValue` (recompute.ts:855-869) so it rides the established FormulaError funnel, a `Set.has` against the hoisted option set (D5). Runs unconditionally for SELECT targets (defense in depth for mid-pass metadata drift; the check is O(1) and branch-predictable). Violation: new `NOT_AN_OPTION` eval error following standard doctrine (value NOT written, last value kept, error on `lastError`, record save never blocked, zero timeline rows). Null bypasses the check and writes through (clears the field), matching the platform's own semantics (twenty-server validate-rating-and-select-field-or-throw.util.ts:27).

Hoist points, complete: the sweep resolves the option set once per pass (alongside recompute.ts:1049-1051) and calls `planRecomputeForRecord` directly. The single-record entry `recomputeForRecord` (recompute.ts:904-984) resolves its own with the same `args.targetOptions ?? await ...` fallback pattern the kind gate uses (recompute.ts:940-942); `RecomputeArgs` (recompute.ts:395-417) gains `targetOptions`, and all three production callers thread their already-resolved set: the event path (handle-record-update.ts:498-508), the widget override toggle-off (formula-editor.tsx:808-820), and the TODAY-staleness refresh (refresh-stale-formulas.ts:136-147). Without this threading, tier 2 silently degrades to skip on exactly the most user-visible single-record paths.

The platform independently validates SELECT writes on the GraphQL path and rejects non-members loudly (`Invalid value "X" for field "y". Valid values are: ...`, INVALID_ARGS_DATA), so tier 2 never risks silent corruption; its job is to fail with a formula-doctrine error instead of a generic `Failed to write ...` wrapper, and to keep a non-member value out of the batch so `flushBatchedWrites` never has to fall back to its per-record retry path (batch-write.ts:84-96), which would cost up to 100 extra mutations per poisoned group.

### D4 · Blank and null normalization for SELECT targets

- Computed `null` writes `null`: the field clears. Wizard-created value fields are nullable (the create payload never sets `isNullable: false`), and the platform allows clearing a nullable SELECT regardless of options.
- Computed blank text (empty or whitespace-only) normalizes to `null` in the SELECT arm of `normalizeComputedValue`. Rationale: the platform makes `''` structurally impossible as an option value (min length 1, UPPER_SNAKE regex), so without this rule every `&`-chain whose parts are all null (null parts become `""`, ADR 0026) would be a permanent per-record error. Blankness already means "null or empty/whitespace text" everywhere in the language (ISBLANK/IFBLANK doctrine), so blank-clears is the consistent reading, not a new coercion.
- Consequence for the static tier: blank string literals in branches are legal (they mean "clear"), and the walker's membership check applies to non-blank literals only.
- F1-empty-string interaction: none by construction. That bug concerns `""` persistence on TEXT dependency fields; a SELECT target never legitimately holds `""` and this design never writes one.

### D5 · Option-set plumbing (no new queries, no new hot-path I/O)

The option data is already resident: `loadAllObjectsWithFields()` fetches and caches `options` per field (metadata-objects.ts:202-214, 243; process-global, workspace-keyed, 60s TTL, in-flight dedup), and it is the same cache entry `loadFieldKinds` reads. What is missing is an accessor: the recompute layer only ever sees the stripped `Map<name, type>` (dynamic-client.ts:168-193 discards `field.options`).

- New accessor in metadata-objects.ts: `targetFieldOptions(objectName, fieldName): Promise<ReadonlyArray<{value: string; label: string}> | null>` (null when the field or its options cannot be resolved). Direct-call precedent: syncable-fields.ts:44, formula-status.ts:179 already bypass the `FormulaClient` abstraction for this cache.
- Recompute pass: resolved once alongside `resolveKindsForFormula` (recompute.ts:1049-1051), built into a `ReadonlySet<string>` once, threaded through the existing args plumbing into the static re-gate and `planRecomputeForRecord`. Event path: once per event alongside its kinds map, same discipline (ADR 0027 D5: once per pass / once per event, never per record).
- Save path: `validateFormula` and `validateExpressionCore` are synchronous and stay that way; they take options as data. The async resolution happens in `handle-formula-change.ts`, which preloads the target field's options alongside its existing `preloadKinds` pass (handle-formula-change.ts:177-205), exactly the kinds pattern. The editor passes its already-fetched options through `validateExpression`. Undefined options at any call site degrade to skip-never-reject; the recompute paths always resolve them, so a definition cannot permanently dodge the gate.
- An empty options array is treated as unresolvable (skip) at every call site: the editor structurally cannot distinguish empty from absent (`deriveObjectFields` drops empty option arrays, formula-field-input.tsx:193-204), and the platform guarantees a created SELECT field has at least one option, so `[]` only arises from degraded metadata.
- validation-core stays front-bundle-safe: it receives options as a plain argument; it does not import the metadata loader (its comment forbids dependencies beyond src/engine and mirror-kinds; the caller supplies data, ADR 0024 bundle discipline).

### D6 · Errors and surfacing

- **Static gate message** (editor live check, save, per-pass re-gate; same string everywhere): `Formula can produce "Hot", which is not an option of the target field (options: HOT, COLD, NEW)`. The option list is bounded (first 6 values, then an ellipsis). When the offending literal case-insensitively matches an option value or label, append the hint: `Did you mean "HOT"?`. This catches the label-vs-value trap (users think in labels; the platform forces UPPER_SNAKE values) at zero runtime cost.
- **Runtime error**: new `FormulaError` code `NOT_AN_OPTION`; the funnel prefixes the code (recompute.ts:863-865), so the surfaced string is `NOT_AN_OPTION: "WARM" is not an option of dealStage` (value excerpt bounded to 80 chars, existing convention), matching the `NON_NUMERIC_VALUE`/`TEXT_TOO_LONG` precedent.
- **Staleness honesty**: gate results read the 60s-TTL metadata cache, so after an options edit the worker-side gates self-heal within a minute; freeze and error copy must not read as permanent state.
- **No new UI surface**: both strings ride the existing `liveError`/`lastError` channel into `<ErrText>` in both editors (formula-editor.tsx:1032-1038, formula-definition-editor.tsx:653-661) and the existing status plumbing.
- The kind-gate mismatch message for SELECT targets stays generic (`Formula computes number but the target field holds text`, with the `Wrap it in TEXT(...)` suggestion): accurate, since a SELECT holds text values, and the membership gate carries the SELECT-specific vocabulary.
- Matching is by option **value**, case-sensitively, exactly like every other string comparison in the language. No label matching, no case folding at runtime.

### D7 · Wizard: the 9th format and the options editor

- New `OUTPUT_FORMATS` entry: `{ key: 'select', label: 'Select', hint: 'one of a fixed set of options', fieldType: 'SELECT', targetFieldType: 'SELECT', defaultDecimals: 0 }` (`defaultDecimals` is a registry-shape requirement, unused by SELECT).
- **Step 2b for `select` is an options editor**: ordered rows of label + color; the option value is auto-derived from the label (uppercase, non-alphanumerics collapsed to `_`, no leading digit or double underscore, 63-char cap) to satisfy the platform validator (`/^(?!.*__)[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/`), with the derived value shown read-only per row. Colors cycle a default palette from Twenty's `TagColor` names; position is row order (drag-reorder can borrow reorder-definitions.ts math; v1 may ship with up/down controls instead, planner's choice). Validity rule in `areFormatOptionsValid`: at least one option, all values valid and unique, labels non-empty, comma-free, 63-char cap.
- **Draft persistence**: the options array rides `targetFieldSettings` JSON like the mirror draft does (`TargetFieldSettings` gains an optional `selectOptions` slot with a recovery arm in `parseTargetFieldSettings`, the `parseMirrorDraft` pattern), so the wizard resumes mid-draft. Resume reads `selectOptions` directly; `optionsFromSettings` stays off the SELECT path entirely (it only ever receives the inner `settings` object, which is null for SELECT).
- **Creation**: the format-mode `createOneField` payload gains `...(isSelect ? { options } : {})`, no ids (server assigns v4 ids, context.md:1209-1215). `buildFieldSettings` returns null for SELECT (options are a field-level input, not a settings JSON key); `formatKeyForType` gains a SELECT case so the settings editor stops falling through to the integer form, and legacy rows must reach it via `targetFieldType`, not `outputFormat` (deployed SELECT mirrors keep `outputFormat: 'mirror'`).
- **Post-creation settings editor**: label editing works as-is. Options editing in v1 is **add + rename only** (label, color, value rename in place): `loadField` additionally queries live `options` (with ids), and `save()` sends the full array back preserving every existing option's `id` (the platform update is full-replace keyed by id; omitting an id is a silent delete-and-recreate, and removal silently remaps records holding that value to default/NULL). **Option removal is deliberately not offered in v1**; users who need it have Twenty's native field settings, and the per-pass static gate (D3) plus tier 2 turn any resulting drift into visible freezes/errors instead of silent data damage. Every options update triggers a full Postgres enum rebuild server-side, so the editor performs one `updateOneField` per explicit user save, never automatic syncing. After a successful save the editor calls `invalidateMetadataCache()` so the front's own live gate re-reads immediately; the worker's cache self-heals within the 60s TTL (D6 staleness honesty), and the editor copy notes the sub-minute lag.

### D8 · Mirror-flow reroute for SELECT sources

The wizard's "Mirror another field" flow keeps offering SELECT sources, but the created definition rides the engine lane, replaying the TEXT precedent (`isTextTarget`, formula-setup-wizard.tsx:760, 796): `isSelectTarget = sourceField.type === 'SELECT'` routes to `outputFormat: 'select'`, clones the source's options onto the new field via the existing `cloneMirrorOptions`, and seeds the expression (bare ref same-record, crossref cross-record). The seeded one-term formula has an open literal set, so tier 2 covers post-creation option drift between source and target. `pickableMirrorSourceFields` keeps SELECT in the list (the filter widens to `isMirrorTargetKind || type === 'SELECT'`). This deliberately diverges from the TEXT precedent, where ADR 0026 dropped TEXT from the mirror picker entirely (its B8): a TEXT copy loses nothing by being typed as a one-term formula in the format flow, but a SELECT copy would lose option cloning, which is real setup work; the mirror flow is the only place that clones options from a source field.

## 4 · Back-compat and migration posture

Zero data rewrite, zero schema changes, no migration, matching ADR 0026's posture (its lines 193-204):

- **Deployed SELECT mirrors become one-term engine formulas** automatically at the lane move: same verbatim string write, same convergence compare (`===`), and the override slot is encoding-compatible (`overrideSlotForKind` mapped SELECT mirrors to `'raw'`, whose JSON text-slot encoding is byte-identical to the text slot SELECT now uses via `usesTextDomain`). A deployed SELECT-mirror override or heartbeat round-trips through the new lane unchanged. Their behavior improves: kind gate now applies (a bare BOOLEAN ref onto SELECT that the mirror gate would have caught is still rejected, now by kind), and membership violations become doctrine errors instead of generic write failures.
- **One save-time check loosens**: SELECT targets leave mirror branch 1c, so its same-kind rule (`Cannot mirror TEXT field "x" onto a SELECT field`, validation-core.ts:147-157) no longer applies. A TEXT-source bare ref onto a SELECT target now validates at save (both are kind `text`) and is covered only by tier 2 per record. Intended: any text-kind expression is legal at the kind tier, and membership is the real gate.
- Legacy `outputFormat: 'mirror'` values on SELECT definitions stay as-is; front-end dispatch treats `targetFieldType` as authoritative (the TEXT precedent left existing rows' outputFormat untouched). One user-visible change: the definition editor's read-only "Mirrors X" provenance panel is gated on `isMirrorTargetKind` (formula-definition-editor.tsx:584-586), so deployed SELECT mirrors flip to the `<FieldSettingsEditor>` branch after the move; the `formatKeyForType` SELECT case (D7) is what keeps that panel from rendering a NUMBER settings form over a SELECT field.
- Old definitions whose expression now violates the membership gate (e.g. a closed literal set naming a deleted option) are not migrated or auto-disabled: they freeze under the per-pass static gate with the reason on the definition row, ADR 0027 D6 legacy doctrine verbatim.
- `formula-definition.object.ts`'s `targetFieldType` is free text (no enum constraint), so `'SELECT'` stores without schema work; only the description string needs updating.

## 5 · Cost model (every operation pays rent)

| Path | Added cost | Notes |
|---|---|---|
| Save / live edit (SELECT targets only) | 1 AST walk O(nodes) + O(literals) set lookups | Editor and server share one code path; zero cost for other targets |
| Recompute pass, per SELECT-target definition | 1 metadata cache read (usually hot), 1 Set build O(options), 1 closed-set re-check O(literals) | The options read and the kinds read ride two 60s caches with independent clocks (dynamic-client.ts:156, metadata-objects.ts:56); worst case one shared, in-flight-deduped metadata pull per worker per 60s, cache-hit in the common case |
| Per record (SELECT targets only) | 1 `Set.has` at the existing normalize-then-write choke point | O(1), no I/O, no allocation |
| Event path, per event | Same as per-pass, once | Same once-per-event discipline as the kinds map |
| Broken definition (closed set, e.g. typo or option drift) | 1 static check per pass, zero record scans, zero writes | vs. approach A's N failed evaluations per pass forever |
| Broken records under an open set | 1 eval + 1 failed membership check per record per pass, zero writes | Irreducible: statics cannot decide; error string stable so heartbeat writes nothing on repeat passes |
| Options create | 0 extra mutations (rides the existing `createOneField`) | |
| Options edit (post-creation) | 1 `updateOneField` per explicit user save; platform performs a full enum rebuild | User-initiated and rare; never automatic; documented in the editor copy |
| Non-SELECT formulas | Zero | Every new branch is behind a `targetFieldType === 'SELECT'` guard |

No new queries on any hot path; no per-record metadata access; no new writes on converged state.

## 6 · Touch map (file level, from the code survey)

Backend/engine:
- `value-io.ts`: `ENGINE_FAMILY` + `usesTextDomain` + SELECT routing in `normalizeStoredValue` / `normalizeComputedValue` (blank-to-null) / `tagEngineValue` / `buildTargetWriteData`.
- `mirror-kinds.ts`: drop SELECT from `MIRRORABLE_KINDS`.
- `kind-inference.ts`: `EXPECTED_KIND_BY_TARGET.SELECT` (compile-forced).
- New engine walker `staticTextOutputs` (src/engine) + `selectMembershipGateError` (kind-inference or sibling module).
- `validation-core.ts` / `save-validation.ts` / `validate-expression.ts`: thread `targetOptions` (synchronous, data-taking), run the static gate.
- `handle-formula-change.ts`: preload the target field's options alongside `preloadKinds` (the async seam for tier 1a).
- `metadata-objects.ts`: `targetFieldOptions` accessor over the existing cache.
- `recompute.ts` / `handle-record-update.ts`: hoist option set per pass/event, static re-gate, tier-2 check inside the normalize try; `RecomputeArgs.targetOptions` with the kind-gate fallback pattern in `recomputeForRecord`.
- `refresh-stale-formulas.ts` and formula-editor.tsx's override toggle-off call site: thread `targetOptions` into `recomputeForRecord`.
- `override-repository.ts` / `override-slot.ts` / handle-record-update's `pinnedOverrideValue`: route through `usesTextDomain`.
- `errors.ts`: `NOT_AN_OPTION`.
- `scripts/audit-strict-gate.ts`: include the membership gate in the pre-deploy audit.

Front:
- `formula-field-formats.ts`: `OutputFormat`/definition unions, 9th entry, `FormatOptions`/`makeFormatOptions`/`buildFieldSettings`/`areFormatOptionsValid` SELECT branches, `TargetFieldSettings.selectOptions` + `parseTargetFieldSettings` recovery arm (`optionsFromSettings` stays off the SELECT path), `pickableMirrorSourceFields` widening.
- `format-options-fields.tsx`: options-editor branch (new list UI from existing primitives).
- `formula-setup-wizard.tsx`: create() options spread, `isSelectTarget` mirror reroute, draft persistence.
- `field-settings-editor.tsx`: `formatKeyForType` SELECT case, options load/edit/save (add + rename only).

Docs/release: ADR 0029, README, context.md, formulahelp reference refresh (post-deploy, per standing memory), docs/adr/README.md index (also backfill the missing 0028 row). Version bump to 0.5.0.

## 7 · Testing

- Engine: `staticTextOutputs` unit table (literals, ladders, ifblank, defaultless IFS, open-set poisoning, blank literals).
- Gate: validation-core closed/open/skip matrix, did-you-mean hint, editor-server message parity.
- Write boundary: value-io SELECT arms (blank-to-null, verbatim write shape), `usesTextDomain` drift guard, override-slot SELECT routing (update the `overrideSlotKind('SELECT') === 'raw'` pin to the new expectation).
- Recompute: per-pass hoist call-count pins (once per pass/event, ADR 0027 testing convention), static-gate freeze on option drift (zero scans), tier-2 `NOT_AN_OPTION` keeps last value, null clears, batch not poisoned.
- Back-compat: deployed SELECT-mirror definition round-trips (override decode, heartbeat, convergence) across the lane move.
- Integration pin (read-side convergence, the F4 null-vs-empty-string class, formula-repository.ts:392-401): clear a SELECT target, re-read it through the record API, assert `normalizeStoredValue(raw, 'SELECT')` is null and the next pass writes nothing. This is a live/integration check, not a unit test; the risk sits entirely in the server round-trip.
- Front: format registry pin update (8 to 9 keys), options-editor validity rules, value derivation vs. the platform regex, wizard resume, mirror reroute.
- Invariants: ENGINE_FAMILY/MIRRORABLE disjointness and the SYNCABLE union unchanged (existing spec pins).

## 8 · Not done / backlog residue this arc creates

- **"Add missing options" one-click fix** on the static-gate error (single `updateOneField`, user-gated): polish backlog, not v1.
- **Option removal in the app's settings editor**: deliberately excluded (D7); revisit only with a danger-zone confirm that names the affected record count.
- **Output-side autocomplete** (suggest option values inside IF/SWITCH branches when the target is SELECT): polish backlog; the did-you-mean hint covers the typo class at zero UI cost.
- **Label rendering in app widgets**: display-value shows the raw option value, a pre-existing gap that now becomes more visible; cheap follow-up, not v1.
- MULTI_SELECT output; label-based matching; any language change.

## 9 · Open questions for the user gate

1. **Queue jump**: the v0.4.0 spec ordered F1-empty-string and the DATE-cast arc ahead of SELECT output (schedule ordering only; no technical dependency stated, and D4 defuses the one plausible F1 interaction). This request pulls SELECT ahead. Confirm the reorder.
2. **Blank-clears doctrine (D4)**: computed empty/whitespace text on a SELECT target silently clears the field instead of erroring. Confirm.
3. **Freeze-on-drift doctrine and its blast radius (D3 tier 1b)**: deleting an option named by a closed-set formula freezes the whole definition (all records) rather than erroring only on records that would compute the deleted value. The review pass surfaced what "frozen" means on the event path: if the membership gate joins `gateErrorByFormulaId`, a frozen definition also records no overrides (handle-record-update.ts:295) and performs no v0.4.0 locked-definition reverts (handle-record-update.ts:436), so an ordinary admin action (deleting an option) temporarily makes a locked field writable and can let a human edit made during the freeze be overwritten after unfreeze. The pre-existing kind gate has exactly this shape, but kind drift needs a schema change while option edits are routine. Two postures:
   - (a) Full freeze, kind-gate doctrine: cheapest, one consistent lane, damage window self-corrects once options are fixed. Recommended.
   - (b) Sweep-only freeze: the hourly sweep freezes (the efficiency win stands), but the event path skips the definition-level gate and relies on tier 2 per record, so lock reverts and override detection keep working under drift, at one eval + one Set.has per touched record.
   Pick one.
4. **Options editing scope (D7)**: v1 is add + rename, no removal. Confirm.

## 10 · Decision log

- 2026-08-10: spec drafted. Approach B (two-tier membership gate) chosen over runtime-only (A) on efficiency-doctrine grounds and over closed-set-required (C) on expressiveness/lane-invariant grounds. Lane move, text-domain predicate consolidation, blank-clears normalization, add-plus-rename-only options editing, and the mirror reroute decided as above.
- 2026-08-10: opus code-cross-reference review pass (13 findings, 0 blockers). Applied directly: tier-1a wiring through handle-formula-change's preload seam (the sync core takes options as data); `targetOptions` threading through `recomputeForRecord` and its three callers; `usesTextDomain` widened to include `'raw'` plus the third override-slot edit; empty option arrays treated as unresolvable; batch-poisoning rationale corrected to the per-record-retry-storm cost; cost-table "strictly cheaper" claim corrected for the two-cache clock offset; `NOT_AN_OPTION` message quoted with its code prefix and thrown inside the normalize try; 60s-TTL staleness honesty notes (front invalidate + worker self-heal); wizard resume via `parseTargetFieldSettings.selectOptions` with `optionsFromSettings` off the SELECT path; section 4 disclosures (branch-1c loosening for TEXT-onto-SELECT, provenance-panel swap for deployed mirrors); read-side null-convergence integration pin in section 7. Escalated to the user gate: the tier-1b freeze's event-path blast radius (question 3 expanded with postures (a)/(b)).
