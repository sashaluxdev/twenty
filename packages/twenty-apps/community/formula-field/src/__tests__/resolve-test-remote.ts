import * as fs from 'fs';

// Resolves the server the integration suite runs against and refuses anything
// but a loopback host: the suite installs, mutates and uninstalls the app, and
// the developer's config.json defaultRemote can be a production workspace.
// Pure apart from reading configPath, so the guard is unit-testable.

export type TestRemote = { apiUrl: string; apiKey: string; source: string };

const LOCAL_SERVER_HINT =
  'To test against a local server, export both TWENTY_API_URL (a localhost ' +
  'URL, e.g. http://localhost:3000) and TWENTY_API_KEY.';

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// URL.hostname is already lowercased, IPv4-normalized (127.1 -> 127.0.0.1)
// and bracketed for IPv6 ([::1]).
const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  IPV4_LOOPBACK.test(hostname) ||
  hostname === '[::1]';

const readConfigRemote = (configPath: string): TestRemote => {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `TWENTY_API_URL and TWENTY_API_KEY are not both set, and ${configPath} ` +
        `does not exist. ${LOCAL_SERVER_HINT}`,
    );
  }

  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // Never the SyntaxError's message: V8 quotes the text around the bad
    // token, which in this file can be a fragment of an API key.
    throw new Error(`${configPath} is not valid JSON. ${LOCAL_SERVER_HINT}`);
  }

  const remoteName =
    isRecord(config) && typeof config.defaultRemote === 'string'
      ? config.defaultRemote
      : 'local';
  const remotes =
    isRecord(config) && isRecord(config.remotes) ? config.remotes : {};
  const entry = remotes[remoteName];
  const apiUrl = isRecord(entry) ? nonEmptyString(entry.apiUrl) : null;
  const apiKey = isRecord(entry) ? nonEmptyString(entry.apiKey) : null;
  const source = `${configPath} remote "${remoteName}"`;

  if (apiUrl === null || apiKey === null) {
    throw new Error(
      `TWENTY_API_URL and TWENTY_API_KEY are not both set, and ${source} ` +
        `lacks an apiUrl or apiKey. ${LOCAL_SERVER_HINT}`,
    );
  }

  return { apiUrl, apiKey, source };
};

export const resolveTestRemote = ({
  env,
  configPath,
}: {
  env: Record<string, string | undefined>;
  configPath: string;
}): TestRemote => {
  const envApiUrl = nonEmptyString(env.TWENTY_API_URL);
  const envApiKey = nonEmptyString(env.TWENTY_API_KEY);

  // Half an env pair is ignored rather than completed from config.json, so a
  // localhost URL can never be paired with a cloud remote's key.
  const remote =
    envApiUrl !== null && envApiKey !== null
      ? {
          apiUrl: envApiUrl,
          apiKey: envApiKey,
          source: 'env TWENTY_API_URL/TWENTY_API_KEY',
        }
      : readConfigRemote(configPath);

  let url: URL | null = null;
  try {
    url = new URL(remote.apiUrl);
  } catch {
    url = null;
  }

  // The raw URL is not echoed: a malformed value may be a misplaced key.
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(
      `Refusing to run integration tests: the apiUrl from ${remote.source} ` +
        `is not a valid http(s) URL. ${LOCAL_SERVER_HINT}`,
    );
  }

  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(
      `Refusing to run integration tests against non-local host ` +
        `"${url.hostname}" (apiUrl from ${remote.source}). The suite ` +
        `installs, mutates and uninstalls the app, so it only runs against ` +
        `localhost, *.localhost, 127.x.x.x or [::1]. ${LOCAL_SERVER_HINT}`,
    );
  }

  return remote;
};
