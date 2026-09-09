// One-time retro purge (spec F4, approved 2026-07-15): runs the ADR 0022
// cleanup with an unbounded lookback against a configured remote. Loops until
// a pass reports no truncation. Soft-delete only — same fail-safe classifier
// the cron uses.
//
// Usage: npx tsx scripts/retro-purge-timeline.ts <remoteName> [--dry-run] [--lookback-days N] [--yes]
// Reads apiUrl + apiKey for <remoteName> from ~/.twenty/config.json via the
// shared scripts/lib/remote-client.ts (same source the integration setup uses
// — src/__tests__/setup-test.ts). Writing requires the literal --yes flag.
import {
  createThrottledFetchTransport,
  loadRemote,
} from './lib/remote-client';

const USAGE =
  'Usage: npx tsx scripts/retro-purge-timeline.ts <remoteName> [--dry-run] [--lookback-days N] [--yes]';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 10 * 365 * DAY_MS;
const MAX_PAGES = 50;

type Arguments = {
  dryRun: boolean;
  confirmed: boolean;
  lookbackMs: number;
};

const parseArguments = (argv: string[]): Arguments => {
  let dryRun = false;
  let confirmed = false;
  let lookbackMs = DEFAULT_LOOKBACK_MS;

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
        console.error(`--lookback-days needs a positive number of days\n${USAGE}`);
        process.exit(1);
      }
      lookbackMs = days * DAY_MS;
      index += 1;
      continue;
    }
    // Never ignore an unrecognized argument: a mistyped --dry-run would
    // otherwise silently start writing.
    console.error(`Unknown argument "${argument}"\n${USAGE}`);
    process.exit(1);
  }

  return { dryRun, confirmed, lookbackMs };
};

const run = async () => {
  const { dryRun, confirmed, lookbackMs } = parseArguments(
    process.argv.slice(3),
  );
  const remote = loadRemote(process.argv[2], USAGE);

  // Announced before any request: which workspace is about to be swept must
  // never be a guess. Host only — the key is never printed.
  console.log(`remote:   ${remote.name} (${new URL(remote.apiUrl).host})`);
  console.log(
    `mode:     ${dryRun ? 'DRY RUN — no writes' : 'APPLY — soft-deletes and strips rows'}`,
  );
  console.log(
    `lookback: ${Math.round(lookbackMs / DAY_MS)} days, up to ${MAX_PAGES} pages per pass`,
  );

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
    createThrottledFetchTransport(remote),
  );

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
    return;
  }

  let pass = 0;
  for (;;) {
    pass += 1;
    const counts = await cleanupFormulaTimelineNoise(client, {
      lookbackMs,
      maxPages: MAX_PAGES,
    });
    console.log(`pass ${pass}:`, counts);
    // No-progress guard: KEPT rows (genuine human/third-party writes the
    // classifier correctly leaves alone) can outnumber maxPages * PAGE_SIZE
    // over a 10-year lookback, so every pass would re-scan the same kept rows,
    // delete/strip nothing, and still report truncated:true — looping forever.
    // Soft-delete-only makes that harmless but it never terminates, so also
    // stop once a pass makes no progress.
    if (!counts.truncated || counts.deleted + counts.stripped === 0) break;
  }
  console.log('Retro purge complete.');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
