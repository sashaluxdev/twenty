import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import {
  RECORD_UPDATED_TYPE_UNIVERSAL_IDENTIFIER,
  cleanupFormulaTimelineNoise,
  parentRecordIdSelectionFor,
} from 'src/logic-functions/lib/timeline-cleanup';

// The cron entry file builds its own client via createDynamicCoreClient; the
// handler test below injects a FakeClient by mocking only that factory. Every
// other dynamic-client export (notably graphqlEnum, which the lib uses to emit
// the NULL member filter) stays real via importOriginal.
const handlerMocks = vi.hoisted(() => ({ client: null as FakeClient | null }));

vi.mock('src/logic-functions/lib/dynamic-client', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('src/logic-functions/lib/dynamic-client')
  >()),
  createDynamicCoreClient: () => handlerMocks.client,
}));

// The workspace-local id of the `recordUpdated` type. Every candidate row now
// carries it, and the lib resolves it from metadata, so the default metadata
// client is mocked here to report it — the cron handler test goes through that
// default path (it passes no options). Hoisted because the mock factory below
// runs while this module's own imports are still evaluating. The universal
// identifier is spelled out there for the same reason; a test below pins it
// against the exported constant.
const { RECORD_UPDATED_TYPE_ID } = vi.hoisted(() => ({
  RECORD_UPDATED_TYPE_ID: 'tat-record-updated',
}));

vi.mock('twenty-client-sdk/metadata', () => ({
  // Non-arrow so the source's `new MetadataApiClient()` constructs it.
  MetadataApiClient: vi.fn(function () {
    return {
      query: async () => ({
        timelineActivityTypes: [
          {
            id: RECORD_UPDATED_TYPE_ID,
            universalIdentifier: '20202020-0d1a-4f0e-8a55-1c0a2f0a2c02',
            isActive: true,
          },
        ],
      }),
    };
  }),
}));

import timelineCleanupFunction from 'src/logic-functions/timeline-cleanup';

// The typed snapshot core stamps on a `recordUpdated` row (shape pinned by
// twenty-shared's TimelineActivityTypeSnapshot).
const recordUpdatedSnapshot = (): Record<string, unknown> => ({
  id: RECORD_UPDATED_TYPE_ID,
  universalIdentifier: RECORD_UPDATED_TYPE_UNIVERSAL_IDENTIFIER,
  name: 'recordUpdated',
  label: 'updated',
  action: 'updated',
});

// A metadata client stub for the injection seam (options.metadataClient).
const fakeMetadataClient = (
  types: Array<Record<string, unknown>>,
): { query: (selection: unknown) => Promise<unknown> } => ({
  query: async () => ({ timelineActivityTypes: types }),
});

