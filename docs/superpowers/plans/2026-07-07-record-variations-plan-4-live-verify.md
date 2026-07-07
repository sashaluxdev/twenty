# Record Variations — Plan 4: Live Verification + Hardening + Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. This plan is intentionally lean — it is a verification and closure phase, not a build phase. Most steps are driven by the orchestrator against a live dev instance rather than dispatched as code tasks.

**Goal:** Prove the whole record-variations feature (Plans 1–3) works end-to-end on a live dev instance, fix whatever the live pass surfaces, and close out documentation/backlog so the feature is handed off clean.

**Tech Stack:** local Twenty dev instance (`bash packages/twenty-utils/setup-dev-env.sh`, `yarn start`), the app deploy CLI (see memory note `twenty-apps-sdk-local-dev`: auth on `/metadata`, local server on `:3000`, `yarn twenty app deploy` workflow from the app directory), Playwright MCP for UI driving, read-only Postgres MCP for data-level assertions.

**Root package:** `packages/twenty-apps/community/formula-field/`.

## Global Constraints

- The live checklist below is the design doc's own "Live verify" section, expanded. Every item gets an explicit PASS/FAIL/BLOCKED verdict in the final report — no silent skips.
- Bugs found live are fixed via the normal dispatch loop (implementer + focused reviewer), each with a regression test in vitest where the bug is unit-reproducible; live-only bugs (layout, sandbox, SSE timing) get a fix + a re-run of the affected checklist item.
- Timing: event triggers are async. After a mutation, poll the expected state (UI via Playwright wait-fors; data via Postgres MCP) with a 30s ceiling before declaring FAIL — the sync path is trigger-driven, not instant.
- When testing the UI end to end, click "Continue with Email" and use the prefilled credentials (repo convention).

---

### Task 1: Deploy + environment baseline

- [ ] Dev instance up (`setup-dev-env.sh` if needed, `yarn start`, worker running — the worker executes logic functions; without it NOTHING in this feature fires).
- [ ] Deploy the app per the memory-documented workflow; confirm deploy output lists the new objects/front-components/logic-functions (variationConfig, variation-widget, variation-config-editor, the 4 config triggers + 2 variation wildcard triggers + variation-sweep cron).
- [ ] Postgres MCP: confirm the workspace schema has the `variationConfig` table and the logic-function/cron registrations.

### Task 2: The design-doc live checklist (Playwright + Postgres MCP)

Run in order; each step's expected state is the assertion:

- [ ] **Enable variations on Company:** nav → Variation configs → create → wizard → pick Company → default `primaryRecord` → create. Expect: config row enabled, no lastError; after page refresh Company has `Primary record` + `Variations` fields and a `Variations` record-page tab.
- [ ] **Create a variation from the widget:** open a seeded company → Variations tab → Create variation. Expect: new record appears in the widget list; via Postgres/API its syncable fields equal the primary's (initial sync fired); its label is `"<name> (variation)"`.
- [ ] **Primary edit propagates:** edit a syncable field (e.g. employees) on the primary. Expect: variation converges ≤30s.
- [ ] **Variation edit diverges:** edit the same field on the variation. Expect: an ACTIVE `formulaOverride` row keyed to the variation appears; widget lists the field as diverged; subsequent primary edits do NOT touch that field but DO still sync others.
- [ ] **Re-sync converges:** widget → Re-sync on the diverged field. Expect: override row `active: false` (value retained), field equals primary again, diverged list empties.
- [ ] **Freeze on delete:** trash the primary. Expect: variation values unchanged after another (blocked) sweep-tick or trigger; widget shows the frozen banner; re-sync disabled.
- [ ] **Restore resumes:** restore the primary, edit a field. Expect: sync resumes; widget banner clears.
- [ ] **Second variation + numbering:** create another variation. Expect label `"<name> (variation 2)"`.
- [ ] **Config disable:** toggle the config off. Expect: primary edits stop propagating; widget hidden on both records (after refresh); re-enable → `handleVariationConfigChange` sweeps and convergence resumes without waiting an hour.
- [ ] **Single-level guard:** via API, attempt to create a variation-of-a-variation (set `primaryRecordId` on a record pointing at an existing variation). Expect: created record is NOT synced (skippedNestedPrimary posture); config `statusReason` mentions the skip after the next sweep.

### Task 3: Fix wave (if any) + closure

- [ ] Dispatch fixes for every FAIL, re-run those checklist items to PASS.
- [ ] Sweep the three build plans' deferred items: Plan 2's live smoke (superseded by Task 2 here — mark it), any orchestrator-ledger Minors worth folding in (e.g. the CURRENCY/DATE override-slot test case noted in Plan 1's review trail — add it now if still absent; it is a 15-line test).
- [ ] Update `context.md` (the app's running context handoff doc) with: feature summary, the three-plan trail, lifecycle semantics table, and known v1 limits (unnamed variations on exotic label kinds, no native-grid badges, per-field opt-out out of scope).
- [ ] Final commit(s) + report with the full PASS/FAIL table.
