// Shared script preamble: resolve a remote from ~/.twenty/config.json, bridge
// it into the env vars the SDK clients read, and build a throttled raw
// /graphql transport for `createDynamicCoreClient`.
//
// The generated CoreApiClient only exists once `twenty dev` / `app:install`
// has run for the active remote, so a bare `createDynamicCoreClient()` in a
// local script throws "CoreApiClient was not generated". Scripts inject the
// transport below instead.
//
// The RawGraphqlTransport import is TYPE-ONLY on purpose: this module must not
// pull any app module (nor the SDK) into the process before `loadRemote` has
// set TWENTY_API_URL — `twenty-client-sdk/metadata` bakes its URL from that env
// var at module load.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { RawGraphqlTransport } from '../../src/logic-functions/lib/dynamic-client';

export type Remote = { name: string; apiUrl: string; apiKey: string };

const CONFIG_PATH = path.join(os.homedir(), '.twenty', 'config.json');

// Cloud rate-limits at 100 requests / 60s and answers a breach with a GraphQL
// error whose message starts "Limit reached". 90 leaves headroom for the
// requests this process makes outside the window (the single MetadataApiClient
// type-id lookup) and for a clock that disagrees with the server's.
const MAX_REQUESTS_PER_WINDOW = 90;
const WINDOW_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 5;

type GraphqlPayload = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message?: string }>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const readConfig = (): unknown => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as unknown;
  } catch (error) {
    // Only the reason is printed, never anything read from the file: it holds
    // API keys for every configured remote.
    console.error(
      `Could not read ${CONFIG_PATH}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    process.exit(1);
  }
};

// Resolves <remoteName> and bridges its credentials into the env vars the SDK
// clients read — same bridge as setup-test.ts / the deployed logic function's
// runtime. Callers must import app modules only AFTER this returns.
export const loadRemote = (remoteName: string, usage: string): Remote => {
  if (nonEmptyString(remoteName) === null || remoteName.startsWith('--')) {
    console.error(usage);
    process.exit(1);
  }

  const config = readConfig();
  const remotes = isPlainObject(config) && isPlainObject(config.remotes)
    ? config.remotes
    : {};
  const entry = remotes[remoteName];
  const apiUrl = isPlainObject(entry) ? nonEmptyString(entry.apiUrl) : null;
  const apiKey = isPlainObject(entry) ? nonEmptyString(entry.apiKey) : null;
  if (apiUrl === null || apiKey === null) {
    console.error(
      `Remote "${remoteName}" with apiUrl+apiKey not found in ~/.twenty/config.json`,
    );
    process.exit(1);
  }

  process.env.TWENTY_API_URL = apiUrl;
  process.env.TWENTY_API_KEY = apiKey;
  process.env.TWENTY_APP_ACCESS_TOKEN ??= apiKey;

  return { name: remoteName, apiUrl, apiKey };
};

const isRateLimited = (payload: GraphqlPayload): boolean =>
  (payload.errors ?? []).some((error) =>
    (error?.message ?? '').startsWith('Limit reached'),
  );

// Token-authed raw /graphql transport with the rate-limit protection the rest
// of the stack does not provide: `execute` (dynamic-client.ts) collapses a
// GraphQL errors[] into a plain `Error(message)`, and `withRetry` only retries
// on `extensions.code`/`subCode` or network-error message regexes — so a
// "Limit reached" error never looks retryable to it. This transport is the only
// place a purge is held back from tripping the limit.
export const createThrottledFetchTransport = (
  remote: Remote,
  options: {
    maxRequestsPerWindow?: number;
    windowMs?: number;
    rateLimitBackoffMs?: number;
    maxRateLimitRetries?: number;
  } = {},
): RawGraphqlTransport => {
  const maxRequestsPerWindow =
    options.maxRequestsPerWindow ?? MAX_REQUESTS_PER_WINDOW;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const rateLimitBackoffMs = options.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS;
  const maxRateLimitRetries =
    options.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;

  const endpoint = `${remote.apiUrl.replace(/\/+$/, '')}/graphql`;
  // Send timestamps of the current sliding window, oldest first.
  const sentAt: number[] = [];

  const takeSlot = async (): Promise<void> => {
    for (;;) {
      const now = Date.now();
      while (sentAt.length > 0 && now - sentAt[0] >= windowMs) {
        sentAt.shift();
      }
      if (sentAt.length < maxRequestsPerWindow) {
        sentAt.push(now);
        return;
      }
      // Wait out the oldest send, plus a small margin so the slot is genuinely
      // free when the loop re-checks.
      await sleep(windowMs - (now - sentAt[0]) + 100);
    }
  };

  const post = async (operation: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<GraphqlPayload> => {
    await takeSlot();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${remote.apiKey}`,
      },
      body: JSON.stringify({
        query: operation.query,
        variables: operation.variables ?? {},
      }),
    });
    const body = await response.text();
    try {
      const parsed: unknown = JSON.parse(body);
      return isPlainObject(parsed) ? (parsed as GraphqlPayload) : {};
    } catch {
      // Not a GraphQL answer at all (proxy error page, gateway timeout): the
      // status plus a short excerpt is enough to diagnose without dumping a
      // whole HTML page into the log.
      throw new Error(
        `HTTP ${response.status} from ${endpoint}: ${body.slice(0, 200)}`,
      );
    }
  };

  return {
    executeGraphqlRequestWithOptionalRefresh: async ({ operation }) => {
      let payload = await post(operation);
      for (
        let retry = 1;
        retry <= maxRateLimitRetries && isRateLimited(payload);
        retry += 1
      ) {
        console.warn(
          `[retro] rate limited; waiting ${Math.round(
            rateLimitBackoffMs / 1000,
          )}s (retry ${retry}/${maxRateLimitRetries})`,
        );
        await sleep(rateLimitBackoffMs);
        payload = await post(operation);
      }
      // Still limited after the last retry: hand the response back unchanged so
      // the caller's own error handling (a thrown Error, a kept row) applies.
      return payload;
    },
  };
};
