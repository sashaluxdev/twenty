# Timeline Spam Fix + Formula Description Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the formula-field app from spamming `timelineActivity` rows (spec F1–F3), retro-purge the existing spam (F4), and add a user-editable `description` to formula definitions surfaced as a "?" tooltip in the Formulas widget tab.

**Architecture:** All changes live in `packages/twenty-apps/community/formula-field` (the cloud platform/SDK offers no timeline suppression — verified). F1 makes the sweep's `lastValue` sample deterministic; F2 makes variation bookkeeping write-avoidant with a daily heartbeat; F3 extends the existing ADR 0020 cleanup cron to definition/config bookkeeping rows and app-authored `updatedBy`-only rows; F4 is a local script that runs the same cleanup with an unbounded lookback against the cloud workspace. The description feature is a new manifest TEXT field + wizard step + post-create editor textarea + widget glyph.

**Tech Stack:** twenty-sdk 2.19.0 (pinned), twenty-client-sdk 2.18.0, raw-GraphQL dynamic client (`lib/dynamic-client.ts`), vitest, @emotion/styled front components (NO twenty-sdk/ui — documented NO-GO).

**Spec:** `docs/superpowers/specs/2026-07-15-timeline-spam-fix-and-description-design.md` — read it first.

## Global Constraints

- Working dir for all commands: `packages/twenty-apps/community/formula-field` (run vitest as `npx vitest run <path>` from there).
- Never import `twenty-sdk/ui` in `src/front-components/**` (crashes the sandbox — `lib/ui.tsx:1-10`). Tooltips are native `title=` attributes only.
- Cleanup posture is fail-safe toward KEEPING rows: only rows positively identified as entirely app-managed are soft-deleted (`deleteTimelineActivity`, never `destroy*`).
- Write-avoidance contract (ADR 0004/M3): a no-op sweep performs zero record writes; timestamps alone never force a write except explicit heartbeat carve-outs (ADR 0015; new daily variation heartbeat).
- Wizard step title for the new field is exactly **"Description"** (user-specified copy, keep it clean).
- Pre-minted UUIDs: field universalIdentifiers are hand-assigned constants; use the exact UUID given in Task 5.
- Do NOT deploy to cloud or touch the cloud workspace from implementation tasks; Task 10 is an orchestrator-run release runbook.
- Comments: short-form `//`, explain WHY. Follow existing file conventions (this codebase comments heavily around fail-safety and platform quirks).
- Commit after each task; `feat(formula-field):` / `fix(formula-field):` / `docs(formula-field):` prefixes as used in git history.

---

### Task 1: F1 — deterministic pagination order in `recomputeAllRecords`

**Files:**
- Modify: `src/logic-functions/lib/recompute.ts:663-675` (the unpaged-scan loop)
- Test: `src/logic-functions/lib/__tests__/pagination.spec.ts`

**Interfaces:**
- Consumes: `graphqlEnum` from `src/logic-functions/lib/dynamic-client` (serializes an enum Name token unquoted).
- Produces: no signature changes; the paginated query now carries `orderBy: [{ id: AscNullsFirst }]`.

**Why:** the definition-row heartbeat guard compares against a "representative" `lastValue` sampled as *first non-error, non-null outcome* of this scan (`recompute.ts:715-740`). Without `orderBy` the scan order varies run-to-run, so the sample flips between records' values and every flip is a "real change" → a `formulaDefinition.updated` timeline row per sweep/event recompute.

- [ ] **Step 1: Write the failing test.** Open `src/logic-functions/lib/__tests__/pagination.spec.ts` and study how it drives `recomputeAllRecords` with the fake client (`fake-client.ts` records the queries the code issues). Add a test asserting the target-record page query includes a stable orderBy:

```ts
it('pages target records in stable id order so the heartbeat sample is deterministic', async () => {
  // Arrange exactly like the existing multi-page test in this file (reuse its
  // fake-client fixture builder), then:
  await recomputeAllRecords(client, formula);
  const pageQueries = client.queries.filter((q) => queryTouches(q, 'opportunities'));
  expect(pageQueries.length).toBeGreaterThan(0);
  for (const query of pageQueries) {
    // The raw serializer emits enum literals unquoted.
    expect(JSON.stringify(query)).toContain('orderBy');
    expect(JSON.stringify(query)).toContain('AscNullsFirst');
  }
});
```

Adapt the assertion helpers to the fake client's actual capture shape (it exists — `dynamic-client.spec.ts` and the current `pagination.spec.ts` assert on issued queries).

