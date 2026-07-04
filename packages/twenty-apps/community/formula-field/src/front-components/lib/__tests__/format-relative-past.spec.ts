import { describe, expect, it } from 'vitest';

import {
  formatRelativePast,
  isStaleTimestamp,
  isStaleTodayFormula,
  STALE_AFTER_MS,
} from 'src/front-components/lib/format-relative-past';

// Fixed reference instant — every test derives its timestamp by subtracting an
// elapsed duration from this, so the assertions never depend on wall-clock time.
const NOW_MS = Date.parse('2026-07-04T12:00:00.000Z');

const isoMsAgo = (elapsedMs: number): string =>
  new Date(NOW_MS - elapsedMs).toISOString();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelativePast', () => {
  it('formats less than 30 seconds as "now"', () => {
    expect(formatRelativePast(isoMsAgo(29 * SECOND), NOW_MS)).toBe('now');
  });

  it('formats 45 seconds as "1 minute ago"', () => {
    expect(formatRelativePast(isoMsAgo(45 * SECOND), NOW_MS)).toBe(
      '1 minute ago',
    );
  });

  it('formats 5 minutes as "5 minutes ago"', () => {
    expect(formatRelativePast(isoMsAgo(5 * MINUTE), NOW_MS)).toBe(
      '5 minutes ago',
    );
  });

  it('formats 44 minutes as "44 minutes ago"', () => {
    expect(formatRelativePast(isoMsAgo(44 * MINUTE), NOW_MS)).toBe(
      '44 minutes ago',
    );
  });

  it('formats 50 minutes as "about 1 hour ago"', () => {
    expect(formatRelativePast(isoMsAgo(50 * MINUTE), NOW_MS)).toBe(
      'about 1 hour ago',
    );
  });

  it('formats 2.6 hours as "about 3 hours ago"', () => {
    expect(formatRelativePast(isoMsAgo(2.6 * HOUR), NOW_MS)).toBe(
      'about 3 hours ago',
    );
  });

  it('formats 26 hours as "1 day ago"', () => {
    expect(formatRelativePast(isoMsAgo(26 * HOUR), NOW_MS)).toBe('1 day ago');
  });

  it('formats 3 days as "3 days ago"', () => {
    expect(formatRelativePast(isoMsAgo(3 * DAY), NOW_MS)).toBe('3 days ago');
  });

  it('formats 40 days as "about 1 month ago"', () => {
    expect(formatRelativePast(isoMsAgo(40 * DAY), NOW_MS)).toBe(
      'about 1 month ago',
    );
  });
});

describe('isStaleTimestamp', () => {
  it('returns true past the 2.5h threshold', () => {
    expect(isStaleTimestamp(isoMsAgo(3 * HOUR), NOW_MS)).toBe(true);
  });

  it('returns false within the threshold', () => {
    expect(isStaleTimestamp(isoMsAgo(2 * HOUR), NOW_MS)).toBe(false);
  });

  it('returns false for a null timestamp', () => {
    expect(isStaleTimestamp(null, NOW_MS)).toBe(false);
  });

  it('returns false for an unparseable timestamp', () => {
    expect(isStaleTimestamp('not-a-date', NOW_MS)).toBe(false);
  });
});

describe('isStaleTodayFormula', () => {
  const baseDefinition = {
    enabled: true,
    expression: 'TODAY()',
    lastEvaluatedAt: null as string | null,
  };

  it('returns true for a TODAY() formula last evaluated 3 hours ago', () => {
    expect(
      isStaleTodayFormula(
        { ...baseDefinition, lastEvaluatedAt: isoMsAgo(3 * HOUR) },
        NOW_MS,
      ),
    ).toBe(true);
  });

  it('returns false for a TODAY() formula last evaluated 1 hour ago', () => {
    expect(
      isStaleTodayFormula(
        { ...baseDefinition, lastEvaluatedAt: isoMsAgo(1 * HOUR) },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('returns false for a non-TODAY() formula even 3 hours old', () => {
    expect(
      isStaleTodayFormula(
        {
          ...baseDefinition,
          expression: 'amount + 1',
          lastEvaluatedAt: isoMsAgo(3 * HOUR),
        },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('returns false when the formula is disabled', () => {
    expect(
      isStaleTodayFormula(
        {
          ...baseDefinition,
          enabled: false,
          lastEvaluatedAt: isoMsAgo(3 * HOUR),
        },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('returns false when lastEvaluatedAt is null', () => {
    expect(
      isStaleTodayFormula({ ...baseDefinition, lastEvaluatedAt: null }, NOW_MS),
    ).toBe(false);
  });

  it('returns false when the expression fails to parse', () => {
    expect(
      isStaleTodayFormula(
        {
          ...baseDefinition,
          expression: 'amount +',
          lastEvaluatedAt: isoMsAgo(3 * HOUR),
        },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('exports the 2.5h threshold constant', () => {
    expect(STALE_AFTER_MS).toBe(2.5 * 60 * 60 * 1000);
  });
});
