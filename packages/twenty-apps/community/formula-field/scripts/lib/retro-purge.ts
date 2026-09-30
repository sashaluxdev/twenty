// Argument parsing and the wet-run pass loop of scripts/retro-purge-timeline.ts,
// split out so they are unit-testable: the script itself starts a run on
// import.
//
// The TimelineCleanupCounts import is TYPE-ONLY for the reason given in
// remote-client.ts: no app module may load before `loadRemote` has run.
import type { TimelineCleanupCounts } from '../../src/logic-functions/lib/timeline-cleanup';

import { MAX_REQUESTS_PER_WINDOW } from './remote-client';

export const RETRO_PURGE_USAGE =
  'Usage: npx tsx scripts/retro-purge-timeline.ts <remoteName> [--dry-run] [--lookback-days N] [--rate N] [--yes]';

export const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 10 * 365 * DAY_MS;
// Cloud allows 100 requests / 60s per API key; the metadata type-id lookup
// runs outside the throttled transport, so a --rate of 100 could trip it.
const MAX_REQUESTS_PER_MINUTE = 95;

export type RetroPurgeArguments = {
  dryRun: boolean;
  confirmed: boolean;
  lookbackMs: number;
  requestsPerMinute: number;
};

export const parseRetroPurgeArguments = (
  argv: string[],
): RetroPurgeArguments | { error: string } => {
  let dryRun = false;
  let confirmed = false;
  let lookbackMs = DEFAULT_LOOKBACK_MS;
  let requestsPerMinute = MAX_REQUESTS_PER_WINDOW;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--yes') {
      confirmed = true;
      continue;
    }
    if (argument === '--lookback-days') {
      const days = Number(argv[index + 1]);
      if (!Number.isFinite(days) || days <= 0) {
        return { error: '--lookback-days needs a positive number of days' };
      }
      lookbackMs = days * DAY_MS;
      index += 1;
      continue;
    }
    if (argument === '--rate') {
      const rate = Number(argv[index + 1]);
      if (
        !Number.isInteger(rate) ||
        rate < 1 ||
        rate > MAX_REQUESTS_PER_MINUTE
      ) {
        return {
          error: `--rate needs a whole number of requests per minute from 1 to ${MAX_REQUESTS_PER_MINUTE}`,
        };
      }
      requestsPerMinute = rate;
      index += 1;
      continue;
    }
    // Never ignore an unrecognized argument: a mistyped --dry-run would
    // otherwise silently start writing.
    return { error: `Unknown argument "${argument}"` };
  }

  return { dryRun, confirmed, lookbackMs, requestsPerMinute };
};

export type WetPurgeResult = {
  scannedNothing: boolean;
  // Summed over passes, so a row that failed and was retried by a later pass
  // counts once per failed attempt.
  failed: number;
};

// Runs passes until one reports no truncation or makes no progress.
export const runWetPurgePasses = async (
  runPass: () => Promise<TimelineCleanupCounts>,
): Promise<WetPurgeResult> => {
  let failed = 0;
  for (let pass = 1; ; pass += 1) {
    const counts = await runPass();
    console.log(`pass ${pass}:`, counts);
    if (pass === 1 && counts.scanned === 0) {
      return { scannedNothing: true, failed };
    }
    failed += counts.failed;
    // No-progress guard: KEPT rows (genuine human/third-party writes the
    // classifier correctly leaves alone) can outnumber maxPages * PAGE_SIZE
    // over a 10-year lookback, so every pass would re-scan the same kept rows,
    // delete/strip nothing, and still report truncated:true — looping forever.
    // Soft-delete-only makes that harmless but it never terminates, so also
    // stop once a pass makes no progress. A pass whose every write failed
    // stops here too, and the caller reports the failures.
    if (!counts.truncated || counts.deleted + counts.stripped === 0) {
      return { scannedNothing: false, failed };
    }
  }
};
