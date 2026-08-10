# SELECT Output (formula-field v0.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SELECT becomes an engine-lane formula target with a two-tier option-membership gate, a blank-clears write boundary, a one-time wizard options editor, and a mirror-flow reroute — per the approved spec `docs/superpowers/specs/2026-08-10-select-output-design.md` (all four user rulings locked; ADR 0029 reserved).

**Architecture:** SELECT moves from `MIRRORABLE_KINDS` to `ENGINE_FAMILY` (the TEXT/ADR-0026 move replayed). A pure AST walker (`staticTextOutputs`) computes a formula's possible literal text outputs; when that set is closed, membership is gated statically at save time and once per recompute pass (whole-definition, write-avoidant freeze on violation); when open, a per-record `Set.has` at the normalize-then-write choke point throws a new `NOT_AN_OPTION` eval error. A single `usesTextDomain` predicate replaces every hard-coded `kind === 'TEXT'` domain check so SELECT can never be silently routed to the numeric lane. Option sets ride the existing 60s metadata cache via a new accessor; the wizard gains a 9th `select` format whose options are defined exactly once at field creation (the app never edits options afterward — user ruling, locked).

**Tech Stack:** TypeScript, vitest, twenty-sdk / twenty-client-sdk, emotion (app UI primitives). App root: `packages/twenty-apps/community/formula-field`. All file paths below are relative to that app root unless they start with `packages/` or `docs/`.

## Global Constraints

- **App version:** `package.json` currently `0.4.0`; bump to `0.5.0` only in Task 14.
- **No new dependencies.** `dependencies: {}` stays empty; never add `twenty-shared` or `twenty-ui` (front-bundle discipline, ADR 0024). Color names get a local constant.
- **validation-core bundle rule:** `validation-core.ts` may not import anything beyond `src/engine`, `mirror-kinds`, and (already today) `kind-inference`. It receives options as plain data; it never imports the metadata loader.
- **Kind lattice untouched:** no `ExpressionKind` changes, no new functions, no new syntax. `fieldTypeToKind` keeps `SELECT -> 'text'`.
- **The app NEVER edits options post-creation** (user ruling 2026-08-10, section 9.4): no `options` key on any `updateOneField`, no add/rename/remove UI outside the creation wizard. Do not resurrect in-app option editing in any form.
- **Skip-never-reject:** unresolvable/empty option metadata degrades every gate to skip (ADR 0027 D1/D5 posture). The recompute paths always re-resolve, so a definition cannot permanently dodge the gate.
- **Efficiency (memory: efficiency-first-formula-design):** option sets resolve once per pass / once per event / once per save — never per record. The per-record cost is one `Set.has`, no allocation. Every new branch sits behind a `targetFieldType === 'SELECT'` guard so non-SELECT formulas pay zero.
- **Error copy verbatim from spec D6** (exact strings pinned in Tasks 4 and 7).
- **MULTI_SELECT and RATING stay mirror-lane.** Do not touch their behavior.
- **House style:** named exports, types over interfaces, `//` comments explaining why only, no JSDoc, no new comments narrating the change itself.
- **Commands** (run from the app root `packages/twenty-apps/community/formula-field`):
  - Single test file: `npx vitest run src/path/to/file.spec.ts`
  - Full unit suite: `npx vitest run`
  - Lint: `yarn lint` — Typecheck: `npx tsc --noEmit`
- **Commits:** one per task, message given in the task. No signatures, no co-author tags.

## File Structure

New files:
- `src/engine/static-text-outputs.ts` — the pure walker (engine-only, no app imports).
- `src/engine/__tests__/static-text-outputs.spec.ts`
- `src/logic-functions/lib/__tests__/select-recompute.spec.ts` — sweep/tier-2/back-compat pins.
- `docs/adr/0029-select-output.md` (Task 14).

Modified (by task): value-io.ts, mirror-kinds.ts, kind-inference.ts (T1, T4); override-repository.ts, override-slot.ts, handle-record-update.ts (T2, T8); metadata-objects.ts (T5); validation-core.ts, save-validation.ts, validate-expression.ts, handle-formula-change.ts, formula-editor.tsx, formula-definition-editor.tsx (T6); errors.ts, recompute.ts (T7); refresh-stale-formulas.ts (T8); formula-field-formats.ts (T1, T9); format-options-fields.tsx (T10); formula-setup-wizard.tsx, field-settings-editor.tsx (T11); scripts/audit-strict-gate.ts (T12); src/__tests__/app-install.integration-test.ts (T13); docs + package.json + src/objects/formula-definition.object.ts (T14).

Task order matters: 1 → 2, 3 → 4 → 5 → 6 → 7 → 8 (6 also needs 1), and 1 → 9 → 10 → 11. 12 needs 4+5. 13 needs 7+8 (not the wizard). 14 last.

**Parallel execution guide** (user directive 2026-08-10: fan out where it saves time). Each wave's two tasks touch disjoint files and may run as concurrent subagents on the same branch; finish and review a wave before starting the next:

| Wave | Tasks | Why disjoint |
|---|---|---|
| 1 | 1 + 3 | lane move (logic-functions + formats) vs new engine files |
| 2 | 2 + 4 | override files vs kind-inference.ts |
| 3 | 5 + 9 | metadata-objects.ts vs formats module |
| 4 | 6 + 10 | validation seam + editors vs format-options-fields.tsx |
| 5 | 7 + 11 | errors/recompute vs wizard + settings editor |
| 6 | 8 + 12 | event path + callers vs audit script (8 touches formula-editor.tsx — wave 4's Task 6 must be merged first, which the wave order guarantees) |
| 7 | 13 + 14 | integration test vs docs/release |

## Review rulings (2026-08-10, user gate on the plan-review findings)

All three semantic questions from the opus review pass were ruled **as spec'd / as planned** — no plan changes:
1. **Save posture**: a membership violation at save DISABLES the definition (spec D3's deliberate save-vs-recompute asymmetry stands; the freeze-only alternative was declined).
2. **Value derivation**: leading tokens strip (`"2nd Stage"` → `ND_STAGE`); the derived value is shown read-only at creation and that is sufficient.
3. **Editor gap**: the editor stays silent when it cannot resolve a SELECT target's options (skip-never-reject; the server's `lastError` surfaces in the same editor within a minute).

---

### Task 1: Lane move — SELECT joins the engine family at the write boundary

SELECT enters `ENGINE_FAMILY`, leaves `MIRRORABLE_KINDS`, and every text-domain branch routes through a new `usesTextDomain` predicate. Blank computed text on a SELECT target normalizes to null (spec D1, D2-partial, D4).

**Files:**
- Modify: `src/logic-functions/lib/value-io.ts` (lines 33-39, ~80, ~128, ~151, ~175)
- Modify: `src/logic-functions/lib/mirror-kinds.ts` (lines 18-30, comment at 32-36)
- Modify: `src/logic-functions/lib/kind-inference.ts` (lines 314-320)
- Modify: `src/front-components/lib/formula-field-formats.ts` (lines 367-369, `pickableMirrorSourceFields` — widened here because the lane move breaks its existing test)
- Test: `src/logic-functions/lib/__tests__/value-io.spec.ts`, `.../mirror-kinds.spec.ts`, `.../kind-inference.spec.ts`, plus fallout updates in `handlers.spec.ts`, `validate-expression.spec.ts`, `validation-core.spec.ts`, `mirror-target.spec.ts`, `recompute.spec.ts`, `scan-selection.spec.ts` (Step 6).

**Interfaces:**
- Consumes: nothing new.
- Produces: `ENGINE_FAMILY` includes `'SELECT'` (so `TargetFieldKind` includes it and `targetFieldKind('SELECT') === 'SELECT'`); `export const usesTextDomain = (kind: TargetFieldKind | 'raw'): boolean` in value-io.ts; `EXPECTED_KIND_BY_TARGET.SELECT === 'text'`; `normalizeComputedValue('SELECT', ...)` blank-to-null semantics; `pickableMirrorSourceFields` keeps SELECT pickable.

- [ ] **Step 1: Write the failing tests** — append to `value-io.spec.ts`:

```ts
describe('usesTextDomain', () => {
  it('is true for exactly TEXT, SELECT and raw (drift guard, ADR 0029 D2)', () => {
    expect(usesTextDomain('TEXT')).toBe(true);
    expect(usesTextDomain('SELECT')).toBe(true);
    expect(usesTextDomain('raw')).toBe(true);
    expect(usesTextDomain('NUMBER')).toBe(false);
    expect(usesTextDomain('CURRENCY')).toBe(false);
    expect(usesTextDomain('DATE')).toBe(false);
    expect(usesTextDomain('DATE_TIME')).toBe(false);
  });
});

describe('SELECT write boundary (ADR 0029)', () => {
  it('targetFieldKind resolves SELECT to itself', () => {
    expect(targetFieldKind('SELECT')).toBe('SELECT');
  });

  it('normalizeStoredValue: stored option value verbatim, non-strings null', () => {
    expect(normalizeStoredValue('HOT', 'SELECT')).toBe('HOT');
    expect(normalizeStoredValue(null, 'SELECT')).toBeNull();
    expect(normalizeStoredValue(42, 'SELECT')).toBeNull();
  });

  it('normalizeComputedValue: verbatim string; blank and null clear', () => {
    expect(normalizeComputedValue('SELECT', 'HOT')).toBe('HOT');
    expect(normalizeComputedValue('SELECT', '')).toBeNull();
    expect(normalizeComputedValue('SELECT', '   ')).toBeNull();
    expect(normalizeComputedValue('SELECT', null)).toBeNull();
  });

  it('TEXT keeps the empty string as a real value (unchanged by the SELECT arm)', () => {
    expect(normalizeComputedValue('TEXT', '')).toBe('');
  });

  it('tagEngineValue tags SELECT results into the text lane', () => {
    expect(tagEngineValue('SELECT', 'HOT')).toEqual({ kind: 'text', value: 'HOT' });
  });

  it('buildTargetWriteData writes the scalar verbatim; null clears', () => {
    expect(buildTargetWriteData('stage', 'SELECT', 'HOT')).toEqual({ stage: 'HOT' });
    expect(buildTargetWriteData('stage', 'SELECT', null)).toEqual({ stage: null });
  });
});
```

Add `usesTextDomain` and `tagEngineValue` to the spec's value-io import (it imports neither today). Append to `mirror-kinds.spec.ts`:

```ts
it('SELECT rides the engine family, not the mirror lane (ADR 0029 D1)', () => {
  expect(MIRRORABLE_KINDS.has('SELECT')).toBe(false);
  expect(ENGINE_FAMILY_KINDS.has('SELECT')).toBe(true);
});
```

Append inside `kind-inference.spec.ts`'s existing `describe('strictKindGateError')`, reusing its `gate` helper:

```ts
  it('SELECT targets gate as text-kind (ADR 0029 D1)', () => {
    expect(gate('IF(amount > 1, "A", "B")', 'SELECT')).toBeNull();
    expect(gate('name', 'SELECT')).toBeNull();
    expect(gate('amount * 2', 'SELECT')).toMatch(
      /computes number but the target field holds text/,
    );
  });
```

- [ ] **Step 2: Run the three spec files, confirm the new tests fail** (`usesTextDomain` not exported; `targetFieldKind('SELECT')` returns `'NUMBER'`; SELECT gate skipped). `npx vitest run src/logic-functions/lib/__tests__/value-io.spec.ts src/logic-functions/lib/__tests__/mirror-kinds.spec.ts src/logic-functions/lib/__tests__/kind-inference.spec.ts`

- [ ] **Step 3: Implement value-io.ts.** Append `'SELECT'` to `ENGINE_FAMILY` (after `'TEXT'`), with one comment line above the array's closing bracket region:

```ts
// SELECT joins with the same string domain (ADR 0029): the computed text must
// additionally name one of the field's options — that membership gate lives in
// kind-inference/recompute; the write boundary treats SELECT as text.
```

Add the predicate right after `targetFieldKind`:

```ts
// The string-domain targets plus the raw mirror slot. Every "is this the text
// lane" branch (value IO, override slots, pinned reads) routes through this
// predicate — a hard-coded `kind === 'TEXT'` is how SELECT data silently lands
// in the numeric lane (ADR 0029 D2). 'raw' carries every deployed mirror
// override, so it must stay true.
export const usesTextDomain = (kind: TargetFieldKind | 'raw'): boolean =>
  kind === 'TEXT' || kind === 'SELECT' || kind === 'raw';
```

Rewrite the four value-io domain checks:
1. `normalizeStoredValue` (line ~80): `if (kind === 'TEXT') {` → `if (usesTextDomain(kind)) {`
2. `normalizeComputedValue` (lines ~128-131) becomes:

```ts
  if (usesTextDomain(kind)) {
    if (value === null) return null;
    const text = typeof value === 'string' ? value : formatNumberAsText(value);
    // SELECT: blank text clears the field (ADR 0029 D4) — '' is structurally
    // impossible as an option value (min length 1, UPPER_SNAKE), and blankness
    // already means "null or empty/whitespace" everywhere in the language.
    if (kind === 'SELECT' && text.trim() === '') return null;
    return text;
  }
```

3. `tagEngineValue` (line ~151): `kind === 'TEXT'` → `usesTextDomain(kind)`
4. `buildTargetWriteData` (line ~175): `if (kind === 'TEXT') {` → `if (usesTextDomain(kind)) {`

- [ ] **Step 4: Implement mirror-kinds.ts and kind-inference.ts.** Remove `'SELECT'` from `MIRRORABLE_KINDS`. Extend the derivation comment (lines 32-36) with one line: `// SELECT moved to the engine family too (ADR 0029), same disjointness contract.` In kind-inference.ts add to `EXPECTED_KIND_BY_TARGET`: `SELECT: 'text',` (TypeScript forces this entry the moment `TargetFieldKind` grows — the build breaks until it's added).

- [ ] **Step 5: Widen the mirror picker** in `formula-field-formats.ts` (its existing test seeds a SELECT source and breaks without this):

```ts
// SELECT stays pickable after its lane move: the mirror flow is the only place
// that clones a source field's options onto the new field (ADR 0029 D8).
export const pickableMirrorSourceFields = <T extends { type: string }>(
  fields: T[],
): T[] =>
  fields.filter(
    (field) => isMirrorTargetKind(field.type) || field.type === 'SELECT',
  );
```

- [ ] **Step 6: Run the FULL unit suite and fix the lane-move fallout** (`npx vitest run`). Apply this policy, mechanically:
  - **Tests whose subject is the mirror lane but whose fixture kind happens to be SELECT** (`mirror-target.spec.ts` lines ~27/120/326/340/383-384/425/546, `recompute.spec.ts` mirror blocks ~567/1260-1310/1744, `scan-selection.spec.ts` ~30-126, `validation-core.spec.ts` ~152-166): swap the fixture kind `'SELECT'` → `'MULTI_SELECT'` (still mirrorable, also enum-shaped) so the test keeps testing the mirror lane. When a swap changes an asserted message string, update the string too (e.g. `onto a MULTI_SELECT field`). `validation-core.spec.ts:74` is a SELECT *source* onto a TEXT target — unaffected, leave it alone.
  - **Tests that pin SELECT's membership itself** (`mirror-kinds.spec.ts`): `:16` (drop SELECT from the expected `MIRRORABLE_KINDS` list), `:34` (the title's "exactly eleven kinds" becomes ten), `:40-52` (add `'SELECT'` to the rejects `it.each`), `:55-67` (the exact `ENGINE_FAMILY` five-element list gains `'SELECT'`), `:131/:135` (`isMirrorDefinition(parse('status'), 'SELECT')` now `false` — flip the expectation and add a `'MULTI_SELECT'` case that stays `true`), `:154/:158` (stay green but go vacuous — re-point at `'LINKS'`). `:70` needs NO change (`selectionEntryForMirrorKind` never consults the sets).
  - **Mirror-branch-1c behavior tests onto SELECT targets** — in BOTH `validate-expression.spec.ts` (lines ~56, 175-279) AND `handlers.spec.ts` (`:226-249`, `:251-278`, `:765-774`, `:776-785`, `:788-801`, `:803-816`): SELECT targets no longer take branch 1c. Rewrite each failing assertion by this mapping (spec section 4):
    - was `"Only a plain field reference can be mirrored onto a SELECT field"` → now valid (`null` / `valid: true`) when the expression's inferred kind is text or unknown, or the kind-gate message `/computes number but the target field holds text/` when numeric.
    - was `"Cannot mirror TEXT field ... onto a SELECT field (kinds must match)"` → now valid (TEXT source and SELECT target are both kind `text`; membership is tier 2's job).
    - was valid for a bare SELECT-onto-SELECT ref → stays valid.
    To keep branch 1c itself covered, re-point at least one test per sub-branch ((b) non-bare-ref, (c) kind-mismatch) at a `MULTI_SELECT` or `LINKS` fixture, with the message strings updated to the new kind.
  - **Must NOT change:** `syncable-fields.spec.ts` (the union list is unchanged by construction — if it fails, the lane move is wrong, stop and re-check), `handlers.spec.ts:1001-1026` (the SELECT toggle-off restore now rides the engine lane and must still pass as-is).

- [ ] **Step 7: Re-run the full suite to green, then typecheck and lint.** `npx vitest run && npx tsc --noEmit && yarn lint`

- [ ] **Step 8: Commit.**

```bash
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): SELECT joins the engine family at the write boundary"
```

---

### Task 2: Override pins ride the text slot for SELECT

The three remaining hard-coded text-domain checks (override write slot, override read slot, pinned-value read) route through `usesTextDomain` (spec D2's "four places" minus value-io, plus the `slot !== 'TEXT'` third edit).

**Files:**
- Modify: `src/logic-functions/lib/override-repository.ts` (lines 182-188)
- Modify: `src/front-components/lib/override-slot.ts` (lines 25-26, 54-66)
- Modify: `src/logic-functions/lib/handle-record-update.ts` (lines 80-89)
- Test: `src/front-components/lib/__tests__/override-slot.spec.ts`

**Interfaces:**
- Consumes: `usesTextDomain` from value-io.ts (Task 1).
- Produces: `overrideSlotKind('SELECT', false) === 'SELECT'` routed to the JSON-text column by all three read/write paths; deployed raw-slot SELECT-mirror pins decode unchanged.

- [ ] **Step 1: Write the failing tests** — append to `override-slot.spec.ts` (add `overrideSlotForKind` to its override-repository import if absent):

```ts
describe('SELECT engine slot (ADR 0029)', () => {
  it('routes an engine SELECT row to its own slot', () => {
    expect(overrideSlotKind('SELECT', false)).toBe('SELECT');
  });

  it('SELECT pins write into and read from the JSON-text column', () => {
    expect(overrideSlotForKind('SELECT', 'HOT')).toEqual({ text: '"HOT"' });
    expect(
      pinnedOverrideDisplayValue('SELECT', { overrideValueText: '"HOT"' }),
    ).toBe('HOT');
    expect(
      pinnedEngineOverrideValue('SELECT', { overrideValueText: '"HOT"' }),
    ).toEqual({ restorable: true, value: 'HOT' });
  });

  it('a deployed raw-slot SELECT-mirror pin round-trips unchanged (back-compat)', () => {
    // Pre-0.5.0 rows were written by overrideSlotForKind('raw', 'HOT') — the
    // encoding is byte-identical to the text slot SELECT now uses.
    expect(overrideSlotForKind('raw', 'HOT')).toEqual({ text: '"HOT"' });
    expect(
      pinnedEngineOverrideValue('SELECT', {
        overrideValue: null,
        overrideValueText: '"HOT"',
      }),
    ).toEqual({ restorable: true, value: 'HOT' });
  });
});
```

- [ ] **Step 2: Run it, confirm failures** (`overrideSlotKind('SELECT', false)` currently returns `'SELECT'` already — verify which assertions fail: the `pinnedEngineOverrideValue('SELECT', ...)` ones read the numeric column today). `npx vitest run src/front-components/lib/__tests__/override-slot.spec.ts`

- [ ] **Step 3: Implement.**
  - `override-repository.ts` — import `usesTextDomain` from value-io; body of `overrideSlotForKind` becomes:

```ts
  usesTextDomain(kind)
    ? { text: JSON.stringify(value ?? null) }
    : { numeric: typeof value === 'number' ? value : null };
```

  - `override-slot.ts` — add `usesTextDomain` to its value-io import line; `usesTextSlot` becomes a delegation (keep the local name so `pinnedOverrideDisplayValue` is untouched):

```ts
// TEXT/SELECT and mirror pins all live in the JSON-text column (the convention
// decodeMirrorOverrideValue reads); the numeric kinds live in overrideValue.
// Delegates to value-io's usesTextDomain so a new text-domain target can never
// fork the read and write conventions (ADR 0029 D2).
const usesTextSlot = (slot: OverrideSlotKind): boolean => usesTextDomain(slot);
```

  and `pinnedEngineOverrideValue`'s guard `if (slot !== 'TEXT') {` becomes `if (!usesTextDomain(slot)) {` (a `'raw'` slot now reaches the decode branch: non-string decodes report `restorable: false`, which is more correct than reading a mirror pin's empty numeric column).
  - `handle-record-update.ts` — add `usesTextDomain` to its value-io import; `pinnedOverrideValue`'s guard `if (targetKind !== 'TEXT') {` becomes `if (!usesTextDomain(targetKind)) {`.

- [ ] **Step 4: Run the full suite, typecheck, lint.** `npx vitest run && npx tsc --noEmit && yarn lint`

- [ ] **Step 5: Commit.**

```bash
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): SELECT override pins ride the text slot"
```

---

### Task 3: The `staticTextOutputs` walker

A pure engine function computing the closed set of literal text outputs, or `null` for an open set (spec D3, "The walker" — semantics complete there and mirrored below).

**Files:**
- Create: `src/engine/static-text-outputs.ts`
- Test: `src/engine/__tests__/static-text-outputs.spec.ts`

**Interfaces:**
- Consumes: `type AstNode` from `src/engine/ast` (discriminants: `{type:'string', value}`, `{type:'if', condition, then, else}`, `{type:'ifblank', value, fallback}`, `{type:'null'}`).
- Produces: `export const staticTextOutputs = (node: AstNode): ReadonlySet<string> | null`.

- [ ] **Step 1: Write the failing test file:**

```ts
import { describe, expect, it } from 'vitest';

import { parse } from 'src/engine/parser';
import { staticTextOutputs } from 'src/engine/static-text-outputs';

const outputsOf = (expression: string): string[] | null => {
  const result = staticTextOutputs(parse(expression));
  return result === null ? null : [...result].sort();
};

describe('staticTextOutputs', () => {
  it('a bare string literal is a singleton set', () => {
    expect(outputsOf('"HOT"')).toEqual(['HOT']);
  });

  it('IF unions both branches; the condition never contributes', () => {
    expect(outputsOf('IF(amount > 5, "HOT", "COLD")')).toEqual(['COLD', 'HOT']);
  });

  it('SWITCH keys sit in condition position and never contribute', () => {
    expect(outputsOf('SWITCH(stage, "won", "CLOSED", "OPEN")')).toEqual([
      'CLOSED',
      'OPEN',
    ]);
  });

  it('a defaultless ladder contributes nothing for the missing default', () => {
    expect(outputsOf('IFS(amount > 100, "HOT", amount > 10, "WARM")')).toEqual([
      'HOT',
      'WARM',
    ]);
  });

  it('IFBLANK unions both arguments', () => {
    expect(outputsOf('IFBLANK("", "NEW")')).toEqual(['', 'NEW']);
  });

  it('blank literals stay in the set (membership exempts them, not the walker)', () => {
    expect(outputsOf('IF(amount > 5, "HOT", "")')).toEqual(['', 'HOT']);
  });

  it('nested ladders union transitively', () => {
    expect(outputsOf('IF(amount > 1, IF(amount > 2, "X", "Y"), "Z")')).toEqual([
      'X',
      'Y',
      'Z',
    ]);
  });

  it('field refs, concat, TEXT(), numbers and open IFBLANK poison to null', () => {
    expect(outputsOf('stage')).toBeNull();
    expect(outputsOf('IF(amount > 5, "HOT", stage)')).toBeNull();
    expect(outputsOf('"A" & "B"')).toBeNull();
    expect(outputsOf('TEXT(amount)')).toBeNull();
    expect(outputsOf('IFBLANK(stage, "NEW")')).toBeNull();
    expect(outputsOf('42')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, confirm module-not-found failure.** `npx vitest run src/engine/__tests__/static-text-outputs.spec.ts`

- [ ] **Step 3: Implement `src/engine/static-text-outputs.ts`:**

```ts
import { type AstNode } from 'src/engine/ast';

// The set of text values a formula can statically produce, or null when the
// set is open (any non-literal in an output position poisons the whole
// result). Drives the SELECT membership gate's static tier (ADR 0029 D3):
// closed set -> membership fully decidable at save/pass time; open set -> the
// per-record runtime check owns it. Condition subtrees never contribute —
// only value positions do. IFS/SWITCH need no cases: they desugar to `if`
// ladders at parse time, and a defaultless ladder's synthesized `null` node
// contributes nothing (a null output clears the field, always legal).
// O(nodes); runs at save time and once per pass, never per record.
export const staticTextOutputs = (node: AstNode): ReadonlySet<string> | null => {
  switch (node.type) {
    case 'string':
      return new Set([node.value]);
    case 'null':
      return new Set();
    case 'if': {
      const thenOutputs = staticTextOutputs(node.then);
      if (thenOutputs === null) return null;
      const elseOutputs = staticTextOutputs(node.else);
      if (elseOutputs === null) return null;
      return new Set([...thenOutputs, ...elseOutputs]);
    }
    case 'ifblank': {
      const valueOutputs = staticTextOutputs(node.value);
      if (valueOutputs === null) return null;
      const fallbackOutputs = staticTextOutputs(node.fallback);
      if (fallbackOutputs === null) return null;
      return new Set([...valueOutputs, ...fallbackOutputs]);
    }
    default:
      return null;
  }
};
```

- [ ] **Step 4: Run the test to green.** If any expression fixture fails to parse (e.g. `IFS` arity), adjust the fixture to the parser's accepted syntax — the semantics under test stay the same.

- [ ] **Step 5: Typecheck, lint, commit.**

```bash
npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): add the staticTextOutputs walker"
```

---

### Task 4: The membership gate and option-set helpers

`selectMembershipGateError` plus the option-set carrier types, in kind-inference.ts alongside `strictKindGateError` (spec D3 tier 1a/1b share this one function; message copy from D6).

**Files:**
- Modify: `src/logic-functions/lib/kind-inference.ts`
- Test: `src/logic-functions/lib/__tests__/kind-inference.spec.ts`

**Interfaces:**
- Consumes: `staticTextOutputs` (Task 3); `AstNode` (already imported here).
- Produces (all exported from kind-inference.ts):
  - `type SelectOption = { value: string; label: string }`
  - `type TargetSelectOptions = { list: ReadonlyArray<SelectOption>; values: ReadonlySet<string> }`
  - `buildTargetSelectOptions(list: ReadonlyArray<SelectOption> | null | undefined): TargetSelectOptions | null` (null for null/empty input — empty means unresolvable, spec D5)
  - `selectMembershipGateError(args: { ast: AstNode; targetFieldType: string | null | undefined; targetOptions: TargetSelectOptions | null | undefined }): string | null`

- [ ] **Step 1: Write the failing tests** — new describe in kind-inference.spec.ts (reuse its existing `parse` import; add `buildTargetSelectOptions` and `selectMembershipGateError` to its kind-inference import):

```ts
describe('selectMembershipGateError', () => {
  const OPTIONS = buildTargetSelectOptions([
    { value: 'HOT', label: 'Hot' },
    { value: 'COLD', label: 'Cold' },
    { value: 'NEW', label: 'New' },
  ]);
  const membership = (
    expression: string,
    targetOptions = OPTIONS,
  ): string | null =>
    selectMembershipGateError({
      ast: parse(expression),
      targetFieldType: 'SELECT',
      targetOptions,
    });

  it('a closed set of member literals passes', () => {
    expect(membership('IF(amount > 5, "HOT", "COLD")')).toBeNull();
  });

  it('a non-member literal is rejected with the bounded option list', () => {
    expect(membership('IF(amount > 5, "WARM", "COLD")')).toBe(
      'Formula can produce "WARM", which is not an option of the target field (options: HOT, COLD, NEW)',
    );
  });

  it('case-insensitive value or label matches add the did-you-mean hint', () => {
    expect(membership('"Hot"')).toBe(
      'Formula can produce "Hot", which is not an option of the target field (options: HOT, COLD, NEW) Did you mean "HOT"?',
    );
  });

  it('blank literals are exempt — they clear the field (D4)', () => {
    expect(membership('IF(amount > 5, "HOT", "")')).toBeNull();
  });

  it('open sets pass — tier 2 owns them', () => {
    expect(membership('stage')).toBeNull();
    expect(membership('IFBLANK(stage, "TYPO")')).toBeNull();
  });

  it('non-SELECT targets and unresolved/empty options skip', () => {
    expect(
      selectMembershipGateError({
        ast: parse('"TYPO"'),
        targetFieldType: 'TEXT',
        targetOptions: OPTIONS,
      }),
    ).toBeNull();
    expect(membership('"TYPO"', null)).toBeNull();
    expect(buildTargetSelectOptions([])).toBeNull();
    expect(buildTargetSelectOptions(null)).toBeNull();
  });

  it('bounds the option list at six values with an ellipsis', () => {
    const many = buildTargetSelectOptions(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((value) => ({ value, label: value })),
    );
    expect(membership('"NOPE"', many)).toBe(
      'Formula can produce "NOPE", which is not an option of the target field (options: A, B, C, D, E, F, …)',
    );
  });
});
```

- [ ] **Step 2: Run kind-inference.spec.ts, confirm the new describe fails to compile/resolve.**

- [ ] **Step 3: Implement** — append to kind-inference.ts (import `staticTextOutputs` from `src/engine/static-text-outputs`):

```ts
// A SELECT field option as the gates consume it: the stored value plus the
// display label. Labels feed the did-you-mean hint only — matching is always
// by value, case-sensitively, like every other string comparison in the
// language (ADR 0029 D6).
export type SelectOption = { value: string; label: string };

// The per-pass / per-event resolved option set: the ordered list for messages
// plus a value Set for O(1) membership at the write boundary. Built once by
// each hoist point, never per record. Null input or an empty list is
// "unresolvable" (the platform guarantees a real SELECT field has at least one
// option), so gates skip rather than reject (ADR 0027 posture).
export type TargetSelectOptions = {
  list: ReadonlyArray<SelectOption>;
  values: ReadonlySet<string>;
};

export const buildTargetSelectOptions = (
  list: ReadonlyArray<SelectOption> | null | undefined,
): TargetSelectOptions | null =>
  list == null || list.length === 0
    ? null
    : { list, values: new Set(list.map((option) => option.value)) };

const MEMBERSHIP_MESSAGE_OPTION_LIMIT = 6;

const membershipGateMessage = (
  literal: string,
  targetOptions: TargetSelectOptions,
): string => {
  const values = targetOptions.list.map((option) => option.value);
  const shown =
    values.slice(0, MEMBERSHIP_MESSAGE_OPTION_LIMIT).join(', ') +
    (values.length > MEMBERSHIP_MESSAGE_OPTION_LIMIT ? ', …' : '');
  // The label-vs-value trap: users think in labels, the platform forces
  // UPPER_SNAKE values. A case-insensitive value/label match names the value
  // the user almost certainly meant.
  const lower = literal.toLowerCase();
  const nearMiss = targetOptions.list.find(
    (option) =>
      option.value.toLowerCase() === lower ||
      option.label.toLowerCase() === lower,
  );
  const hint = nearMiss ? ` Did you mean "${nearMiss.value}"?` : '';
  return `Formula can produce "${literal}", which is not an option of the target field (options: ${shown})${hint}`;
};

// SELECT membership gate, static tier (ADR 0029 D3): when the formula's text
// outputs form a closed literal set, every non-blank literal must name a
// defined option value. Open sets pass (the per-record check owns them); an
// unresolvable option set skips, never rejects. Blank literals are legal —
// they normalize to null and clear the field (D4). Runs after the kind gate,
// so the tree is already text-kind at the root.
export const selectMembershipGateError = (args: {
  ast: AstNode;
  targetFieldType: string | null | undefined;
  targetOptions: TargetSelectOptions | null | undefined;
}): string | null => {
  const { ast, targetFieldType, targetOptions } = args;
  if (targetFieldType !== 'SELECT' || targetOptions == null) {
    return null;
  }
  const outputs = staticTextOutputs(ast);
  if (outputs === null) {
    return null;
  }
  for (const literal of outputs) {
    if (literal.trim() === '') {
      continue;
    }
    if (!targetOptions.values.has(literal)) {
      return membershipGateMessage(literal, targetOptions);
    }
  }
  return null;
};
```

- [ ] **Step 4: Run to green; full suite; typecheck; lint. Commit.**

```bash
npx vitest run && npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): add the SELECT membership gate"
```

---

### Task 5: The `targetFieldOptions` accessor

Option data is already cached by `loadAllObjectsWithFields` (per-field `options`, 60s TTL, in-flight dedup); this adds the missing accessor (spec D5). No new queries.

**Files:**
- Modify: `src/logic-functions/lib/metadata-objects.ts`
- Test: `src/logic-functions/lib/__tests__/metadata-objects.spec.ts`

**Interfaces:**
- Consumes: `loadAllObjectsWithFields` (same file); `type SelectOption` (Task 4).
- Produces: `export const targetFieldOptions = async (objectName: string, fieldName: string): Promise<ReadonlyArray<SelectOption> | null>` — null on load failure, missing object/field, non-array or empty options.

- [ ] **Step 1: Write the failing tests** — append to metadata-objects.spec.ts (it already imports the fake seam; add `targetFieldOptions`):

```ts
describe('targetFieldOptions', () => {
  afterEach(() => {
    __setFakeObjectsWithFieldsForTests(null);
  });

  const seedStageOptions = (options: unknown) => {
    __setFakeObjectsWithFieldsForTests([
      {
        id: 'obj-1',
        nameSingular: 'opportunity',
        labelIdentifierFieldMetadataId: null,
        fields: [
          {
            id: 'field-1',
            name: 'formulaStage',
            type: 'SELECT',
            isActive: true,
            isSystem: false,
            options,
          },
        ],
      },
    ]);
  };

  it('returns value/label pairs from the cached field metadata', async () => {
    seedStageOptions([
      { id: 'a', value: 'HOT', label: 'Hot', color: 'red', position: 0 },
      { id: 'b', value: 'COLD', label: 'Cold', color: 'blue', position: 1 },
    ]);
    expect(await targetFieldOptions('opportunity', 'formulaStage')).toEqual([
      { value: 'HOT', label: 'Hot' },
      { value: 'COLD', label: 'Cold' },
    ]);
  });

  it('label falls back to the value; malformed entries drop', async () => {
    seedStageOptions([{ value: 'HOT' }, { label: 'no value' }, null]);
    expect(await targetFieldOptions('opportunity', 'formulaStage')).toEqual([
      { value: 'HOT', label: 'HOT' },
    ]);
  });

  it('missing object/field, non-array or empty options resolve to null', async () => {
    seedStageOptions([]);
    expect(await targetFieldOptions('opportunity', 'formulaStage')).toBeNull();
    expect(await targetFieldOptions('nope', 'formulaStage')).toBeNull();
    expect(await targetFieldOptions('opportunity', 'other')).toBeNull();
    seedStageOptions(undefined);
    expect(await targetFieldOptions('opportunity', 'formulaStage')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure.** `npx vitest run src/logic-functions/lib/__tests__/metadata-objects.spec.ts`

- [ ] **Step 3: Implement** — append to metadata-objects.ts (type-only import: `import { type SelectOption } from 'src/logic-functions/lib/kind-inference';`):

```ts
// Option set of a SELECT target field, read from the same 60s cache every
// other metadata consumer rides (ADR 0029 D5) — no new queries, no new TTLs.
// Null when the load fails, the object/field is missing, or no usable options
// exist; callers treat null as skip-never-reject. Direct-call precedent over
// the FormulaClient abstraction: syncable-fields.ts, formula-status.ts.
export const targetFieldOptions = async (
  objectName: string,
  fieldName: string,
): Promise<ReadonlyArray<SelectOption> | null> => {
  let objects: MetadataObjectInfo[];
  try {
    objects = await loadAllObjectsWithFields();
  } catch {
    return null;
  }
  const field = objects
    .find((candidate) => candidate.nameSingular === objectName)
    ?.fields.find((candidate) => candidate.name === fieldName);
  if (!field || !Array.isArray(field.options)) {
    return null;
  }
  const options = field.options
    .filter(
      (option): option is { value: string; label?: unknown } =>
        Boolean(option) &&
        typeof (option as { value?: unknown }).value === 'string',
    )
    .map((option) => ({
      value: option.value,
      label: typeof option.label === 'string' ? option.label : option.value,
    }));
  return options.length > 0 ? options : null;
};
```

- [ ] **Step 4: Run to green; full suite; typecheck; lint. Commit.**

```bash
npx vitest run && npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): expose target-field options over the metadata cache"
```

---

### Task 6: Tier 1a — the save gate and the editors' live check

`validateExpressionCore` gains a `targetOptions` data input and runs the membership gate; the backend save path preloads options next to `preloadKinds`; both editors pass their already-fetched options so the live check matches the server byte-for-byte (spec D3 tier 1a, D5 save path).

**Files:**
- Modify: `src/logic-functions/lib/validation-core.ts` (param + new step after 1b, lines ~97-112)
- Modify: `src/logic-functions/lib/save-validation.ts` (`ValidateArgs` at 61, call site at 155-164)
- Modify: `src/front-components/lib/validate-expression.ts` (7th parameter)
- Modify: `src/logic-functions/lib/handle-formula-change.ts` (preload before the `validateFormula` call at ~207)
- Modify: `src/front-components/formula-editor.tsx` (line 248 destructure; call sites 615 and 843)
- Modify: `src/front-components/formula-definition-editor.tsx` (`validate` helper at 101-120; line 384 destructure; call sites 495 and 524)
- Test: `src/front-components/lib/__tests__/validate-expression.spec.ts`

**Interfaces:**
- Consumes: `selectMembershipGateError`, `buildTargetSelectOptions`, `type SelectOption` (Task 4); `targetFieldOptions` (Task 5).
- Produces: `validateExpressionCore({..., targetOptions?: ReadonlyArray<SelectOption> | null})`; `validateFormula({..., targetOptions?})`; `validateExpression(expression, hostObject, targetField, allDefinitions, fieldKinds?, targetFieldType?, targetOptions?)`.

- [ ] **Step 1: Write the failing tests** — append to validate-expression.spec.ts:

```ts
describe('SELECT membership at save (ADR 0029 tier 1a)', () => {
  const kinds = new Map([
    ['amount', 'NUMBER'],
    ['stage', 'SELECT'],
  ]);
  const OPTIONS = [
    { value: 'HOT', label: 'Hot' },
    { value: 'COLD', label: 'Cold' },
  ];
  const run = (
    expression: string,
    targetOptions?: ReadonlyArray<{ value: string; label: string }> | null,
  ) =>
    validateExpression(
      expression,
      'company',
      'formulaStage',
      [],
      (object) => (object === 'company' ? kinds : undefined),
      'SELECT',
      targetOptions,
    );

  it('a closed member set saves clean', () => {
    expect(run('IF(amount > 5, "HOT", "COLD")', OPTIONS)).toBeNull();
  });

  it('a typo is rejected in the editor and at save, with the hint', () => {
    expect(run('IF(amount > 5, "Hot", "COLD")', OPTIONS)).toBe(
      'Formula can produce "Hot", which is not an option of the target field (options: HOT, COLD) Did you mean "HOT"?',
    );
  });

  it('open sets and missing/empty options pass (tier 2 covers them)', () => {
    expect(run('stage', OPTIONS)).toBeNull();
    expect(run('"TYPO"')).toBeNull();
    expect(run('"TYPO"', null)).toBeNull();
    expect(run('"TYPO"', [])).toBeNull();
  });

  it('the kind gate still fires first for non-text expressions', () => {
    expect(run('amount * 2', OPTIONS)).toMatch(
      /computes number but the target field holds text/,
    );
  });
});
```

- [ ] **Step 2: Run, confirm the 7-arg call fails to typecheck/behave.** `npx vitest run src/front-components/lib/__tests__/validate-expression.spec.ts`

- [ ] **Step 3: Implement validation-core.ts.** Add to the input type: `targetOptions?: ReadonlyArray<SelectOption> | null;` (destructure it too). Import `buildTargetSelectOptions`, `selectMembershipGateError`, `type SelectOption` from kind-inference (already an allowed dependency — 1b imports from it today). Insert between the 1b block and 1c:

```ts
  // 1b'. SELECT membership gate, static tier (ADR 0029 D3): only for SELECT
  //      targets with a resolvable option set. Open literal sets pass — the
  //      per-record runtime check owns them; missing options skip, never
  //      reject (the recompute gates re-check with resolved options).
  const membershipError = selectMembershipGateError({
    ast,
    targetFieldType,
    targetOptions: buildTargetSelectOptions(targetOptions),
  });
  if (membershipError !== null) {
    return { valid: false, error: membershipError };
  }
```

- [ ] **Step 4: Thread the save path.** In save-validation.ts add to `ValidateArgs`:

```ts
  // The candidate's target SELECT option set, preloaded by the caller
  // (handle-formula-change's async seam). Absent/null degrades the membership
  // gate to skip.
  targetOptions?: ReadonlyArray<SelectOption> | null;
```

destructure it in `validateFormula` and add `targetOptions,` to its `validateExpressionCore({...})` call. In validate-expression.ts add the 7th parameter `targetOptions?: ReadonlyArray<SelectOption> | null` and pass `targetOptions,` into the core call. Import `type SelectOption` in both.

- [ ] **Step 5: Preload in handle-formula-change.ts.** Import `targetFieldOptions` from metadata-objects. Directly above the `const result = validateFormula({...})` call (~line 207):

```ts
  // The membership gate's async seam (ADR 0029 tier 1a): the sync validator
  // takes options as data. Unresolvable options degrade to skip — the
  // recompute gates re-check with resolved options every pass.
  const targetOptions =
    after.targetFieldType === 'SELECT' && after.targetObject
      ? await targetFieldOptions(after.targetObject, after.targetField ?? '')
      : null;
```

and add `targetOptions,` to the `validateFormula({...})` call. (The existing invalid-result posture — save-but-disable with `lastError` — needs no change; a membership violation now flows through it.)

- [ ] **Step 6: Thread the editors.**
  - formula-editor.tsx line 248 currently reads `const { kindsByName: hostFieldKinds } = useObjectFields(hostObject);` — add `fields: hostFields,` to the destructure. At both `validateExpression(` call sites (lines ~615 and ~843) append a 7th argument:

```ts
        definition.targetFieldType === 'SELECT'
          ? hostFields.find((field) => field.name === definition.targetField)
              ?.options ?? null
          : null,
```

  Add `hostFields` to the enclosing hooks' dependency arrays: the `saveExpression` useCallback deps at ~line 656, and the `content` useMemo (opens ~line 830) whose dep array sits at lines 1042-1059.
  - formula-definition-editor.tsx: give the module-level `validate` helper a 5th parameter `targetOptions?: ReadonlyArray<SelectOption> | null` (import `type SelectOption` from kind-inference) and pass it as `validateExpression`'s 7th argument. Line 384: also destructure `fields: targetObjectFields`. At both `validate(...)` call sites (~495, ~524) append:

```ts
        definition.targetFieldType === 'SELECT'
          ? targetObjectFields.find(
              (field) => field.name === definition.targetField,
            )?.options ?? null
          : null,
```

  (`FieldOption.options` is `Array<{value: string; label: string}>` — structurally `SelectOption[]`; `deriveObjectFields` drops empty arrays, and absent options degrade to skip, which is the intended editor posture.)

- [ ] **Step 7: Run to green; full suite; typecheck; lint. Commit.**

```bash
npx vitest run && npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): gate SELECT literals at save and in the editors"
```

---

### Task 7: Recompute — per-pass re-gate, tier-2 check, `NOT_AN_OPTION`

The sweep resolves the option set once per pass, re-gates statically (freeze on option drift: zero record scans), and the per-record membership check throws inside the existing normalize try so it rides the FormulaError funnel (spec D3 tier 1b + tier 2, D6 runtime error).

**Files:**
- Modify: `src/engine/errors.ts`
- Modify: `src/logic-functions/lib/recompute.ts` (RecomputeArgs ~395-417; planRecomputeForRecord destructure ~761-770 and normalize try ~855-869; recomputeForRecord ~904-984; sweep gate block ~1049-1081 and per-record call ~1170-1180)
- Test: create `src/logic-functions/lib/__tests__/select-recompute.spec.ts`

**Interfaces:**
- Consumes: `selectMembershipGateError`, `buildTargetSelectOptions`, `type TargetSelectOptions` (Task 4); `targetFieldOptions` (Task 5); `FormulaError` (engine errors).
- Produces: `'NOT_AN_OPTION'` in `FormulaErrorCode`; `RecomputeArgs.targetOptions?: TargetSelectOptions | null`; runtime error surfaced as `NOT_AN_OPTION: "WARM" is not an option of formulaStage`; `recomputeForRecord` resolves its own options when not threaded (kind-gate fallback pattern).

- [ ] **Step 1: Write the failing test file** `select-recompute.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import {
  __setFakeObjectsWithFieldsForTests,
  targetFieldOptions,
} from 'src/logic-functions/lib/metadata-objects';
import {
  recomputeAllRecords,
  recomputeForRecord,
} from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';

// Pass-through spy so the once-per-pass hoist is observable (same seam pattern
// as recompute.spec.ts's parse counter).
vi.mock('src/logic-functions/lib/metadata-objects', async (importActual) => {
  const actual =
    await importActual<typeof import('src/logic-functions/lib/metadata-objects')>();
  return { ...actual, targetFieldOptions: vi.fn(actual.targetFieldOptions) };
});

const seedMetadata = (values: string[]) => {
  __setFakeObjectsWithFieldsForTests([
    {
      id: 'obj-opportunity',
      nameSingular: 'opportunity',
      labelIdentifierFieldMetadataId: null,
      fields: [
        {
          id: 'field-stage',
          name: 'formulaStage',
          type: 'SELECT',
          isActive: true,
          isSystem: false,
          options: values.map((value, index) => ({
            id: `opt-${index}`,
            value,
            label: value,
            color: 'green',
            position: index,
          })),
        },
      ],
    },
  ]);
};

const selectFormula = (
  expression: string,
  extra: Partial<FormulaDefinitionRecord> = {},
): FormulaDefinitionRecord => ({
  id: 'fs1',
  targetObject: 'opportunity',
  targetField: 'formulaStage',
  targetFieldType: 'SELECT',
  outputFormat: 'select',
  expression,
  enabled: true,
  ...extra,
});

const seedRecords = (
  client: FakeClient,
  records: Array<Record<string, unknown>>,
) => {
  client.setFieldKinds('opportunity', {
    amount: 'NUMBER',
    stage: 'SELECT',
    formulaStage: 'SELECT',
  });
  client.seed('opportunity', records);
};

afterEach(() => {
  __setFakeObjectsWithFieldsForTests(null);
  vi.clearAllMocks();
});

describe('SELECT sweep (ADR 0029)', () => {
  it('writes the computed option value on the engine lane', async () => {
    seedMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    seedRecords(client, [
      { id: 'o1', amount: 200, formulaStage: null },
      { id: 'o2', amount: 5, formulaStage: null },
    ]);

    await recomputeAllRecords(
      client,
      selectFormula('IF(amount > 100, "HOT", "COLD")'),
    );

    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
    expect(client.get('opportunity', 'o2')!.formulaStage).toBe('COLD');
  });

  it('resolves the option set once per pass, not per record', async () => {
    seedMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    seedRecords(client, [
      { id: 'o1', amount: 200, formulaStage: null },
      { id: 'o2', amount: 5, formulaStage: null },
      { id: 'o3', amount: 50, formulaStage: null },
    ]);

    await recomputeAllRecords(
      client,
      selectFormula('IF(amount > 100, "HOT", "COLD")'),
    );

    expect(vi.mocked(targetFieldOptions)).toHaveBeenCalledTimes(1);
  });

  it('option drift freezes the whole definition: zero scans, zero writes', async () => {
    seedMetadata(['HOT']); // COLD was deleted natively
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', amount: 200, formulaStage: 'HOT' }]);

    const outcomes = await recomputeAllRecords(
      client,
      selectFormula('IF(amount > 100, "HOT", "COLD")'),
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].targetRecordId).toBe('');
    expect(outcomes[0].error).toMatch(/can produce "COLD"/);
    expect(client.querySelections).toHaveLength(0);
    expect(client.writes).toHaveLength(0);
  });

  it('tier 2: an open-set non-member errors per record and keeps the last value', async () => {
    seedMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', stage: 'WARM', formulaStage: 'HOT' }]);

    const outcomes = await recomputeAllRecords(client, selectFormula('stage'));

    expect(outcomes[0].error).toBe(
      'NOT_AN_OPTION: "WARM" is not an option of formulaStage',
    );
    expect(outcomes[0].changed).toBe(false);
    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
    expect(client.writes).toHaveLength(0);
  });

  it('blank computed text clears the field; an already-null target converges without a write', async () => {
    seedMetadata(['HOT']);
    const client = new FakeClient();
    seedRecords(client, [
      { id: 'o1', amount: 5, formulaStage: 'HOT' },
      { id: 'o2', amount: 5, formulaStage: null },
    ]);

    await recomputeAllRecords(client, selectFormula('IF(amount > 100, "HOT", "")'));

    expect(client.get('opportunity', 'o1')!.formulaStage).toBeNull();
    expect(client.writes).toHaveLength(1);
  });

  it('a non-member never poisons the page batch (mixed page, one write)', async () => {
    seedMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    seedRecords(client, [
      { id: 'o1', stage: 'HOT', formulaStage: null },
      { id: 'o2', stage: 'WARM', formulaStage: null },
    ]);

    const outcomes = await recomputeAllRecords(client, selectFormula('stage'));

    // o1 writes through; o2's NOT_AN_OPTION never reaches the batch, so
    // flushBatchedWrites never falls back to its per-record retry path.
    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
    expect(client.get('opportunity', 'o2')!.formulaStage).toBeNull();
    expect(client.writes).toHaveLength(1);
    const errored = outcomes.find((outcome) => outcome.targetRecordId === 'o2');
    expect(errored?.error).toMatch(/NOT_AN_OPTION/);
  });

  it('a deployed SELECT mirror (bare ref, outputFormat "mirror") converges on the engine lane', async () => {
    seedMetadata(['HOT']);
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', stage: 'HOT', formulaStage: 'HOT' }]);

    const outcomes = await recomputeAllRecords(
      client,
      selectFormula('stage', { outputFormat: 'mirror' }),
    );

    expect(outcomes[0].changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });
});

describe('recomputeForRecord SELECT fallback (ADR 0029)', () => {
  it('a direct call without threaded options still gates — it resolves its own', async () => {
    seedMetadata(['HOT']);
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', amount: 200, formulaStage: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: selectFormula('IF(amount > 100, "HOT", "COLD")'),
      targetRecordId: 'o1',
    });

    expect(outcome.error).toMatch(/can produce "COLD"/);
    expect(outcome.changed).toBe(false);
    expect(client.writes).toHaveLength(0);
  });

  it('unresolvable options skip the gates and write through', async () => {
    __setFakeObjectsWithFieldsForTests([]); // degraded metadata: no objects
    const client = new FakeClient();
    seedRecords(client, [{ id: 'o1', amount: 200, formulaStage: null }]);

    const outcome = await recomputeForRecord({
      client,
      formula: selectFormula('IF(amount > 100, "HOT", "COLD")'),
      targetRecordId: 'o1',
    });

    expect(outcome.error).toBeNull();
    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
  });
});
```

- [ ] **Step 2: Run it, confirm failures** (`NOT_AN_OPTION` missing, no gating). `npx vitest run src/logic-functions/lib/__tests__/select-recompute.spec.ts`

- [ ] **Step 3: Add the error code** — errors.ts union gains `| 'NOT_AN_OPTION'` after `'TEXT_TOO_LONG'`.

- [ ] **Step 4: Implement recompute.ts.**
  - Imports: add `FormulaError` next to the existing `isFormulaError` import; `buildTargetSelectOptions`, `selectMembershipGateError`, `type TargetSelectOptions` from kind-inference; `targetFieldOptions` from metadata-objects.
  - `RecomputeArgs` gains:

```ts
  // The target SELECT field's option set, resolved ONCE by the caller
  // (ADR 0029 D5) — the pass and event paths thread it; recomputeForRecord
  // resolves its own when absent (the kind-gate fallback pattern). Null on
  // non-SELECT targets.
  targetOptions?: TargetSelectOptions | null;
```

  - `planRecomputeForRecord`: add `targetOptions,` to its destructure list. Inside the existing normalize try (after the `normalizeComputedValue` assignment, before the catch):

```ts
    // Tier 2 (ADR 0029 D3): a SELECT write must name a defined option. Runs
    // unconditionally for SELECT targets — defense in depth for mid-pass
    // metadata drift; O(1), no I/O. Null bypasses (clears the field, the
    // platform's own semantics); unresolved options degrade to skip. Thrown
    // here so it rides the FormulaError funnel: value NOT written, last value
    // kept, error on lastError, the record save never blocked — and the
    // non-member never reaches flushBatchedWrites' per-record retry path.
    if (
      formula.targetFieldType === 'SELECT' &&
      typeof result === 'string' &&
      targetOptions != null &&
      !targetOptions.values.has(result)
    ) {
      const excerpt = result.length > 80 ? `${result.slice(0, 80)}…` : result;
      throw new FormulaError(
        'NOT_AN_OPTION',
        `"${excerpt}" is not an option of ${targetField}`,
      );
    }
```

  - Sweep (`recomputeAllRecords`): right after the `fieldKindsByObject` resolution (~1049-1051), using the existing `targetObject`/`targetField` locals:

```ts
  // The SELECT option set is a property of the definition's target field:
  // resolved once per pass (same cache discipline as the kinds read above) and
  // threaded into the static re-gate and every per-record membership check.
  const targetSelectOptions =
    formula.targetFieldType === 'SELECT'
      ? buildTargetSelectOptions(
          await targetFieldOptions(targetObject, targetField),
        )
      : null;
```

  After the existing kind-gate refusal block (~1081):

```ts
  // Membership re-gate, tier 1b (ADR 0029 D3): deleting an option a closed-set
  // formula names freezes the whole definition write-avoidantly — one static
  // check per pass, zero record scans, self-healing within the metadata TTL
  // once the option is restored natively.
  const membershipGateError =
    compiled === undefined
      ? null
      : selectMembershipGateError({
          ast: compiled.ast,
          targetFieldType: formula.targetFieldType,
          targetOptions: targetSelectOptions,
        });
  if (membershipGateError !== null) {
    return refuseWholeDefinition(client, formula, emptyValue, membershipGateError);
  }
```

  In the per-record loop's `planRecomputeForRecord({...})` call (lines ~1197-1208), add `targetOptions: targetSelectOptions,`.
  - `recomputeForRecord`: declare `let targetOptions = args.targetOptions;` immediately BEFORE the `if (compiled !== undefined)` block (so it is in scope for the `planRecomputeForRecord({ ...args, compiled, fieldKindsByObject: gateKindsByObject, targetOptions })` call at ~line 963). Then inside that block, after the kind-gate early return, add:

```ts
    if (formula.targetFieldType === 'SELECT') {
      // Same fallback contract as the kinds above: every production caller
      // threads options already — including null, which means "resolved but
      // unresolvable" and must NOT re-resolve. Only a truly absent value (a
      // direct caller) resolves its own, at one cached metadata read, keeping
      // the caller GATED rather than silently ungated.
      if (targetOptions === undefined) {
        targetOptions = buildTargetSelectOptions(
          await targetFieldOptions(
            formula.targetObject ?? '',
            formula.targetField ?? '',
          ),
        );
      }
      const membershipGateError = selectMembershipGateError({
        ast: compiled.ast,
        targetFieldType: formula.targetFieldType,
        targetOptions,
      });
      if (membershipGateError !== null) {
        return {
          formulaId: formula.id,
          targetRecordId,
          changed: false,
          value: emptyComputedValue(formula, false),
          error: membershipGateError,
        };
      }
    }
```

- [ ] **Step 5: Run the new file to green, then the FULL suite** — `handlers.spec.ts:1001` (SELECT toggle-off) must still pass: its options are unresolvable in that test (no fake metadata seeded), so tier 2 skips and the write goes through. `npx vitest run`

- [ ] **Step 6: Typecheck, lint, commit.**

```bash
npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): two-tier SELECT gating in recompute"
```

---

### Task 8: Event path and single-record callers thread the option set

The event handler hoists options once per event, joins the membership verdict into `gateErrorByFormulaId` (full both-lane freeze — user ruling 3), and the two front single-record callers thread their own resolved set (spec D3 hoist points).

**Files:**
- Modify: `src/logic-functions/lib/handle-record-update.ts` (after line ~250; gate loop 258-273; recompute call 498-508)
- Modify: `src/front-components/formula-editor.tsx` (toggle-off call ~808-820)
- Modify: `src/front-components/lib/refresh-stale-formulas.ts` (call ~135-147)
- Test: `src/logic-functions/lib/__tests__/handlers.spec.ts`

**Interfaces:**
- Consumes: Task 4 helpers, Task 5 accessor, Task 7's `RecomputeArgs.targetOptions`.
- Produces: membership-frozen definitions skip override detection, lock reverts, and event recompute (the `gateErrorByFormulaId` map); all three production single-record callers pass `targetOptions`.

- [ ] **Step 1: Write the failing tests** — append to handlers.spec.ts (add `__setFakeObjectsWithFieldsForTests` to its metadata-objects imports, or add that import):

```ts
describe('handleRecordUpdate SELECT membership (ADR 0029)', () => {
  const seedSelectMetadata = (values: string[]) => {
    __setFakeObjectsWithFieldsForTests([
      {
        id: 'obj-opportunity',
        nameSingular: 'opportunity',
        labelIdentifierFieldMetadataId: null,
        fields: [
          {
            id: 'field-stage',
            name: 'formulaStage',
            type: 'SELECT',
            isActive: true,
            isSystem: false,
            options: values.map((value, index) => ({
              id: `opt-${index}`,
              value,
              label: value,
              color: 'green',
              position: index,
            })),
          },
        ],
      },
    ]);
  };

  afterEach(() => {
    __setFakeObjectsWithFieldsForTests(null);
  });

  it('event recompute writes a member option value', async () => {
    seedSelectMetadata(['HOT', 'COLD']);
    const client = new FakeClient();
    client.setFieldKinds('opportunity', {
      amount: 'NUMBER',
      formulaStage: 'SELECT',
    });
    client.seed('formulaDefinition', [
      {
        id: 'f-select',
        targetObject: 'opportunity',
        targetField: 'formulaStage',
        targetFieldType: 'SELECT',
        expression: 'IF(amount > 100, "HOT", "COLD")',
        enabled: true,
      },
    ]);
    client.seed('opportunity', [{ id: 'o1', amount: 200, formulaStage: null }]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', amount: 200, formulaStage: null },
      updatedFields: ['amount'],
      actorWorkspaceMemberId: 'member-1',
    });

    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('HOT');
  });

  it('option drift freezes the event lane too: no recompute, no pin, no lock revert', async () => {
    seedSelectMetadata(['HOT']); // COLD was deleted natively
    const client = new FakeClient();
    client.setFieldKinds('opportunity', {
      amount: 'NUMBER',
      formulaStage: 'SELECT',
    });
    client.seed('formulaDefinition', [
      {
        id: 'f-frozen',
        targetObject: 'opportunity',
        targetField: 'formulaStage',
        targetFieldType: 'SELECT',
        expression: 'IF(amount > 100, "HOT", "COLD")',
        enabled: true,
        allowOverride: false,
      },
    ]);
    client.seed('opportunity', [{ id: 'o1', amount: 200, formulaStage: 'OUTSIDE' }]);

    await handleRecordUpdate({
      client,
      objectName: 'opportunity',
      recordId: 'o1',
      after: { id: 'o1', amount: 200, formulaStage: 'OUTSIDE' },
      updatedFields: ['formulaStage'],
      actorWorkspaceMemberId: 'member-1',
    });

    // Frozen on both lanes (user ruling 3): the outside write sticks until the
    // options are fixed natively; nothing pins, nothing reverts.
    expect(client.get('opportunity', 'o1')!.formulaStage).toBe('OUTSIDE');
    expect(
      client.mutationSelections.some(
        (selection) => 'createFormulaOverride' in selection,
      ),
    ).toBe(false);
    expect(
      client.writes.filter((write) => write.startsWith('opportunity:')),
    ).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run handlers.spec.ts, confirm the two new tests fail.**

- [ ] **Step 3: Implement handle-record-update.ts.** Imports: `buildTargetSelectOptions`, `selectMembershipGateError`, `type TargetSelectOptions` from kind-inference; `targetFieldOptions` from metadata-objects. After the `eventFieldKindsByObject` resolution (~line 250):

```ts
  // SELECT option sets for the event's affected SELECT targets, once per event
  // (the kinds map's discipline, ADR 0027 D5). Every read rides the 60s
  // metadata cache, so N SELECT formulas cost at most one cold pull.
  const targetOptionsByFormulaId = new Map<string, TargetSelectOptions | null>();
  for (const formula of eventAffectedFormulas) {
    if (formula.targetFieldType !== 'SELECT') {
      continue;
    }
    targetOptionsByFormulaId.set(
      formula.id,
      buildTargetSelectOptions(
        await targetFieldOptions(
          formula.targetObject ?? '',
          formula.targetField ?? '',
        ),
      ),
    );
  }
```

In the `gateErrorByFormulaId` loop, the verdict becomes a chain (membership joins the same freeze map — override-detection skip at ~295 and the lock-revert consult at ~436 need no changes):

```ts
    const gateError =
      strictKindGateError({
        ast: compiled.ast,
        hostObject: formula.targetObject ?? '',
        targetFieldType: formula.targetFieldType,
        fieldKinds: (object) => eventFieldKindsByObject.get(object),
      }) ??
      selectMembershipGateError({
        ast: compiled.ast,
        targetFieldType: formula.targetFieldType,
        targetOptions: targetOptionsByFormulaId.get(formula.id) ?? null,
      });
```

In the event-path `recomputeForRecord({...})` call (~498-508) add:

```ts
        targetOptions: targetOptionsByFormulaId.get(formula.id) ?? null,
```

- [ ] **Step 4: Thread the two front callers.**
  - formula-editor.tsx toggle-off (~808): add to the `recomputeForRecord({...})` args (imports: `buildTargetSelectOptions` from kind-inference, `targetFieldOptions` from metadata-objects):

```ts
            targetOptions:
              definition.targetFieldType === 'SELECT'
                ? buildTargetSelectOptions(
                    await targetFieldOptions(
                      definition.targetObject,
                      definition.targetField,
                    ),
                  )
                : null,
```

  - refresh-stale-formulas.ts (~135-147): same addition to the `recomputeForRecordFn({...})` call, using `definition.targetObject ?? ''` / `definition.targetField ?? ''`, with the same imports.

- [ ] **Step 5: Run to green; full suite; typecheck; lint. Commit.**

```bash
npx vitest run && npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): thread SELECT options through the event path and single-record callers"
```

---

### Task 9: The `select` format registry — drafts, derivation, persistence

The pure-data layer for the 9th wizard format: option drafts, label→value derivation matching the platform validator, validity, the create payload builder, and draft persistence in `targetFieldSettings` (spec D7 data half).

**Files:**
- Modify: `src/front-components/lib/formula-field-formats.ts`
- Test: `src/front-components/lib/__tests__/formula-field-formats.spec.ts`

**Interfaces:**
- Consumes: `MirrorClonedOption` (same file).
- Produces (all exported): `OutputFormat` gains `'select'`; `OutputFormatDefinition.fieldType`/`targetFieldType` unions gain `'SELECT'`; `type SelectOptionDraft = { label: string; color: string }`; `FormatOptions.selectOptions: SelectOptionDraft[]`; `SELECT_OPTION_COLORS`; `OPTION_VALUE_PATTERN`; `deriveOptionValue(label: string): string`; `isValidOptionValue(value: string): boolean`; `selectOptionsProblem(drafts: SelectOptionDraft[]): string | null`; `buildSelectOptionsPayload(drafts: SelectOptionDraft[]): MirrorClonedOption[]`; `TargetFieldSettings.selectOptions?: SelectOptionDraft[]` with a `parseTargetFieldSettings` recovery arm.

- [ ] **Step 1: Write the failing tests.** Update the registry pin (append `'select'` to the expected key array in the existing `OUTPUT_FORMATS` test) and add:

```ts
describe('SELECT output format (ADR 0029)', () => {
  it('registers select as a SELECT-typed engine format', () => {
    const select = getOutputFormat('select');
    expect(select.fieldType).toBe('SELECT');
    expect(select.targetFieldType).toBe('SELECT');
  });

  it('carries no settings JSON — options are a field-level input', () => {
    expect(buildFieldSettings('select', makeFormatOptions('select'))).toBeNull();
  });

  it('seeds one blank option row', () => {
    expect(makeFormatOptions('select').selectOptions).toEqual([
      { label: '', color: SELECT_OPTION_COLORS[0] },
    ]);
  });
});

describe('deriveOptionValue', () => {
  it('derives the platform UPPER_SNAKE shape from a label', () => {
    expect(deriveOptionValue('Hot lead!')).toBe('HOT_LEAD');
    expect(deriveOptionValue('closed — won')).toBe('CLOSED_WON');
    expect(deriveOptionValue('a__b')).toBe('A_B');
    expect(deriveOptionValue(' Hot ')).toBe('HOT');
  });

  it('strips leading digits/underscores and trailing underscores', () => {
    expect(deriveOptionValue('2nd stage')).toBe('ND_STAGE');
    expect(deriveOptionValue('__x__')).toBe('X');
  });

  it('caps at 63 chars without a trailing underscore', () => {
    expect(deriveOptionValue('a'.repeat(70))).toBe('A'.repeat(63));
    expect(deriveOptionValue(`${'a'.repeat(62)}-bc`).endsWith('_')).toBe(false);
  });

  it('returns empty when nothing usable remains', () => {
    expect(deriveOptionValue('42')).toBe('');
    expect(deriveOptionValue('---')).toBe('');
  });

  it('every non-empty derivation passes the platform regex', () => {
    for (const label of ['Hot', '2nd Stage', 'a  b', 'x__y', 'won!']) {
      const value = deriveOptionValue(label);
      if (value !== '') {
        expect(value).toMatch(OPTION_VALUE_PATTERN);
      }
    }
  });
});

describe('selectOptionsProblem / areFormatOptionsValid(select)', () => {
  const drafts = (...labels: string[]) =>
    labels.map((label) => ({ label, color: 'green' }));

  it('accepts ordered unique labelled options', () => {
    expect(selectOptionsProblem(drafts('Hot', 'Cold'))).toBeNull();
    expect(
      areFormatOptionsValid('select', {
        ...makeFormatOptions('select'),
        selectOptions: drafts('Hot', 'Cold'),
      }),
    ).toBe(true);
  });

  it('rejects empty lists, blank labels, commas and over-long labels', () => {
    expect(selectOptionsProblem([])).toBe('Add at least one option.');
    expect(selectOptionsProblem(drafts('Hot', ' '))).toBe(
      'Every option needs a label.',
    );
    expect(selectOptionsProblem(drafts('a,b'))).toBe(
      'Option labels cannot contain commas.',
    );
    expect(selectOptionsProblem(drafts('x'.repeat(64)))).toMatch(/too long/);
    expect(
      areFormatOptionsValid('select', {
        ...makeFormatOptions('select'),
        selectOptions: [],
      }),
    ).toBe(false);
  });

  it('rejects labels deriving no value or colliding values', () => {
    expect(selectOptionsProblem(drafts('42'))).toMatch(/does not derive/);
    expect(selectOptionsProblem(drafts('Hot!', 'hot'))).toBe(
      'Two options derive the same value.',
    );
  });
});

describe('buildSelectOptionsPayload', () => {
  it('derives value and position, trims labels, sends no ids', () => {
    expect(
      buildSelectOptionsPayload([
        { label: ' Hot ', color: 'red' },
        { label: 'Cold', color: 'blue' },
      ]),
    ).toEqual([
      { label: 'Hot', value: 'HOT', color: 'red', position: 0 },
      { label: 'Cold', value: 'COLD', color: 'blue', position: 1 },
    ]);
  });
});

describe('TargetFieldSettings.selectOptions', () => {
  it('round-trips through serialize/parse', () => {
    const raw = serializeTargetFieldSettings({
      settings: null,
      selectOptions: [{ label: 'Hot', color: 'red' }],
    });
    expect(parseTargetFieldSettings(raw)?.selectOptions).toEqual([
      { label: 'Hot', color: 'red' },
    ]);
  });

  it('degrades malformed drafts to absent', () => {
    const raw = JSON.stringify({
      settings: null,
      selectOptions: [{ label: 3 }, 'x'],
    });
    expect(parseTargetFieldSettings(raw)?.selectOptions).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the spec file, confirm failures.**

- [ ] **Step 3: Implement in formula-field-formats.ts:**
  - `OutputFormat` union: add `| 'select'`. `OutputFormatDefinition`: widen `fieldType` and `targetFieldType` to include `'SELECT'`.
  - Append the 9th registry entry after `text`:

```ts
  // SELECT is an engine target (ADR 0029): the formula computes a text value
  // that must name one of the field's options; blank computes clear the field.
  // Options are defined exactly once, here in the wizard — post-creation
  // management is native-only (user ruling 2026-08-10).
  {
    key: 'select',
    label: 'Select',
    hint: 'one of a fixed set of options',
    fieldType: 'SELECT',
    targetFieldType: 'SELECT',
    defaultDecimals: 0,
  },
```

  - Colors + draft type + derivation + validity (place near `cloneMirrorOptions`):

```ts
// Twenty TagColor names the wizard cycles for new options. The app cannot
// import twenty-shared (no dependencies, ADR 0024), so a subset is pinned
// here; the server accepts any member of its full TagColor set.
export const SELECT_OPTION_COLORS = [
  'green',
  'turquoise',
  'sky',
  'blue',
  'purple',
  'pink',
  'orange',
  'yellow',
  'red',
  'gray',
];

// A wizard-draft option row: the value is always re-derived from the label at
// create time, so drafts persist only what the user typed.
export type SelectOptionDraft = {
  label: string;
  color: string;
};

// The platform's option-value validator (twenty-server is-snake-case-string):
// UPPER_SNAKE, starts with a letter, no double underscore.
export const OPTION_VALUE_PATTERN = /^(?!.*__)[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

// Derives the option VALUE from its label: uppercase, non-alphanumeric runs
// collapse to single underscores, leading digits/underscores and trailing
// underscores drop, 63-char cap (re-trimmed so the cap never leaves a
// trailing underscore).
export const deriveOptionValue = (label: string): string => {
  const collapsed = label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^[_0-9]+/, '')
    .replace(/_+$/, '');
  return collapsed.slice(0, 63).replace(/_+$/, '');
};

export const isValidOptionValue = (value: string): boolean =>
  value.length > 0 && value.length <= 63 && OPTION_VALUE_PATTERN.test(value);

// The single validity rule shared by the wizard's Create gate and the options
// editor's inline error line — one message so the two can never disagree.
export const selectOptionsProblem = (
  drafts: SelectOptionDraft[],
): string | null => {
  if (drafts.length === 0) return 'Add at least one option.';
  for (const draft of drafts) {
    const label = draft.label.trim();
    if (label.length === 0) return 'Every option needs a label.';
    if (label.length > 63) return `Option label "${label.slice(0, 20)}…" is too long (63 max).`;
    if (label.includes(',')) return 'Option labels cannot contain commas.';
  }
  const values = drafts.map((draft) => deriveOptionValue(draft.label));
  const invalidIndex = values.findIndex((value) => !isValidOptionValue(value));
  if (invalidIndex >= 0) {
    return `"${drafts[invalidIndex].label}" does not derive a usable option value.`;
  }
  if (new Set(values).size !== values.length) {
    return 'Two options derive the same value.';
  }
  return null;
};

// The createOneField options payload: value derived, position = row order,
// no ids (the server assigns v4 ids before its enum validators run).
export const buildSelectOptionsPayload = (
  drafts: SelectOptionDraft[],
): MirrorClonedOption[] =>
  drafts.map((draft, index) => ({
    label: draft.label.trim(),
    value: deriveOptionValue(draft.label),
    color: draft.color,
    position: index,
  }));
```

  - `FormatOptions` gains `selectOptions: SelectOptionDraft[];` and `makeFormatOptions` seeds it:

```ts
    selectOptions:
      format === 'select' ? [{ label: '', color: SELECT_OPTION_COLORS[0] }] : [],
```

  - `buildFieldSettings`: widen the early guard to `if (definition.fieldType === 'TEXT' || definition.fieldType === 'SELECT') { return null; }` and extend its comment: SELECT options are a field-level create input, never a settings key.
  - `areFormatOptionsValid`: before the DATE/CUSTOM branch add:

```ts
  if (definition.fieldType === 'SELECT') {
    return selectOptionsProblem(options.selectOptions) === null;
  }
```

  - `TargetFieldSettings` gains `selectOptions?: SelectOptionDraft[];`. Add the recovery arm (the `parseMirrorDraft` pattern) and wire it into `parseTargetFieldSettings` (`selectOptions?: unknown` in the parsed cast, `...(selectOptions ? { selectOptions } : {})` in the return):

```ts
// Recovers persisted option drafts. Any malformed entry voids the whole slot —
// a corrupted draft degrades to the seeded blank row rather than crashing.
const parseSelectOptionDrafts = (
  raw: unknown,
): SelectOptionDraft[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const drafts = raw.filter(
    (candidate): candidate is SelectOptionDraft =>
      Boolean(candidate) &&
      typeof (candidate as SelectOptionDraft).label === 'string' &&
      typeof (candidate as SelectOptionDraft).color === 'string',
  );
  return drafts.length === raw.length ? drafts : undefined;
};
```

- [ ] **Step 4: Run to green; full suite; typecheck; lint. Commit.**

```bash
npx vitest run && npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): register the select output format with option drafts"
```

---

### Task 10: The one-time options editor component

`SelectOptionsEditor` — an exported sibling component in format-options-fields.tsx (NOT a branch inside `FormatOptionsFields`, which the field-settings editor also renders and which must never show options post-creation; it gets a null-guard instead). Wizard-only UI: ordered rows of label + derived value + cycling color, up/down reorder (planner's choice over drag for v1), add/remove (removal is fine here — the field does not exist yet; the post-creation ban starts at creation).

**Files:**
- Modify: `src/front-components/lib/format-options-fields.tsx`

**Interfaces:**
- Consumes: `SelectOptionDraft`, `SELECT_OPTION_COLORS`, `deriveOptionValue`, `selectOptionsProblem` (Task 9); ui primitives `TextInput`, `SecondaryButton`, `StepperButton`, `ChoiceChip`, `MutedText`, `HintText`, `ErrText`.
- Produces: `export const SelectOptionsEditor = ({ drafts, onChange }: { drafts: SelectOptionDraft[]; onChange: (drafts: SelectOptionDraft[]) => void })`; `FormatOptionsFields` returns `null` for `fieldType === 'SELECT'`.

No component-test harness exists in this app (pure-logic specs only); the logic is covered by Task 9's tests. Deliverable check = typecheck + lint + full suite.

- [ ] **Step 1: Add the SELECT null-guard** in `FormatOptionsFields`, directly after the TEXT guard:

```tsx
  // SELECT options are edited by SelectOptionsEditor in the wizard ONLY. This
  // shared form is also rendered by the field-settings editor, and options are
  // never editable post-creation (ADR 0029 D7) — so the SELECT arm is empty by
  // design, not by omission.
  if (definition.fieldType === 'SELECT') {
    return null;
  }
```

- [ ] **Step 2: Implement the component** in the same file (imports: add `SelectOptionDraft`, `SELECT_OPTION_COLORS`, `deriveOptionValue`, `selectOptionsProblem` to the `formula-field-formats` import, and `TextInput`, `SecondaryButton` to the `ui` import — neither is imported today; add style entries to the file's `f` style object: `optionRow: { display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }`, `optionLabel: { flex: 1 }`, `optionValue: { fontFamily: 'ui-monospace, monospace', minWidth: 80 }`):

```tsx
type SelectOptionsEditorProps = {
  drafts: SelectOptionDraft[];
  onChange: (drafts: SelectOptionDraft[]) => void;
};

// One-time options editor for the wizard's `select` format (ADR 0029 D7):
// options are defined here, at field creation, and the app never edits them
// again — post-creation management is Twenty's native data model settings.
// The option VALUE derives from the label (platform UPPER_SNAKE rule) and is
// shown read-only; row order is the option position.
export const SelectOptionsEditor = ({
  drafts,
  onChange,
}: SelectOptionsEditorProps) => {
  const patchRow = (index: number, patch: Partial<SelectOptionDraft>) =>
    onChange(
      drafts.map((draft, position) =>
        position === index ? { ...draft, ...patch } : draft,
      ),
    );
  const moveRow = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    const next = [...drafts];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
  };
  const removeRow = (index: number) =>
    onChange(drafts.filter((_draft, position) => position !== index));
  const addRow = () =>
    onChange([
      ...drafts,
      {
        label: '',
        color: SELECT_OPTION_COLORS[drafts.length % SELECT_OPTION_COLORS.length],
      },
    ]);
  const cycleColor = (index: number) => {
    const current = SELECT_OPTION_COLORS.indexOf(drafts[index].color);
    patchRow(index, {
      color: SELECT_OPTION_COLORS[(current + 1) % SELECT_OPTION_COLORS.length],
    });
  };
  const problem = selectOptionsProblem(drafts);

  return (
    <div>
      {drafts.map((draft, index) => (
        <div key={index} style={f.optionRow}>
          <StepperButton
            onClick={() => moveRow(index, -1)}
            disabled={index === 0}
          >
            ↑
          </StepperButton>
          <StepperButton
            onClick={() => moveRow(index, 1)}
            disabled={index === drafts.length - 1}
          >
            ↓
          </StepperButton>
          <TextInput
            value={draft.label}
            placeholder="Option label"
            onChange={(event) => patchRow(index, { label: event.target.value })}
            style={f.optionLabel}
          />
          <MutedText style={f.optionValue}>
            {deriveOptionValue(draft.label) || '—'}
          </MutedText>
          <ChoiceChip selected={false} onMouseDown={() => cycleColor(index)}>
            {draft.color}
          </ChoiceChip>
          <StepperButton
            onClick={() => removeRow(index)}
            disabled={drafts.length === 1}
          >
            ×
          </StepperButton>
        </div>
      ))}
      <SecondaryButton onClick={addRow}>Add option</SecondaryButton>
      {problem ? (
        <ErrText as="div" style={f.err}>
          {problem}
        </ErrText>
      ) : (
        <HintText as="div" style={f.hint}>
          Options are created once with the field; edit them later in Twenty's
          data model settings.
        </HintText>
      )}
    </div>
  );
};
```

- [ ] **Step 3: Full suite, typecheck, lint. Commit.**

```bash
npx vitest run && npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): one-time options editor for the select wizard step"
```

---

### Task 11: Wizard and settings-editor wiring

Step 2b renders the options editor for `select`; `create()` sends the options payload; drafts persist and resume; the mirror flow reroutes SELECT sources to the engine lane while keeping option cloning; the settings editor dispatches SELECT correctly and never touches options (spec D7 UI half, D8).

**Files:**
- Modify: `src/front-components/lib/formula-setup-wizard.tsx` (state init ~140-150; persistFormatOptions ~383-398; step 2b ~896-907; create() ~658-730; createMirror ~734-824)
- Modify: `src/front-components/lib/field-settings-editor.tsx` (formatKeyForType ~53-72; the form area)

**Interfaces:**
- Consumes: Task 9 exports (`SelectOptionDraft`, `buildSelectOptionsPayload`, `selectOptionsProblem` via `areFormatOptionsValid`), Task 10's `SelectOptionsEditor`.
- Produces: a wizard that creates SELECT fields with one-time options; `formatKeyForType('SELECT', anything) === 'select'` (so deployed SELECT mirrors — `outputFormat: 'mirror'` — dispatch by `targetFieldType`, spec section 4); mirror flow emits `outputFormat: 'select'` for SELECT sources.

- [ ] **Step 1: Wizard resume.** In the `options` useState initializer (~140-150), overlay the persisted drafts after `optionsFromSettings` (which stays off the SELECT path — it only reads the inner `settings`, null for select):

```tsx
    if (initialFormat) {
      const resumed = optionsFromSettings(
        initialFormat,
        parsed?.settings ?? null,
        draft.currencyCode || parsed?.currencyCode,
      );
      // SELECT drafts resume from their dedicated slot (ADR 0029 D7):
      // optionsFromSettings never sees them because a select draft carries no
      // inner settings object.
      if (initialFormat === 'select' && parsed?.selectOptions) {
        resumed.selectOptions = parsed.selectOptions;
      }
      return resumed;
    }
```

(Hoist the `parseTargetFieldSettings(draft.targetFieldSettings)` result to a `const parsed` at the top of the initializer if the current code inlines it.)

- [ ] **Step 2: Wizard persistence.** In `persistFormatOptions`, extend the serialized object:

```tsx
        targetFieldSettings: serializeTargetFieldSettings({
          settings,
          currencyCode: isCurrency ? nextOptions.currencyCode : undefined,
          ...(formatKey === 'select'
            ? { selectOptions: nextOptions.selectOptions }
            : {}),
        }),
```

(`pickFormat` needs no change — `makeFormatOptions('select')` already seeds the blank row, and `changeOptions` already persists on every edit. `create()`'s own `serializeTargetFieldSettings({ settings, currencyCode })` intentionally drops `selectOptions`: after creation the options live on the field, natively, and a stale draft copy would only invite drift confusion.)

- [ ] **Step 3: Step 2b.** Replace the single 2b conditional (~896-907) with a three-way branch:

```tsx
          {format === 'select' ? (
            <div style={layout.step}>
              <StepTitle style={layout.stepTitle}>2b · Options</StepTitle>
              <SelectOptionsEditor
                drafts={options.selectOptions}
                onChange={(selectOptions) =>
                  changeOptions({ ...options, selectOptions })
                }
              />
            </div>
          ) : format && getOutputFormat(format).fieldType !== 'TEXT' ? (
            <div style={layout.step}>
              <StepTitle style={layout.stepTitle}>2b · Format options</StepTitle>
              <FormatOptionsFields
                format={format}
                options={options}
                onChange={changeOptions}
              />
            </div>
          ) : null}
```

Import `SelectOptionsEditor` alongside `FormatOptionsFields`. (`readyToCreate` already calls `areFormatOptionsValid`, so the Create button auto-disables on invalid drafts — no change there.)

- [ ] **Step 4: create() payload.** Inside `create()` add `const isSelect = formatDefinition.targetFieldType === 'SELECT';` next to `isCurrency`, and in the `createOneField` field object, after the `settings` spread:

```tsx
                  ...(isSelect
                    ? { options: buildSelectOptionsPayload(options.selectOptions) }
                    : {}),
```

Import `buildSelectOptionsPayload`.

- [ ] **Step 5: Mirror reroute.** In `createMirror`, next to `isTextTarget` (~760):

```tsx
      // SELECT left the mirror lane too (ADR 0029 D8): the field is still
      // cloned WITH its options — the one thing only this flow can do — but
      // the definition rides the engine lane with the membership gate.
      const isSelectTarget = sourceField.type === 'SELECT';
```

and the definition's `outputFormat` (~796) becomes:

```tsx
          outputFormat: isSelectTarget ? 'select' : isTextTarget ? 'text' : 'mirror',
```

(Option cloning needs no change — `clonesOptions` already covers SELECT; the seeded one-term expression has an open literal set, so tier 2 covers source/target option drift.)

- [ ] **Step 6: Settings editor.** In field-settings-editor.tsx add to `formatKeyForType`'s switch, before `default`:

```tsx
      case 'SELECT':
        return 'select';
```

(Legacy deployed SELECT mirrors keep `outputFormat: 'mirror'` and reach this via `targetFieldType` — without this case they'd fall through to the `'integer'` NUMBER form.) In the loaded-form area (next to where `FormatOptionsFields` renders), add:

```tsx
          {targetFieldType === 'SELECT' ? (
            <HintText as="div">
              Options are managed in Twenty's data model settings, not here.
            </HintText>
          ) : null}
```

**Keep Save alive for SELECT** — without this, label editing dies: `canSave` at line ~224 calls `areFormatOptionsValid(format, options)`, and for `'select'` the editor's `options` state is the seeded blank draft row (`optionsFromSettings` never populates `selectOptions` from a live field), so `selectOptionsProblem` returns an error and the Save button is disabled forever. Change it to:

```ts
  // SELECT has no editable settings here (options are native-owned, ADR 0029
  // D7); the draft-row validity rule is a wizard concern and must not veto
  // label editing.
  const canSave =
    loaded && !saving && (format === 'select' || areFormatOptionsValid(format, options));
```

Verify by reading the save path that nothing SELECT-related is sent: `buildFieldSettings('select', ...)` is null so the `settings` spread drops out, and no `options` key exists anywhere in the mutation — this is the ruling's hard line.

- [ ] **Step 7: Full suite, typecheck, lint. Commit.**

```bash
npx vitest run && npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "feat(formula-field): wire select through the wizard, mirror reroute and settings editor"
```

- [ ] **Step 8 (optional, needs a running local server):** live-check the wizard: `bash packages/twenty-utils/setup-dev-env.sh && yarn start` (repo root), create a select formula field end-to-end, confirm options land on the field and the typo error appears in the editor.

---

### Task 12: Audit script covers the membership gate

`scripts/audit-strict-gate.ts` gains the membership verdict so a pre-deploy audit catches would-freeze definitions (spec touch map).

**Files:**
- Modify: `scripts/audit-strict-gate.ts`

**Interfaces:**
- Consumes: `selectMembershipGateError`, `buildTargetSelectOptions` (Task 4), `targetFieldOptions` (Task 5).
- Produces: GATED verdicts for membership violations, same table output.

- [ ] **Step 1: Extend the dynamic import block** (~lines 65-77) to also pull `selectMembershipGateError` and `buildTargetSelectOptions` from kind-inference and `targetFieldOptions` from metadata-objects (same deferred-import style — env vars must be set first).

- [ ] **Step 2: Extend the verdict.** In the per-formula loop, after `strictKindGateError` produces `gateError`, chain the membership check before bucketing:

```ts
    let verdictError = gateError;
    if (verdictError === null && formula.targetFieldType === 'SELECT') {
      // Same two-tier source of truth the recompute pass uses (ADR 0029 D3).
      verdictError = selectMembershipGateError({
        ast: compiled.ast,
        targetFieldType: formula.targetFieldType,
        targetOptions: buildTargetSelectOptions(
          await targetFieldOptions(
            formula.targetObject ?? '',
            formula.targetField ?? '',
          ),
        ),
      });
    }
```

and bucket on `verdictError` instead of `gateError` below.

- [ ] **Step 3: Verify it compiles** (`npx tsc --noEmit`), lint, and if a local remote is configured run `npx tsx scripts/audit-strict-gate.ts <remote>` to eyeball the table. Commit.

```bash
git add -A packages/twenty-apps/community/formula-field
git commit -m "chore(formula-field): audit script covers the membership gate"
```

---

### Task 13: Integration pin — SELECT null convergence (live server)

The spec's section-7 read-side pin: clear a SELECT target through a real server round-trip, assert the raw re-read normalizes to null and the definition settles without an error loop (the F4 null-vs-empty-string class). Runs only against a live local Twenty server.

**Files:**
- Modify: `src/__tests__/app-install.integration-test.ts` (new `it` inside the existing `describe` — reuses its build/deploy/install lifecycle, `gql` helper and `waitForValue`)

**Interfaces:**
- Consumes: `normalizeStoredValue` from value-io (Task 1); the file's existing `gql`, `waitForValue`, `MetadataApiClient`.

- [ ] **Step 1: Add the test** (import `normalizeStoredValue` from `src/logic-functions/lib/value-io` at the top):

```ts
  it('SELECT target (ADR 0029): option value writes, blank clears, null converges', async () => {
    const metadataClient = new MetadataApiClient();
    const suffix = `${Date.now() % 1000000}`;
    const fieldName = `formulaStage${suffix}`;
    let fieldId: string | null = null;
    try {
      const objectsResponse = await metadataClient.query({
        objects: {
          __args: { filter: {}, paging: { first: 500 } },
          edges: { node: { id: true, nameSingular: true } },
        },
      });
      const opportunityObjectId = (objectsResponse.objects.edges as any[])
        .map((edge) => edge.node)
        .find((node) => node.nameSingular === 'opportunity').id;

      const createdField = await metadataClient.mutation({
        createOneField: {
          __args: {
            input: {
              field: {
                objectMetadataId: opportunityObjectId,
                type: 'SELECT',
                name: fieldName,
                label: `Formula Stage ${suffix}`,
                options: [
                  { label: 'Hot', value: 'HOT', color: 'red', position: 0 },
                  { label: 'Cold', value: 'COLD', color: 'blue', position: 1 },
                ],
              },
            },
          },
          id: true,
        },
      });
      fieldId = createdField.createOneField.id as string;

      const created = await gql(
        `mutation($d:OpportunityCreateInput!){ createOpportunity(data:$d){ id } }`,
        { d: { name: `IT select ${suffix}`, formulaInputA: 5 } },
      );
      const oppId = created.createOpportunity.id as string;

      await gql(
        `mutation($d:FormulaDefinitionCreateInput!){ createFormulaDefinition(data:$d){ id } }`,
        {
          d: {
            name: `IT select ${suffix}`,
            targetObject: 'opportunity',
            targetField: fieldName,
            targetFieldType: 'SELECT',
            outputFormat: 'select',
            expression: 'IF(formulaInputA > 3, "HOT", "")',
            enabled: true,
          },
        },
      );

      const readStage = async () => {
        const data = await gql(
          `query($id:UUID!){ opportunity(filter:{id:{eq:$id}}){ ${fieldName} } }`,
          { id: oppId },
        );
        return data.opportunity?.[fieldName] ?? null;
      };

      // formulaInputA = 5 -> "HOT" is a member and writes through.
      expect(await waitForValue(readStage, 'HOT')).toBe('HOT');

      // Blank branch -> null -> the field clears (D4), and the raw re-read
      // normalizes to null — the read half of the convergence loop.
      await gql(
        `mutation($id:UUID!,$d:OpportunityUpdateInput!){ updateOpportunity(id:$id,data:$d){ id } }`,
        { id: oppId, d: { formulaInputA: 1 } },
      );
      expect(await waitForValue(readStage, null)).toBeNull();
      expect(normalizeStoredValue(await readStage(), 'SELECT')).toBeNull();

      // Settled state stays settled: another pass over the null target must
      // not error-loop (lastError stays empty on the definition).
      await gql(
        `mutation($id:UUID!,$d:OpportunityUpdateInput!){ updateOpportunity(id:$id,data:$d){ id } }`,
        { id: oppId, d: { formulaInputA: 2 } },
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(await readStage()).toBeNull();
      const definitions = await gql(
        `query{ formulaDefinitions(filter:{targetField:{eq:"${fieldName}"}}){ edges { node { lastError } } } }`,
      );
      expect(
        definitions.formulaDefinitions.edges[0].node.lastError ?? '',
      ).toBe('');
    } finally {
      if (fieldId) {
        await metadataClient.mutation({
          deleteOneField: { __args: { input: { id: fieldId } }, id: true },
        });
      }
    }
  }, 120000);
```

- [ ] **Step 2: Run it against a live server** (`bash packages/twenty-utils/setup-dev-env.sh`, then `yarn start` at repo root in another shell, then from the app root): `npx vitest run --config vitest.integration.config.ts`. If the GraphQL field/filter names differ from the fixtures above (e.g. the definitions filter shape), adapt the query to the shapes already used elsewhere in this same file — the assertions are the contract.

- [ ] **Step 3: Commit.**

```bash
git add -A packages/twenty-apps/community/formula-field
git commit -m "test(formula-field): SELECT null-convergence integration pin"
```

---

### Task 14: Docs, ADR 0029, version 0.5.0

**Files:**
- Create: `docs/adr/0029-select-output.md`
- Modify: `docs/adr/README.md` (index ends at 0027 — backfill 0028, add 0029)
- Modify: `README.md`, `context.md`, `src/objects/formula-definition.object.ts`, `package.json`

- [ ] **Step 1: Write ADR 0029** (`docs/adr/0029-select-output.md`). Header pattern copied from ADR 0028: title `ADR 0029: SELECT output — engine lane and the option-membership gate`; `**Status: IMPLEMENTED (design approved 2026-08-10; implemented <today's date>).**`; pointer lines to the spec (`docs/superpowers/specs/2026-08-10-select-output-design.md`, repo root `docs/`) and this plan. Body sections, each condensed from the named spec section (the spec is the source of truth — do not re-derive):
  1. **Context and contract** — ADR 0026's closing commitment, and how this ADR sharpens it (spec §1).
  2. **Decision: lane move** — ENGINE_FAMILY/MIRRORABLE disjointness preserved, union unchanged, bare-ref-onto-SELECT becomes a one-term engine formula (spec D1).
  3. **Decision: `usesTextDomain`** — the trap class it kills, the `'raw'` arm, the three override-path edits (spec D2).
  4. **Decision: two-tier membership gate** — walker semantics, tier 1a save posture (disable) vs tier 1b freeze (enabled, write-avoidant, both lanes — user ruling 3 with the disclosed blast radius: no override detection, no lock reverts while frozen, self-heals within the 60s TTL), tier 2 `NOT_AN_OPTION` doctrine (spec D3, §9.3).
  5. **Decision: blank-clears** (spec D4, ruling 2) and **option plumbing** (accessor over the existing cache, once per pass/event, spec D5).
  6. **Decision: errors** — both message formats verbatim, did-you-mean, staleness honesty (spec D6).
  7. **Decision: one-time options** — the wizard defines options exactly once; the app never edits them after creation; ruling 4 is STRICTER than the drafted add-plus-rename editor, which is deleted from scope, not deferred (spec D7, §9.4). Mirror-flow reroute keeps SELECT pickable for option cloning, diverging deliberately from TEXT's B8 (spec D8).
  8. **Back-compat** — zero migration; deployed SELECT mirrors become one-term engine formulas; branch-1c loosening; provenance-panel swap; legacy `outputFormat: 'mirror'` rows dispatch by `targetFieldType` (spec §4).
  9. **Cost model** — reproduce the spec §5 table.
  10. **Residue** — spec §8 verbatim, including the explicit "do not resurrect in-app option editing" line.

- [ ] **Step 2: Fix the ADR index** (`docs/adr/README.md`) — append two rows after 0027:

```md
| [0028](0028-create-time-override-lock.md) | Create-time override lock | Implemented |
| [0029](0029-select-output.md) | SELECT output — engine lane and the option-membership gate | Implemented |
```

- [ ] **Step 3: README.md.** (a) Document the `select` output format wherever the 8 formats are enumerated (label `Select`, one-of-options semantics, blank-clears, options defined once in the wizard / managed natively afterward, freeze-on-drift note phrased as self-healing within a minute of fixing the options). (b) The error-code enumeration at ~line 495 gains `NOT_AN_OPTION` (it already lists `TEXT_TOO_LONG`).

- [ ] **Step 4: context.md.** In the createOneField/app-facts section (~lines 1209-1215 already document the no-ids option payload), add: the app's `select` format sends `options` at create only; the app never updates options (native settings own them); `NOT_AN_OPTION` and the membership freeze exist.

- [ ] **Step 5: formula-definition.object.ts.** Update the `targetFieldType` field description (lines ~76-81) to:

```ts
      description:
        'Field type of the value field: NUMBER (default), CURRENCY, DATE, ' +
        'DATE_TIME, TEXT or SELECT for engine formulas (a SELECT result must ' +
        'name a defined option value), or a mirrorable kind (BOOLEAN, ' +
        'MULTI_SELECT, RATING, LINKS, ...) for mirror definitions. Currency ' +
        'values are read and written as amountMicros; DATE/DATE_TIME use the ' +
        'Excel serial-date model (epoch-days).',
```

- [ ] **Step 6: package.json** — `"version": "0.5.0"`.

- [ ] **Step 7: Full suite, typecheck, lint one last time; commit.**

```bash
npx vitest run && npx tsc --noEmit && yarn lint
git add -A packages/twenty-apps/community/formula-field
git commit -m "docs(formula-field): ADR 0029, README/context refresh, v0.5.0"
```

---

## Not in this plan (deliberate)

- **Cloud deploy** of v0.5.0 (and the still-pending v0.4.0 cloud deploy) — separate user-gated step.
- **formulahelp skill refresh** — post-deploy, per standing memory (the language itself didn't change, but `NOT_AN_OPTION` and SELECT-target errors belong in its error tables).
- **Output-side autocomplete, label rendering in widgets, MULTI_SELECT output** — spec §8 backlog.
- **Any in-app option editing** — ruled out, not deferred. Never add it back.
