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
// SDK clients (CoreApiClient, via createDynamicCoreClient) read these env vars
// — same bridge as setup-test.ts / the deployed logic function's runtime.
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
