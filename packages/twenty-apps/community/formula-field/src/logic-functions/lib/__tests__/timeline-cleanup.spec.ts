import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';
import { cleanupFormulaTimelineNoise } from 'src/logic-functions/lib/timeline-cleanup';

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
        name: 'company.updated',
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
        name: 'company.updated',
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

  it('keeps a row whose diff contains only human fields', async () => {
    seedDefinition(client);
    client.seed('timelineActivity', [
      {
        id: 't1',
        name: 'company.updated',
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
        name: 'company.updated',
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
      { id: 't-empty', name: 'company.updated', properties: {}, happensAt: recentIso() },
      // missing properties entirely
      { id: 't-missing', name: 'company.updated', happensAt: recentIso() },
      // unparsable JSON string
      {
        id: 't-bad-json',
        name: 'company.updated',
        properties: '{not valid json',
        happensAt: recentIso(),
      },
      // empty diff inside otherwise-valid properties
      {
        id: 't-empty-diff',
        name: 'company.updated',
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
        name: 'company.updated',
        properties: JSON.stringify({ diff: { revenue: { before: 1, after: 2 } } }),
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(1);
    expect(client.get('timelineActivity', 't1')).toBeUndefined();
  });

  it('never touches rows for objects with no formula definitions and builds the documented filter', async () => {
    seedDefinition(client, { targetObject: 'company', targetField: 'revenue' });
    // A person row whose object has no formula definition. The real server would
    // exclude it via the name-in filter; the classifier keeps it regardless.
    client.seed('timelineActivity', [
      {
        id: 'p1',
        name: 'person.updated',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
    ]);

    const counts = await cleanupFormulaTimelineNoise(client);

    expect(counts.deleted).toBe(0);
    expect(counts.kept).toBe(1);
    expect(client.get('timelineActivity', 'p1')).toBeDefined();

    // Filter shape: name limited to defined objects, workspaceMemberId IS NULL
    // (unquoted enum), and a lookback window.
    const filter = timelineQuery(client).timelineActivities.__args.filter;
    expect(filter.name).toEqual({ in: ['company.updated'] });
    expect(filter.workspaceMemberId).toEqual({ is: { __graphqlEnum: 'NULL' } });
    expect(typeof filter.happensAt.gte).toBe('string');
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
      name: 'company.updated',
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
        name: 'company.updated',
        properties: { diff: { revenue: { before: 1, after: 2 } } },
        happensAt: recentIso(),
      },
      {
        id: 't2',
        name: 'company.updated',
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