// Feeds the classifier rows the server filter would have excluded, so the
// in-process G2/G3 gates can be exercised on their own: a widened or drifted
// server filter must never turn into a delete.
const injectTimelineRows = (
  client: FakeClient,
  rows: Array<Record<string, unknown>>,
): void => {
  const realQuery = client.query.bind(client);
  client.query = vi.fn(async (selection: any) => {
    if ('timelineActivities' in selection) {
      client.querySelections.push(selection);
      return {
        timelineActivities: {
          edges: rows.map((node) => ({ node })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    }
    return realQuery(selection);
  });
};

// Seeds a FormulaDefinition so its targetField (+ companion status field) counts
// as app-managed for the given object.
const seedDefinition = (
  client: FakeClient,
  overrides: {
    id?: string;
    targetObject?: string | null;
    targetField?: string | null;
    enabled?: boolean;
  } = {},
): void => {
  client.seed('formulaDefinition', [
    {
      id: overrides.id ?? 'def-1',
      targetObject: overrides.targetObject ?? 'company',
      targetField: overrides.targetField ?? 'revenue',
      enabled: overrides.enabled ?? true,
    },
  ]);
};

const recentIso = (): string => new Date().toISOString();

// Locates the timelineActivities query the module built, for filter-shape asserts.
const timelineQuery = (client: FakeClient): any =>
  client.querySelections.find((selection) => 'timelineActivities' in selection);

// The lib warns on its never-silent paths (an unresolvable type id, a run that
// scanned nothing). Silenced by default so the suite output stays readable; the
// tests that care assert on the spy.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('cleanupFormulaTimelineNoise', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('deletes a row whose diff keys are exactly one formula targetField', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  it('deletes a row whose diff covers a targetField AND its companion status field', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: {
          diff: {
            revenue: { before: 1, after: 2 },
            revenueFxStatus: { before: 'OK', after: 'OFFLINE' },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  it('classifies the fxOverrides key as formula-managed for objects with definitions', async () => {
    seedDefinition(client, { targetObject: 'opportunity', targetField: 'dealScore' });
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetOpportunityId: 'o1',
        properties: { diff: { fxOverrides: { before: null, after: 'Deal Score' } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  it('keeps a row whose diff contains only human fields', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: { diff: { name: { before: 'A', after: 'B' } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeDefined();
  });

  it('strips only the managed keys from a mixed row, preserving other properties subkeys and human payloads', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: {
          diff: {
            revenue: { before: 1, after: 2 },
            revenueFxStatus: { before: 'OK', after: 'OFFLINE' },
            name: { before: 'Acme', after: 'Acme Inc' },
          },
          // Non-diff subkey that must survive the strip untouched.
          workspaceMemberName: 'System',
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.stripped).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(counts.kept).toBe(0);

    // No delete was issued; the row survives with a rewritten diff.
    const row = client.get('timelineActivity', 't1');
    expect(row).toBeDefined();
    expect(row!.properties).toEqual({
      diff: { name: { before: 'Acme', after: 'Acme Inc' } },
      workspaceMemberName: 'System',
    });
    // Exactly one write, and it was the update (never a delete).
    expect(client.writes).toEqual([
      `timelineActivity:t1:properties=${JSON.stringify({
        diff: { name: { before: 'Acme', after: 'Acme Inc' } },
        workspaceMemberName: 'System',
      })}`,
    ]);
  });

  it('keeps rows with empty, missing, or unparsable properties (object and JSON-string cases)', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      // empty properties object
      {
        id: 't-empty',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: {},
        happensAt: recentIso(),
      },
      // missing properties entirely
      {
        id: 't-missing',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        happensAt: recentIso(),
      },
      // unparsable JSON string
      {
        id: 't-bad-json',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: '{not valid json',
        happensAt: recentIso(),
      },
      // empty diff inside otherwise-valid properties
      {
        id: 't-empty-diff',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: { diff: {} },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.kept).toBe(4);
    expect(counts.deleted).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.mutations).toBe(0);
  });

  it('deletes a row whose properties arrive as a valid JSON string', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: JSON.stringify({ diff: { revenue: { before: 1, after: 2 } } }),
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  it('never fetches rows for objects with no formula definitions and builds the documented filter', async () => {
    seedDefinition(client, { targetObject: 'company', targetField: 'revenue' });
    // A person row whose object has no formula definition: no managed object's
    // parent-pointer column is populated, so the `or` group excludes it at the
    // server and it is never even scanned.
    client.seed('timelineActivity', [
      {
        id: 'p1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetPersonId: 'person-1',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.scanned).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(client.get('timelineActivity', 'p1')).toBeDefined();

    // Filter shape: candidates are recordUpdated rows (workspace-local type id)
    // parented on one of the managed objects (an `or` over their parent-pointer
    // columns, ANDed with the sibling keys), authored by no workspace member
    // (unquoted NULL enum), inside the lookback window. The removed `name`
    // column must not reappear.
    const filter = timelineQuery(client).timelineActivities.__args.filter;
    expect(filter.name).toBeUndefined();
    expect(filter.timelineActivityTypeId).toEqual({ eq: RECORD_UPDATED_TYPE_ID });
    expect(filter.or).toEqual([
      { targetCompanyId: { is: { __graphqlEnum: 'NOT_NULL' } } },
      { targetFormulaDefinitionId: { is: { __graphqlEnum: 'NOT_NULL' } } },
      { targetVariationConfigId: { is: { __graphqlEnum: 'NOT_NULL' } } },
    ]);
    expect(filter.workspaceMemberId).toEqual({ is: { __graphqlEnum: 'NULL' } });
    expect(typeof filter.happensAt.gte).toBe('string');
  });

  it('pins the standard recordUpdated type universalIdentifier', () => {
    // Sourced from twenty-server's standard-timeline-activity-type-definitions
    // constant; the metadata mock above spells out the same literal.
    expect(RECORD_UPDATED_TYPE_UNIVERSAL_IDENTIFIER).toBe(
      '20202020-0d1a-4f0e-8a55-1c0a2f0a2c02',
    );
  });

  it('returns zero counts and issues no timelineActivities query when there are no definitions', async () => {
    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts).toEqual({
      scanned: 0,
      deleted: 0,
      stripped: 0,
      kept: 0,
      truncated: false,
    });
    expect(timelineQuery(client)).toBeUndefined();
  });

  it('respects MAX_PAGES: sets truncated when more pages remain', async () => {
    seedDefinition(client);
    // 20 pages of 100 = 2000 processed; 2001 rows leaves one page remaining. All
    // rows are human-only so nothing is mutated and pagination stays stable.
    const rows = Array.from({ length: 2001 }, (_unused, index) => ({
      id: `t${String(index).padStart(5, '0')}`,
      timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
      timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
      targetCompanyId: 'c1',
      properties: { diff: { name: { before: 'a', after: 'b' } } },
      happensAt: recentIso(),
    }));
    client.seed('timelineActivity', rows);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.truncated).toBe(true);
    expect(counts.scanned).toBe(2000);
    expect(counts.kept).toBe(2000);
    expect(counts.deleted).toBe(0);
  });

  it('isolates a per-row mutation failure: first delete throws, second row still processed', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
      {
        id: 't2',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: { diff: { revenue: { before: 3, after: 4 } } },
        happensAt: recentIso(),
      },
    ]);

    // Fail only the FIRST delete (non-retryable plain error), so the run must
    // keep that row and still process the second.
    const realMutation = client.mutation.bind(client);
    let firstDeleteSeen = false;
    client.mutation = vi.fn(async (selection: any) => {
      if ('deleteTimelineActivity' in selection && !firstDeleteSeen) {
        firstDeleteSeen = true;
        throw new Error('boom');
      }
      return realMutation(selection);
    });

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.scanned).toBe(2);
    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(1);
    // t1 (first, failed) survives; t2 was deleted.
    expect(client.get('timelineActivity', 't1')).toBeDefined();
    expect(client.get('timelineActivity', 't2')).toBeUndefined();
  });
});

// Seeds `company` object metadata (label `name`, syncable NUMBER `employees` and
// TEXT `industry`, plus the config's own `primaryRecord` relation which is never
// syncable) so computeSyncableFields yields {employees, industry}. A NUMBER
// `revenue` field is present so a FormulaDefinition can target it (kept out of
// the syncable set by computeSyncableFields' formula-exclusion).
const seedCompanyMetadata = (client: FakeClient): void => {
  client.setObjectsWithFields([
    {
      id: 'obj-company',
      nameSingular: 'company',
      labelIdentifierFieldMetadataId: 'field-name',
      fields: [
        { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
        { id: 'field-industry', name: 'industry', type: 'TEXT', isActive: true, isSystem: false },
        { id: 'field-revenue', name: 'revenue', type: 'NUMBER', isActive: true, isSystem: false },
        { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false, relationType: 'MANY_TO_ONE', joinColumnName: 'primaryRecordId' },
      ],
    },
  ]);
};

// Seeds an enabled VariationConfig for `company` (default relation field).
const seedVariationConfig = (client: FakeClient): void => {
  client.seed('variationConfig', [
    {
      id: 'vc-1',
      targetObject: 'company',
      relationFieldName: 'primaryRecord',
      enabled: true,
    },
  ]);
};

// Counts how many parent-record reads the run issued against `objectName` — the
// singular `{ [object]: { … } }` selections, which only the variation verdict
// lookup builds (the timelineActivities/variationConfigs/formulaDefinitions
// reads use different top-level keys, and computeSyncableFields reads metadata
// off the fake seam, not client.query). Backs the one-query caching assertion.
const parentReadCount = (client: FakeClient, objectName: string): number =>
  client.querySelections.filter((selection) => objectName in selection).length;

describe('cleanupFormulaTimelineNoise — typed contract gates (G2/G3)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    seedDefinition(client, { targetObject: 'company', targetField: 'revenue' });
  });

  // The server filter matches on the workspace-local type id; the snapshot is
  // the stable, workspace-independent fact. A row whose id says recordUpdated
  // but whose snapshot says otherwise (routing, a stale id, a reused row) must
  // not be touched, however app-owned its diff looks.
  it('keeps a recordCreated-snapshot row whose diff is entirely app-managed', async () => {
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: {
          id: 'tat-record-created',
          universalIdentifier: '20202020-0d1a-4f0e-8a55-1c0a2f0a2c01',
          name: 'recordCreated',
          label: 'was created by',
          action: 'created',
        },
        targetCompanyId: 'c1',
        properties: {
          diff: {
            revenue: { before: 1, after: 2 },
            revenueFxStatus: { before: 'OK', after: 'OFFLINE' },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.scanned).toBe(1);
    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.mutations).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeDefined();
  });

  it('keeps a routed object-specific update row (non-recordUpdated snapshot)', async () => {
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: {
          id: 'tat-task-updated',
          universalIdentifier: '7f2c9b41-5d3e-4a68-9c10-8b6d4e2f0a33',
          name: 'taskUpdated',
          label: 'updated',
          action: 'updated',
        },
        targetCompanyId: 'c1',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(client.mutations).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeDefined();
  });

  it('keeps a row with a null snapshot', async () => {
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: null,
        targetCompanyId: 'c1',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(client.mutations).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeDefined();
  });

  // G3: the row -> object mapping is the SINGLE populated parent column. Two
  // populated columns make the mapping ambiguous, so the row is not classified.
  // `lastError` is app-owned bookkeeping on BOTH candidate objects, so picking
  // either one would delete the row — only the ambiguity guard keeps it.
  it('keeps a row with two populated parent columns', async () => {
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetFormulaDefinitionId: 'def-1',
        targetVariationConfigId: 'vc-1',
        properties: { diff: { lastError: { before: null, after: 'BOOM' } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.scanned).toBe(1);
    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(client.mutations).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeDefined();
  });

  it('keeps a row with no populated parent column', async () => {
    // The `or` group would exclude this row at the server, so it is injected
    // directly: the in-process gate is the second line of defense.
    injectTimelineRows(client, [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.scanned).toBe(1);
    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(client.mutations).toBe(0);
  });

  // G2, last paragraph: with no resolvable recordUpdated type id there is no
  // safe candidate filter, so the (large) timelineActivities table is not
  // queried at all and the run is a warned no-op.
  it('returns zero counts and issues no timelineActivities query when the type id cannot be resolved', async () => {
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client, {
      metadataClient: fakeMetadataClient([
        {
          id: 'tat-record-created',
          universalIdentifier: '20202020-0d1a-4f0e-8a55-1c0a2f0a2c01',
          isActive: true,
        },
      ]),
    });

    expect(counts).toEqual({
      scanned: 0,
      deleted: 0,
      stripped: 0,
      kept: 0,
      truncated: false,
    });
    expect(timelineQuery(client)).toBeUndefined();
    expect(client.get('timelineActivity', 't1')).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not resolve the recordUpdated'),
    );
  });

  it('ignores an inactive recordUpdated type, and warns on every run', async () => {
    const metadataClient = fakeMetadataClient([
      {
        id: RECORD_UPDATED_TYPE_ID,
        universalIdentifier: RECORD_UPDATED_TYPE_UNIVERSAL_IDENTIFIER,
        isActive: false,
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client, { metadataClient });
    // The second run is served by the memo, which caches the null verdict — it
    // must still say so out loud.
    await cleanupFormulaTimelineNoise(client, { metadataClient });

    expect(counts.scanned).toBe(0);
    expect(timelineQuery(client)).toBeUndefined();
    expect(
      warnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('could not resolve the recordUpdated'),
      ),
    ).toHaveLength(2);
  });

  it('keeps every row when the metadata lookup fails', async () => {
    const counts = await cleanupFormulaTimelineNoise(client, {
      metadataClient: {
        query: async () => {
          throw new Error('metadata boom');
        },
      },
    });

    expect(counts.scanned).toBe(0);
    expect(timelineQuery(client)).toBeUndefined();
    // The failure detail (with the error) plus the run-level verdict.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not load timelineActivityTypes'),
      expect.any(Error),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not resolve the recordUpdated'),
    );
  });

  // G4: the type id is workspace-stable, so it costs at most one extra request
  // per run — and a second run inside the TTL costs none.
  it('memoizes the type-id lookup across runs', async () => {
    let metadataQueries = 0;
    const metadataClient = {
      query: async () => {
        metadataQueries += 1;
        return {
          timelineActivityTypes: [
            {
              id: RECORD_UPDATED_TYPE_ID,
              universalIdentifier: RECORD_UPDATED_TYPE_UNIVERSAL_IDENTIFIER,
              isActive: true,
            },
          ],
        };
      },
    };

    await cleanupFormulaTimelineNoise(client, { metadataClient });
    await cleanupFormulaTimelineNoise(client, { metadataClient });

    expect(metadataQueries).toBe(1);
  });

  // The silent-zero mode is what hid the broken `name` filter for 17 days.
  it('warns when a run scans nothing while objects are managed', async () => {
    await cleanupFormulaTimelineNoise(client);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('scanned 0 rows'),
    );
  });
});

