import { afterEach, describe, expect, it, vi } from 'vitest';

import { createThrottledFetchTransport } from '../../../../scripts/lib/remote-client';

// The transport under test lives in scripts/, which vitest's unit `include`
// (src/**/*.spec.ts) does not cover — hence the spec's home here. It is the
// only rate-limit protection in the retro-purge stack (dynamic-client's
// `execute` collapses a GraphQL errors[] into a plain Error, so `withRetry`
// never recognizes a limit), so its window arithmetic is worth pinning.
type Transport = ReturnType<typeof createThrottledFetchTransport>;

const REMOTE = {
  name: 'test',
  apiUrl: 'https://example.invalid',
  apiKey: 'test-key',
};

// Minimal stand-in for the parts of Response the transport reads.
const stubFetch = (payload: unknown): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const send = (transport: Transport): Promise<unknown> =>
  transport.executeGraphqlRequestWithOptionalRefresh({
    operation: { query: '{ __typename }' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createThrottledFetchTransport', () => {
  it('caps sends per window and prunes the window as it ages', async () => {
    const fetchMock = stubFetch({ data: { ok: true } });
    const transport = createThrottledFetchTransport(REMOTE, {
      windowMs: 50,
      maxRequestsPerWindow: 2,
    });

    await send(transport);
    await send(transport);
    const thirdStart = Date.now();
    await send(transport);
    // The third send has no slot until the oldest of the first two ages out.
    expect(Date.now() - thirdStart).toBeGreaterThanOrEqual(50);

    // Those two are now outside the window, so the next send is free again —
    // proof the timestamps are pruned rather than only appended to.
    const fourthStart = Date.now();
    await send(transport);
    expect(Date.now() - fourthStart).toBeLessThan(50);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries a "Limit reached" payload up to the cap, then returns it as-is', async () => {
    const limited = { errors: [{ message: 'Limit reached. Try again later.' }] };
    const fetchMock = stubFetch(limited);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = createThrottledFetchTransport(REMOTE, {
      rateLimitBackoffMs: 1,
      maxRateLimitRetries: 2,
    });

    const payload = await send(transport);

    // One attempt plus the two allowed retries, then the payload is handed back
    // so the caller's own error handling applies.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(payload).toEqual(limited);
  });

  it('throws on a valid-JSON body that is not a GraphQL response object', async () => {
    // Coercing this to `{}` would surface as a run that scanned 0 rows and
    // exited 0.
    stubFetch([{ data: null }]);

    await expect(send(createThrottledFetchTransport(REMOTE))).rejects.toThrow(
      'HTTP 200',
    );
  });
});
