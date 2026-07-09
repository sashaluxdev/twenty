import { beforeEach, describe, expect, it } from 'vitest';

import { loadOverriddenRecordIds } from 'src/logic-functions/lib/override-repository';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

// Exercises the FakeClient's opt-in cursor pagination against a real cursor
// loop. loadOverriddenRecordIds pages with `first`/`after` until
// hasNextPage is false — with a page size smaller than the row count it must
// traverse every page, advancing `after` each time, and terminate. A mock that
// never advanced the cursor (the fidelity gap this guards) would resend page 1
// forever: the loop would hang or return a short/duplicated id set.

describe('FakeClient cursor pagination (multi-page loop)', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('traverses every page and collects all ids when the page size is smaller than the row count', async () => {
    client.seed(
      'formulaOverride',
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `ovr-${index + 1}`,
        targetObject: 'company',
        targetField: 'score',
        recordId: `rec-${index + 1}`,
        active: true,
      })),
    );

    const ids = await loadOverriddenRecordIds(client, 'company', 'score', 2);

    // All 5 records surfaced -> the loop advanced across 3 pages (2 + 2 + 1).
    expect(ids).toEqual(
      new Set(['rec-1', 'rec-2', 'rec-3', 'rec-4', 'rec-5']),
    );

    // Exactly 3 pages were served (5 rows / page size 2, ceil = 3).
    const pageQueries = client.querySelections.filter(
      (selection) => selection.formulaOverrides,
    );
    expect(pageQueries).toHaveLength(3);

    // The cursor advanced page to page (undefined -> ovr-2 -> ovr-4).
    const afterCursors = pageQueries.map(
      (selection) => selection.formulaOverrides.__args.after,
    );
    expect(afterCursors).toEqual([undefined, 'ovr-2', 'ovr-4']);
  });

  it('returns a single page with hasNextPage false when the page size covers every row', async () => {
    client.seed(
      'formulaOverride',
      Array.from({ length: 3 }, (_unused, index) => ({
        id: `ovr-${index + 1}`,
        targetObject: 'company',
        targetField: 'score',
        recordId: `rec-${index + 1}`,
        active: true,
      })),
    );

    const ids = await loadOverriddenRecordIds(client, 'company', 'score', 10);

    expect(ids).toEqual(new Set(['rec-1', 'rec-2', 'rec-3']));
    const pageQueries = client.querySelections.filter(
      (selection) => selection.formulaOverrides,
    );
    expect(pageQueries).toHaveLength(1);
  });
});
