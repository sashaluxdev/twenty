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

// Answers each call with the next response in order, repeating the last one.
const stubFetchSequence = (
  responses: Array<{ status: number; body: string }>,
): ReturnType<typeof vi.fn> => {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { status: response.status, text: async () => response.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const send = (transport: Transport) =>
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
    // A real (non-fake) timer window: 500ms gives a wide margin over any
    // event-loop stall between sends, so an occasional scheduling delay can
    // never prune the window early and flake the >= assertion below.
    const transport = createThrottledFetchTransport(REMOTE, {
      windowMs: 500,
      maxRequestsPerWindow: 2,
    });

    await send(transport);
    await send(transport);
    const thirdStart = Date.now();
    await send(transport);
    // The third send has no slot until the oldest of the first two ages out.
    expect(Date.now() - thirdStart).toBeGreaterThanOrEqual(500);

    // Those two are now outside the window, so the next send is free again —
    // proof the timestamps are pruned rather than only appended to.
    const fourthStart = Date.now();
    await send(transport);
    expect(Date.now() - fourthStart).toBeLessThan(500);
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

  // Cloud's API speed limit answers at HTTP 200 with this errors[] message
  // (usage-limit-speed.service.ts); the legacy throttler says "Limit reached".
  it.each([
    'Rate limit exceeded for apiKey: 100 requests per 60s.',
    'RATE LIMIT EXCEEDED for application: 500 requests per 60s.',
    'limit reached (100 tokens per 60000 ms)',
  ])('backs off on "%s" until the limit clears', async (message) => {
    const fetchMock = stubFetchSequence([
      {
        status: 200,
        body: JSON.stringify({
          data: { deleteTimelineActivity: null },
          errors: [{ message, extensions: { code: 'RATE_LIMITED' } }],
        }),
      },
      { status: 200, body: JSON.stringify({ data: { ok: true } }) },
    ]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = createThrottledFetchTransport(REMOTE, {
      rateLimitBackoffMs: 1,
    });

    const payload = await send(transport);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payload).toEqual({ data: { ok: true } });
  });

  it.each([
    ['an HTML page', '<html><body>429 Too Many Requests</body></html>'],
    [
      'a JSON body with no errors[]',
      JSON.stringify({ statusCode: 429, message: 'Too Many Requests' }),
    ],
  ])(
    'backs off on HTTP 429 with %s, then hands back a GraphQL error rather than an empty answer',
    async (_description, body) => {
      const fetchMock = stubFetchSequence([{ status: 429, body }]);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const transport = createThrottledFetchTransport(REMOTE, {
        rateLimitBackoffMs: 1,
        maxRateLimitRetries: 2,
      });

      const payload = await send(transport);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      // An errors[] is what makes `execute` throw; a payload without one would
      // read as a successful mutation.
      expect(payload.errors?.[0]?.message).toContain('HTTP 429');
    },
  );

  it.each([
    'Usage limit reached for apiKey',
    'record limit reached for this workspace',
  ])(
    'does not wait out "%s", which no 60s backoff can clear',
    async (message) => {
      const fetchMock = stubFetch({ errors: [{ message }] });

      const payload = await send(
        createThrottledFetchTransport(REMOTE, { rateLimitBackoffMs: 1 }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(payload).toEqual({ errors: [{ message }] });
    },
  );

  it('throws on a valid-JSON body that is not a GraphQL response object', async () => {
    // Coercing this to `{}` would surface as a run that scanned 0 rows and
    // exited 0.
    stubFetch([{ data: null }]);

    await expect(send(createThrottledFetchTransport(REMOTE))).rejects.toThrow(
      'HTTP 200',
    );
  });
});
