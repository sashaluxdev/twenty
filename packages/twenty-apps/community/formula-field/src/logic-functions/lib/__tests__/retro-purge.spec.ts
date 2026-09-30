import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TimelineCleanupCounts } from 'src/logic-functions/lib/timeline-cleanup';

import {
  parseRetroPurgeArguments,
  runWetPurgePasses,
} from '../../../../scripts/lib/retro-purge';

// Lives here for the same reason as remote-client-transport.spec.ts: vitest's
// unit `include` only covers src/**/*.spec.ts.

const DAY_MS = 24 * 60 * 60 * 1000;

const passCounts = (
  overrides: Partial<TimelineCleanupCounts> = {},
): TimelineCleanupCounts => ({
  scanned: 100,
  deleted: 0,
  stripped: 0,
  kept: 0,
  failed: 0,
  truncated: false,
  ...overrides,
});

describe('parseRetroPurgeArguments', () => {
  it('defaults to a wet, unconfirmed, 10-year run at 90 requests per minute', () => {
    expect(parseRetroPurgeArguments([])).toEqual({
      dryRun: false,
      confirmed: false,
      lookbackMs: 10 * 365 * DAY_MS,
      requestsPerMinute: 90,
    });
  });

  it('reads --rate alongside the other flags', () => {
    expect(
      parseRetroPurgeArguments([
        '--rate',
        '30',
        '--yes',
        '--lookback-days',
        '7',
      ]),
    ).toEqual({
      dryRun: false,
      confirmed: true,
      lookbackMs: 7 * DAY_MS,
      requestsPerMinute: 30,
    });
  });

  it.each(['1', '95'])('accepts the boundary rate %s', (rate) => {
    expect(parseRetroPurgeArguments(['--rate', rate])).toMatchObject({
      requestsPerMinute: Number(rate),
    });
  });

  it.each(['0', '96', '-5', '30.5', 'abc', '--yes'])(
    'rejects --rate %s',
    (rate) => {
      expect(parseRetroPurgeArguments(['--rate', rate])).toEqual({
        error: expect.stringContaining('--rate'),
      });
    },
  );

  it('rejects --rate with no value', () => {
    expect(parseRetroPurgeArguments(['--rate'])).toEqual({
      error: expect.stringContaining('--rate'),
    });
  });

  it('still rejects an unrecognized argument', () => {
    expect(parseRetroPurgeArguments(['--dryrun'])).toEqual({
      error: expect.stringContaining('--dryrun'),
    });
  });
});

describe('runWetPurgePasses', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sums failed mutations across passes while passes keep making progress', async () => {
    const runPass = vi
      .fn<() => Promise<TimelineCleanupCounts>>()
      .mockResolvedValueOnce(
        passCounts({ deleted: 60, failed: 2, truncated: true }),
      )
      .mockResolvedValueOnce(passCounts({ deleted: 5, failed: 1 }));

    await expect(runWetPurgePasses(runPass)).resolves.toEqual({
      scannedNothing: false,
      failed: 3,
    });
    expect(runPass).toHaveBeenCalledTimes(2);
  });

  it('stops on a pass whose every write failed, reporting those failures', async () => {
    const runPass = vi
      .fn<() => Promise<TimelineCleanupCounts>>()
      .mockResolvedValue(passCounts({ failed: 100, truncated: true }));

    await expect(runWetPurgePasses(runPass)).resolves.toEqual({
      scannedNothing: false,
      failed: 100,
    });
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it('reports a first pass that scanned nothing without running another', async () => {
    const runPass = vi
      .fn<() => Promise<TimelineCleanupCounts>>()
      .mockResolvedValue(passCounts({ scanned: 0 }));

    await expect(runWetPurgePasses(runPass)).resolves.toEqual({
      scannedNothing: true,
      failed: 0,
    });
    expect(runPass).toHaveBeenCalledTimes(1);
  });
});