- [ ] **Step 2: Run it, verify it fails.** `npx vitest run src/logic-functions/lib/__tests__/pagination.spec.ts` — expected: new test FAILS (no `orderBy` in captured query), all pre-existing tests PASS.

- [ ] **Step 3: Implement.** In `recompute.ts`, add `graphqlEnum` to the existing import from `src/logic-functions/lib/dynamic-client` (check the import block at the top; add the import line if absent), then change the page query args (currently lines 666-673):

```ts
        [pluralName]: {
          __args: {
            first: pageSize,
            // Stable scan order (ADR 0022): the heartbeat's representative
            // lastValue is "first non-error, non-null outcome" of this scan.
            // Unordered pagination made that sample flip between records
            // run-to-run, defeating the write-avoidance guard and churning
            // formulaDefinition.updated timeline rows.
            orderBy: [{ id: graphqlEnum('AscNullsFirst') }],
            ...(after ? { after } : {}),
          },
          edges: { node: { id: true } },
          pageInfo: { hasNextPage: true, endCursor: true },
        },
```

- [ ] **Step 4: Run the full lib suite.** `npx vitest run src/logic-functions/lib/__tests__/` — expected: all PASS. If any existing pagination fixture asserts the exact args object, update it to include the orderBy.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "fix(formula-field): stable id order in recomputeAllRecords scan — deterministic lastValue sample (ADR 0022)"`

---

### Task 2: F2 — write-avoidant variation bookkeeping with daily heartbeat

**Files:**
- Modify: `src/logic-functions/lib/variation-config-repository.ts` (add guarded helper below `updateVariationConfigBookkeeping`, line 124-142)
- Modify: `src/logic-functions/lib/variation-sync.ts:942-948` and `:1044-1055` (both bookkeeping call sites in `sweepVariationConfig`)
- Test: `src/logic-functions/lib/__tests__/variation-sweep.spec.ts`

**Interfaces:**
- Consumes: `VariationConfigRecord` (from `lib/variation-types.ts`) — MUST expose `lastSyncedAt`, `lastError`, `status`, `statusReason`. Verify the type and `VARIATION_CONFIG_FIELDS_SELECTION` (in `variation-config-repository.ts`) include all four; add any missing field to both (the object defines them — `src/objects/variation-config.object.ts`).
- Produces: `updateVariationConfigBookkeepingIfChanged(client, config, next) => Promise<boolean>` (true = wrote). Task 8's ADR references the 24h heartbeat constant `VARIATION_BOOKKEEPING_HEARTBEAT_MS`.

**Why:** `sweepVariationConfig` currently ends with an unconditional `lastSyncedAt` write per enabled config per hourly run (and per config-change event via `handle-variation-config-change.ts:116`) → 24+ `variationConfig.updated` timeline rows/day/config. The editor renders `lastSyncedAt` as "last synced" (`variation-config-editor.tsx:336-337`), so freshness can't be dropped entirely — hence the daily heartbeat (spec F2 guard rail).

- [ ] **Step 1: Write the failing tests** in `variation-sweep.spec.ts` (reuse its existing fake-client fixtures; the config fixtures must carry `lastSyncedAt`/`lastError`/`status`/`statusReason`):

```ts
describe('bookkeeping write-avoidance (ADR 0022)', () => {
  it('skips the bookkeeping write when nothing changed and lastSyncedAt is fresh', async () => {
    // config fixture: lastError: '', status: '', statusReason: '',
    // lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()  // 1h ago
    // sweep over records that produce no errors and no status reason
    await sweepVariationConfig(client, config);
    expect(mutationsOf(client, 'updateVariationConfig')).toHaveLength(0);
  });

  it('writes when lastError changes', async () => {
    // same fresh-lastSyncedAt fixture, but sweep hits a per-record error
    await sweepVariationConfig(client, config);
    const writes = mutationsOf(client, 'updateVariationConfig');
    expect(writes).toHaveLength(1);
  });

  it('writes a daily heartbeat when lastSyncedAt is older than 24h', async () => {
    // lastSyncedAt: 25h ago, nothing else changed
    await sweepVariationConfig(client, config);
    expect(mutationsOf(client, 'updateVariationConfig')).toHaveLength(1);
  });

  it('treats an unparsable lastSyncedAt as heartbeat-due (writes)', async () => {
    // lastSyncedAt: null
    await sweepVariationConfig(client, config);
    expect(mutationsOf(client, 'updateVariationConfig')).toHaveLength(1);
  });
});
```

Write `mutationsOf` to filter the fake client's captured mutations by top-level key (a helper with this shape likely already exists in the spec file — reuse it).

- [ ] **Step 2: Run, verify the skip-test fails** (today every sweep writes): `npx vitest run src/logic-functions/lib/__tests__/variation-sweep.spec.ts`

- [ ] **Step 3: Implement the helper** in `variation-config-repository.ts`, below `updateVariationConfigBookkeeping`:

```ts
// 24h heartbeat: the editor shows lastSyncedAt as "last synced", so it cannot
// go permanently stale — but bumping it every hourly sweep churned one
// variationConfig.updated timeline row per config per hour (ADR 0022).
export const VARIATION_BOOKKEEPING_HEARTBEAT_MS = 24 * 60 * 60 * 1000;

