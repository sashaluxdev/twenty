// Every CoreApiClient call goes through this wrapper. The Twenty GraphQL API
// returns errors at HTTP 200 in an `errors[]` body; the genql client surfaces
// that as a thrown error carrying `.errors[]`. Rate limiting (~100 req / 60s)
// arrives as `LIMIT_REACHED`. We retry those (and generic network blips) with
// bounded exponential backoff; everything else is rethrown immediately so real
// bugs surface fast.
//
// Note: this file lives under logic-functions/ so it must NOT import
// twenty-shared (oxlint rule). We duck-type the error shape instead of
// importing the client's error class.

const RETRYABLE_CODES = new Set([
  'LIMIT_REACHED',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
]);

type GraphqlLikeError = {
  errors?: Array<{ extensions?: { code?: string; subCode?: string } }>;
  message?: string;
};

export const isRetryable = (error: unknown): boolean => {
  const candidate = error as GraphqlLikeError;

  if (Array.isArray(candidate?.errors)) {
    for (const graphqlError of candidate.errors) {
      // The platform wraps throttle errors as code BAD_USER_INPUT with the
      // real signal in subCode — check BOTH, not code-with-subCode-fallback
      // (code is always set, so `code ?? subCode` never reached subCode).
      const { code, subCode } = graphqlError?.extensions ?? {};
      if (code && RETRYABLE_CODES.has(code)) {
        return true;
      }
      if (subCode && RETRYABLE_CODES.has(subCode)) {
        return true;
      }
    }
    return false;
  }

  // Network-level failure (fetch threw, connection reset) — worth a retry.
  const message = candidate?.message ?? '';
  return /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(message);
};

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  // Injectable sleep so tests don't wait on real timers.
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !isRetryable(error)) {
        throw error;
      }

      // Exponential backoff: 500ms, 1s, 2s, ... (deterministic; no jitter so
      // behaviour is reproducible in tests).
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
};
