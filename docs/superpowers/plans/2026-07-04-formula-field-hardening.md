# Formula Field Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved hardening spec (`docs/superpowers/specs/2026-07-04-formula-field-hardening-design.md`): pointer-event drag gesture with core-aligned midpoint positions and cancel semantics (ADR 0014), TODAY() staleness self-heal + indicator (ADR 0015), and system-field UI lockdown — then attack it with a live adversarial gauntlet.

**Architecture:** Both ADRs are committed and Accepted — they are the binding design. Pure logic lands in tested helpers (`reorder-definitions.ts`, `dependencies.ts`, new `format-relative-past.ts`); `formula-editor.tsx` wires gestures/staleness; `formula-repository.ts` gets the heartbeat carve-out; `formula-definition.object.ts` gets `isUIEditable: false` on bookkeeping fields.

**Tech Stack:** Twenty Apps SDK, remote-dom React front components, vitest, raw-GraphQL dynamic client, Playwright MCP for live verification.

## Global Constraints

- App dir: `packages/twenty-apps/community/formula-field/` (paths below relative to it unless rooted).
- Unit tests: from app dir, `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run > <scratchpad>/vitest.log 2>&1; tail -20 <scratchpad>/vitest.log`. Baseline: 252 passing.
- Lint: from app dir, `/home/sasha_shin/twenty/node_modules/.bin/oxlint -c .oxlintrc.json .`
- Deploy: from app dir, `node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev --once` (server :3000). Hard-refresh/clear IndexedDB `twenty-front-metadata-store` before judging UI.
- API key: `~/.twenty/config.json` → `remotes.local.apiKey`. Core records `/graphql`, metadata `/metadata`. Scratch scripts → scratchpad, never the repo.
- No `any` in new signatures; named exports; types over interfaces; kebab-case files; short `//` WHY comments.
- Commits: one per task, `feat|fix(formula-field): ...`, trailer `Claude-Session: https://claude.ai/code/session_01KeSEXorVgFXVcLcbWvdW2f`. Stage only `packages/twenty-apps/community/formula-field` (+ the plan file in Task 1).
- Binding design docs (already committed): `docs/adr/0014-pointer-gesture-midpoint-positions.md`, `docs/adr/0015-today-staleness-self-heal.md`, spec at `docs/superpowers/specs/2026-07-04-formula-field-hardening-design.md`.

---

### Task 1: Engine `usesToday` walker + truthful heartbeat (ADR 0015 backend)

**Files:**
- Modify: `src/engine/dependencies.ts` (add `usesToday` export)
- Modify: `src/logic-functions/lib/formula-repository.ts` (`recordEvaluationHeartbeat` carve-out)
- Modify: `src/logic-functions/lib/recompute.ts` (pass the flag from the parsed AST)
- Test: `src/engine/__tests__/dependencies.spec.ts`, `src/logic-functions/lib/__tests__/recompute.spec.ts`

**Interfaces:**
- Produces: `usesToday(node: <the AST node type dependencies.ts already uses>): boolean` — exported from `src/engine/dependencies.ts` AND re-exported via `src/engine/index.ts` if other exports are re-exported there (match existing pattern). `recordEvaluationHeartbeat` gains a required `expressionUsesToday: boolean` parameter (update all call sites).