// Write-avoidant bookkeeping (mirrors formula-repository's M3 contract): a
// no-op sweep performs ZERO config-row writes. Writes only when error/status
// content changed, or once per heartbeat window to keep lastSyncedAt honest.
// NaN from an unparsable lastSyncedAt reads as heartbeat-due, not fresh
// (same Number.isFinite posture as recordEvaluationHeartbeat).
export const updateVariationConfigBookkeepingIfChanged = async (
  client: FormulaClient,
  config: VariationConfigRecord,
  next: { lastError: string; status: string; statusReason: string },
): Promise<boolean> => {
  const changed =
    (config.lastError ?? '') !== next.lastError ||
    (config.status ?? '') !== next.status ||
    (config.statusReason ?? '') !== next.statusReason;
  const lastSyncedAtMs = Date.parse(config.lastSyncedAt ?? '');
  const heartbeatDue =
    !Number.isFinite(lastSyncedAtMs) ||
    Date.now() - lastSyncedAtMs > VARIATION_BOOKKEEPING_HEARTBEAT_MS;
  if (!changed && !heartbeatDue) {
    return false;
  }
  await updateVariationConfigBookkeeping(client, config.id, {
    lastSyncedAt: new Date().toISOString(),
    lastError: next.lastError,
    status: next.status,
    statusReason: next.statusReason,
  });
  return true;
};
```

(If `VariationConfigRecord` lacks any of the four fields, add them to the type and to `VARIATION_CONFIG_FIELDS_SELECTION` in the same commit.)

- [ ] **Step 4: Replace both call sites** in `variation-sync.ts`. The relation-field-dead early return (currently `:943-948`) becomes:

```ts
  if (!relationFieldHealth.ok) {
    await updateVariationConfigBookkeepingIfChanged(client, config, {
      lastError: relationFieldHealth.error,
      status: 'OFFLINE',
      statusReason: relationFieldHealth.error,
    });
```

and the end-of-sweep write (currently `:1048-1055`) becomes:

```ts
  await updateVariationConfigBookkeepingIfChanged(client, config, {
    lastError: firstError,
    // A completed sweep proves the config is operational: clear an OFFLINE
    // status a previous unhealthy sweep may have set (recovery convention).
    status: '',
    statusReason,
  });
```

Update the import from `variation-config-repository`.

- [ ] **Step 5: Run the variation suites.** `npx vitest run src/logic-functions/lib/__tests__/` — all PASS. Existing tests that asserted an unconditional bookkeeping write must be updated to provide a stale/changed fixture (do not delete assertions — make the fixtures explicit about why a write happens).

- [ ] **Step 6: Commit.** `git commit -am "fix(formula-field): write-avoidant variation bookkeeping with 24h lastSyncedAt heartbeat (ADR 0022)"`

---

### Task 3: F3 — cleanup cron covers bookkeeping rows and app `updatedBy`-only rows

**Files:**
- Modify: `src/logic-functions/lib/timeline-cleanup.ts` (model build `:196-225`, `processRow` `:334-411`, `stripKeysFromRow` `:296-329`)
- Test: `src/logic-functions/lib/__tests__/timeline-cleanup.spec.ts`

**Interfaces:**
- Consumes: existing `buildManagedModel`, `processRow` internals; `ObjectManagedModel.formula` semantics = "keys the app always owns" (bookkeeping keys join this set for the two definition objects).
- Produces: cleanup now also fetches/purges `formulaDefinition.updated` and `variationConfig.updated` rows (their parent columns `targetFormulaDefinitionId` / `targetVariationConfigId` follow the existing `target${Capitalized}Id` builder — no special-casing needed); app-authored `updatedBy`-only rows on any managed object are deleted.

Constants to add near the top of `timeline-cleanup.ts`:

```ts
// The actor name core stamps on this app's writes (application-config.ts
// displayName). Kept as a local literal: application-config imports
// twenty-sdk/define, which server lib code must not pull in.
const APP_ACTOR_NAME = 'Formula Field';

// Definition-object bookkeeping keys — always app-written (isUIEditable: false
// or engine-owned). A row whose diff touches ONLY these is pure app noise.
// `order` is deliberately absent: the widget's drag-reorder writes it on the
// user's behalf, so it stays keep-side (fail-safe).
const DEFINITION_BOOKKEEPING_KEYS = new Set([
  'lastValue', 'lastValueText', 'lastEvaluatedAt', 'lastError',
  'status', 'statusReason', 'dependencies',
]);
const VARIATION_CONFIG_BOOKKEEPING_KEYS = new Set([
  'lastSyncedAt', 'lastError', 'status', 'statusReason',
]);
```

- [ ] **Step 1: Write the failing tests** in `timeline-cleanup.spec.ts` (reuse its row/model fixtures). Cases:

```ts
// 1. formulaDefinition bookkeeping row -> deleted
//    name: 'formulaDefinition.updated', diff: { lastValue: {...}, lastEvaluatedAt: {...} }
// 2. formulaDefinition row with a human-editable key -> kept untouched
//    diff: { expression: {...}, lastError: {...} }
// 3. variationConfig lastSyncedAt heartbeat row -> deleted
//    name: 'variationConfig.updated', diff: { lastSyncedAt: {...} }
// 4. opportunity row, diff ONLY updatedBy with after {source:'APPLICATION', name:'Formula Field'} -> deleted
// 5. opportunity row, diff ONLY updatedBy with after {source:'API', name:'Supabase'} -> kept
// 6. opportunity row, diff { <formulaTargetField>: {...}, updatedBy(after=Formula Field) } -> deleted
//    (previously this stripped down to an updatedBy-only stub; now the whole row is app-owned)
// 7. opportunity row, diff { stage: {...}, <formulaTargetField>: {...}, updatedBy(after=Formula Field) }
//    -> stripped to { stage: {...} } and KEPT (human key present; formula + app-actor keys stripped;
//       surviving diff non-empty so no delete)
// 8. query filter now includes 'formulaDefinition.updated' and 'variationConfig.updated' in name.in
//    and selects targetFormulaDefinitionId / targetVariationConfigId
```

Assert outcomes via the captured `deleteTimelineActivity` / `updateTimelineActivity` mutations, matching the file's existing style.

- [ ] **Step 2: Run, verify new cases fail.** `npx vitest run src/logic-functions/lib/__tests__/timeline-cleanup.spec.ts`

- [ ] **Step 3: Implement.**

3a. In `buildManagedModel` (after merging formula + variation maps), register the definition objects whenever the app has anything at all (the maps' loaders already ran; add when either loader returned entries **or** any formulaDefinition edge existed — pass that through from `loadFormulaManagedByObject` by also counting draft definitions with empty targetField):

```ts
  // The definition records themselves churn <object>.updated rows from
  // engine bookkeeping (ADR 0022). Register them as app-owned key sets so the
  // same classifier covers them. Only when the app has any definitions/configs
  // at all — otherwise model stays empty and the cron never queries timeline.
  if (model.size > 0 || hasAnyDefinition) {
    model.set('formulaDefinition', {
      formula: DEFINITION_BOOKKEEPING_KEYS,
      variation: new Set<string>(),
      relationFieldName: DEFAULT_RELATION_FIELD,
    });
    model.set('variationConfig', {
      formula: VARIATION_CONFIG_BOOKKEEPING_KEYS,
      variation: new Set<string>(),
      relationFieldName: DEFAULT_RELATION_FIELD,
    });
  }
```

(`hasAnyDefinition`: make `loadFormulaManagedByObject` return `{ managedByObject, hasAnyDefinition }` — a draft definition still receives status/dependency writes.)

3b. In `processRow`, immediately after `const keys = Object.keys(diff);` classification, treat the app's own actor stamp as an app-owned key:

```ts
  // Core re-stamps updatedBy unconditionally on every accepted update, so a
  // redundant no-op write by this app (recompute race) leaves a diff whose
  // only key is updatedBy -> app noise. Only OUR actor qualifies; any other
  // actor (Supabase, another app) stays keep-side.
  const updatedByEntry = isPlainObject(diff.updatedBy) ? diff.updatedBy : null;
  const updatedByAfter =
    updatedByEntry && isPlainObject(updatedByEntry.after)
      ? updatedByEntry.after
      : null;
  const appActorUpdatedBy =
    updatedByAfter?.source === 'APPLICATION' &&
    updatedByAfter?.name === APP_ACTOR_NAME;
```

Then fold it into the existing key partition: where `formulaKeys` is built (`:354`), add `updatedBy` when `appActorUpdatedBy`:

```ts
  const formulaKeys = new Set(
    keys.filter(
      (key) =>
        managed.formula.has(key) || (key === 'updatedBy' && appActorUpdatedBy),
    ),
  );
```

The rest of `processRow` is unchanged — the partition now routes: bookkeeping-only definition rows and app-`updatedBy`-only rows to `deleteRow`; rows with human keys to `stripKeysFromRow` (which now also strips the app actor key).

3c. In `stripKeysFromRow`, delete instead of writing an empty stub:

```ts
    const newDiff: Record<string, unknown> = {};
    for (const key of keys) {
      if (!stripKeys.has(key)) {
        newDiff[key] = diff[key];
      }
    }
    // Stripping everything would leave an empty-diff stub row; that IS pure
    // app noise, so delete it instead (mirrors core, which never creates
    // empty-diff update rows).
    if (Object.keys(newDiff).length === 0) {
      return deleteRow(client, row);
    }
```

(Move `deleteRow` above `stripKeysFromRow` if declaration order requires.)

- [ ] **Step 4: Run the cleanup suite, then the whole lib suite.** `npx vitest run src/logic-functions/lib/__tests__/` — all PASS. Pay attention to existing strip-behavior tests: case-6-style rows previously asserted `stripped`; those assertions change to `deleted` only when the surviving diff would be empty — verify each changed expectation against the fail-safe rule before editing it.

- [ ] **Step 5: Commit.** `git commit -am "fix(formula-field): timeline cleanup covers definition/config bookkeeping rows and app updatedBy-only rows (ADR 0022)"`

---

### Task 4: F4 — parameterize cleanup + retro-purge script

**Files:**
- Modify: `src/logic-functions/lib/timeline-cleanup.ts:416-419` (options param), `:449` (lookback), `:457` (page cap)
- Create: `scripts/retro-purge-timeline.ts`
- Modify: `package.json` (script entry + `tsx` devDependency)
- Test: `src/logic-functions/lib/__tests__/timeline-cleanup.spec.ts`

**Interfaces:**
- Produces: `cleanupFormulaTimelineNoise(client, options?: { lookbackMs?: number; maxPages?: number })` — defaults preserve today's behavior (48h / 20 pages). The cron caller (`src/logic-functions/timeline-cleanup.ts`) needs no change.

- [ ] **Step 1: Failing test:** in `timeline-cleanup.spec.ts`, assert that `cleanupFormulaTimelineNoise(client, { lookbackMs: 1000 * 60 })` issues a query whose `happensAt.gte` is ~1 minute ago (compare with tolerance), and that the default call still uses ~48h.

- [ ] **Step 2: Run, verify it fails** (no options param exists).

- [ ] **Step 3: Implement the options param:**

```ts
export const cleanupFormulaTimelineNoise = async (
  client: FormulaClient,
  options: { lookbackMs?: number; maxPages?: number } = {},
): Promise<TimelineCleanupCounts> => {
  const lookbackMs = options.lookbackMs ?? LOOKBACK_MS;
  const maxPages = options.maxPages ?? MAX_PAGES;
```

and use `lookbackMs` in the `happensAt` filter, `maxPages` in the page loop.

- [ ] **Step 4: Write the script** `scripts/retro-purge-timeline.ts`:

```ts
// One-time retro purge (spec F4, approved 2026-07-15): runs the ADR 0022
// cleanup with an unbounded lookback against a configured remote. Loops until
// a pass reports no truncation. Soft-delete only — same fail-safe classifier
// the cron uses.
//
// Usage: npx tsx scripts/retro-purge-timeline.ts <remoteName>
// Reads apiUrl + apiKey for <remoteName> from ~/.twenty/config.json (same
// source the integration setup uses — src/__tests__/setup-test.ts).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const remoteName = process.argv[2];
if (!remoteName) {
  console.error('Usage: npx tsx scripts/retro-purge-timeline.ts <remoteName>');
  process.exit(1);
}
const config = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.twenty', 'config.json'), 'utf8'),
);
const remote = config.remotes?.[remoteName];
if (!remote?.apiUrl || !remote?.apiKey) {
  console.error(`Remote "${remoteName}" with apiUrl+apiKey not found in ~/.twenty/config.json`);
  process.exit(1);
}
// SDK clients read these env vars (same bridge as setup-test.ts).
process.env.TWENTY_API_URL = remote.apiUrl;
process.env.TWENTY_API_KEY = remote.apiKey;
process.env.TWENTY_APP_ACCESS_TOKEN ??= remote.apiKey;

const run = async () => {
  // Import AFTER env is set so client construction sees the remote.
  const { createDynamicCoreClient } = await import(
    '../src/logic-functions/lib/dynamic-client'
  );
  const { cleanupFormulaTimelineNoise } = await import(
    '../src/logic-functions/lib/timeline-cleanup'
  );
  const client = createDynamicCoreClient();
  const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
  let pass = 0;
  for (;;) {
    pass += 1;
    const counts = await cleanupFormulaTimelineNoise(client, {
      lookbackMs: TEN_YEARS_MS,
      maxPages: 50,
    });
    console.log(`pass ${pass}:`, counts);
    if (!counts.truncated) break;
  }
  console.log('Retro purge complete.');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Check `createDynamicCoreClient`'s actual export/construction signature in `dynamic-client.ts:170-181` and adjust the call if it takes arguments. Add to `package.json`: `"retro-purge": "tsx scripts/retro-purge-timeline.ts"` under scripts, `"tsx"` as a devDependency (latest 4.x), then `yarn install`.

- [ ] **Step 5: Verify:** `npx vitest run src/logic-functions/lib/__tests__/timeline-cleanup.spec.ts` PASSES; `npx tsx scripts/retro-purge-timeline.ts` with no arg prints usage and exits 1. Do NOT run it against any remote in this task.

- [ ] **Step 6: Commit.** `git commit -am "feat(formula-field): parameterized timeline cleanup + retro-purge script (spec F4)"`

---

### Task 5: Description field — schema

**Files:**
- Modify: `src/objects/formula-definition.object.ts` (`FORMULA_DEFINITION_FIELDS` map `:12-31`; `fields` array — insert after the `expression` literal at `:91-97`)

**Interfaces:**
- Produces: `formulaDefinition.description` (TEXT, UI-editable) — consumed by Tasks 6, 7, 8. Universal identifier (pre-minted, use verbatim): `7c2a1f5e-4b8d-4e2a-9f63-0d81c5b7ae24`.

- [ ] **Step 1: Add the UUID** to `FORMULA_DEFINITION_FIELDS`: `description: '7c2a1f5e-4b8d-4e2a-9f63-0d81c5b7ae24',`

- [ ] **Step 2: Add the field literal** after the `expression` entry:

```ts
    {
      universalIdentifier: FORMULA_DEFINITION_FIELDS.description,
      type: FieldType.TEXT,
      name: 'description',
      label: 'Description',
      description:
        'What this formula does, in human terms. Shown as a hover tooltip ' +
        'next to the formula in the Formulas tab.',
      icon: 'IconInfoCircle',
    },
```

- [ ] **Step 3: Verify:** `npx tsc --noEmit` (or the app's typecheck invocation if package.json defines one) passes; `npx vitest run src/__tests__ --exclude "**/*.integration-test.ts"` still passes if unit tests cover object definitions (check `metadata-objects.spec.ts`).

- [ ] **Step 4: Commit.** `git commit -am "feat(formula-field): description field on FormulaDefinition"`

---

### Task 6: Description — wizard step + post-create editor

**Files:**
- Modify: `src/front-components/lib/formula-setup-wizard.tsx` (state near the other field states; debounce effect after the name one at `:344-350`; step block after "3 · Field name" at `:958-980`)
- Modify: `src/front-components/formula-definition-editor.tsx` (description editor block before `<FormulaDangerZone>` at `:592`; definition query/type in the same file must select `description`)

**Interfaces:**
- Consumes: `TextArea`, `StepTitle`, `MutedText` from `lib/ui.tsx`; `persistDraft` (`formula-setup-wizard.tsx:182-195`); `CoreApiClient` mutation pattern.
- Produces: wizard drafts and saved definitions carry `description`; the `WizardDraft` type gains `description: string`.

- [ ] **Step 1: Wizard state + seed.** Find `type WizardDraft` (in `formula-setup-wizard.tsx` or its types import) and add `description: string;`. Find where `FormulaDefinitionEditor` builds the draft (`formula-definition-editor.tsx:465-475`, `name: definition.name` line) and pass `description: definition.description ?? ''` — this requires `description` in that file's definition query + local type (add `description: true` to its GraphQL selection; find it by grepping `statusReason: true` in the file). In the wizard component, alongside the existing `label` state:

```tsx
  const [description, setDescription] = useState(draft.description);
  const descriptionTouched = useRef(false);
```

- [ ] **Step 2: Debounced persistence**, directly below the name-persist effect (`:344-350`), same shape:

```tsx
  // Persist the typed description (debounced) so it survives navigation,
  // matching the name field's resumability contract.
  useEffect(() => {
    if (!descriptionTouched.current) return;
    const handle = setTimeout(() => {
      persistDraft({ description });
    }, 800);
    return () => clearTimeout(handle);
  }, [description, persistDraft]);
```

- [ ] **Step 3: Step block**, inserted between the Field-name step's closing `</div>` (`:980`) and the `layout.actions` div (`:982`). Step numbering: the preceding step is literally titled `3 · Field name` — title this one with the next number in the wizard's visible sequence (check whether a step 4 already exists in either mode branch; if so, renumber consistently within the touched branch only):

```tsx
      <div style={layout.step}>
        <StepTitle style={layout.stepTitle}>4 · Description</StepTitle>
        <TextArea
          style={layout.filter}
          value={description}
          placeholder="What does this formula do?"
          rows={2}
          onChange={(event) => {
            descriptionTouched.current = true;
            setDescription(event.target.value);
          }}
        />
        <MutedText as="div">
          Optional — shown as a hover tooltip in the Formulas tab.
        </MutedText>
      </div>
```

The visible title text after the numbering separator must be exactly **"Description"** — no longer phrasing. Verify `TextArea` accepts `rows` (check `lib/ui.tsx:180-184`; if not, omit it).

- [ ] **Step 4: Post-create editor.** In `formula-definition-editor.tsx`, before `<FormulaDangerZone>` (`:592`), add a small self-contained block (descriptions must stay editable after creation — the name currently is not, the description must be):

```tsx
      <div style={layout.descriptionSection}>
        <SectionTitle style={layout.descriptionTitle}>Description</SectionTitle>
        <TextArea
          value={descriptionDraft}
          placeholder="What does this formula do?"
          rows={2}
          onChange={(event) => setDescriptionDraft(event.target.value)}
        />
      </div>
```

with state seeded from the loaded definition and the same 800ms-debounce persistence via the file's existing update-mutation pattern (grep `updateFormulaDefinition` in this file and reuse it; skip the write when the draft equals the loaded value — write-avoidance applies to UI too). Add `descriptionSection`/`descriptionTitle` entries to the file's `layout` object (`:604+`), layout-only values per the file's comment convention.

- [ ] **Step 5: Verify.** Typecheck passes; `npx vitest run src/front-components` passes (front-component specs live under `src/front-components/lib/__tests__/`). Front components have no DOM test rig for these files — correctness is covered by typecheck + the Task 10 manual verification pass.

- [ ] **Step 6: Commit.** `git commit -am "feat(formula-field): description editing — wizard step + definition editor"`

---

### Task 7: Description — "?" tooltip in the Formulas widget tab

**Files:**
- Modify: `src/front-components/formula-editor.tsx` (`Definition` type `:87-104`; GraphQL selection `:287-308`; map `:314-331`; header row `:867-895`; `layout` object)

**Interfaces:**
- Consumes: `formulaDefinition.description` (Task 5), `MutedText` from `lib/ui.tsx`.

- [ ] **Step 1: Thread the field.** Add `description: string;` to the `Definition` type, `description: true,` to the query selection, `description: edge.node.description ?? '',` to the map.

- [ ] **Step 2: Render the glyph** in the header row, directly after the name span (`:891-893`):

```tsx
            <span style={layout.name}>
              {definition.name || definition.targetField}
            </span>
            {definition.description ? (
              // Native title tooltip — the app's only tooltip mechanism
              // (twenty-sdk/ui is a NO-GO in the front-component sandbox).
              <MutedText
                as="span"
                style={layout.helpGlyph}
                title={definition.description}
                aria-label={definition.description}
              >
                ?
              </MutedText>
            ) : null}
```

- [ ] **Step 3: Add the layout entry** to the file's `layout` object (layout-only values; color comes from the `MutedText` archetype):

```ts
  helpGlyph: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    border: '1px solid currentColor',
    fontSize: '10px',
    lineHeight: 1,
    marginLeft: '6px',
    cursor: 'help',
    flexShrink: 0,
  },
```

Check the header's flex layout (`layout.header`, `layout.name`, `layout.value`): the glyph must sit between name and value without pushing the value off-row — if `layout.name` has `flex: 1` the glyph belongs *inside* the name span's flow; adjust placement accordingly and note what you did in the task report.

- [ ] **Step 4: Verify.** Typecheck + `npx vitest run src/front-components` pass. No glyph is rendered when description is empty (code-inspection is enough here; manual check happens in Task 10).

- [ ] **Step 5: Commit.** `git commit -am "feat(formula-field): description ? tooltip in Formulas tab"`

---

### Task 8: ADR 0022 + docs

**Files:**
- Create: `docs/adr/0022-timeline-bookkeeping-quiet.md` (app-relative: `packages/twenty-apps/community/formula-field/docs/adr/`)
- Modify: `docs/adr/README.md` (index line), `README.md` (description field mention in the feature docs), `context.md` (running context — follow its existing entry style, add a 2026-07-15 arc entry)

- [ ] **Step 1: Write ADR 0022** following the file conventions of `docs/adr/0020-timeline-noise-cleanup.md` / `0021-*`. Content requirements: the three measured root causes (unstable `lastValue` sample from unordered pagination; unconditional variation bookkeeping; recompute-race `updatedBy`-only diffs, with core's unconditional actor re-stamp as the mechanism), the decisions (F1 stable order, F2 write-avoidance + 24h heartbeat — note the editor's "last synced" display is why the heartbeat exists, F3 classifier extension incl. the empty-stub-becomes-delete change), the retro purge (F4, approved 2026-07-15), and the standing caveat inherited from ADR 0020 (delete all of this if core ever ships audit exclusion). Reference the spec doc path.

- [ ] **Step 2: Update** `docs/adr/README.md` index, `README.md` (add description field + tooltip to the user-facing feature list), and `context.md` (new arc entry: what shipped in v0.1.8, retro purge pending/done).

- [ ] **Step 3: Commit.** `git commit -am "docs(formula-field): ADR 0022 — timeline bookkeeping quiet + description feature docs"`

---

### Task 9: Version bump + full gate

**Files:**
- Modify: `package.json` (`"version"` → `0.1.8`)

- [ ] **Step 1:** Bump version to `0.1.8`.
- [ ] **Step 2: Full gate**, all from the app directory — expected all green:
  - `npx vitest run` (unit; ~835+ tests)
  - typecheck (the repo convention: `npx tsc --noEmit` with the app's tsconfig)
  - `yarn lint` (app-local script; use `--fix` variant for autofixable issues)
- [ ] **Step 3:** From repo root: `npx nx lint:diff-with-main twenty-apps 2>/dev/null || true` — if the workspace lints apps via a different project name, run the app-local lint only; report which ran.
- [ ] **Step 4: Commit.** `git commit -am "chore(formula-field): v0.1.8 — timeline bookkeeping quiet + description tooltip"`

---

### Task 10: Release runbook — cloud deploy, retro purge, verification (ORCHESTRATOR/HUMAN — do not dispatch to an implementation subagent)

Requires cloud credentials and touches the production workspace. Execute step-by-step, verifying each before the next.

- [ ] **Step 1: Local smoke (optional but recommended):** `bash packages/twenty-utils/setup-dev-env.sh`, sync with `node <repo>/node_modules/twenty-sdk/dist/cli.cjs dev --once`, create a formula with a description, confirm the wizard step, the editor textarea, and the "?" tooltip render; confirm a sweep pass produces no `formulaDefinition.updated` rows for an unchanged formula.
- [ ] **Step 2: Cloud publish.** Follow `context.md:625-651` exactly — the hosted platform line may be newer than the pinned 2.19.0; publish from a scratch install with the MATCHING npm twenty-sdk version (`app:publish --private -r cloud`, then `app:install -r cloud`). This gotcha has bitten before; do not skip the version check.
- [ ] **Step 3: Post-deploy observation (1-2h):** confirm new `formulaDefinition.updated` rows stop appearing for unchanged formulas (allow ADR 0015 `TODAY()` heartbeats + the 10-min cleanup lag), and no new no-op `variationConfig.updated` rows on the hourly sweep.
- [ ] **Step 4: Retro purge:** ensure `~/.twenty/config.json` has the `cloud` remote with apiUrl+apiKey, then `npx tsx scripts/retro-purge-timeline.ts cloud`. Loop output until `truncated: false`.
- [ ] **Step 5: Verify counts** (Twenty MCP or GraphQL), against the 2026-07-15 baseline (spec acceptance criterion 4):
  - `formulaDefinition.updated`: from 3,770 down to ≈ genuine edits only
  - `variationConfig.updated`: from 177 down to ≈ genuine config edits
  - `opportunity.updated` rows with app-authored `updatedBy`-only diffs: 0 (baseline 671 app-authored / 1,598 total no-op)
- [ ] **Step 6:** Update `context.md` (purge done + counts), commit, push.
