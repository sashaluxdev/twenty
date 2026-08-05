# FINAL ALIGNMENT REVIEW — strict kind typing arc

**VERDICT: AMEND FIRST.** The architecture is sound and no fleet finding refutes a holistic verdict at the design level. But eleven defects would break the build, break the suite, or silently void a load-bearing pin on first contact — including one write path that bypasses the gate entirely and three pre-existing tests the plan never names. All are text-level fixes to the two documents; none require redesign. Estimated amendment effort: one editing pass, no new investigation.

---

## 1. Cross-check: fleet vs. holistic, fleet vs. fleet

**No fleet report contradicts another.** The only two apparent divergences are non-substantive: batch 2 cites branch 1b at `validation-core.ts:102-114` and batch 3 at `:94-114` (94 is the comment head, 102 the guard — I read the file, both are right); batch 6's UNVERIFIABLE line-staleness note is about T5's future diff, not a disagreement with batch 5's confirmations.

**Fleet findings that change holistic verdicts:**

| Holistic claim | Fleet evidence | Revised |
|---|---|---|
| Coherence gap (a): "SWITCH/IFS never mentioned, plan relies *silently* on desugaring" | Batch 2 verified `parseSwitch` emits `{type:'comparison',operator:'='}` rungs folded by `foldLadder`; `AstNode` has no switch/ifs member | **Downgraded to cheap insurance.** The reliance is correct, not silent risk. Add one test row, not a table entry. |
| Doctrine (ADR 0024) "contingent on the import assumption flagged below" | Batch 2: `validation-core.ts` already imports `ENGINE_FAMILY_KINDS` from `mirror-kinds`, which already pulls `value-io` | **Contingency discharged.** Bundle-neutrality claim stands. |
| Risk: "T6 gets four good pins" | Batch 6 I12/I13: the zero-scan pin cannot detect a gate placed after `loadOverriddenRecordIds`, and the event-path pin describes an impossible assertion | **Downgraded to two working pins.** T6's proof density is now the *weakest*, not the strongest. |
| Concern #1: `formula-editor.tsx` owned by no task | Batches 4+5 both confirm `:782`; I found a **second** ungated caller the holistic missed | **Escalated.** Two ungated write paths, not one. |
| Concern #3 (T5/T6 placement collision) | Batch 6 confirmed 748<751<766 exactly; batch 6's UNVERIFIABLE flags T5's insertions will shift them | **Confirmed and sharpened.** |

**Interface contracts undermined:** two. T6's `client.mutations`-filtered assertion is not implementable (`mutations` is `public mutations = 0`, a scalar; the filterable array is `mutationSelections`, fake-client.ts:56), and T6's claimed "cyclic-skip precedent" shape does not exist in the codebase (see A15).

---

## 2. Load-bearing assumptions — final status

