# Formula-field cleanup wave (post-v0.5.0)

**Status: APPROVED FOR EXECUTION (commissioned by user 2026-08-12; opus code-cross-referencing review pass done same day, all 14 mechanical corrections folded in below; 4 semantic rulings recorded in section "Review rulings").**

Scope source: the three code follow-ups named in the v0.5.0 final report. Explicitly OUT of scope, with reasons:
- formulahelp skill refresh — gated on the cloud deploy per the v0.5.0 plan and standing memory. RIDER: the queued refresh must carry Item A's fold rule, or it ships a stale derivation description.
- Post-deploy live check of a deployed SELECT mirror's raw-slot pin — needs cloud data.
- The v0.5.0 ledger's deferred minors — not commissioned; unchanged risk; available as a later polish pass.

## Review rulings (2026-08-12, orchestrator, user unattended — surfaced in final report)

1. **Item B kept as defense-in-depth.** The reviewer proved the NUMBER-form bug is latent: a healthy deployed mirror renders the provenance line, not this editor (formula-definition-editor.tsx:692-714 gates on `mirrorSource`, non-null for bare-ref mirror rows). Reachable only for mirror-kind rows with an empty/unparseable/non-bare expression (API-created or degenerate). Fix is cheap and correct; problem statement corrected below. Implementer/reviewer note: you CANNOT reproduce it by opening a healthy deployed mirror.
2. **`deriveFieldName` folds too** (reviewer semantic finding 2): same silent letter loss (`'Café Noir' → 'cafNoir'`) on the field's permanent, non-editable API name. Same one-line transform, part of Item A.
3. **Duplicate-collision copy names the labels** (semantic finding 3): post-fold, `'Cafe'` and `'Café'` collide while looking different; the bare `'Two options derive the same value.'` is no longer a usable hint. Message becomes `Options "<label1>" and "<label2>" derive the same value.` — update the pinned assertion at `__tests__/formula-field-formats.spec.ts:551-552`.
4. **MonoText stays muted-only** (semantic finding 4): one call site today; the file's other mono styles are documented primary-color exceptions. YAGNI.

## Cost model (all items)

| Item | Path affected | Per-record recompute cost | Other cost |
|---|---|---|---|
| A diacritic fold | wizard label/name derivation (creation-time only) | zero | +`normalize('NFD')` + one regex pass per derive call, O(label) |
| B mirror-kind settings dispatch | field-settings editor (admin UI) | zero | strictly less work: removes a wrong NUMBER-settings write |
| C MonoText archetype | styling only | zero | zero runtime delta |

No item touches the engine, recompute, event, or save-validation paths. The v0.5.0 efficiency invariants are untouched.

## Item A — diacritic folding in both derivers

**Problem.** `deriveOptionValue` (src/front-components/lib/formula-field-formats.ts:417-424) drops non-ASCII letters via the `[^A-Z0-9]+ → _` collapse: `Gagné → GAGN` (silent letter loss, passes validation), `Café Noir → CAF_NOIR`. `deriveFieldName` (:580-599) has the identical defect on the permanent field API name (`'Café Noir' → 'cafNoir'`). Option values and field names are permanent (options: locked ruling 4; names: not editable in the wizard).

**Decision.** Fold diacritics as the FIRST transform in both derivers:

```ts
label.normalize('NFD').replace(/\p{M}/gu, '')
```