- [ ] **Step 1: Write failing tests for `usesToday`** in `dependencies.spec.ts`: `TODAY()` alone → true; `TODAY() + 100` → true; `IF(a > TODAY(), 1, 2)` → true (condition); `IF(a, TODAY(), 2)` / `IF(a, 1, TODAY())` → true (each branch); `a + b * 2` → false; `[object:uuid:field] + 1` → false; nested `-(TODAY())` → true. Parse real expressions with the engine's own `parse` (same style as existing dependency tests). Run focused → FAIL (usesToday not exported).
- [ ] **Step 2: Implement `usesToday`** as a recursive walker in `dependencies.ts`, mirroring the existing dependency-extraction walker's switch EXACTLY (same node-type case names — read the walker first; `today` → true, leaf value/ref nodes → false, composite nodes → OR of children). Run focused → PASS.
- [ ] **Step 3: Write failing tests for the heartbeat carve-out** in `recompute.spec.ts` (fake-client style, `vi.setSystemTime`): (a) no-op outcome + `expressionUsesToday: true` + stored `lastEvaluatedAt` 2h old → exactly one definition write containing ONLY `lastEvaluatedAt`; (b) same but `lastEvaluatedAt` 10min old → ZERO writes; (c) no-op + flag false + `lastEvaluatedAt` 2h old → ZERO writes (M3 preserved); (d) changed-value outcome behaves exactly as before regardless of flag. Run → FAIL.
- [ ] **Step 4: Implement**: `recordEvaluationHeartbeat(client, formula, outcome, expressionUsesToday)` — in the existing no-op early-return branch, add: if `expressionUsesToday` and (`formula.lastEvaluatedAt` missing OR older than `60 * 60 * 1000` ms) → `updateFormulaBookkeeping(client, formula.id, { lastEvaluatedAt: new Date().toISOString() })`. In `recompute.ts`, compute the flag once from the already-parsed AST (`usesToday(ast)`) where evaluation happens and thread it to every `recordEvaluationHeartbeat` call site. Run focused → PASS.
- [ ] **Step 5: Full suite (expect 252 + new) + lint clean.**
- [ ] **Step 6: Commit** `feat(formula-field): usesToday walker + truthful TODAY heartbeat (ADR 0015)`.

---

### Task 2: `computeDropWrite` midpoint helper + field lockdown (ADR 0014 §4, spec §3)

**Files:**
- Modify: `src/front-components/lib/reorder-definitions.ts`
- Modify: `src/objects/formula-definition.object.ts`
- Test: `src/front-components/lib/__tests__/reorder-definitions.spec.ts`

**Interfaces:**
- Consumes: existing `computeReorderWrites` (same file).
- Produces (Task 3 imports this exact name): `computeDropWrite(items: Array<{ id: string; order: number | null }>, draggedId: string): Array<{ id: string; order: number }>` — `items` is the FINAL visual order; returns `[]` (nothing to persist), one midpoint write, or a full-reindex write set.

- [ ] **Step 1: Write failing tests** in the existing spec file, new `describe('computeDropWrite')`: 
  - unknown draggedId → `[]`;
  - all-numbered, dragged between neighbors `0` and `1` → `[{id, order: 0.5}]` only;
  - dragged to top (next neighbor order `0`) → `[{id, order: -1}]`; dragged to bottom (prev `3`) → `[{id, order: 4}]`;
  - drag returned to origin (already strictly between neighbors) → `[]`;
  - single-item list, numbered → `[]`; single-item list, null → `[{id, order: 0}]`;
  - any participating neighbor null → full reindex (equals `computeReorderWrites(items)` result);
  - duplicate neighbor orders (both `2`) → full reindex; NaN neighbor → full reindex;
  - precision exhaustion: neighbors `0` and `Number.MIN_VALUE` (midpoint collides) → full reindex;
  - abuse lock-ins for existing helpers: `sortByOrder` with NaN/negative/fractional/duplicate orders stays total + non-lossy (same elements, length preserved); `movePreview`/`computeReorderWrites` with duplicate ids operate on first match without throwing.
  Run focused → FAIL (computeDropWrite not exported).
- [ ] **Step 2: Implement** (append to `reorder-definitions.ts`):