| # | Assumption | Status |
|---|---|---|
| 1 | IFS/SWITCH desugar to IF ladders, no residual nodes | **VERIFIED** (batch 2, batch 1) |
| 2 | 748 < 751 < 766; hoist can precede 748 | **VERIFIED** — I read recompute.ts:740-766: everything before 748 is local consts, no awaits, so the hoist has room |
| 3 | Cyclic skip returns the synthetic shape T6 mimics; consumers tolerate it | **REFUTED as stated / SAFE in substance.** `grep "targetRecordId: ''"` → zero hits repo-wide. The cyclic skip is `formula-sweep.ts:66-75`, which `continue`s *before* calling `recomputeAllRecords` and writes `lastError` directly. **However** all four `recomputeAllRecords` callers (formula-sweep.ts:77, handle-formula-change.ts:169, handle-record-update.ts:349, handle-definition-lifecycle.ts:203) touch only `.length`, `.changed`, `.error` — the synthetic outcome is tolerated. Write-avoidance is real but comes from `recordEvaluationHeartbeat`'s own comparisons (formula-repository.ts:369, 383-390, 399-407), not from the cyclic skip. |
| 4 | Branch 1c constrains mirror lane to bare refs | **VERIFIED** — 1c(b) `bareReferenceOf(ast) === null → reject` |
| 5 | Bundle import edge already exists | **VERIFIED** |
| 6 | Heartbeat: 4 sites, named field sets | **VERIFIED** — I re-read 363-413; exactly 4 `updateFormulaBookkeeping` calls with exactly the keys T6 names |
| 7 | date-serial imports/importers | **VERIFIED** |
| 8 | `toNumber` is the single choke point for NON_NUMERIC_VALUE messages | **PARTIALLY REFUTED.** Eight throw sites. `evaluator.ts:332/388/464/481` interpolate bounded values (a number, a node type) — harmless. But **`coercion.ts:109` interpolates `JSON.stringify(raw)` unbounded** on the resolver path and lands in `lastError` exactly like the evaluator's. T1's truncation bounds the evaluator/`NUMBER()` path only. |
| 9 | `coerceToNumber` handles JS booleans | **VERIFIED** — `if (typeof raw === 'boolean') return raw ? 1 : 0;` |
| 10 | `preloadKinds` memoized per object | **VERIFIED** — `if (!objectName \|\| kindsByObject.has(objectName)) return;` plus dynamic-client's `fieldKindsCacheByWorkspace` |
| 11 | Parse count 5; `vi.mock('src/engine/parser')` seam | **VERIFIED** (batch 5 re-derived independently) |
| 12 | RATING is an enum string | **VERIFIED** |
| 13 | FakeClient granularity | **PARTIALLY REFUTED** — see A4/A5 |

Two assumptions (3, 13) are refuted in their literal form; neither breaks the design, both require document amendments so an implementer isn't sent looking for code that doesn't exist or writing an assertion that can't compile.

---

## 3. Triage of every INCORRECT / UNVERIFIABLE finding

**Real must-fix (would break implementation, build, or a load-bearing pin): 11**
B2-I3 (fixture), B2-I4 (ordering message), B3-I7 (unused imports), B3-I8 (three reversed tests), B3-I9 (dead helpers), B4-I10 (missing type import), B6-I12 (under-enforcing pin), B6-I13 (impossible assertion), B6-I14 (both-loops understatement), B7-I15 (globstar), plus B6-U1 promoted to a staleness note.

**Cosmetic (fix in passing): 5** — B1-I1, B1-I2, B3-I6 (citation drift), B2-I5 (message-label inconsistency), B4-I11 (F1 label collision).

