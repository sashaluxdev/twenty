# Formula Field Roadmap Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the two remaining roadmap features — TODAY() (ADR 0012, already implemented uncommitted, needs audit + live verify + commit) and drag-to-reorder in the Formula tab (ADR 0013, design-only) — then audit and stabilize the branch.

**Architecture:** TODAY() is a reserved nullary function in the pure engine, fed a caller-supplied `todayEpochDay` from the single clock read in `date-serial.ts` (ADR 0012). Drag-to-reorder is a pointer-event sortable list in `formula-editor.tsx` (native DnD is not in the remote-dom allowlist), persisted via a new nullable `order` NUMBER field on FormulaDefinition, reindexed 0..N-1 on drop with write-avoidance (ADR 0013).

**Tech Stack:** Twenty Apps SDK, React (remote-dom front components), vitest, raw-GraphQL dynamic client.

## Global Constraints

- App dir: `packages/twenty-apps/community/formula-field/` (all paths below relative to it unless rooted).
- Unit tests: from app dir, `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run > <scratchpad>/vitest.log 2>&1; tail -20 <scratchpad>/vitest.log` (redirect + tail — background runs sometimes swallow stdout). Baseline: 237 passing.
- Lint: from app dir, `/home/sasha_shin/twenty/node_modules/.bin/oxlint -c .oxlintrc.json .`
- Deploy: from app dir, `node /home/sasha_shin/twenty/node_modules/twenty-sdk/dist/cli.cjs dev --once` (server on :3000, NOT SDK default 2020).
- API key for scripts: `~/.twenty/config.json` → `remotes.local.apiKey`. Core records on `/graphql`, metadata/auth on `/metadata`. Never mint/forge tokens.
- After any deploy, hard-refresh the browser (IndexedDB metadata cache serves a stale widget otherwise). For Playwright: clear site data or delete the `twenty-front-metadata-store` IndexedDB DB, then reload.
- Front-component build is lenient (undefined identifiers surface only at runtime) — live verification is mandatory for front-component changes.
- No `any` leakage into new helper signatures; named exports; types over interfaces; kebab-case files.
- Commits: one per task, `feat(formula-field): ...` / `fix(formula-field): ...` style, matching recent history.
- Do NOT touch production deploy (`remote:add` / `app deploy`) — local only.
- Repo-root junk files (`defs-header.md`, `defs-list.png`, `wizard-*.png`) are session artifacts — never `git add` them.

---

### Task 1: Audit, live-verify, and commit TODAY() (ADR 0012)

The implementation is ALREADY in the working tree (uncommitted): engine parser/ast/evaluator/dependencies changes, `currentEpochDay()` in `date-serial.ts`, `todayEpochDay` wiring in `recompute.ts`, `TODAY()` autocomplete in `formula-field-input.tsx`, ADR 0012, context.md roadmap renumber. 237 unit tests pass. This task verifies and lands it — it does NOT write new feature code (small fixes from review findings are fine).

**Files:**
- Review (uncommitted diff): `src/engine/{ast,parser,evaluator,dependencies}.ts`, `src/engine/__tests__/{parser,evaluator,dependencies}.spec.ts`, `src/logic-functions/lib/{date-serial,recompute}.ts`, `src/logic-functions/lib/__tests__/recompute.spec.ts`, `src/front-components/lib/formula-field-input.tsx`, `docs/adr/0012-today-function.md`, `context.md`
- No new files.

**Interfaces:**
- Produces: committed TODAY() feature; engine `EvaluateOptions.todayEpochDay`; `currentEpochDay()` export from `date-serial.ts`. Later tasks rely on nothing from this task except a clean tree.

- [ ] **Step 1: Run lint on the app dir** — expect clean. Fix any findings.

- [ ] **Step 2: Code-review the uncommitted diff against ADR 0012** (reviewer subagent reads `git diff` + ADR). Review focus: parser reserved-word handling (bare `today`, `today.x` dotted paths, case-insensitivity), evaluator throw-on-missing-option semantics, dependency extraction no-op, exactly ONE production clock read site, test coverage of each ADR clause. Fix confirmed findings; re-run tests after any fix.

