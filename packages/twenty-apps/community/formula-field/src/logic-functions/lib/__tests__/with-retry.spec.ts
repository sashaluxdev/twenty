import { describe, expect, it, vi } from 'vitest';

import { withRetry } from 'src/logic-functions/lib/with-retry';

const noSleep = async () => {};

// Real platform shape: code is always BAD_USER_INPUT, signal lives in subCode.
const limitReachedError = () =>
  Object.assign(new Error('limit'), {
    errors: [
      { extensions: { code: 'BAD_USER_INPUT', subCode: 'LIMIT_REACHED' } },
    ],
  });

describe('withRetry', () => {
  it('retries when the retryable signal is in subCode', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(limitReachedError())
      .mockResolvedValueOnce('ok');

    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable graphql errors', async () => {
    const operation = vi.fn().mockRejectedValue(
      Object.assign(new Error('nope'), {
        errors: [
          { extensions: { code: 'BAD_USER_INPUT', subCode: 'INVALID_INPUT' } },
        ],
      }),
    );

    await expect(withRetry(operation, { sleep: noSleep })).rejects.toThrow(
      'nope',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts', async () => {
    const operation = vi.fn().mockRejectedValue(limitReachedError());

    await expect(
      withRetry(operation, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toThrow('limit');
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
