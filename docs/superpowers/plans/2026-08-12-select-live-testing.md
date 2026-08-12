# SELECT Output v0.5.0 + Cleanup Wave — Production-Emulation Test Plan (local dev env)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or direct execution with the same per-phase evidence discipline. Steps use checkbox (`- [ ]`) syntax. This plan TESTS existing code; no production source files may be modified except the one sanctioned local-only tweak (sweep cadence, Phase 0), reverted in Phase 6.

**Status: REVIEWED (opus code-cross-referencing pass 2026-08-12; 12 mechanical corrections folded in; 5 semantic rulings recorded below). Ready to execute in a fresh session.**

**Goal:** exercise every surface touched by v0.5.0 (merged to main `717ad2e508`) and the cleanup wave (branch `feat/formula-field-cleanup-wave`, `156c3afab8..c5dd4593e3`) against a live local Twenty instance under production-shaped data; catch edge cases the unit pins can't see; survey performance against the spec §5 cost model.

**Tree under test:** `feat/formula-field-cleanup-wave` (= upstream v2.30 + v0.5.0 + cleanup). Checked out and clean. Do not merge or rebase anything.

**Evidence convention:** `packages/twenty-apps/community/formula-field/verification-reports/2026-08-12-select-live/` — one `P<phase>-<check>.md` per check (commands, raw output, verdict) plus screenshots. `verification-reports/` is git-excluded via `.git/info/exclude`; it must never enter a commit.

## Review rulings (2026-08-12, recorded for the executor; user may override)

1. **Cadence:** `*/3 * * * *` (every 3 min), NOT per-minute — the sweep budget is 100s (`formula-sweep.ts:21`) with `timeoutSeconds: 120`, so a 1-min cadence overlaps passes and makes Phase 4's timings meaningless. Phase 4 additionally requires the completes-within-budget precondition (4.0).
2. **Tier-2's live-reachable case is the cross-field option mismatch** (Phase 1's seeding mechanism), because the platform guarantees a SELECT column can never hold a non-member (enum coercion + native PG enum + option-delete migration nulls unmapped rows). The mid-pass-drift race in ADR 0029 D3's "defense in depth" framing stays unit-pinned only; no live timing test is attempted. Surface this nuance to the user as ADR wording context, not a failure.
3. **refresh-stale-formulas gets live coverage** (new 3.10) — it was touched by v0.5.0, runs a full browser-side sweep, and had zero live checks.
4. **Legacy pin back-compat:** the string-pin case is free by construction (same column, same encoding pre/post-0.5.0); the genuinely distinct legacy shape is a NON-STRING mirror pin (1.3b seeds both). If the user believed string pins carried migration risk, that belief is unfounded.
5. **Phase ordering:** the integration suite wipes all formula definitions and uninstalls the app — it runs LAST (5.3), after all snapshots and report data are captured.

