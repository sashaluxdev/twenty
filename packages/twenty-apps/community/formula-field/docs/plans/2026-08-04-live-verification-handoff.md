# Live Verification Handoff — string-output arc (pre-deploy)

For: an opus orchestrator session. Written 2026-08-04 at the end of the arc-completion session.
Mode: superpowers:subagent-driven-development discipline — the orchestrator dispatches every mechanical step (server starts, seeding, UI driving, DB queries) to subagents and does only briefs, adjudication, and ledger upkeep. This document is the plan; keep a ledger section at the bottom of this file (append-only) so a stalled session can resume.

## Context — where things stand

- The string-output arc (TEXT formula output, `&` concat, ADR 0026, v0.2.0) is **merged to local main** at `bb30c16bc7`. Nothing pushed, nothing deployed.
- All verification so far was **code-only**: 1084 vitest unit tests / 66 files, tsc, oxlint, greps. The "end-to-end" tests use a fake client. No live server, no real Postgres writes through the SDK, no browser, no real upgrade of persisted v0.1.x data. `.tsx` files have typecheck-only coverage.
- Purpose of this pass: exercise the riskiest behaviors against a real running instance before the user decides on cloud deploy. The two highest-risk items (Phase H): deployed TEXT mirrors over dirty date-shaped data (H1 fix), and the first post-upgrade pass rewriting stored date-shaped TEXT mirror values in place (B2/B5).
- Dev environment is **already up**: local Postgres :5432 and Redis :6379 (native, not Docker), `default` + `test` databases ready, `.env` files in place, schema initialized. Do not re-run setup unless something is broken; the script is `bash packages/twenty-utils/setup-dev-env.sh` (idempotent).
- Package root: `packages/twenty-apps/community/formula-field`. History and all adjudications: `docs/plans/2026-07-31-string-output-execution-ledger.md` (the final `[status]` entry lists ~20 triaged non-blocking follow-ups). Deltas: ADR 0026 Consequences (B1-B8 + H2 same-record caveat).

## Hard constraints

- **No cloud deploy.** Deploy needs explicit user approval and the SDK version must match the hosted platform line.
- **No formulahelp skill edits** (separate user approval).
- **No schema changes, no field UID edits, no push to any remote.**
- Local writes to the dev workspace are fine — that is the point. Note anything destructive in the ledger before doing it.
- Twenty CRM login for UI work: click "Continue with Email", use the prefilled credentials.
- Apps SDK local dev: auth lives on `/metadata`, app served against local `:3000`; the formula-field app must be synced into the local workspace via the SDK CLI before any of this works (check whether it already is before re-syncing).

## Toolbox

- `mcp__postgres__*` — read-only Postgres MCP for verifying rows (workspace schemas hold `formula_definitions`, `formula_overrides`, target tables).
- Playwright MCP (`mcp__playwright__*`) — browser driving for wizard/editor checks.
- `yarn start` / `npx nx start twenty-server` / `npx nx run twenty-server:worker` — app processes. Run them via a background-capable subagent or `run_in_background` Bash; they never terminate on their own.
- Unit suite (regression backstop): `npx vitest run` from the package root — 1084/66 green at merge.

## Model roster (per task)

Dispatch with explicit models: haiku for pure-mechanical (process starts, single-script seeding from a complete spec), sonnet for multi-step drive-and-observe work (UI flows, seed-then-query), opus only where the subagent must judge observed behavior against the ADR in the field. The orchestrator (opus) adjudicates every observation report against the expectations table below — subagents report what happened, the orchestrator decides pass/delta/fail.

## Tasks

Linear except where noted. Each task: one dispatch, report file under the scratchpad or a `verification-reports/` dir the orchestrator chooses, ledger line here on completion.

### T1 — Bring the stack up and confirm the app is live (haiku)
Start server, worker, and front (background). Verify: server GraphQL responds, worker connects to Redis, front serves, login works with prefilled creds. Confirm the formula-field app (v0.2.0 code) is installed/synced in the local workspace — if the local workspace has no formula objects (`formula_definitions` etc. absent from the workspace schema), sync the app with the SDK CLI first and report what that took. Output: process handles/ports, workspace schema name carrying the formula objects.