- [ ] **Step 3: Live-verify TODAY() end-to-end** against the running local stack (server :3000 confirmed up; ensure the worker is running — `ps aux | grep "twenty-server:worker"`, start with `npx nx run twenty-server:worker` in background if not):
  1. Deploy: `dev --once` from the app dir.
  2. Via a scratch Node script (scratchpad, NOT repo) using the config.json API key against `/graphql`: find an existing enabled FormulaDefinition with a live target field (query `formulaDefinitions`); if none exists, create the target value field via the metadata API the way the wizard does (`createOneField`, lowercase `dataType`) plus a FormulaDefinition record.
  3. Set its expression to `TODAY() + 100`, wait for save-validation + recompute (poll the definition's `lastValue`/`lastError` heartbeat, and touch a record of the target object to fire `*.updated` recompute).
  4. Assert the computed value equals `floor(Date.now()/86400000) + 100` and `lastError` is empty. Also verify an `IF(<dateField> > TODAY() + 100, 1, 0)` expression evaluates without error on a record with a date field if one is available.
  5. Restore the original expression, confirm recompute converges back.
- Expected: computed values exact; no errors in heartbeat.

- [ ] **Step 4: Run full unit suite + lint one final time** — expect 237+ pass, lint clean.

- [ ] **Step 5: Commit** — stage ONLY the app files + ADR 0012 + context.md (NOT repo-root pngs/md):

```bash
git add packages/twenty-apps/community/formula-field docs/superpowers/plans/2026-07-04-formula-field-roadmap-completion.md
git commit -m "feat(formula-field): TODAY() function via injected epoch-day (ADR 0012)"
```

---

### Task 2: Reorder schema + pure helpers (TDD)

**Files:**
- Modify: `src/objects/formula-definition.object.ts` (add `order` field)
- Create: `src/front-components/lib/reorder-definitions.ts`
- Test: `src/front-components/lib/__tests__/reorder-definitions.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (Task 3 relies on these exact names):
  - `sortByOrder<TItem extends { order: number | null }>(items: TItem[]): TItem[]` — new array, ascending `order`, `null` treated as +Infinity, stable (ties/nulls preserve input order).
  - `movePreview<TItem extends { id: string }>(items: TItem[], dragId: string, hoverId: string): TItem[]` — new array with the `dragId` item spliced to `hoverId`'s index; returns the input array unchanged (same reference) when either id is missing or ids are equal.
  - `computeReorderWrites(items: Array<{ id: string; order: number | null }>): Array<{ id: string; order: number }>` — reindex the given visual order 0..N-1, return only rows whose stored `order` differs (write-avoidance; a `null` stored order always differs).
  - New FormulaDefinition NUMBER field `order` (nullable, no default).

- [ ] **Step 1: Add the `order` field to `formula-definition.object.ts`.** Add a new UUID to the `FORMULA_DEFINITION_FIELDS` universal-identifier map (generate with `node -e "console.log(require('crypto').randomUUID())"`), then append after `statusReason` in the fields array, copying the `lastValue` shape (nullable NUMBER by omission of defaultValue):

```ts
{
  universalIdentifier: FORMULA_DEFINITION_FIELDS.order,
  type: FieldType.NUMBER,
  name: 'order',
  label: 'Order',
  description: 'Display position in the record-page Formula tab (managed by drag-to-reorder).',
  icon: 'IconArrowsSort',
},
```

- [ ] **Step 2: Write failing tests** in `src/front-components/lib/__tests__/reorder-definitions.spec.ts` (follow the plain-import style of `formula-field-formats.spec.ts` — no module mocking). Cover at least:
  - `sortByOrder`: all-null input → same sequence (fresh-install invariant); mixed null/numbered → numbered ascending first, nulls after in input order; does not mutate input.
  - `movePreview`: moves forward and backward; unknown dragId/hoverId → same reference; dragId === hoverId → same reference; does not mutate input.
  - `computeReorderWrites`: already 0..N-1 → `[]`; all-null → writes for every row; single swap → only the changed rows; empty list → `[]`.

- [ ] **Step 3: Run the new spec, verify it FAILS** (module not found): `node /home/sasha_shin/twenty/node_modules/vitest/vitest.mjs run reorder-definitions`

- [ ] **Step 4: Implement `src/front-components/lib/reorder-definitions.ts`:**

```ts
// Pure ordering helpers for the record-page Formula tab (ADR 0013).
// null order = "never reordered": sorts after numbered rows, keeping the
// query's own fetch order (stable sort), so a fresh install is unchanged.

export const sortByOrder = <TItem extends { order: number | null }>(
  items: TItem[],
): TItem[] =>
  [...items].sort(
    (left, right) =>
      (left.order ?? Number.POSITIVE_INFINITY) -
      (right.order ?? Number.POSITIVE_INFINITY),
  );

export const movePreview = <TItem extends { id: string }>(
  items: TItem[],
  dragId: string,
  hoverId: string,
): TItem[] => {
  const fromIndex = items.findIndex((item) => item.id === dragId);
  const toIndex = items.findIndex((item) => item.id === hoverId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return items;
  }
  const next = [...items];
  const [dragged] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, dragged);
  return next;
};