```ts
// Core-aligned drop persistence (ADR 0014): ONE fractional midpoint write
// for the dragged row; full reindex only when the list needs normalizing
// (unnumbered rows involved, duplicate/NaN neighbors, or float precision
// exhausted). Items must be in FINAL visual order.
export const computeDropWrite = (
  items: Array<{ id: string; order: number | null }>,
  draggedId: string,
): Array<{ id: string; order: number }> => {
  const index = items.findIndex((item) => item.id === draggedId);
  if (index < 0) {
    return [];
  }
  const dragged = items[index];
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index < items.length - 1 ? items[index + 1] : undefined;
  if (
    (previous !== undefined && previous.order === null) ||
    (next !== undefined && next.order === null) ||
    (previous === undefined && next === undefined && dragged.order === null)
  ) {
    return computeReorderWrites(items);
  }
  const previousOrder = previous?.order ?? undefined;
  const nextOrder = next?.order ?? undefined;
  // A drag returned to its origin slot persists nothing.
  if (
    dragged.order !== null &&
    Number.isFinite(dragged.order) &&
    (previousOrder === undefined || previousOrder < dragged.order) &&
    (nextOrder === undefined || dragged.order < nextOrder)
  ) {
    return [];
  }
  let candidate: number;
  if (previousOrder === undefined && nextOrder === undefined) {
    candidate = 0;
  } else if (previousOrder === undefined) {
    candidate = (nextOrder as number) - 1;
  } else if (nextOrder === undefined) {
    candidate = previousOrder + 1;
  } else {
    candidate = (previousOrder + nextOrder) / 2;
  }
  if (
    !Number.isFinite(candidate) ||
    (previousOrder !== undefined && candidate <= previousOrder) ||
    (nextOrder !== undefined && candidate >= nextOrder)
  ) {
    return computeReorderWrites(items);
  }
  return [{ id: draggedId, order: candidate }];
};
```

  Run focused → PASS. (If a test exposes a genuine flaw in this reference code, fix the code AND say so in your report — the tests are the contract.)
- [ ] **Step 3: Field lockdown** in `formula-definition.object.ts`: add `isUIEditable: false` to exactly these fields: `order`, `dependencies`, `lastValue`, `lastError`, `lastEvaluatedAt`, `status`, `statusReason`, `createdField`. Do NOT touch `name`, `expression`, `enabled`, `targetObject`, `targetField`, `targetFieldType`, `currencyCode`, `targetFieldSettings`.
- [ ] **Step 4: Full suite + lint clean.**
- [ ] **Step 5: Commit** `feat(formula-field): midpoint drop writes + system-field UI lockdown (ADR 0014)`.

---

### Task 3: Pointer gesture rewrite in `formula-editor.tsx` (ADR 0014 §1-3, §5)

**Files:**
- Modify: `src/front-components/formula-editor.tsx` ONLY.

**Interfaces:**
- Consumes: `computeDropWrite` (Task 2), existing `movePreview`/`sortByOrder`, existing mutation pattern `client.mutation({ updateFormulaDefinition: { __args: { id, data: { order } }, id: true } })`.
- Produces: the hardened gesture; no new exports.

Read the current drag implementation fully first (handle onMouseDown, row onMouseEnter, container onMouseUp/onMouseLeave, `draggingRef`/`draggingId`/`definitionsRef`, `finishDrag`, `styles.dragHandle`/`styles.rowDragging`). Rewrite per ADR 0014:

- [ ] **Step 1: Event migration.** Replace ALL gesture mouse handlers with pointer equivalents — no mouse handlers remain on handle/row/container. Handle: `onPointerDown` (keep `event.preventDefault()`; store `{ id, startX: event.clientX, startY: event.clientY }` in a new `pendingDragRef`; do NOT arm the drag). Handle style additions: `touchAction: 'none'`.
- [ ] **Step 2: 8px activation.** Rows get `onPointerMove`: if `pendingDragRef.current` is set and not yet armed, arm when `Math.hypot(event.clientX - startX, event.clientY - startY) >= 8` → set `draggingRef.current = true`, `setDraggingId(pending.id)`. Guard `clientX/clientY` possibly-undefined under the remote-dom proxy (if undefined on every move event, arm on the first move instead and note it in your report — do not silently ship a dead feature).
- [ ] **Step 3: Preview + commit + cancel.** Row `onPointerEnter` = same reorder-preview logic as the old onMouseEnter (armed drags only). Container `onPointerUp` = commit: clear `pendingDragRef`, and if armed → disarm + persist via `computeDropWrite(definitionsRef.current.map(({id, order}) => ({id, order})), draggedId)`; `writes.length === 0` → done; one write → single mutation; multiple (normalization) → `Promise.all`. After persisting, update local state: set each written row's `order` locally (functional setDefinitions + keep `definitionsRef` in sync) — do NOT renumber rows that weren't written. try/catch → on failure `setTimeout(load, 500)`. Container `onPointerLeave` + `onPointerCancel` = CANCEL: clear pending, and if armed → disarm + revert preview by calling `load()` (guard is clear so it re-sorts from server state); NOTHING persisted. Keep the tracked dragged id in a ref (`draggingIdRef` or reuse pending) so commit/cancel read it synchronously — not from state.
- [ ] **Step 4: Visuals.** `styles.dragHandle`: glyph `⋮⋮` (or keep `⠿` ONLY if `⋮⋮` renders badly — check in Task 4), color muted gray (match the file's existing muted tone, e.g. `#999` family), `cursor: 'grab'`; while this row is armed-dragging, `cursor: 'grabbing'`. `styles.rowDragging`: replace opacity/dashed treatment with a light translucent background tint (e.g. `rgba(0,0,0,0.04)`) + the existing border strengthened one step — keep 4-side longhand borders (shorthand/longhand React bug, see context.md gotcha).
- [ ] **Step 5: Verify.** Full suite (no regressions; gesture is live-verified in Task 5) + lint + `dev --once` build/typecheck/deploy succeeds. Self-review checklist: zero `onMouse*` gesture handlers remain; every referenced identifier exists (lenient build!); poll guard untouched (skips ONLY definitions write mid-drag).
- [ ] **Step 6: Commit** `feat(formula-field): pointer-event drag with 8px arming and silent cancel (ADR 0014)`.

---

### Task 4: Staleness UI — `formatRelativePast` + widget note + self-heal (ADR 0015 front)

**Files:**
- Create: `src/front-components/lib/format-relative-past.ts`
- Test: `src/front-components/lib/__tests__/format-relative-past.spec.ts`
- Modify: `src/front-components/formula-editor.tsx` (staleness note + self-heal)
- Modify: `src/front-components/formula-definition-editor.tsx` (always-on relative timestamp)

**Interfaces:**
- Consumes: `usesToday` from the engine (Task 1), `recomputeForRecord` (already imported by the widget), definition fields `enabled`/`expression`/`lastEvaluatedAt`.
- Produces: `formatRelativePast(isoTimestamp: string, nowMs: number): string`; `isStaleTodayFormula(definition: { enabled: boolean; expression: string; lastEvaluatedAt: string | null }, nowMs: number): boolean` (also in `format-relative-past.ts` — parses via engine `parse` + `usesToday`, returns false on parse failure or missing timestamp).

- [ ] **Step 1: Write failing tests** for `formatRelativePast` (fixed `nowMs`, replicating core's `beautifyPastDateRelativeToNow` format — see ADR 0015): <30s → `now`; 45s → `1 minute ago`; 5min → `5 minutes ago`; 44min → `44 minutes ago`; 50min → `about 1 hour ago`; 2.6h → `about 3 hours ago`; 26h → `1 day ago`; 3d → `3 days ago`; 40d → `about 1 month ago`. And for `isStaleTodayFormula`: TODAY expression + 3h-old timestamp → true; 1h-old → false (threshold 2.5h); non-TODAY expression + 3h-old → false; disabled → false; null timestamp → false; unparseable expression → false. Run → FAIL.
- [ ] **Step 2: Implement** both in `format-relative-past.ts` — threshold constant `STALE_AFTER_MS = 2.5 * 60 * 60 * 1000` exported for the widget. Bucket math for the format (seconds<30 → 'now'; <90s → '1 minute ago'; <45min → 'N minutes ago' rounded; <24h → 'about N hours ago' rounded; <30d → 'N days ago' [singular at 1]; else 'about N months ago'). Run → PASS.
- [ ] **Step 3: Widget wiring** (`formula-editor.tsx`): add `lastEvaluatedAt` to the definitions query selection + `Definition` type + mapper. Per rendered block where `isStaleTodayFormula(...)` → render a muted orange note (match existing banner styling family, but smaller/inline): `Computed {formatRelativePast(lastEvaluatedAt, Date.now())} — refreshing…`. In `load()` (or a post-load effect), if ANY host definition is stale → call `recomputeForRecord` for the viewed record, throttled via a `lastSelfHealAtRef` to once per 60s per widget instance; after it resolves, `setTimeout(load, 1500)` to pick up fresh values (match the file's existing post-write reload pattern).
- [ ] **Step 4: Definition editor** (`formula-definition-editor.tsx`): where the heartbeat/status info renders, add an always-on muted line `Last evaluated {formatRelativePast(lastEvaluatedAt, Date.now())}` (omit when `lastEvaluatedAt` is null). Read the file first; follow its existing layout/style conventions.
- [ ] **Step 5: Full suite + lint + `dev --once` succeeds.**
- [ ] **Step 6: Commit** `feat(formula-field): TODAY staleness note + front-runtime self-heal (ADR 0015)`.

---

### Task 5: Deploy + adversarial gauntlet

**Files:** none (verification; fixes loop into Task 3/4 files with `fix(formula-field): ...` commits).

Run the spec's 8-item gauntlet (spec §"The attack"), evidence per item (actual values/screenshots/GraphQL results):
- [ ] 1. Mouse drag both directions + touch-emulated drag (Playwright touch/pointer emulation).
- [ ] 2. Handle click with <8px travel on an ALL-NULL order list → zero writes (orders unchanged via GraphQL before/after).
- [ ] 3. Drag, exit the widget container, release outside → order reverts, nothing persisted.
- [ ] 4. pointercancel mid-drag (e.g. touch-scroll emulation) → same revert.
- [ ] 5. Rapid successive drags converge correctly; single-item list drag is a no-op.
- [ ] 6. API-mangle orders (duplicates + negatives + a NaN write if the API accepts it) → render deterministic, no crash; one normalization-triggering drop heals (verify via GraphQL: clean strictly-increasing floats or 0..N−1).
- [ ] 7. Midpoint exhaustion: script repeated same-slot midpoint writes via API until `computeDropWrite` would collide, then one UI drop → fallback reindex fires (orders become 0..N−1).
- [ ] 8. Staleness drill: STOP the worker; via API set a TODAY-formula's `lastEvaluatedAt` to 4h ago and its stored value to yesterday's expected value; open the record in the browser → stale note appears AND value self-heals to today's correct number with the worker DOWN (this is the headline resilience property — capture before/after values); confirm `lastEvaluatedAt` updated; RESTART the worker after.
- [ ] Also verify the `isUIEditable` lockdown deployed: the `order`/`status`/etc. cells render read-only on the FormulaDefinition record page while `name`/`expression` stay editable.
- [ ] Commit any fixes; report evidence.

---

### Task 6: Final review + context.md + stabilization

- [ ] **Step 1: Whole-branch review** (most capable model) over the hardening commits — ADR conformance (0014/0015), gauntlet evidence cross-check, regressions in the untouched override/convergence stack.
- [ ] **Step 2: Fix confirmed findings; re-verify affected surfaces.**
- [ ] **Step 3: Update `context.md`**: hardening summary in the DONE section, new gotchas learned, test count, ADR references.
- [ ] **Step 4: Final full run** (suite, lint, `git status` clean) and commit `docs(formula-field): context handoff — hardening complete`.
