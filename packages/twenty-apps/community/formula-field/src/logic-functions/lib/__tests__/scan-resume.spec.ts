import { describe, expect, it } from 'vitest';

import { handleFormulaChange } from 'src/logic-functions/lib/handle-formula-change';
import { recomputeAllRecords } from 'src/logic-functions/lib/recompute';
import { type FormulaDefinitionRecord } from 'src/logic-functions/lib/types';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('scanCursor bookkeeping', () => {
  it('does not re-enter formula handling when only the scan cursor changed', async () => {
    const client = new FakeClient();
    const after = {
      id: 'formula-1',
      targetObject: 'opportunity',
      targetField: 'score',
      targetFieldType: 'NUMBER',
      expression: 'amount + 1',
      enabled: true,
      scanCursor: 'opp-100',
    };

    const result = await handleFormulaChange({
      client,
      after,
      updatedFields: ['scanCursor'],
    });

    expect(result).toEqual({ handled: false, reason: 'bookkeeping-only' });
    expect(client.mutations).toBe(0);
  });
});

const RESUME_FORMULA: FormulaDefinitionRecord = {
  id: 'formula-1',
  targetObject: 'opportunity',
  targetField: 'score',
  targetFieldType: 'NUMBER',
  outputFormat: 'integer',
  expression: 'amount + 1',
  enabled: true,
};

describe('budget-bounded resumable scan', () => {
  const seed = (client: FakeClient, count: number): void => {
    client.setFieldKinds('opportunity', { amount: 'NUMBER', score: 'NUMBER' });
    client.seed('formulaDefinition', [{ ...RESUME_FORMULA }]);
    client.seed(
      'opportunity',
      Array.from({ length: count }, (_unused, index) => ({
        id: `opp-${String(index + 1).padStart(3, '0')}`,
        amount: index + 1,
        score: null,
      })),
    );
  };

  it('stops at a page boundary once the deadline passes and stores the cursor', async () => {
    const client = new FakeClient();
    seed(client, 6);

    // Deadline already passed: exactly one page runs, then the scan yields.
    const outcomes = await recomputeAllRecords(client, RESUME_FORMULA, {
      pageSize: 2,
      deadlineAt: Date.now() - 1,
    });

    expect(outcomes).toHaveLength(2);
    expect(client.get('formulaDefinition', 'formula-1')?.scanCursor).toBe('opp-002');
  });

  it('resumes from the stored cursor instead of the first record', async () => {
    const client = new FakeClient();
    seed(client, 6);

    // Resume is opt-in: the sweep passes resumeFromStoredCursor, so this test
    // does too. The resume assertions below are unchanged.
    const outcomes = await recomputeAllRecords(
      client,
      { ...RESUME_FORMULA, scanCursor: 'opp-004' },
      { resumeFromStoredCursor: true, pageSize: 10 },
    );

    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'opp-005',
      'opp-006',
    ]);
  });

  it('clears the cursor when a pass reaches the end', async () => {
    const client = new FakeClient();
    seed(client, 3);
    client.seed('formulaDefinition', [{ ...RESUME_FORMULA, scanCursor: 'opp-001' }]);

    // Resume is opt-in: the cursor is cleared only on a pass that opted in.
    await recomputeAllRecords(
      client,
      { ...RESUME_FORMULA, scanCursor: 'opp-001' },
      { resumeFromStoredCursor: true, pageSize: 10 },
    );

    expect(client.get('formulaDefinition', 'formula-1')?.scanCursor).toBe('');
  });

  it('scans from the first record when resume is NOT opted in, even with a stored cursor', async () => {
    // The Critical regression (final-review Fix 1): event-driven callers pass a
    // formula that carries scanCursor but must NOT resume. Without the flag the
    // scan must cover opp-001..opp-006, not just the tail past opp-004.
    const client = new FakeClient();
    seed(client, 6);

    const outcomes = await recomputeAllRecords(
      client,
      { ...RESUME_FORMULA, scanCursor: 'opp-004' },
      { pageSize: 10 },
    );

    expect(outcomes.map((outcome) => outcome.targetRecordId)).toEqual([
      'opp-001',
      'opp-002',
      'opp-003',
      'opp-004',
      'opp-005',
      'opp-006',
    ]);
  });

  it('does not clear a stored cursor on a non-resumed (event-driven) full pass', async () => {
    // The cursor protocol is the sweep's alone: an event-driven pass neither
    // reads nor writes it, so a stored cursor survives untouched.
    const client = new FakeClient();
    seed(client, 3);
    client.seed('formulaDefinition', [{ ...RESUME_FORMULA, scanCursor: 'opp-001' }]);

    await recomputeAllRecords(
      client,
      { ...RESUME_FORMULA, scanCursor: 'opp-001' },
      { pageSize: 10 },
    );

    expect(client.get('formulaDefinition', 'formula-1')?.scanCursor).toBe('opp-001');
  });

  it('skips the heartbeat on a resumed pass that completes (Fix 2)', async () => {
    // A resumed pass is partial by construction — its heartbeat sample is the
    // tail, not the record-1 sample a full pass produces, so running it would
    // churn lastValue run-to-run (ADR 0022). Observe: no updateFormulaDefinition
    // mutation carrying heartbeat fields (lastValue/lastEvaluatedAt) fires.
    const client = new FakeClient();
    seed(client, 6);
    client.seed('formulaDefinition', [{ ...RESUME_FORMULA, scanCursor: 'opp-004' }]);

    await recomputeAllRecords(
      client,
      { ...RESUME_FORMULA, scanCursor: 'opp-004' },
      { resumeFromStoredCursor: true, pageSize: 10 },
    );

    const heartbeatWrites = client.mutationSelections.filter((selection) => {
      const data = selection?.updateFormulaDefinition?.__args?.data as
        | Record<string, unknown>
        | undefined;
      return (
        data !== undefined &&
        ('lastValue' in data ||
          'lastValueText' in data ||
          'lastEvaluatedAt' in data)
      );
    });
    expect(heartbeatWrites).toHaveLength(0);
    // Contrast: a full (non-resumed) pass DOES write the heartbeat.
    expect(client.get('formulaDefinition', 'formula-1')?.lastValue ?? null).toBe(
      null,
    );
  });

  it('writes the heartbeat on a full (non-resumed) completing pass', async () => {
    // The positive contrast to the skip above: a full pass keeps its heartbeat.
    const client = new FakeClient();
    seed(client, 6);

    await recomputeAllRecords(client, RESUME_FORMULA, { pageSize: 10 });

    const heartbeatWrites = client.mutationSelections.filter((selection) => {
      const data = selection?.updateFormulaDefinition?.__args?.data as
        | Record<string, unknown>
        | undefined;
      return data !== undefined && 'lastValue' in data;
    });
    expect(heartbeatWrites.length).toBeGreaterThan(0);
  });
});

