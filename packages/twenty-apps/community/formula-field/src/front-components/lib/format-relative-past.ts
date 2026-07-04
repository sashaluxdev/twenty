import { parse, usesToday } from 'src/engine';

// TODAY()-dependent values only refresh on record events or the hourly sweep
// (ADR 0012). If the worker/sweep dies, `lastEvaluatedAt` stops advancing —
// this is the widget-side threshold past which that silence is treated as
// staleness rather than "legitimately unchanged" (ADR 0015). Two missed
// hourly sweeps, scaled up from core's 30min sync-staleness convention (which
// assumes a minutes-cadence pipeline, not our hourly one).
export const STALE_AFTER_MS = 2.5 * 60 * 60 * 1000;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

const pluralize = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? '' : 's'}`;

// Replicates core's `beautifyPastDateRelativeToNow` idiom (date-fns
// formatDistanceToNow with addSuffix + includeSeconds) as a small, dependency-
// free formatter — the sandbox cannot import twenty-front (ADR 0015).
export const formatRelativePast = (
  isoTimestamp: string,
  nowMs: number,
): string => {
  const thenMs = Date.parse(isoTimestamp);
  // An unparseable timestamp must not crash the widget — treat it as "just
  // now" rather than propagating NaN through the bucket math below.
  const elapsedMs = Number.isFinite(thenMs) ? Math.max(0, nowMs - thenMs) : 0;
  const seconds = elapsedMs / 1000;

  if (seconds < 30) return 'now';
  if (elapsedMs < 90 * SECOND_MS) return '1 minute ago';
  if (elapsedMs < 45 * MINUTE_MS) {
    return `${pluralize(Math.round(elapsedMs / MINUTE_MS), 'minute')} ago`;
  }
  if (elapsedMs < DAY_MS) {
    return `about ${pluralize(Math.round(elapsedMs / HOUR_MS), 'hour')} ago`;
  }
  if (elapsedMs < 30 * DAY_MS) {
    return `${pluralize(Math.round(elapsedMs / DAY_MS), 'day')} ago`;
  }
  return `about ${pluralize(Math.round(elapsedMs / MONTH_MS), 'month')} ago`;
};

export type StalenessCheckDefinition = {
  enabled: boolean;
  expression: string;
  lastEvaluatedAt: string | null;
};

// Pure timestamp-age half of the staleness rule, split out so callers that
// have already resolved the TODAY() dependency (e.g. the widget memoizes a
// usesTodayFlag per definition to avoid re-parsing on every poll/render) can
// check age alone. Null/unparseable timestamps are never "stale" — there is
// no evaluation on record to have aged.
export const isStaleTimestamp = (
  lastEvaluatedAt: string | null,
  nowMs: number,
): boolean => {
  if (!lastEvaluatedAt) return false;
  const lastEvaluatedAtMs = Date.parse(lastEvaluatedAt);
  if (!Number.isFinite(lastEvaluatedAtMs)) return false;
  return nowMs - lastEvaluatedAtMs > STALE_AFTER_MS;
};

// Staleness is scoped to TODAY-using formulas only (ADR 0015): lastEvaluatedAt
// is written only when a value CHANGES (M3 write-avoidance), so on its own it
// means "last change", not "last evaluation" — a healthy formula whose value
// legitimately never changes would false-positive. Parse failures and
// disabled/timestamp-less definitions are never "stale" — there is nothing to
// self-heal from the widget in either case.
export const isStaleTodayFormula = (
  definition: StalenessCheckDefinition,
  nowMs: number,
): boolean => {
  if (!definition.enabled) return false;

  let expressionUsesToday: boolean;
  try {
    expressionUsesToday = usesToday(parse(definition.expression));
  } catch {
    return false;
  }
  if (!expressionUsesToday) return false;

  return isStaleTimestamp(definition.lastEvaluatedAt, nowMs);
};