describe('parentRecordIdSelectionFor', () => {
  it('pins the server naming: target${Capitalized}Id for standard AND custom objects', () => {
    // Standard objects match the typed columns on
    // timeline-activity.workspace-entity.ts (targetCompanyId, ...).
    expect(parentRecordIdSelectionFor('company')).toBe('targetCompanyId');
    expect(parentRecordIdSelectionFor('opportunity')).toBe('targetOpportunityId');
    // Custom objects run the SAME server-side builder (no standard/custom
    // branch): only the first character is upper-cased, the rest untouched.
    expect(parentRecordIdSelectionFor('myThing')).toBe('targetMyThingId');
  });
});

describe('cleanupFormulaTimelineNoise — variation-managed rows', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    seedCompanyMetadata(client);
    seedVariationConfig(client);
  });

  it('deletes a variation record row whose diff keys are all syncable fields (FK non-null)', async () => {
    // Parent record is itself a variation: its config-relation FK points at a primary.
    client.seed('company', [{ id: 'c-var', primaryRecordId: 'c-primary' }]);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c-var',
        properties: {
          diff: {
            employees: { before: 10, after: 20 },
            industry: { before: 'Tech', after: 'Fintech' },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  it('keeps the identical row when the record is a primary (FK null)', async () => {
    // No config-relation FK -> the record is a primary; the same field names can
    // be human/integration-authored, so the row is not app noise.
    client.seed('company', [{ id: 'c-primary', primaryRecordId: null }]);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c-primary',
        properties: {
          diff: {
            employees: { before: 10, after: 20 },
            industry: { before: 'Tech', after: 'Fintech' },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeDefined();
  });

  it('deletes a variation row whose diff mixes syncable fields and formula fields (both managed)', async () => {
    seedDefinition(client, { targetObject: 'company', targetField: 'revenue' });
    client.seed('company', [{ id: 'c-var', primaryRecordId: 'c-primary' }]);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c-var',
        properties: {
          diff: {
            employees: { before: 10, after: 20 }, // variation-managed
            revenue: { before: 1, after: 2 }, // formula-managed
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  it('keeps a variation-candidate row when the parent record read fails, still processing later rows', async () => {
    // A formula on revenue gives a Task-1 all-formula row that needs no parent
    // read, so it must still be deleted even while the parent read is failing.
    seedDefinition(client, { targetObject: 'company', targetField: 'revenue' });
    client.seed('company', [{ id: 'c-var', primaryRecordId: 'c-primary' }]);
    client.seed('timelineActivity', [
      {
        id: 't-variation',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c-var',
        properties: { diff: { employees: { before: 10, after: 20 } } },
        happensAt: recentIso(),
      },
      {
        id: 't-formula',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c-var',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    // Every parent-record read (top-level key `company`) throws.
    client.failQueriesFor('company', new Error('parent read boom'));

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.scanned).toBe(2);
    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(1);
    // Variation row kept (read failed -> fail-safe); the all-formula row still deleted.
    expect(client.get('timelineActivity', 't-variation')).toBeDefined();
    expect(client.get('timelineActivity', 't-formula')).toBeUndefined();
  });

  it('caches the per-record verdict: two rows for one record cost exactly one parent read', async () => {
    client.seed('company', [{ id: 'c-var', primaryRecordId: 'c-primary' }]);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c-var',
        properties: { diff: { employees: { before: 10, after: 20 } } },
        happensAt: recentIso(),
      },
      {
        id: 't2',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c-var',
        properties: { diff: { industry: { before: 'A', after: 'B' } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(2);
    // Both rows resolve the SAME record -> the second reads the cache, not the API.
    expect(parentReadCount(client, 'company')).toBe(1);
  });

  it('no enabled variation configs -> classification is identical to Task 1 (no parent read)', async () => {
    // Fresh client WITHOUT a variation config: reproduces a Task 1 delete case.
    client = new FakeClient();
    seedCompanyMetadata(client);
    seedDefinition(client, { targetObject: 'company', targetField: 'revenue' });
    client.seed('company', [{ id: 'c-var', primaryRecordId: 'c-primary' }]);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c-var',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
    // The variation path never engaged: no parent-record read was issued.
    expect(parentReadCount(client, 'company')).toBe(0);
  });
});

describe('cleanupFormulaTimelineNoise — definition bookkeeping and app updatedBy rows', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  // Case 1: a formulaDefinition update row whose diff touches only engine
  // bookkeeping keys is pure app noise -> deleted.
  it('deletes a formulaDefinition update row whose diff is only engine bookkeeping keys', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetFormulaDefinitionId: 'def-1',
        properties: {
          diff: {
            lastValue: { before: 1, after: 2 },
            lastEvaluatedAt: { before: 'a', after: 'b' },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  // Case 2: a formulaDefinition update row with a human-editable key
  // (`expression`) is NOT deleted; only the app-owned bookkeeping key is
  // stripped, the human key + its payload survive.
  it('strips bookkeeping from a formulaDefinition update row that also has a human-editable key', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetFormulaDefinitionId: 'def-1',
        properties: {
          diff: {
            expression: { before: '1+1', after: '2+2' },
            lastError: { before: null, after: 'BOOM' },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.stripped).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(counts.kept).toBe(0);
    const row = client.get('timelineActivity', 't1');
    expect(row).toBeDefined();
    expect(row!.properties).toEqual({
      diff: { expression: { before: '1+1', after: '2+2' } },
    });
  });

  // Case 3: a variationConfig heartbeat row (only lastSyncedAt) is pure
  // app noise -> deleted.
  it('deletes a variationConfig heartbeat row whose diff is only lastSyncedAt', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetVariationConfigId: 'vc-1',
        properties: { diff: { lastSyncedAt: { before: 'a', after: 'b' } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  // Case 4: a managed target-object row whose only diff key is THIS app's own
  // updatedBy stamp (source APPLICATION, name 'Formula Field') is app noise from
  // a redundant recompute write -> deleted.
  it("deletes a target-object row whose only diff key is this app's own updatedBy stamp", async () => {
    seedDefinition(client, { targetObject: 'opportunity', targetField: 'revenue' });
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetOpportunityId: 'o1',
        properties: {
          diff: {
            updatedBy: {
              before: { source: 'API', name: 'Supabase' },
              after: { source: 'APPLICATION', name: 'Formula Field' },
            },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  // Case 5: an updatedBy-only row from ANOTHER actor (Supabase / API) is not the
  // app's own stamp -> kept (fail-safe toward keeping).
  it('keeps a target-object row whose only diff key is a non-app updatedBy stamp', async () => {
    seedDefinition(client, { targetObject: 'opportunity', targetField: 'revenue' });
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetOpportunityId: 'o1',
        properties: {
          diff: {
            updatedBy: {
              before: { source: 'APPLICATION', name: 'Formula Field' },
              after: { source: 'API', name: 'Supabase' },
            },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.kept).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeDefined();
  });

  // Case 6: a formula target field + the app's own updatedBy stamp — the whole
  // row is app-owned (no human key), so it is deleted rather than stripped to an
  // updatedBy-only stub.
  it("deletes a row whose diff is a formula target field plus this app's own updatedBy stamp", async () => {
    seedDefinition(client, { targetObject: 'opportunity', targetField: 'revenue' });
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetOpportunityId: 'o1',
        properties: {
          diff: {
            revenue: { before: 1, after: 2 },
            updatedBy: {
              before: { source: 'API', name: 'Supabase' },
              after: { source: 'APPLICATION', name: 'Formula Field' },
            },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(counts.kept).toBe(0);
    expect(counts.stripped).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  // Case 7: a human key (`stage`) alongside a formula field and the app's own
  // updatedBy stamp — the formula + app-actor keys are stripped, but the human
  // key remains, so the surviving diff is non-empty and the row is KEPT.
  it('strips formula and app updatedBy keys but keeps a human key alongside them', async () => {
    seedDefinition(client, { targetObject: 'opportunity', targetField: 'revenue' });
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetOpportunityId: 'o1',
        properties: {
          diff: {
            stage: { before: 'NEW', after: 'WON' },
            revenue: { before: 1, after: 2 },
            updatedBy: {
              before: { source: 'API', name: 'Supabase' },
              after: { source: 'APPLICATION', name: 'Formula Field' },
            },
          },
        },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.stripped).toBe(1);
    expect(counts.deleted).toBe(0);
    expect(counts.kept).toBe(0);
    const row = client.get('timelineActivity', 't1');
    expect(row).toBeDefined();
    expect(row!.properties).toEqual({
      diff: { stage: { before: 'NEW', after: 'WON' } },
    });
  });

  // Case 8: with any definition present, the query fetches the two definition
  // objects too and selects their parent-pointer columns.
  it('extends the query filter and selection to the two definition objects', async () => {
    seedDefinition(client);

    await cleanupFormulaTimelineNoise(client);

    const built = timelineQuery(client);
    const filter = built.timelineActivities.__args.filter;
    expect(filter.or).toEqual(
      expect.arrayContaining([
        { targetFormulaDefinitionId: { is: { __graphqlEnum: 'NOT_NULL' } } },
        { targetVariationConfigId: { is: { __graphqlEnum: 'NOT_NULL' } } },
      ]),
    );
    const node = built.timelineActivities.edges.node;
    expect(node.targetFormulaDefinitionId).toBe(true);
    expect(node.targetVariationConfigId).toBe(true);
    // The snapshot replaces the removed `name` column in the node selection.
    expect(node.timelineActivityTypeSnapshot).toBe(true);
    expect(node.name).toBeUndefined();
  });
});

describe('cleanupFormulaTimelineNoise — options (spec F4)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  // Tolerance for comparing the `happensAt.gte` timestamp against "now minus
  // the expected lookback" — generous enough to absorb test execution jitter
  // without weakening the assertion's intent (right window, not exact ms).
  const TOLERANCE_MS = 5_000;

  it('uses the default ~48h lookback when no options are passed', async () => {
    seedDefinition(client);

    await cleanupFormulaTimelineNoise(client);

    const filter = timelineQuery(client).timelineActivities.__args.filter;
    const gteMs = new Date(filter.happensAt.gte).getTime();
    const expectedMs = Date.now() - 48 * 60 * 60 * 1000;
    expect(Math.abs(gteMs - expectedMs)).toBeLessThan(TOLERANCE_MS);
  });

  it('honors options.lookbackMs, overriding the 48h default', async () => {
    seedDefinition(client);

    await cleanupFormulaTimelineNoise(client, { lookbackMs: 1000 * 60 });

    const filter = timelineQuery(client).timelineActivities.__args.filter;
    const gteMs = new Date(filter.happensAt.gte).getTime();
    const expectedMs = Date.now() - 1000 * 60;
    expect(Math.abs(gteMs - expectedMs)).toBeLessThan(TOLERANCE_MS);
  });
});

describe('timeline-cleanup cron (default export handler)', () => {
  it('sweeps app noise via the injected client and returns the outcome counts', async () => {
    const client = new FakeClient();
    handlerMocks.client = client;
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        timelineActivityTypeId: RECORD_UPDATED_TYPE_ID,
        timelineActivityTypeSnapshot: recordUpdatedSnapshot(),
        targetCompanyId: 'c1',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const result = (await timelineCleanupFunction.config.handler()) as Record<
      string,
      number | boolean
    >;

    // The handler is a thin wrapper: it must spread the lib's counts back out
    // (so the cron log shows scanned/deleted) and actually delete the row.
    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(0);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
    // The cron contract this file exists to pin.
    expect(timelineCleanupFunction.config.cronTriggerSettings?.pattern).toBe(
      '*/10 * * * *',
    );
  });
});