// ADR 0025's measured numbers, kept as a regression check: a full-object
// backfill of 387 previously-null records (19 enabled definitions in the real
// workspace all target opportunity; this exercises one of them end to end).
describe('measured request counts for a 387-record scan (ADR 0025)', () => {
  it('collapses reads to page-count while writes stay per-changed-record', async () => {
    const client = new FakeClient();
    client.setFieldKinds('opportunity', { amount: 'NUMBER', score: 'NUMBER' });
    client.seed('formulaDefinition', [{ ...RESUME_FORMULA }]);
    client.seed(
      'opportunity',
      Array.from({ length: 387 }, (_unused, index) => ({
        id: `opp-${String(index + 1).padStart(3, '0')}`,
        amount: index + 1,
        score: null,
      })),
    );

    const outcomes = await recomputeAllRecords(client, RESUME_FORMULA, {});

    expect(outcomes).toHaveLength(387);
    // 4 page reads (pageSize 100 default: 100+100+100+87) + 1 override-record
    // load, versus ~391 reads (4 pages + 387 per-record fetches) before the
    // prefetch (Task 2).
    expect(client.queries).toBe(5);
    // 387 value-write mutations (this formula's output is unique per record —
    // amount + 1 over distinct amounts — so payload-grouping cannot collapse
    // them; batch-write.spec.ts covers the case where it does) + 1 heartbeat
    // write, versus up to 387 writes before batching (Task 5) — the win here
    // is the batch endpoint's chunking headroom, not a lower call count for
    // this particular all-distinct-values dataset.
    expect(client.mutations).toBe(388);
  });
});
