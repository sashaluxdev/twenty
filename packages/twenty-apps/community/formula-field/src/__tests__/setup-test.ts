import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll } from 'vitest';

import { resolveTestRemote } from 'src/__tests__/resolve-test-remote';

// Integration-test setup. Resolves the server from TWENTY_API_URL +
// TWENTY_API_KEY (both set), else from the defaultRemote in
// ~/.twenty/config.json, and refuses any non-loopback host (see
// resolve-test-remote.ts). It then verifies the server is reachable, exposes
// the URL + API key to the SDK clients via env vars, and writes
// config.test.json so the CLI operations (appBuild/appDeploy/appInstall) can
// run in test mode without disturbing the developer's default config.

const CONFIG_DIR = path.join(os.homedir(), '.twenty');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TEST_CONFIG_PATH = path.join(CONFIG_DIR, 'config.test.json');

// Resolved at module load rather than in beforeAll: setup files load before
// the test file's own imports, so a refusal lands before any network call,
// env mutation or config.test.json write.
const { apiUrl, apiKey } = resolveTestRemote({
  env: process.env,
  configPath: CONFIG_PATH,
});

beforeAll(async () => {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/healthz`);
  } catch {
    throw new Error(
      `Twenty server is not reachable at ${apiUrl}. Start it before running ` +
        'the integration tests.',
    );
  }
  if (!response.ok) {
    throw new Error(`Server at ${apiUrl} returned ${response.status}`);
  }

  // SDK clients (CoreApiClient / MetadataApiClient) read these env vars.
  process.env.TWENTY_API_URL = apiUrl;
  process.env.TWENTY_API_KEY = apiKey;
  process.env.TWENTY_APP_ACCESS_TOKEN ??= apiKey;

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    TEST_CONFIG_PATH,
    JSON.stringify(
      {
        version: 1,
        defaultRemote: 'local',
        remotes: { local: { apiUrl, apiKey } },
      },
      null,
      2,
    ),
  );
});
