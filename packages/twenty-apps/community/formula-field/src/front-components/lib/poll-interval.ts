// One knob for every widget's background refresh. 4s (the original value)
// re-ran each widget's full multi-query load ~900×/hour per open tab and was
// the single biggest steady-state load amplifier; 30s keeps cross-user edits
// visibly fresh while cutting that by 7.5×. User-initiated actions refresh
// immediately via their own load() calls, not this timer.
export const POLL_INTERVAL_MS = 30_000;