**Known env facts (verified 2026-08-12, do not rediscover):**
- Dev server/worker are DOWN. Post-upstream-merge DB NOT migrated — Phase 0 resets it fresh instead.
- `cron:register:all` bootstraps the server's static pollers once per Redis; app cron triggers ride the `CronTrigger` poller's per-minute metadata scan (`cron-trigger.cron.job.ts`) and need NO per-app registration. Install order does not matter.
- The nx `twenty-server:command` target `dependsOn: ["build"]` and build runs `rimraf dist` — invoking it with the stack up crash-loops server+worker (documented in the 2026-08-04 arc's T6 verdict). Use `twenty-server:command-no-deps`.
- `twenty app deploy`/`appInstall` reject same-version and downgrade tarballs; `twenty dev` manifest sync has NO version gate — use it for the cadence tweak.
- Sweep pattern lives at `formula-sweep.ts:120` (`'0 * * * *'` stock). Budget `SWEEP_BUDGET_MS = 100_000`, page size 100; on budget yield the scan cursor writes the definition row per partial pass.
- `opportunity.stage` is a STANDARD field and `amount` is CURRENCY read as micros (`amountMicros`) — thresholds like `> 100` mean $0.0001. Name seeded fields `oppStage` etc.; use micros-scale thresholds (`> 100000000` = $100) or a plain NUMBER source.
- Auth: `setup-test.ts:18-27` reads `TWENTY_API_URL`/`TWENTY_API_KEY` then falls back to `~/.twenty/config.json` whose `defaultRemote` is `"cloud"` — NOT exporting them points integration runs at PRODUCTION. Local remote is `dev` (`http://127.0.0.1:3000`). **NEVER print/cat `~/.twenty/config.json` — it holds live production credentials. Source silently:** `export TWENTY_API_URL=$(jq -r '.remotes.dev.apiUrl' ~/.twenty/config.json); export TWENTY_API_KEY=$(jq -r '.remotes.dev.apiKey' ~/.twenty/config.json)`.
- `yarn lint` doesn't run from the app dir — `npx oxlint -c .oxlintrc.json .`. TS6305 storms in composite dist/ → `npx tsc -b tsconfig.spec.json`.
- UI login: "Continue with Email", prefilled credentials. Playwright MCP available.

---

## Phase 0 — Environment bring-up

- [ ] **0.1 Fresh database on merged code:** `bash packages/twenty-utils/setup-dev-env.sh --reset` (drops default/test DBs, flushes Redis, re-inits schema — sidesteps the v2.29/v2.30 upgrade-path ambiguity; upgrade-shaped APP state is emulated via API seeding in Phase 1, same precedent as the 2026-08-04 arc's T2 seed).
- [ ] **0.2 Register cron pollers BEFORE starting the stack:** `npx nx run twenty-server:command-no-deps -- cron:register:all` (command-no-deps skips the dist-wiping build dependency; running it pre-stack avoids the crash-loop either way).
- [ ] **0.3 Start the stack:** `npx nx start twenty-server`, `npx nx run twenty-server:worker`, `npx nx start twenty-front` (three background processes; `http://localhost:3000/healthz` = 200; front on :3001).
- [ ] **0.4 Cadence tweak (sanctioned, local-only):** edit `formula-sweep.ts:120` to `pattern: '*/3 * * * *'`, then propagate via `twenty dev` manifest sync (no version gate). Keep the working tree dirty with exactly this one change for the whole run; revert in Phase 6. If `twenty dev` sync is unavailable, fall back to `app deploy` with `package.json` bumped to `0.5.1-cadence` (then 0.5's version assertion becomes "0.5.0 or the cadence build", and `package.json` joins the Phase 6 revert list). Every timing number notes the cadence.
- [ ] **0.5 Deploy + install the app under test** (twenty CLI, env vars exported per the auth fact above; the app-install integration test's lifecycle is the reference for exact calls). Verify installed version and that logic functions + widgets registered.
- [ ] **0.6 Confirm the loop is alive:** trivial NUMBER formula on opportunity via the widget; source edit → event-path write within seconds; one sweep pass fires within ~3 min (worker logs). Evidence: P0-loop.md.

## Phase 1 — Production-shaped seed

All via API (GraphQL / metadata API); seed script at `verification-reports/2026-08-12-select-live/seed.ts` (scratch, never committed).

- [ ] **1.1 Volume:** 3,000 opportunity records. Numeric source: plain NUMBER field `dealScore` with varied values (nulls, 0, negatives, huge). SELECT source `oppStage` with options HOT/WARM/COLD, mixed distribution (~2% WARM — see 1.2's superset mechanism; do NOT attempt to seed non-member enum values: the platform rejects them at GraphQL coercion AND the column is a native PG enum).
- [ ] **1.2 SELECT formula definitions:**
  - `formulaStageClosed`: `IF(dealScore > 100, "HOT", "COLD")` onto a SELECT target with options HOT/COLD/NEW (closed set).
  - `formulaStageOpen`: bare `oppStage` onto a SELECT target whose options are HOT/COLD ONLY — the source's WARM records compute a non-member of the TARGET: the tier-2 path at a controlled distribution, with no illegal data (the gate reads the computed value against target options).
  - `formulaStageBlanky`: `IF(dealScore > 100, "HOT", "")` — blank-clears.
- [ ] **1.3 Legacy-shaped rows (upgrade emulation):** (a) SELECT-target definition with `outputFormat: 'mirror'` + bare-ref expression (`outputFormat` is an unvalidated TEXT field — seedable); (b) TWO formulaOverride rows on a SELECT target: `overrideValueText: '"HOT"'` (string pin — compatible by construction, ruling 4) and `overrideValueText: '42'` (non-string legacy mirror pin → must hit the `restorable: false` branch and re-pin the current value, not clear the field); (c) a mirror-kind (BOOLEAN or MULTI_SELECT) definition with an EMPTY expression — the degenerate row that reaches the settings editor's mirror-kind path (cleanup Item B's only live entry).
- [ ] **1.4 Control group:** one TEXT, one NUMBER formula; one MULTI_SELECT mirror, one RATING mirror — regression sentinels.
- [ ] **1.5 Baseline snapshot:** record counts, definition list with lastError states, one full sweep pass duration from worker logs; assert every definition's `scanCursor` is EMPTY after the pass (pass completed within budget — precondition for all later timing/stability assertions). Evidence: P1-seed.md.

## Phase 2 — Wizard + derivation surfaces (UI, Playwright)

- [ ] **2.1 Select creation happy path:** options editor add/remove (remove disabled at one row), reorder (order = position), color cycling, read-only derived value. Create → options land on the field (metadata API: values, labels, colors, positions, server ids). Screenshots.
- [ ] **2.2 Derivation edge cases (cleanup A live):** `Gagné`→GAGNE, `Café Noir`→CAFE_NOIR, `2nd Stage`→ND_STAGE (ruling 2), `Å`→A, `Søren`→S_REN (documented residue — must still create), `ホット`→rejected ("does not derive a usable option value"), `Cafe`+`Café` together→collision copy naming both labels, 63-char label, comma label rejected. Field NAME: label `Café Noir` → API name `cafeNoir`.
- [ ] **2.3 Draft persistence:** mid-wizard drafts resume after navigate away/back; corrupt the persisted `selectOptions` JSON via API → degrades to the seeded blank row, no crash.
- [ ] **2.4 Create gate + visual:** blank/duplicate labels disable Create with the inline problem line; the derived-value cell renders mono + muted (cleanup C, screenshot).
- [ ] **2.5 Mirror flow reroute:** mirror a native SELECT source (including one with non-ASCII option labels) → options cloned VERBATIM (no derivation pass), definition rides the engine lane (`outputFormat: 'select'`), converges.

## Phase 3 — Gates, recompute, drift (the two-tier core)

- [ ] **3.1 Editor live-check parity:** on a SELECT target: `"TYPO"` → membership error with bounded option list; `"Hot"` → did-you-mean `"HOT"`; 7+ options → ellipsis after 6; `dealScore * 2` → kind-gate message (fires first); open set → no error. Both editors. Byte-compare editor message vs server `lastError` after a forced API save of the same expression.
- [ ] **3.2 Save posture:** API-save a closed-set violation (bypassing the editor) → saved but DISABLED, `lastError` = gate message (ruling 1). Fix expression → re-enable → converges.
- [ ] **3.3 Tier-1b freeze on drift:** with `formulaStageClosed` converged over 3k records, natively DELETE target option COLD → within one tick the definition freezes: `lastError` = membership message, ZERO app scans/writes for it (worker logs). EXPECTED PLATFORM EFFECT (not app behavior): the option-delete migration NULLS every record holding COLD — HOT records unchanged; the app writes nothing while frozen. Outside writes to the target stick (no pin, no lock revert — both-lane freeze, ruling 3). Restore COLD natively → self-heals within the 60s TTL + one tick; nulled records repaired by the first post-unfreeze pass.
- [ ] **3.4 Tier-2 per record:** `formulaStageOpen`'s WARM records keep last value with definition `lastError` = `NOT_AN_OPTION: "WARM" is not an option of <field>`; member records write through in the same pass (batch non-poisoning at volume). Heartbeat stability: with the drifted set STABLE and 1.5's within-budget precondition confirmed, the definition row's `updatedAt` stays stable across passes (firstError is deterministic — id-ordered scan; a cursor-yielding pass invalidates this assertion, reduce volume if so).
- [ ] **3.5 Blank-clears:** flip records across the `dealScore` boundary on `formulaStageBlanky` → field clears to null (UI empty, GraphQL null); settled nulls converge with zero writes; no error loop.
- [ ] **3.6 Overrides on SELECT:** with `allowOverride: true`, human-edit a computed SELECT value to another MEMBER option → pin lands in the JSON-text slot (postgres MCP: `overrideValueText` set, numeric null). Per-record override toggle OFF → value retained, record handed back to the formula; toggle back ON → pin restored from `overrideValueText`, "Override value restored" hint renders. The legacy string pin (1.3b) restores identically; the NON-STRING pin (`'42'`) hits `restorable: false` → re-pins the current value rather than clearing. With `allowOverride: false`, outside edit → lock revert. Under active freeze → neither pin nor revert fires.
- [ ] **3.7 Legacy SELECT mirror (1.3a):** converges on the engine lane (both server and widget route on AST + kind, not outputFormat); settings editor opens via targetFieldType dispatch (select form, label-editable, Save alive, NO options UI); provenance panel renders for the healthy bare-ref definition.
- [ ] **3.8 Settings editors (cleanup B live):** the degenerate mirror-kind row (1.3c) opens label-only: label edit + Save works, NO settings key and NO options key in the mutation (network log), no NUMBER form. A real NUMBER formula's settings editor still shows the number form. SELECT hint renders only for SELECT targets.
- [ ] **3.9 Audit script:** `npx tsx scripts/audit-strict-gate.ts dev` with 3.3's drift active → frozen definition buckets GATED with the membership verdict; healthy ones pass.
- [ ] **3.10 Browser-side sweep (refresh-stale-formulas, ruling 3):** open the FormulaDefinition page for `formulaStageClosed` UNDER active drift → the browser-initiated sweep freezes identically to the worker's (no writes, same lastError), respects its 60s module-global throttle, and does not flood queries (watch the network tab — this is ADR 0023's regression surface). Repeat on the healthy definition → converges.

## Phase 4 — Performance survey (spec §5 cost model)

All numbers note the `*/3` cadence; three runs each, report median.
- [ ] **4.0 Precondition:** every seeded definition's `scanCursor` empty after each measured pass (within-budget). If any pass yields, reduce definition count or volume until clean — timing assertions are invalid on yielding passes.
- [ ] **4.1 Sweep pass wall time** at 3k records: SELECT closed-set vs TEXT control vs NUMBER control — SELECT overhead must be statistically indistinguishable from TEXT (one metadata read per pass + one `Set.has` per record).
- [ ] **4.2 Once-per-pass discipline:** evidence = (a) the unit pin (toHaveBeenCalledTimes(1)) plus (b) the timing delta — SELECT pass wall time must not scale super-linearly vs the TEXT control (a per-record metadata fetch would). Postgres query counts CANNOT observe this (options ride a process-global 60s cache over the metadata HTTP API) — do not attempt.
- [ ] **4.3 Freeze cost:** drifted closed-set definition at 3k records — frozen-definition pass cost ≈ constant (no scan; log timing vs healthy pass).
- [ ] **4.4 Event-path latency:** p50/p95 of source-edit → SELECT target visible write, 20 samples (API polling with timestamps), vs the NUMBER control.
- [ ] **4.5 Editor responsiveness:** 50-option SELECT target — live membership check smooth per keystroke; wizard options editor usable at 50 rows.
- [ ] **4.6 Tier-2 error volume:** ~60 drifted records (2%) — pass-duration impact vs clean pass; definition-row write count stays 1 (heartbeat short-circuit).

## Phase 5 — Regression sentinels (ORDER MATTERS — 5.3 is destructive)

- [ ] **5.1** TEXT/NUMBER controls: values identical before/after all phases (snapshot diff).
- [ ] **5.2** MULTI_SELECT and RATING mirrors: still mirror-lane (raw passthrough, raw-slot overrides), untouched.
- [ ] **5.3 LAST, after all snapshots and report data are captured:** unit suite `npx vitest run`; then the integration suite — WARNING: its lifecycle deletes ALL formula definitions, installs at version `0.1.<timestamp>`, and uninstalls in afterAll. First `twenty app uninstall` the 0.5.0 install (else the suite's install is rejected as a downgrade). Expect app `package.json` left dirty if the run aborts. `npx vitest run --config vitest.integration.config.ts`.

## Phase 6 — Teardown and report

- [ ] **6.1 Revert local tweaks:** `git checkout -- packages/twenty-apps/community/formula-field/src/logic-functions/formula-sweep.ts packages/twenty-apps/community/formula-field/package.json` (the cadence tweak and/or the integration suite both mutate them); `git status` must be clean. Redeploy a clean build only if the env is being kept alive (note: 5.3 leaves the app uninstalled).
- [ ] **6.2 Findings report:** `verification-reports/2026-08-12-select-live/REPORT.md` — per-surface verdict table, failures with repro, performance table vs cost model, fix-list (fixes are a separate wave).
- [ ] **6.3 Decision package for the user:** integration menu for `feat/formula-field-cleanup-wave` (merge/PR/keep) + cloud-deploy go/no-go for v0.5.0 (and still-pending v0.4.0) + formulahelp refresh (must carry the diacritic fold rule) + the ADR 0029 D3 wording nuance from ruling 2.

## Not in this plan (deliberate)
- Cloud deploy and the formulahelp refresh (user-gated, post-testing).
- Fixing anything found — findings feed a separate fix wave.
- A live mid-pass-drift race test for tier 2 (ruling 2: unit-pinned only).
- Load beyond 3k records or multi-workspace emulation.
