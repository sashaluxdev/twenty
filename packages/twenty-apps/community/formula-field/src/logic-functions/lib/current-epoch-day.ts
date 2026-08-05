import { MS_PER_DAY } from 'src/engine/date-serial';

// The ONE place the engine's ambient "current date" (TODAY(), ADR 0012) reads
// the system clock — a whole UTC epoch-day, floored like a DATE target. Lives
// app-side, not in the engine: the engine must stay a pure function of its
// inputs, never reading Date.now() itself. recompute.ts reads this once per
// evaluation and passes it into EvaluateOptions.todayEpochDay.
export const currentEpochDay = (): number =>
  Math.floor(Date.now() / MS_PER_DAY);
