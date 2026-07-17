import { describe, expect, it, vi } from 'vitest';

import {
  __resetSharedRefreshStatesForTests,
  type DefinitionLike,
  type RefreshThrottleState,
  refreshStaleTodayFormulas,
  sharedSweepRefreshState,
} from 'src/front-components/lib/refresh-stale-formulas';
import { type FormulaClient } from 'src/logic-functions/lib/types';

// The orchestrator runs through INJECTED recompute functions (recomputeForRecordFn /
// recomputeAllRecordsFn), so these tests hand in plain vi.fn() fakes — no module
// mocking (mirrors the injectable-client style of delete-definition-completely.spec.ts).
// `client` itself is opaque here: it is only ever forwarded to the injected fns.

const HOUR_MS = 60 * 60 * 1000;
const now = Date.parse('2026-07-06T12:00:00.000Z');
// STALE_AFTER_MS is 2.5h (format-relative-past.ts) — 3h ago is past it, 10min isn't.
const staleIso = new Date(now - 3 * HOUR_MS).toISOString();
const freshIso = new Date(now - 10 * 60 * 1000).toISOString();

const fakeClient: FormulaClient = {
  query: async () => ({}),
  mutation: async () => ({}),
};

const def = (overrides: Partial<DefinitionLike> = {}): DefinitionLike => ({
  id: 'def-1',
  targetObject: 'opportunity',
  targetField: 'formulaScore',
  targetFieldType: 'NUMBER',
  expression: 'TODAY()',
  enabled: true,
  lastEvaluatedAt: staleIso,
  usesTodayFlag: true,
  ...overrides,
});

const idleState = (): RefreshThrottleState => ({
  lastRefreshAt: 0,
  inFlight: false,
});

