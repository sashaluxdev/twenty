# Variation Sync: RELATION Mirroring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make record-variations sync mirror MANY_TO_ONE RELATION fields (by copying the FK join column) from primary to variations. (DATE mirroring confirmed working — user ruled it a one-off config issue, out of scope.)

**Architecture:** `computeSyncableFields` gains relation awareness: for a `RELATION` field whose metadata `settings` shows `relationType: 'MANY_TO_ONE'` with a `joinColumnName`, it emits a syncable entry named after the **join column** (`accountOwnerId`), kind `'RELATION'`. Because the server (verified in this repo's twenty-server at the 2.19 platform line — the code Twenty Cloud runs) reports relation changes in `record.updated` events with **both** the relation name and the join column in `properties.updatedFields`, and carries the raw FK scalar in `properties.before/after`, every downstream path in `variation-sync.ts` (event matching, GraphQL selection, diff, write, divergence detection, override slots) already works on the FK scalar unchanged. The metadata loader just needs to pull `settings`.

**Tech Stack:** Twenty Apps SDK (twenty-sdk 2.19 line), TypeScript, vitest (via monorepo root node_modules), FakeClient test harness.

## Global Constraints

- **Cloud is the deployment target.** All event-shape assumptions are the server's, not local conveniences: `updatedFields` for a MANY_TO_ONE change = `[relationName, joinColumnName]` (twenty-server `object-record-changed-values.ts`, `computeUpdatedFieldsFromDiff` returns both; pinned by server spec `object-record-changed-values.spec.ts:310-325`); `properties.after`/`before` carry the raw join column scalar; `properties.diff` keys the relation NAME with `{id}` shape (we do not consume `diff`). Cloud metadata (probed read-only 2026-07-10) confirms: `relationType` + `joinColumnName` live under `field.settings` (JSON scalar); **`joinColumnName` is present ONLY on the MANY_TO_ONE owning side; the ONE_TO_MANY inverse has `joinColumnName: null`.**
- **Do NOT touch `MIRRORABLE_KINDS` or anything in `mirror-kinds.ts`.** That allowlist is shared with formula mirror-mode (`isMirrorTargetKind`); adding RELATION there would let formulas target relation fields. RELATION support lives in `computeSyncableFields` only.
- **MORPH_RELATION stays excluded** (needs discriminator-column handling — deferred backlog). Only `field.type === 'RELATION'` with `relationType === 'MANY_TO_ONE'` AND a non-empty `joinColumnName` is mirrored.
- The config's own pointer relation (`field.name !== relationFieldName` guard) must remain excluded — a variation is never re-pointed.
- Overrides are never deleted by sync (standing invariant). Relation overrides use the JSON text slot (`overrideSlotFor` routes every non-NUMBER kind to `overrideValueText`; an id string JSON-encodes fine).
- Baseline: 835 tests green in 49 files at arc base. Full suite must stay green after every task. Run from the app dir `/home/sasha_shin/twenty/packages/twenty-apps/community/formula-field` with `../../../../node_modules/.bin/vitest run` (single file: append the spec path).
- Lint gates: `npx nx lint:diff-with-main twenty-apps` equivalent — use the app's standing gates: oxlint must stay 0 errors / 0 warnings (same command as previous arcs: `npx oxlint` from the app dir if configured; otherwise the repo-level `npx nx lint:diff-with-main` for the touched project).
- Code style: named exports, types over interfaces, `//` comments explaining WHY, no `any`.
- Commit per task with conventional prefix `feat(formula-field):` / `test(formula-field):` / `docs(formula-field):`.

---

### Task 1: Metadata loader pulls relation settings; `computeSyncableFields` emits join-column entries for MANY_TO_ONE relations

**Files:**
- Modify: `src/logic-functions/lib/metadata-objects.ts` (types at :13-36; `loadAllObjectsWithFields` at :130-216 — the `fieldsList` GraphQL selection at :164-171, field push loop just below it)
- Modify: `src/logic-functions/lib/syncable-fields.ts` (whole filter chain, :68-77)
- Test: `src/logic-functions/lib/__tests__/syncable-fields.spec.ts`
- Test (conditional): if `src/logic-functions/lib/__tests__/metadata-objects.spec.ts` (or any spec mocking `MetadataApiClient.query`) exists, extend it to cover `settings` parsing; if no such spec exists, the seam-level fixtures below are the coverage (the parse is two nullable property reads).

**Interfaces:**
- Consumes: existing `MetadataFieldInfo`, `MetadataObjectInfo`, `computeSyncableFields(client, targetObject, relationFieldName)`.
- Produces (later tasks rely on these exact shapes):
  - `MetadataFieldInfo` gains `relationType?: string | null` and `joinColumnName?: string | null`.
  - `computeSyncableFields` returns, for an eligible relation, `{ name: '<joinColumnName>', kind: 'RELATION' }` — note `name` IS the join column, e.g. `accountOwnerId`.

- [ ] **Step 1: Write the failing tests** — append to `syncable-fields.spec.ts` inside the existing `describe('computeSyncableFields', ...)`:

```ts
  it('includes a MANY_TO_ONE relation as its join column, keyed kind RELATION', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-owner', name: 'accountOwner', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'accountOwnerId' },
          { id: 'field-people', name: 'people', type: 'RELATION', isActive: true, isSystem: false, relationType: 'ONE_TO_MANY', joinColumnName: null },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'primaryRecordId' },
        ],
      },
    ]);

    const result = await computeSyncableFields(client, 'company', 'primaryRecord');

    expect(result).toContainEqual({ name: 'accountOwnerId', kind: 'RELATION' });
    // ONE_TO_MANY inverse (no local FK) stays excluded.
    expect(result.map((field) => field.name)).not.toContain('people');
    expect(result.map((field) => field.name)).not.toContain('peopleId');
    // The config's own pointer relation is never syncable.
    expect(result.map((field) => field.name)).not.toContain('primaryRecordId');
    expect(result.map((field) => field.name)).not.toContain('primaryRecord');
  });

  it('excludes a RELATION field with MANY_TO_ONE type but no join column, and MORPH_RELATION entirely', async () => {
    const client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-broken', name: 'brokenRel', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: null },
          { id: 'field-morph', name: 'owner', type: 'MORPH_RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'ownerId' },
        ],
      },
    ]);

    const result = await computeSyncableFields(client, 'company', 'primaryRecord');

    expect(result.map((field) => field.name).sort()).toEqual(['name']);
  });
```

Also UPDATE the first existing test in this file (`'includes mirrorable and engine-family kinds, excludes the label field, ...'`): its two RELATION fixture fields (`primaryRecord`, `people`) currently carry no `relationType`/`joinColumnName` — leave them as-is (absent settings ⇒ excluded, which the test already asserts) but reword the test name's tail from "non-writable kinds" to "non-writable kinds and settings-less relations" so the pinned meaning stays accurate.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd /home/sasha_shin/twenty/packages/twenty-apps/community/formula-field && ../../../../node_modules/.bin/vitest run src/logic-functions/lib/__tests__/syncable-fields.spec.ts`
Expected: the two new tests FAIL (`accountOwnerId` absent from result); existing tests still pass.

- [ ] **Step 3: Extend `MetadataFieldInfo` + the GraphQL pull in `metadata-objects.ts`**

In the type (after `isUnique?: boolean;`):

```ts
  // RELATION-only (parsed from the metadata `settings` JSON): the FK-owning
  // MANY_TO_ONE side carries joinColumnName; the ONE_TO_MANY inverse has null.
  // Cloud 2.19 shape verified 2026-07-10 (docs/plans/2026-07-10-relation-mirroring.md).
  relationType?: string | null;
  joinColumnName?: string | null;
```

In the `fieldsList` selection add `settings: true` after `isUnique: true`. In the field push loop:

```ts
      for (const field of node.fieldsList ?? []) {
        if (field?.id && field?.name && field?.type) {
          const settings = (field.settings ?? null) as {
            relationType?: string | null;
            joinColumnName?: string | null;
          } | null;
          fields.push({
            id: field.id,
            name: field.name,
            type: field.type,
            isActive: field.isActive !== false,
            isSystem: field.isSystem === true,
            isUnique: field.isUnique === true,
            relationType: settings?.relationType ?? null,
            joinColumnName: settings?.joinColumnName ?? null,
          });
        }
      }
```

- [ ] **Step 4: Rework the `computeSyncableFields` filter chain in `syncable-fields.ts`**

Replace the return chain (currently :68-77) with:

```ts
  return object.fields
    .filter((field) => field.isActive)
    .filter((field) => !field.isSystem)
    .filter((field) => field.id !== object.labelIdentifierFieldMetadataId)
    .filter((field) => field.name !== relationFieldName)
    .filter((field) => !formulaTargetFields.has(field.name))
    .filter((field) => !field.isUnique)
    .flatMap((field) => {
      // MANY_TO_ONE relations mirror via their FK join column: the server
      // reports that column in updatedFields and event payloads, and the
      // dynamic client reads/writes it as a plain scalar — so the syncable
      // entry IS the join column, and every downstream path (selection, diff,
      // write, divergence, override slot) treats it as an ordinary scalar.
      // ONE_TO_MANY inverses (no local FK) and MORPH_RELATION (discriminator
      // column, deferred) stay excluded.
      if (field.type === 'RELATION') {
        return field.relationType === 'MANY_TO_ONE' && field.joinColumnName
          ? [{ name: field.joinColumnName, kind: 'RELATION' }]
          : [];
      }
      return SYNCABLE_KINDS.has(field.type)
        ? [{ name: field.name, kind: field.type }]
        : [];
    });
```

Also update the big comment block above `computeSyncableFields` (:33-46): it currently says the allowlist "already excludes RELATION/MORPH_RELATION ... by construction" — rewrite that clause to say MANY_TO_ONE relations ARE syncable via their join column while ONE_TO_MANY/MORPH_RELATION remain excluded.

- [ ] **Step 5: Run the file, then the full suite**

Run: `../../../../node_modules/.bin/vitest run src/logic-functions/lib/__tests__/syncable-fields.spec.ts` → all pass.
Run: `../../../../node_modules/.bin/vitest run` → expected 837 passed (835 + 2), 0 failed. If any OTHER spec fails, STOP and report — do not adjust unrelated specs without flagging it (a failure elsewhere means an existing path receives relation entries it did not expect; that is signal, not noise).

- [ ] **Step 6: Lint + commit**

```bash
git add src/logic-functions/lib/metadata-objects.ts src/logic-functions/lib/syncable-fields.ts src/logic-functions/lib/__tests__/syncable-fields.spec.ts
git commit -m "feat(formula-field): mirror MANY_TO_ONE relations via join column in variation sync"
```

---

### Task 2: End-to-end sync specs (relation mirror, null-clear, override pin, divergence, new-variation) + docs

**Files:**
- Test: `src/logic-functions/lib/__tests__/variation-sync-primary-update.spec.ts` (append before final `});`)
- Test: `src/logic-functions/lib/__tests__/variation-sync-divergence.spec.ts` (append a relation case following the existing DATE divergence test's structure at :111-136)
- Test: whichever spec file covers `syncNewVariationRecord` (find it: `grep -l syncNewVariationRecord src/logic-functions/lib/__tests__/`) — append a relation copy case there
- Modify (only if a test exposes a gap): `src/logic-functions/lib/variation-sync.ts` — the design predicts ZERO changes needed; any red test here is a discovery to fix minimally and report
- Verify (read-only): `src/logic-functions/on-record-updated-variations.ts` — confirm the trigger declaration has no `updatedFields` filter that would exclude join-column names (if it filters, report; do not silently widen)
- Modify: `docs/adr/` — new ADR "Relation mirroring via join column" using the next free number (check `ls docs/adr/`), plus the ADR index; update `context.md` current-status section with one short paragraph
- Modify: `src/logic-functions/lib/syncable-fields.ts` only if Task 1's comment rewrite missed anything the ADR contradicts

**Interfaces:**
- Consumes from Task 1: `computeSyncableFields` emits `{ name: '<joinColumnName>', kind: 'RELATION' }` for MANY_TO_ONE relations; fixture fields accept `relationType`/`joinColumnName`.
- Produces: nothing downstream — this is the closing verification + documentation task.

- [ ] **Step 1: Write the failing/regression specs.** In `variation-sync-primary-update.spec.ts`, extend the `beforeEach` fixture's field list with:

```ts
          { id: 'field-owner', name: 'accountOwner', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'accountOwnerId' },
```

Then append these tests (adapt seed shapes to the file's existing pattern — every seeded company row must now also carry an `accountOwnerId` key, `null` where unused, so unchanged-field diffs stay quiet):

```ts
  it('mirrors a MANY_TO_ONE relation change by copying the join column onto variations', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: null, employees: 50, accountOwnerId: 'user-2', primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: null, employees: 50, accountOwnerId: 'user-1', primaryRecordId: 'p1' },
    ]);

    // Server-shape fidelity (cloud 2.19): a relation change reports BOTH the
    // relation name and the join column in updatedFields.
    const outcomes = await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['accountOwner', 'accountOwnerId'],
      relationFieldName: 'primaryRecord',
    });

    expect(outcomes.find((outcome) => outcome.variationRecordId === 'v1')?.changed).toBe(true);
    expect(client.get('company', 'v1')!.accountOwnerId).toBe('user-2');
  });

  it('mirrors a relation cleared to null on the primary', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: null, employees: 50, accountOwnerId: null, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: null, employees: 50, accountOwnerId: 'user-1', primaryRecordId: 'p1' },
    ]);

    await syncPrimaryUpdateToVariations({
      client,
      targetObject: 'company',
      primaryRecordId: 'p1',
      updatedFields: ['accountOwner', 'accountOwnerId'],
      relationFieldName: 'primaryRecord',
    });

    expect(client.get('company', 'v1')!.accountOwnerId).toBeNull();
  });

  it('respects an active override pinning a variation relation (does not overwrite the pinned join column)', async () => {
    // Seed the override following the existing override test's exact shape
    // (see the 'skips a field with an active override' test above): fieldName
    // is the JOIN COLUMN ('accountOwnerId'), value in the JSON text slot.
    // Assert v1.accountOwnerId keeps its pinned value after a primary change
    // and that the other changed field still syncs.
  });
```

For the override test, transcribe the seeding shape from the existing `'skips a field with an active override on that variation, but still syncs its other changed fields'` test (lines 54-87 of the file) — same override record object shape, with `fieldName: 'accountOwnerId'` and `overrideValueText: JSON.stringify('user-1')`. Do not invent new seed helpers.

In `variation-sync-divergence.spec.ts`, append (mirroring the DATE divergence test's structure at :111-136):

```ts
  // A human re-pointing a relation on a variation pins it: the join column
  // diverging from the primary creates a JSON-text-slot override.
  it('creates a text-slot override when a variation relation join column diverges from the primary', async () => { /* structure copied from the DATE case at :111-136, with field kind RELATION, name accountOwnerId, event after: { accountOwnerId: 'user-9' } */ });
```

(Write it fully in the file, copying the DATE test's structure verbatim with the relation fixture/values — the DATE test is the template; the assertion is `overrideValueText: JSON.stringify('user-9')` and no numeric slot.)

In the `syncNewVariationRecord` spec file, append a case: primary has `accountOwnerId: 'user-2'`, freshly created variation has `accountOwnerId: null` → after `syncNewVariationRecord`, variation's `accountOwnerId === 'user-2'`.

- [ ] **Step 2: Run the three spec files**

Run: `../../../../node_modules/.bin/vitest run src/logic-functions/lib/__tests__/variation-sync-primary-update.spec.ts src/logic-functions/lib/__tests__/variation-sync-divergence.spec.ts <new-variation spec file>`
Expected: with Task 1 landed, ALL these should already PASS (the design predicts zero variation-sync.ts changes). Two legitimate outcomes:
  - All green → proceed to Step 3.
  - Any red → investigate WHERE the FK scalar path breaks (likely candidates: FakeClient `project()` behavior for the fixture, or an unforeseen kind-gate in variation-sync.ts). Fix minimally in `variation-sync.ts` or the test fixture — NOT by weakening the assertion — and record the discovery for the report.

- [ ] **Step 3: Trigger declaration check (read-only).** Read `src/logic-functions/on-record-updated-variations.ts` (and its trigger registration/config). Confirm the record.updated trigger carries NO `updatedFields` filter, or if it does, that join-column names pass it. Note the finding in the report; if a filter would block relation columns, STOP and report BLOCKED (that is a config-shape decision, not an implementer call).

- [ ] **Step 4: Full suite + lint**

Run: `../../../../node_modules/.bin/vitest run` → expected: Task 1 count + new tests (≥5 added here), 0 failed. Run the standing oxlint gate → 0/0.

- [ ] **Step 5: Docs.** New ADR at the next free number in `docs/adr/` titled "Variation sync mirrors MANY_TO_ONE relations via join column": context (relations silently non-mirroring), decision (join-column-as-syncable-entry, server dual-name updatedFields evidence with twenty-server file refs, cloud 2.19 settings shape), consequences (ONE_TO_MANY/MORPH_RELATION excluded — backlog; override rows show the column name e.g. `accountOwnerId`). Add to the ADR index. Add one status paragraph to `context.md`.

- [ ] **Step 6: Commit** (tests+any code as one commit, docs as a second):

```bash
git add src/logic-functions/lib/__tests__/ src/logic-functions/lib/variation-sync.ts
git commit -m "test(formula-field): relation mirror end-to-end specs (primary update, null-clear, override pin, divergence, new variation)"
git add docs/adr/ context.md
git commit -m "docs(formula-field): ADR — relation mirroring via join column"
```

---

## Explicitly Out of Scope (report as backlog, do not build)

- MORPH_RELATION mirroring (discriminator column).
- RICH_TEXT mirroring (separate latent gap, same silent-exclusion mechanism).
- Wizard/health-hint surfacing WHY a field is excluded from sync (candidate follow-up given the cloud findings; user decision).
- Cloud deploy (user-gated; cloud stays on v0.1.4 until the user approves a deploy).
- Fixing the user's cloud config state (variation config targets empty `activity`; `opportunity` has no config) — that is workspace data, not code.
