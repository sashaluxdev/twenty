// One-time retro purge (spec F4, approved 2026-07-15): runs the ADR 0022
// cleanup with an unbounded lookback against a configured remote. Loops until
// a pass reports no truncation. Soft-delete only — same fail-safe classifier
// the cron uses.
//
// Usage: npx tsx scripts/retro-purge-timeline.ts <remoteName> [--dry-run] [--lookback-days N] [--rate N] [--yes]
// Reads apiUrl + apiKey for <remoteName> from ~/.twenty/config.json via the
// shared scripts/lib/remote-client.ts (same source the integration setup uses
// — src/__tests__/setup-test.ts). Writing requires the literal --yes flag.
// --rate caps requests per minute through the throttled transport (1-95,
// default 90).
// Exit codes: 1 bad/unrecognized arguments, 2 wet mode (no --dry-run) without
// --yes, 3 a pass scanned 0 rows (nothing to purge, or the candidate filter
// couldn't see anything -- see the printed warning above for which), 4 at
// least one delete/strip mutation failed after its retries (those rows are
// still live; re-running is safe and retries them).
import {
  DAY_MS,
  RETRO_PURGE_USAGE,
  parseRetroPurgeArguments,
  runWetPurgePasses,
} from './lib/retro-purge';
import {
  createThrottledFetchTransport,
  loadRemote,
} from './lib/remote-client';

const MAX_PAGES = 50;

const run = async () => {
  const parsedArguments = parseRetroPurgeArguments(process.argv.slice(3));
  if ('error' in parsedArguments) {
    console.error(`${parsedArguments.error}\n${RETRO_PURGE_USAGE}`);
    process.exit(1);
  }
  const { dryRun, confirmed, lookbackMs, requestsPerMinute } = parsedArguments;
  const remote = loadRemote(process.argv[2], RETRO_PURGE_USAGE);

  // Announced before any request: which workspace is about to be swept must
  // never be a guess. Host only — the key is never printed.
  console.log(`remote:   ${remote.name} (${new URL(remote.apiUrl).host})`);
  console.log(
    `mode:     ${dryRun ? 'DRY RUN — no writes' : 'APPLY — soft-deletes and strips rows'}`,
  );
  console.log(
    `lookback: ${Math.round(lookbackMs / DAY_MS)} days, up to ${MAX_PAGES} pages per pass`,
  );
  console.log(`rate:     ${requestsPerMinute} requests per minute`);

  if (!dryRun && !confirmed) {
    console.error(
      '\nRefusing to write without --yes. Preview with --dry-run, then re-run with --yes to apply.',
    );
    process.exit(2);
  }

  // Imported AFTER loadRemote so client construction sees the remote — and so
  // twenty-client-sdk/metadata bakes the right URL at module load.
  const { createDynamicCoreClient } = await import(
    '../src/logic-functions/lib/dynamic-client'
  );
  const { cleanupFormulaTimelineNoise } = await import(
    '../src/logic-functions/lib/timeline-cleanup'
  );
  const client = createDynamicCoreClient(
    createThrottledFetchTransport(remote, {
      maxRequestsPerWindow: requestsPerMinute,
    }),
  );

  // A first pass that scans nothing is worth calling out loudly rather than
  // exiting 0 like a completed purge: it means either the candidate filter
  // could not resolve (the resolver's own warning fires above this), or the
  // lookback genuinely holds no candidate rows -- either way, nothing to
  // purge, and that fact should not look identical to "purge done".
  const reportScannedNothing = (): never => {
    console.log(
      'first pass scanned 0 rows: nothing was purged; see the warning above ' +
        '(no formula definitions or variation configs, type id unresolved, or no candidate rows in the lookback).',
    );
    process.exit(3);
  };

  if (dryRun) {
    const counts = await cleanupFormulaTimelineNoise(client, {
      lookbackMs,
      maxPages: MAX_PAGES,
      dryRun: true,
    });
    console.log('\nwould apply:', counts);
    if (counts.truncated) {
      console.log(
        `\nMore rows remain beyond the ${MAX_PAGES}-page cap. A dry run cannot page past it: ` +
          'nothing is deleted, so every further pass would re-scan these same rows. ' +
          'Re-run with --yes to apply, then dry-run again to see what is left.',
      );
    }
    if (counts.scanned === 0) {
      reportScannedNothing();
    }
    return;
  }

  const { scannedNothing, failed } = await runWetPurgePasses(() =>
    cleanupFormulaTimelineNoise(client, {
      lookbackMs,
      maxPages: MAX_PAGES,
    }),
  );
  if (scannedNothing) {
    reportScannedNothing();
  }
  if (failed > 0) {
    console.error(
      `\n${failed} delete/strip mutation(s) failed after their retries; those rows are still live. ` +
        'Re-run the same command to retry them: the purge is soft-delete-only and restartable.',
    );
    process.exit(4);
  }
  console.log('Retro purge complete.');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