export const computeReorderWrites = (
  items: Array<{ id: string; order: number | null }>,
): Array<{ id: string; order: number }> =>
  items
    .map((item, index) => ({ id: item.id, order: index, stored: item.order }))
    .filter((item) => item.stored !== item.order)
    .map(({ id, order }) => ({ id, order }));
```

- [ ] **Step 5: Run the spec — expect PASS; run the full suite — expect no regressions; lint.**

- [ ] **Step 6: Commit:**

```bash
git add packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): order field + pure reorder helpers (ADR 0013)"
```

---

### Task 3: Wire drag-to-reorder into formula-editor.tsx

**Files:**
- Modify: `src/front-components/formula-editor.tsx`

**Interfaces:**
- Consumes: `sortByOrder`, `movePreview`, `computeReorderWrites` from `src/front-components/lib/reorder-definitions` (Task 2 signatures above); existing `createDynamicCoreClient()` mutation pattern `client.mutation({ updateFormulaDefinition: { __args: { id, data }, id: true } })`.
- Produces: user-visible drag-to-reorder; no new exports.

Implementation spec (per ADR 0013 — pointer/mouse events only, native DnD is NOT in the remote-dom allowlist):

- [ ] **Step 1: Extend the data path.**
  - Add `order: number | null` to the `Definition` type (~line 45).
  - Add `order: true` to the `formulaDefinitions` selection in `load()` (~line 162) and `order: edge.node.order ?? null` to the mapper (~line 184).
  - After the host filter (`const defs = host ? ... : []`, ~line 221), apply `const sortedDefs = sortByOrder(defs)` and pass THAT to `setDefinitions`.

- [ ] **Step 2: Drag state + poll guard.**
  - Add `const [draggingId, setDraggingId] = useState<string | null>(null);` and `const draggingRef = useRef(false);` next to the existing refs (~line 139).
  - In `load()`, guard ONLY the definitions write: `if (!draggingRef.current) { setDefinitions(sortedDefs); }` — values/overrides/drafts updates below stay unconditional (ADR: poll keeps refreshing values mid-drag, must not clobber the reorder preview).

- [ ] **Step 3: The gesture.** On each definition block (the `<div key={definition.id} style={styles.row}>`):
  - Add a drag handle as the FIRST child of the header row (`styles.header`): a `<span>` with glyph `⠿`, `onMouseDown={() => { draggingRef.current = true; setDraggingId(definition.id); }}`, style `cursor: 'grab', userSelect: 'none', marginRight: 8, color: '#999'`.
  - On the block div: `onMouseEnter={() => { if (draggingRef.current && draggingId && draggingId !== definition.id) { setDefinitions((current) => movePreview(current, draggingId, definition.id)); } }}`.
  - While `draggingId === definition.id`, give the block a subtle lifted style (e.g. `opacity: 0.7, border: '1px dashed #999'`) merged over `styles.row`.
- Note: remote-dom gotcha — do NOT use `window`/`document` listeners; component-tree bubbling only. Guard any focus/selection APIs with try/catch if touched.

- [ ] **Step 4: The drop.** On the tab's outermost container div add BOTH `onMouseUp` and `onMouseLeave` → the same `finishDrag` callback (mouseLeave covers releasing outside the widget so a drag never stays armed):

```tsx
const finishDrag = useCallback(async () => {
  if (!draggingRef.current) return;
  draggingRef.current = false;
  setDraggingId(null);
  const writes = computeReorderWrites(
    definitionsRef.current.map(({ id, order }) => ({ id, order })),
  );
  if (writes.length === 0) return;
  const client = createDynamicCoreClient();
  await Promise.all(
    writes.map((write) =>
      client.mutation({
        updateFormulaDefinition: {
          __args: { id: write.id, data: { order: write.order } },
          id: true,
        },
      }),
    ),
  );
  // Reflect persisted orders locally so the next poll (which re-sorts) agrees.
  setDefinitions((current) =>
    current.map((definition, index) => ({ ...definition, order: index })),
  );
}, []);
```

  - `definitionsRef`: add `const definitionsRef = useRef<Definition[]>([]);` kept in sync right after each `setDefinitions` call (or via `definitionsRef.current = sortedDefs` in `load()` and inside the mouseEnter/finish updates using the functional-update return value). The callback must read the CURRENT visual order synchronously — state closures are stale inside `useCallback([], ...)`.
  - Swallow-and-surface errors: wrap the mutation batch in try/catch; on failure `setTimeout(load, 500)` to re-converge from the server.

- [ ] **Step 5: Verify no-regression paths by unit suite + lint** (the editor itself has no spec — the helpers carry the logic; the editor wiring is verified live in Task 4). Full suite green, lint clean.

- [ ] **Step 6: Commit:**

```bash
git add packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): drag-to-reorder in the Formula tab (ADR 0013)"
```

---

### Task 4: Deploy + live-verify drag-to-reorder

**Files:** none (verification only; fixes loop back into Task 3's files).

**Interfaces:** Consumes the deployed app; produces evidence for the final report.

- [ ] **Step 1: Deploy** `dev --once`; confirm the `order` field appears on formulaDefinition metadata (query `/metadata` fields for the object, or postgres MCP).

- [ ] **Step 2: Seed a reorderable state.** Ensure at least 3 FormulaDefinitions target the SAME object with live target fields (create via script + `createOneField` if needed — reuse the Task 1 script pattern).

- [ ] **Step 3: Browser-verify with Playwright** (front on :3001; "Continue with Email" prefilled credentials; clear the `twenty-front-metadata-store` IndexedDB DB first, then reload):
  1. Open a record of the target object → Formulas tab; confirm the ⠿ handles render and blocks are in expected order.
  2. Drag block 3 above block 1: `mousedown` on its handle → `mousemove`/`hover` over block 1 → `mouseup` on the container (use Playwright mouse API with explicit move steps so mouseenter fires).
  3. Confirm the visual order changes live during the drag and sticks after release.
  4. Reload the page — order persists (sort-by-order path).
  5. Verify persisted values: `order` = 0..N-1 via `/graphql` script or postgres MCP.
  6. Confirm the 4s poll doesn't clobber a drag: start a drag, hold >5s over a new position, release — final order must match the held position.
- Any failure → fix in Task 3's files, redeploy, re-verify (systematic-debugging, no guess-fixes).

- [ ] **Step 4: Commit any fixes** (`fix(formula-field): ...`).

---

### Task 5: Final audit, context.md update, stabilization

**Files:**
- Modify: `context.md` (roadmap items 4+5 → DONE with the same summary style as items 1-3; refresh "Tests" count; add any new gotchas learned)
- Possibly: fix files from audit findings.

- [ ] **Step 1: Whole-branch review** (opus reviewer) over `git diff <pre-Task-1-commit>..HEAD` — correctness, ADR conformance, remote-dom pitfalls, write-avoidance, no `any` leaks, test coverage. Adversarial focus: the drop-write race (poll vs finishDrag), mouseLeave-mid-drag semantics, `order` collisions across two browsers.
- [ ] **Step 2: Fix confirmed findings; re-run suite + lint; redeploy + spot re-verify live if front code changed.**
- [ ] **Step 3: Update `context.md`** (mark 4+5 done, capture new platform facts/gotchas discovered in Tasks 1-4).
- [ ] **Step 4: Final full run:** unit suite (expect ~250+), lint, `git status` clean except known repo-root artifacts.
- [ ] **Step 5: Commit** `docs(formula-field): context handoff — roadmap complete` and STOP — return to the user for human verification and next design inputs (production deploy explicitly out of scope).
