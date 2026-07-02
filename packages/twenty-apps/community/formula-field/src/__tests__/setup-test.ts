import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll } from 'vitest';

// Integration-test setup. Reads the configured local remote from
// ~/.twenty/config.json (written by `twenty remote:add` or manually — see the
// README runbook), verifies the server is reachable, and exposes the URL + API
// key to the SDK clients via env vars. It also writes config.test.json so the
// CLI operations (appBuild/appDeploy/appInstall) can run in test mode without
// disturbing the developer's default config.

const CONFIG_DIR = path.join(os.homedir(), '.twenty');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TEST_CONFIG_PATH = path.join(CONFIG_DIR, 'config.test.json');

beforeAll(async () => {
  let apiUrl = process.env.TWENTY_API_URL;
  let apiKey = process.env.TWENTY_API_KEY;

  // Fall back to the default remote in config.json when env vars are unset.
  if ((!apiUrl || !apiKey) && fs.existsSync(CONFIG_PATH)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const remote = config.remotes?.[config.defaultRemote ?? 'local'];
    apiUrl = apiUrl || remote?.apiUrl;
    apiKey = apiKey || remote?.apiKey;
  }

  if (!apiUrl || !apiKey) {
    throw new Error(
      'TWENTY_API_URL and TWENTY_API_KEY must be set (or a local remote must ' +
        'exist in ~/.twenty/config.json). See the README runbook.',
    );
  }

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