**False alarms: 0.** Every INCORRECT finding survived re-checking. B1-I2 is the weakest (citing `:549-568` to include `foldLadder`'s doc comment is defensible), but costs nothing to tighten.

---

## 4. Ranked amendment list

### BLOCKERS — fix before dispatch

**A1. Three pre-existing tests reverse under the new rules and are named nowhere.**
*Document:* implementation plan, Task 3, Step 1. I read `validation-core.spec.ts` and confirmed all three.
- `:44-54` "accepts a concatenation expression onto a TEXT target", `aString & "INV" & 1+TODAY()` — `1+TODAY()` infers `date` (number+date→date), `&` requires text ⇒ now rejected. Replace the expression with `aString & "INV" & TEXT(1 + TODAY())` to preserve the "a full engine expression validates onto TEXT" coverage.
- `:71-90` "rejects a bare ref to a non-text source kind onto a TEXT target" — `toEqual` pins 1d's exact message `Cannot mirror BOOLEAN field "isActive" onto a TEXT field (kinds must match)`; with 1d deleted this is caught by the output gate with different copy. Change to `expect(result.error).toMatch(/computes boolean but the target field holds text/)`.
- `:105-119` "leaves a non-bare expression … unrestricted", `isActive & ""` — now rejected per S5. Invert to assert `/"&" joins text; wrap boolean values in TEXT\(\)/`, and add a positive companion `TEXT(isActive) & ""` → valid.
*Add the sentence:* "Three additional pre-existing tests reverse; update them in this step — the suite is not green without it."

**A2. Two single-record write paths bypass the gate.** *(escalates holistic #1)*
*Document:* implementation plan, Task 6, Files + Step 3.
`recomputeForRecord` has exactly two non-`handleRecordUpdate` callers, **both ungated** after T6 as written: `src/front-components/formula-editor.tsx:782` (override toggle-off, "hand the record back to the formula") and `src/front-components/lib/refresh-stale-formulas.ts:135` (`recomputeForRecordFn`, the widget's per-record TODAY refresh — **not named in the holistic review**). On a legacy definition like `closeDate = "2026-01-15"` both evaluate a silently-wrong value and write it, while the sweep refuses to — the exact B6 outcome the arc exists to kill.
*Change:* put the gate inside `recomputeForRecord` itself (resolving kinds from `args.fieldKindsByObject` when supplied, else one cached `fieldKinds` call) rather than only at `handleRecordUpdate`'s two loops. That covers all three call sites at one point; `handleRecordUpdate`'s hoisted gate still short-circuits before reaching it, so no per-event rent is added. If the gate stays at call sites instead, add both files to Task 6's **Files** list explicitly.
Note `refresh-stale-formulas.ts:142`'s `recomputeAllRecordsFn` call is already covered.

**A3. Pin the hoist ahead of the gate anchor.** *(holistic #3, confirmed)*
*Document:* implementation plan, Task 5, Interfaces.
*Add:* "Both the hoisted `compileFormula` and `resolveKindsForFormula` must be placed **before** `recompute.ts:748` (`emptyValue`), not merely before `buildScanSelection` — Task 6's gate sits immediately after 748 and needs `compiled.ast` + `kindsByObject` in scope there. Lines 740-748 are local consts with no awaits, so the hoist has room."

**A4. The zero-scan pin cannot detect a misplaced gate.**
*Document:* implementation plan, Task 6, Step 1, first test.
`loadOverriddenRecordIds` queries under the top-level key `formulaOverrides`, not the target object's plural key, so the `Object.keys(selection)[0] === 'opportunities'` filter passes even if the gate lands after line 751 — voiding the placement contract the same task calls load-bearing.
*Change:* `expect(client.querySelections).toHaveLength(0);` (whole-query assertion), or keep the filter and add `expect(client.querySelections.filter((s) => Object.keys(s)[0] === 'formulaOverrides')).toHaveLength(0);`.

**A5. `client.mutations` cannot be filtered.**
*Document:* implementation plan, Task 6, Step 1, second test comment.
`fake-client.ts:49` is `public mutations = 0` (scalar counter); the filterable array is `mutationSelections` (`:56`, pushed at `:324`).
*Change:* "assert on `client.mutationSelections`, filtering by mutation key (`createFormulaOverride`, `updateOpportunity`)".

**A6. Test fixture is incomplete as transcribed.**
*Document:* implementation plan, Task 2, Step 1, `kinds` Map literal.
*Change:* add `['myLinks', 'LINKS'],` into the literal and delete the trailing `// add ['myLinks','LINKS'] …` comment. Without it both opaque rows resolve to `unknown` and *pass*, inverting their expectations.

**A7. Unused imports after the Task 3 edit.**
*Document:* implementation plan, Task 3, Step 3.
`handle-formula-change.ts:1` imports `bareReferenceOf, parse`, used only inside the replaced block (`:114`).
*Change:* "Update the `src/engine` import: add `extractDependencies`, drop `bareReferenceOf` and `parse`." Lint fails otherwise.

**A8. Dead private helpers left behind.**
*Document:* implementation plan, Task 3, Files.
*Change:* "delete `collectStringComparisonRefs` + its export + `StringComparisonRefs` **and its two now-orphaned private helpers `walkStringComparisons` and `collectStringOperand` (dependencies.ts:217-317)**".

**A9. The stale-doctrine audit under-searches.**
*Document:* implementation plan, Task 9, Step 1.
`src/**/__tests__/` collapses to `src/engine/__tests__/` with globstar off (this sandbox's default), silently skipping `coercion.spec.ts` and `recompute.spec.ts` — the very file Task 9 names elsewhere at `:795-843`.
*Change:* `grep -rn "B2\|B6\|date-shaped\|truthiness\|coerces numeric-shaped" src/`.

**A10. No error message for same-family, unequal-kind ordering.**
*Document:* implementation plan, Task 2, Rules, ordering bullet.
`closeDate < syncedAt` and `amount < closeDate` satisfy "in {number,date,datetime}" but not "kinds equal", and no message is specified — this is S8's own named regression.
*Change:* "kinds unequal → reuse `Cannot compare ${left} with ${right} using \"${op}\" (kinds must match)`; kinds equal but outside {number,date,datetime} → `Cannot order ${kind} values with \"${op}\"`." Add rejection rows `['IF(closeDate < syncedAt, 1, 0)', /Cannot compare date with datetime/]` and `['IF(amount < closeDate, 1, 0)', /Cannot compare number with date/]`.

**A11. Test snippet won't compile.**
*Document:* implementation plan, Task 4, Step 1, `value-io.spec.ts` block.
*Change:* prepend "add `type TargetFieldKind` to the existing `src/logic-functions/lib/value-io` import" — the file does not currently import it.

### SHOULD-FIX — fold in during the same pass

**A12. Dotted-subpath kinds are knowingly wrong and create new false rejections.** *(holistic #10)*
*Document:* implementation plan, Task 2, "Node kinds" bullet.
Root-segment inference makes `price.currencyCode` → `number` (it holds text) and `myLinks.primaryLinkUrl` → `opaque`, so `myLinks.primaryLinkUrl & "x"` — which evaluates correctly today — becomes a save rejection with no escape hatch.
*Change:* "a **dotted** path (`segments.length > 1`) infers `unknown` (skip, never reject); only a bare root reference maps through `fieldTypeToKind`." This loosens save-time rejection for dotted paths relative to 1b, which is the safe direction (1b was over-rejecting on paths it never resolved), and simultaneously removes the wrong `price.currencyCode → number`. Add rows: `['myLinks.primaryLinkUrl & "x"', 'text']` and `['price.amountMicros + 1', 'unknown']`. This also discharges D1's undelivered "the implementation plan pins the exact unit for CURRENCY" obligation — bare `price` → `number` (micros), subpaths ungated.

**A13. Close the committed red window on the event path.** *(holistic #2)*
*Document:* implementation plan, Task 4, Step 4.
*Change:* thread the event-path kinds map in Task 4 (map construction is local and cheap) and leave Task 5 to hoist it to once-per-event. Delete "update each to supply kinds **or to pin the new verbatim behavior**" — the second clause invites pins that encode broken semantics and then must be re-reverted.

**A14. Files line understates the T6 diff.**
*Document:* implementation plan, Task 6, Files.
*Change:* "(gate in **both** the override-detection loop and the per-formula loop)".

**A15. Reword the "cyclic-skip precedent".**
*Document:* implementation plan, Task 6, Interfaces + Step 3 (and the Architecture line at plan:7).
No `targetRecordId: ''` outcome exists anywhere in the repo, and the cyclic skip never enters `recomputeAllRecords` — an implementer following the pointer finds nothing.
*Change:* "The synthetic outcome shape is new. Write-avoidance comes from `recordEvaluationHeartbeat`'s own comparisons (formula-repository.ts:369/383/399), not from the cyclic skip; the cyclic skip at `formula-sweep.ts:66-75` is the *posture* precedent (record the problem, skip the work), not the code shape. Verified: all four `recomputeAllRecords` callers consume only `.length`/`.changed`/`.error`, so the empty `targetRecordId` is inert." Add a one-line note that `formula-sweep`'s `evaluated` counter will read 1 for a gated definition.

**A16. Truncation claim is narrower than stated.**
*Document:* implementation plan, Task 1 (and design doc where the 80-char bound is asserted).
`coercion.ts:109` builds `Field value is not numeric (${JSON.stringify(raw)})` unbounded on the resolver path and reaches `lastError` identically.
*Change:* either apply the same 80-char bound at `coercion.ts:109`, or scope the claim to "bounds the evaluator's arithmetic and `NUMBER()` paths; the resolver-side `coerceToNumber` message is unchanged."

**A17. One SWITCH/IFS row (cheap insurance on assumption 1).**
*Document:* implementation plan, Task 2, Step 1.
*Add:* `['SWITCH(stage, "Won", 1, "Lost", 0)', 'number']` and `['SWITCH(closeDate, "2026-01-15", 1, 0)', /Cannot compare date with text/]`. If the desugar ever changes, this row fails loudly instead of silently returning `unknown`.

**A18. DATE_TIME convergence pin.** *(holistic #6)*
*Document:* implementation plan, Task 4.
*Change:* duplicate the two-pass/zero-write convergence test for a DATE_TIME target (fractional serial → ISO → store → re-read → parse → bit-identical float under `valuesEqual`'s `===`). One fixture; guards ADR 0022's catastrophic mode at its likeliest point.

**A19. Two-formula isolation pin.** *(holistic #7)*
*Document:* implementation plan, Task 5.
*Change:* add a test where one event matches two engine-lane formulas with different ASTs and assert each writes its own value — a scoping error in the hoist writes formula A's result to formula B's records with no error surfaced.

**A20. Cross-record kind mismatch has zero coverage.** *(holistic #5)*
*Document:* implementation plan, Task 3, Step 1 (+ one row in Task 2).
D5 types cross-record operands for the first time (1b exempted them). Add a rejection test whose mismatch lives on a cross-ref object, and note in Task 10's ADR that the editor keeps only its host-object map, so cross-record mismatches are an editor-accepts / server-rejects class.

### COSMETIC — fix in passing

**A21.** Design doc / Task 10: name datetime↔date bridging in **Not-done** (S8 removes `syncedAt > TODAY()` with no sanctioned rewrite, unlike S1/S3/S5 which each ship one). *(holistic #4)*
**A22.** Design doc D1: "five kinds" → seven (`opaque`, `unknown`); reconcile before it propagates into ADR 0027. Add a line that `boolean` is an unreachable *output* kind.
**A23.** Design doc: disambiguate the two `F1`s (efficiency-review scope guard vs. the pre-existing empty-string bug from `verification-reports/T6-verdict.md`).
**A24.** Task 2 Rules: state that `opaque` renders as the bare label `opaque` in generic mismatch messages but as the raw field type in `TEXT()`'s dedicated message — or unify on the raw type.
**A25.** Citation drift: Task 1 `parser.ts:235-309` → `:235-268` (or `:235-318` if the whole reserved-word region was meant); `foldLadder` → `:554-568`; Task 3 `handle-formula-change.ts:103-110` → `:112-120`.
**A26.** Task 6: add "line numbers are as of pre-Task-5; after Task 5's hoist, anchor on the content markers (`emptyValue`, `loadOverriddenRecordIds`, `buildScanSelection`), not the numbers."
**A27.** Missing rows: `syncedAt + 30` → datetime (T2); output-gate rows for DATE_TIME and CURRENCY targets (T2); a negative control in T6 proving a *passing* definition still scans after the gate lands.

### CONSIDERED AND DECLINED

**Holistic #8 (lazy event-path kinds map) and #9 (stamp kinds on field nodes).** Both are genuine rent observations, both are optimizations of code that does not exist yet. Recommend recording them as an explicit accept/reject line in Task 5 and Task 4 respectively ("considered, deferred: the per-reference root-split + two map lookups is accepted for v1") rather than expanding scope mid-arc. #9 in particular interacts with A12 — if dotted paths become `unknown`, the stamping shape changes — so it should be revisited after this arc, not during.

---

## 5. Dispatch readiness

Apply **A1-A11** and the arc is dispatchable; **A12-A20** are strongly recommended in the same editing pass because each targets an under-proved hot spot the holistic review already flagged, and all are one-paragraph or one-fixture changes. **A21-A27** can ride along or be swept into Task 10.

After amendment the only remaining open item is the one the plan already schedules correctly: T6's line citations will shift under T5's hoist, mitigated by the content anchors A26 makes explicit.