describe('refreshStaleTodayFormulas', () => {
  it('refreshes only stale enabled TODAY definitions', async () => {
    const staleToday = def({ id: 'stale-today' });
    const freshToday = def({ id: 'fresh-today', lastEvaluatedAt: freshIso });
    const staleNonToday = def({ id: 'stale-non-today', usesTodayFlag: false });
    const staleDisabled = def({ id: 'stale-disabled', enabled: false });

    const recomputeAllRecordsFn = vi.fn().mockResolvedValue([]);

    const refreshed = await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [staleToday, freshToday, staleNonToday, staleDisabled],
      now,
      state: idleState(),
      sweepAllRecords: true,
      recomputeAllRecordsFn,
    });

    expect(recomputeAllRecordsFn).toHaveBeenCalledTimes(1);
    expect(recomputeAllRecordsFn).toHaveBeenCalledWith(fakeClient, staleToday, {
      shouldContinue: undefined,
    });
    expect(refreshed).toEqual(['stale-today']);
  });

  it('recomputes the viewed record first when recordId is given', async () => {
    const staleToday = def();
    const calls: string[] = [];
    const recomputeForRecordFn = vi.fn().mockImplementation(async () => {
      calls.push('record');
      return {};
    });
    const recomputeAllRecordsFn = vi.fn().mockImplementation(async () => {
      calls.push('all');
      return [];
    });

    await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [staleToday],
      now,
      state: idleState(),
      recordId: 'rec-1',
      sweepAllRecords: true,
      recomputeForRecordFn,
      recomputeAllRecordsFn,
    });

    expect(calls).toEqual(['record', 'all']);
    expect(recomputeForRecordFn).toHaveBeenCalledWith({
      client: fakeClient,
      formula: staleToday,
      targetRecordId: 'rec-1',
    });

    // When recordId is omitted, recomputeForRecordFn is never called.
    const recomputeForRecordFnUnused = vi.fn();
    const recomputeAllRecordsFnAgain = vi.fn().mockResolvedValue([]);
    await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [staleToday],
      now,
      state: idleState(),
      sweepAllRecords: true,
      recomputeForRecordFn: recomputeForRecordFnUnused,
      recomputeAllRecordsFn: recomputeAllRecordsFnAgain,
    });
    expect(recomputeForRecordFnUnused).not.toHaveBeenCalled();
  });

  it('throttles: does nothing when lastRefreshAt is within 60s of now', async () => {
    const recomputeAllRecordsFn = vi.fn();
    const state: RefreshThrottleState = {
      lastRefreshAt: now - 30_000,
      inFlight: false,
    };

    const refreshed = await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [def()],
      now,
      state,
      sweepAllRecords: true,
      recomputeAllRecordsFn,
    });

    expect(refreshed).toEqual([]);
    expect(recomputeAllRecordsFn).not.toHaveBeenCalled();
    expect(state).toEqual({ lastRefreshAt: now - 30_000, inFlight: false });
  });

  it('guards re-entry: does nothing when state.inFlight is true', async () => {
    const recomputeAllRecordsFn = vi.fn();
    const state: RefreshThrottleState = { lastRefreshAt: 0, inFlight: true };

    const refreshed = await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [def()],
      now,
      state,
      sweepAllRecords: true,
      recomputeAllRecordsFn,
    });

    expect(refreshed).toEqual([]);
    expect(recomputeAllRecordsFn).not.toHaveBeenCalled();
    expect(state).toEqual({ lastRefreshAt: 0, inFlight: true });
  });

  it('sets inFlight during the run and clears it after, including on failure', async () => {
    const state: RefreshThrottleState = { lastRefreshAt: 0, inFlight: false };
    let inFlightDuringCall = false;
    const recomputeAllRecordsFn = vi.fn().mockImplementation(async () => {
      inFlightDuringCall = state.inFlight;
      throw new Error('boom');
    });
    const onStateChange = vi.fn();

    const refreshed = await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [def()],
      now,
      state,
      sweepAllRecords: true,
      recomputeAllRecordsFn,
      onStateChange,
    });

    expect(inFlightDuringCall).toBe(true);
    expect(state.inFlight).toBe(false);
    expect(state.lastRefreshAt).toBe(now);
    // The failure is swallowed (passive stale note remains the failure surface).
    expect(refreshed).toEqual([]);
    expect(onStateChange).toHaveBeenCalled();
  });

  it('processes multiple stale definitions sequentially', async () => {
    const defA = def({ id: 'a' });
    const defB = def({ id: 'b' });
    const order: string[] = [];
    const recomputeAllRecordsFn = vi
      .fn()
      .mockImplementation(async (_client: unknown, formula: DefinitionLike) => {
        order.push(`start-${formula.id}`);
        await Promise.resolve();
        order.push(`end-${formula.id}`);
        return [];
      });

    const refreshed = await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [defA, defB],
      now,
      state: idleState(),
      sweepAllRecords: true,
      recomputeAllRecordsFn,
    });

    // Not interleaved: def A's call fully completes before def B's starts.
    expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b']);
    expect(refreshed).toEqual(['a', 'b']);
  });

  it('skips the full sweep when sweepAllRecords is false but still fixes the viewed record', async () => {
    const recomputeForRecordFn = vi.fn().mockResolvedValue(undefined);
    const recomputeAllRecordsFn = vi.fn().mockResolvedValue([]);

    const refreshed = await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [def()],
      now,
      state: idleState(),
      recordId: 'rec-1',
      sweepAllRecords: false,
      recomputeForRecordFn,
      recomputeAllRecordsFn,
    });

    expect(recomputeForRecordFn).toHaveBeenCalledTimes(1);
    expect(recomputeAllRecordsFn).not.toHaveBeenCalled();
    expect(refreshed).toEqual(['def-1']);
  });

  it('threads shouldContinue through to the sweep', async () => {
    const shouldContinue = () => false;
    const recomputeAllRecordsFn = vi.fn().mockResolvedValue([]);

    await refreshStaleTodayFormulas({
      client: fakeClient,
      definitions: [def()],
      now,
      state: idleState(),
      sweepAllRecords: true,
      shouldContinue,
      recomputeAllRecordsFn,
    });

    expect(recomputeAllRecordsFn).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ id: 'def-1' }),
      { shouldContinue },
    );
  });

  it('throttles across two callers sharing the module-global state', async () => {
    __resetSharedRefreshStatesForTests();
    const recomputeAllRecordsFn = vi.fn().mockResolvedValue([]);
    const base = {
      client: fakeClient,
      definitions: [def()],
      state: sharedSweepRefreshState,
      sweepAllRecords: true,
      recomputeAllRecordsFn,
    };

    await refreshStaleTodayFormulas({ ...base, now });
    // A second "mount" 1s later — previously a fresh useRef, now shared state.
    await refreshStaleTodayFormulas({ ...base, now: now + 1_000 });

    expect(recomputeAllRecordsFn).toHaveBeenCalledTimes(1);
  });
});