- `\p{M}` (combining marks), NOT `\p{Diacritic}` — the reviewer proved `Diacritic` includes ASCII `^` and `` ` `` (plus `·¨¯´¸`), which would change ASCII-label behavior (`'A^B' → AB` instead of `A_B`). `\p{M}` has a zero-diff ASCII sweep. Compiles at target es2018 / TS 5.9.3 (verified).
- Foldings: `Gagné → GAGNE`, `Café Noir → CAFE_NOIR`, `Été → ETE`, `Señor → SENOR`, `Å → A` (rejection-boundary flip: was `''`); `deriveFieldName('Café Noir') → 'cafeNoir'`.
- **Residue (goes in ADR 0029, verbatim intent):** Latin letters with no canonical decomposition still mangle silently and pass validation: `Søren → S_REN`, `Łódź → ODZ`, `Œuvre → UVRE`, `Æther → THER` (Ø/Æ/Œ/Ł/Đ/Þ/Ð class). Non-Latin scripts (`ホット`, `Проба`) still derive `''` and are rejected with the existing copy. Full transliteration needs the `transliteration` dep — forbidden by ADR 0024's no-dependency rule. Pin one residue fixture: `Søren → S_REN`.

**Untouched rulings.** Ruling 2 (leading digits strip, `2nd Stage → ND_STAGE`) byte-identical for ASCII labels (fold deletes only combining marks). `OPTION_VALUE_PATTERN` (:411) unchanged; totality holds — the fold only deletes characters upstream of the existing collapse.

**Collision copy.** `selectOptionsProblem`'s duplicate arm (:446-448) now reports `Options "<label1>" and "<label2>" derive the same value.` using the first colliding pair's trimmed labels. New fixture: `drafts('Cafe', 'Café')` collides with the new message; existing `('Hot!', 'hot')` assertion updated to the new copy.

**Files.** `src/front-components/lib/formula-field-formats.ts` (both derivers + collision message), `src/front-components/lib/__tests__/formula-field-formats.spec.ts` (new fixtures in the existing `describe('deriveOptionValue')` at :485-516: GAGNE/CAFE_NOIR/ETE/SENOR foldings, `Å → A`, `Søren → S_REN`, `ホット → ''`; extend the regex-conformance loop at :509 with `'Gagné'`, `'Café Noir'`; `deriveFieldName` fixtures incl. `'Café Noir' → 'cafeNoir'`; collision-copy updates), `docs/adr/0029-select-output.md` (derivation paragraph: fold clause, non-decomposable residue class, AND the pending "leading digits are stripped, not rejected" clarification — closes a v0.5.0 review minor).

**Tests-first.** New fixtures fail (GAGN etc.), then implement.

## Item B — mirror-kind targets get label-only settings editing (defense-in-depth)

**Problem (corrected).** `formatKeyForType` (src/front-components/lib/field-settings-editor.tsx:53-77) defaults every unlisted `targetFieldType` to the NUMBER path: a mirror-kind row (BOOLEAN/MULTI_SELECT/RATING/LINKS…) that reaches this editor renders the NUMBER format form and Save writes `{type:'number',decimals:0,dataType:'int'}` settings onto the non-number field. LATENT: healthy deployed mirrors render the provenance line instead (`mirrorSource` gate); only API-created or degenerate rows (empty/unparseable/non-bare expression with a mirror kind) reach it. Do not attempt to reproduce via a healthy mirror.

**Decision.**
- `formatKeyForType` returns `OutputFormat | null`. Dispatch: return `null` ONLY when `isMirrorTargetKind(targetFieldType)` (import from `src/logic-functions/lib/mirror-kinds`); keep today's default arm for everything else — a blank/unknown `targetFieldType` means NUMBER app-wide (value-io.ts:47-52, validation-core.ts:136-138) and must keep the NUMBER form. Move nothing else: the current default-arm body already serves real NUMBER targets and stays their path.
- Null-path consumers — ALL of these are additions (nothing throws today for reachable rows, everything throws for null if unguarded):
  1. `:88 isCurrency` — `getOutputFormat(format)` THROWS on null. Guard: `format !== null && getOutputFormat(format).fieldType === 'CURRENCY'`.
  2. `loadField` `optionsFromSettings(format, …)` (:145-151) — throws inside the try/catch → `setError` and `loaded` never set → Save dead forever. Null path must SKIP `optionsFromSettings` (seed `makeFormatOptions('integer')` or keep the initial state, never read on the null path) and still reach `setLoaded(true)`.
  3. `save` `buildFieldSettings(format, options)` (:170) — throws. Null path must NOT CALL it; send no `settings` key and no currency `defaultValue`.
  4. `canSave` (:233) — gains `format === null ||` alongside the existing `format === 'select' ||` bypass (label editing stays alive).
  5. `FormatOptionsFields` render — do not render for null format.
  6. The SELECT hint at :301 is keyed on `targetFieldType === 'SELECT'` — LEAVE IT ALONE.
- The save-time `targetFieldSettings` rewrite stays as-is. Evidence it is safe (so the reviewer need not relitigate): `parseTargetFieldSettings` is read only by the wizard (formula-setup-wizard.tsx:145, :181), which renders only while `!definition.targetField` (formula-definition-editor.tsx:582) — a completed definition never resumes it.

**Hard line.** Unchanged: no `options` key on any mutation, ever.

**Files.** `src/front-components/lib/field-settings-editor.tsx` only (345 lines; `formatKeyForType` has no external importers — grep-verified). No component-test harness; deliverable check is tsc + lint + full suite, and the reviewer verifies the null path by inspection at every consumer listed above.

## Item C — MonoText archetype replaces the raw fontFamily token

**Problem.** `f.optionValue` (src/front-components/lib/format-options-fields.tsx:293) hardcodes `fontFamily: 'ui-monospace, monospace'` inside the file's documented layout-only style object — the plan-conflict parked in the v0.5.0 review.

**Decision.** `src/front-components/lib/ui.tsx` gains, next to `MonoInput` (:187):

```ts
export const MonoText = styled(MutedText)`
  font-family: ui-monospace, monospace;
`;
```

(`MutedText` is an exported `styled.span` at :253; emotion component composition is already proven in this file by `MonoInput = styled(TextInput)`.) Muted-only by design — the file's other raw mono styles are documented primary-color exceptions and stay put.

`format-options-fields.tsx`: `f.optionValue` becomes `{ minWidth: 80 }`, and the single consumer (:364, the derived-value cell) renders `<MonoText style={f.optionValue}>` instead of `<MutedText …>` (import swap). Zero visual change: color rule from MutedText, font rule added, layout unchanged.

**Files.** `src/front-components/lib/ui.tsx`, `src/front-components/lib/format-options-fields.tsx`.

## Execution shape (commissioned)

One wave, three parallel chains (disjoint files), run as a Workflow: sonnet implementers, opus reviewers, one fix round max per item, orchestrator runs the whole-wave gate and makes one scoped commit per item. Branch: `feat/formula-field-cleanup-wave` off main (717ad2e508). Workers never run `git add`/`git commit` (shared-index race). Gate commands (app root): `npx vitest run`, `npx tsc --noEmit` (NOTE: tsconfig excludes `**/*.spec.ts` — vitest execution is the only gate over Item A's fixtures), `npx oxlint -c .oxlintrc.json .`. Integration menu returns to the user after the wave gate.
