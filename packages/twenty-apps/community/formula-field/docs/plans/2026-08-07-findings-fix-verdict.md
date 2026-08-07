# Findings fix session verdict — F4, F3, F2 closed (2026-08-07)

Executes the directive in `2026-08-06-findings-fix-brief.md`: fix all parked findings,
re-verify code-only. All three fixed, per-task reviews clean, final whole-plan review clean
after one fix wave. Suite 1184 → 1210 tests (unit 1209 + integration file updated), oxlint
clean, tsc no new errors.

## Commits

- `adb2f490d1` F4 — gated TEXT-target defs no longer churn one heartbeat write per sweep.
  ''/NULL normalized in the write-avoidance comparison in `recordEvaluationHeartbeat`
  (comparison site, not load site — the widget path bypasses `loadEnabledFormulas`). Also
  closes the same churn on the raw/mirror lane.
- `323d1637bd` F3 — definition updates touching only fields no formula reads short-circuit.
  NOTE: the brief's root-cause hypotheses were REFUTED in platform source (`updatedFields`
  is always exact; `updatedAt` excluded since 2024; empty diff ⇒ no event). Real defects
  fixed: `order` (app widget drag-to-reorder wrote it per drop ⇒ full recompute) and
  `position` (platform stopped stripping POSITION Jun 2026, twenty-server `20c83e1f86`).
  Row-image fallback added for absent `updatedFields` (fails open). Style ruling folded in
  (`handle-record-update.ts:183` truthiness idiom).
- `20840ad8c7` F2 — blank-targetFieldType defs stop paying evaluation + failed-write rent.
  User ruling (a)+(b)-lite: save-validation rejects blank `targetFieldType` when
  `targetField` is set; recompute lane refuses blank-target defs before any expensive work,
  one write-avoidant definition-row error, zero writes on repeat passes. Blank-target gate
  SKIP pinned intact.
- `72a9adc354` fix wave — integration-test payloads + context.md seed recipe gained
  `targetFieldType: 'NUMBER'` (they predate F2's save rule).

P4.3 (waived lane): unit coverage confirmed read-only, no code change
(`handlers.spec.ts:1023/:1065/:1843`).

## Open diagnosis

The live `lastEvaluatedAt`-only burst that motivated F3 remains UNEXPLAINED — every
code-side hypothesis was refuted (including deployed-bundle and version-skew checks). If it
recurs on cloud: log the actual `on-formula-definition-updated` payload live before
theorizing.

## Deploy gate (v0.3.0 cloud)

Before deploying, on the cloud workspace:
1. `npx tsx scripts/audit-strict-gate.ts cloud` — show gated list to the user.
2. Query defs with `targetFieldType` NULL/'' — any legacy blank-target row aimed at a real
   NUMBER column works today and will STOP computing under F2 (the one user-visible
   behavior change). Non-empty population ⇒ user sees the list before deploy.

## Deferred follow-ups (triaged OK-TO-DEFER at final review, priority order)

1. `handle-variation-config-change.ts:14-26` — same `position` defect as F3 (one line, same
   fix shape). Strongest candidate.
2. `name`/`description` into the ignorable set — `formula-definition-editor.tsx:323` writes
   `{description}` on an 800ms debounce; each tick costs a full target-record scan
   (write-avoidant but reads are real). Cheapest remaining efficiency win.
3. Override-detection lane blank-target skip (`handle-record-update.ts:347-397`) — a human
   edit of a blank-target def's target field can upsert an ACTIVE override row pinning null
   (one line; stops junk override rows).
4. Unrecognized/whitespace `targetFieldType` (`'FOO'`, `' '`) reproduces F2 exactly — wants
   a user ruling on legal type values before widening validation.
5. `override-repository.ts:204-208` — ''/NULL churn family on inactive-override re-pin (at
   most one redundant write per pin; cannot loop).
6. `deepJsonEqual` Date-instance equality — harmless today (payloads JSON-serialized); worth
   a comment at `handle-formula-change.ts:88`.

Parked earlier, unchanged: ISBLANK design hole (needs user ruling), SELECT output arc
(ADR 0026), F1-empty-string bug arc.