### T2 — Seed pre-upgrade-shaped state (sonnet)
Goal: rows that look like what a v0.1.x deployment would have on disk the moment v0.2.0 code starts. Since local code is already v0.2.0, simulate by writing definitions/records whose STORED shape matches the old lane, then letting the new code take over:
- A TEXT mirror definition (`outputFormat: 'mirror'`, TEXT source → TEXT target) over records whose source values include: dirty date-shaped strings `8801-25-03`, `1234-56-78`; a valid date-shaped string `2026-01-15`; an ISO datetime-shaped string; a >600-char string; an empty string; a normal string `ACME-42`.
- A numeric formula definition (control — must be untouched by everything below).
- A TEXT-target definition with an active override (pinned value in `overrideValueText`, old JSON convention) — plus one override row hand-written with a NON-string JSON payload (e.g. `123`) to exercise the H4 unrestorable path.
Seeding may go through the app's own APIs where possible; direct SQL only where the old shape cannot be produced by new code (document each direct write). Postgres MCP is read-only — direct writes need the server-side path or a psql call; prefer API-created rows then targeted UPDATEs. Report: exact record ids, definition ids, workspace schema.

### T3 — Upgrade-path observation (sonnet drive, opus adjudication)
Trigger recompute (worker cron or the app's recompute entry point) over the seeded data. Then query and compare against expectations:

| Check | Expectation (source) |
|---|---|
| Dirty date-shaped values (`8801-25-03`, `1234-56-78`) | Copied VERBATIM to target, `error: null`, definition keeps converging — no freeze (H1 fix) |
| Valid date-shaped `2026-01-15` through the TEXT mirror | REWRITTEN in place to the canonical rendering of its epoch-day serial — this is expected delta B2/B5, confirm it matches the ADR's description exactly |
| >600-char value | Target holds full text; `lastValueText` holds a truncated but VALID-JSON envelope that decodes to a string preview (H7) |
| Empty string, `ACME-42` | Verbatim, converging |
| Numeric control definition | Bit-for-bit no change in behavior, heartbeat advancing |
| Overridden TEXT record | Skipped by the sweep (override suppression), stored pin untouched |

Any mismatch that is not literally described in ADR 0026 is a STOP-and-report finding, not something to fix inline.

### T4 — Wizard and editor UI pass (sonnet, Playwright)
1. Create a new formula via the wizard with the **Text** output format; expression with `&` concat; verify save, display of the computed value, and that the Field settings section for TEXT is sane (known cosmetic issue: header/Save over empty body — confirm it is only cosmetic).
2. Confirm TEXT fields are absent from the mirror-source picker (B8) and that the Text-format path replaces it.
3. Override lifecycle on a TEXT row: pin a value (goes to the text slot), disable, re-enable — the pinned value must be restored, not nulled (H4). Repeat with the hand-seeded non-string pin from T2: re-enable must RE-PIN THE CURRENT value, never write null.
4. Editor validation live: bare BOOLEAN ref onto a TEXT target rejected at save with the kinds-must-match message (H3); `isActive & ""` accepted; a TEXT definition's Current-value line renders the decoded heartbeat.
Screenshots for each numbered item into the report dir.

### T5 — Known-delta live demonstrations (sonnet)
Reproduce, on purpose, the two sharp edges the user must see before deploy, and capture them:
- H2: same-record TEXT field holding `2026-01-15` compared `= "2026-01-15"` → false where v0.1.x string mode returned true (silent flip; no save-time protection).
- Lone-string-literal condition (`IF("a", 1, 2)`) now saves and errors per-record at runtime instead of failing at save (undocumented-delta follow-up in the ledger).
These are documentation demos, not bugs to fix.

### T6 — Verdict synthesis (orchestrator, inline)
Collate T3-T5 into a single verdict table: PASS / EXPECTED-DELTA (with ADR cite) / FINDING. Any FINDING: adjudicate — real regressions get one fix dispatch + scoped re-review per SDD, doc-only gaps get appended to the execution ledger's follow-up list. Then present the user the deploy decision: verdict table + ADR 0026 Consequences + the H2/lone-literal demos. **Do not deploy.** Tear down or leave the dev processes per user preference; note which in the ledger.

## Ledger (append-only — orchestrator maintains)

- 2026-08-04 [setup] Handoff written; dev env up (local Postgres/Redis, schema initialized); nothing dispatched yet.
