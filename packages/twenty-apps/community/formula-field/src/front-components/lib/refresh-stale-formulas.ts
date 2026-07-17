import { isStaleTimestamp } from 'src/front-components/lib/format-relative-past';
import {
  recomputeAllRecords,
  recomputeForRecord,
} from 'src/logic-functions/lib/recompute';
import {
  type FormulaClient,
  type FormulaDefinitionRecord,
} from 'src/logic-functions/lib/types';

// Single refresh orchestrator, called by both widgets (record-page
// formula-editor and the FormulaDefinition's own formula-definition-editor).
// recomputeAllRecords is the HONEST refresh — it fixes every record of the
// target object (idempotent, write-avoidant) AND advances the definition's
// lastEvaluatedAt heartbeat, which is what actually clears the "Formula last
// evaluated {relative}" stale note. But running that whole-object sweep as a
// side effect of merely viewing one record was itself a defect (ADR 0023):
// the record-page widget now passes sweepAllRecords: false and recomputes
// only the viewed record; the definition page keeps the full sweep (it's the
// admin surface for exactly one definition) and is what actually advances the
// heartbeat. Elsewhere, staleness surfaces as the passive note until the
// definition page is visited or the hourly cron sweep (ADR 0012/0020) runs —
// that is honest too, since the sweep genuinely is stale in that window.
export type DefinitionLike = FormulaDefinitionRecord & {
  enabled: boolean;
  lastEvaluatedAt: string | null;
  // Parsed once by the caller (ADR 0015) — both widgets already hold this
  // flag from load time; re-parsing the expression here on every 4s poll
  // would defeat the point of memoizing it.
  usesTodayFlag: boolean;
};

export type RefreshThrottleState = {
  lastRefreshAt: number;
  inFlight: boolean;
};

// Module-global throttle states. The per-mount useRef versions reset on every
// tab open (Twenty unmounts inactive tabs), which defeated the 60s throttle —
// every open re-triggered refresh work (ADR 0023). One state per surface:
// record-page editors (per-record recompute) and the definition page (full
// sweep) throttle independently, but each throttles across ALL of its mounts.
export const sharedRecordRefreshState: RefreshThrottleState = {
  lastRefreshAt: 0,
  inFlight: false,
};
export const sharedSweepRefreshState: RefreshThrottleState = {
  lastRefreshAt: 0,
  inFlight: false,
};
export const __resetSharedRefreshStatesForTests = (): void => {
  sharedRecordRefreshState.lastRefreshAt = 0;
  sharedRecordRefreshState.inFlight = false;
  sharedSweepRefreshState.lastRefreshAt = 0;
  sharedSweepRefreshState.inFlight = false;
};

export type RefreshStaleOptions = {
  client: FormulaClient;
  definitions: ReadonlyArray<DefinitionLike>;
  now: number;
  // Caller-held (e.g. a ref) so the throttle/in-flight guard survives across
  // polls without triggering re-renders on its own.
  state: RefreshThrottleState;
  // The viewed record, when called from the record-page widget — recomputed
  // first so the value the user is looking at corrects before the full sweep.
  recordId?: string;
  // Whether to run the full recomputeAllRecords sweep after the per-record
  // fix. The record-page widget passes false: a whole-object sweep triggered
  // by merely viewing a record was the browser-side query-flood source
  // (ADR 0023). The definition page passes true — it is the admin surface for
  // exactly one definition, and the sweep is what advances lastEvaluatedAt.
  sweepAllRecords: boolean;
  // Polled between records by recomputeAllRecords; lets the initiating widget
  // stop a sweep on unmount instead of orphaning it.
  shouldContinue?: () => boolean;
  recomputeForRecordFn?: typeof recomputeForRecord;
  recomputeAllRecordsFn?: typeof recomputeAllRecords;
  // Lets the widget re-render to show/hide the "Refreshing formula…" note.
  onStateChange?: () => void;
};

// Mirrors the pre-existing self-heal throttle: bounds how often a
// persistently-stale definition re-triggers a refresh per mounted widget.
const REFRESH_THROTTLE_MS = 60_000;

const isStaleEnabledToday = (
  definition: DefinitionLike,
  now: number,
): boolean =>
  definition.enabled &&
  definition.usesTodayFlag &&
  isStaleTimestamp(definition.lastEvaluatedAt, now);

// Refreshes every stale, enabled, TODAY()-using definition. Returns the ids
// that were actually refreshed (i.e. completed without throwing) — errors are
// caught per-definition and swallowed, since the passive stale note is the
// intended failure surface (ADR 0015), not a thrown promise the widget must
// handle. Sequential by design: definitions are processed one at a time so a
// slow/failing definition never interleaves with the next.
export const refreshStaleTodayFormulas = async ({
  client,
  definitions,
  now,
  state,
  recordId,
  sweepAllRecords,
  shouldContinue,
  recomputeForRecordFn = recomputeForRecord,
  recomputeAllRecordsFn = recomputeAllRecords,
  onStateChange,
}: RefreshStaleOptions): Promise<string[]> => {
  if (state.inFlight) {
    return [];
  }
  if (now - state.lastRefreshAt <= REFRESH_THROTTLE_MS) {
    return [];
  }

  const staleDefinitions = definitions.filter((definition) =>
    isStaleEnabledToday(definition, now),
  );
  if (staleDefinitions.length === 0) {
    return [];
  }

  state.inFlight = true;
  onStateChange?.();

  const refreshedIds: string[] = [];
  try {
    for (const definition of staleDefinitions) {
      try {
        if (recordId) {
          await recomputeForRecordFn({
            client,
            formula: definition,
            targetRecordId: recordId,
          });
        }
        if (sweepAllRecords) {
          await recomputeAllRecordsFn(client, definition, { shouldContinue });
        }
        refreshedIds.push(definition.id);
      } catch {
        // Swallowed per-definition — see the function-level comment above.
      }
    }
  } finally {
    // Advance the throttle even on failure, or a persistently-failing
    // definition would re-attempt (and re-fail) on every 4s poll.
    state.lastRefreshAt = now;
    state.inFlight = false;
    onStateChange?.();
  }

  return refreshedIds;
};
