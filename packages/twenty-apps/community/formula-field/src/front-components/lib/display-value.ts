import {
  epochDaysToDateString,
  epochDaysToIsoDateTime,
} from 'src/logic-functions/lib/date-serial';
import { isMirrorTargetKind } from 'src/logic-functions/lib/mirror-kinds';
import { decodeMirrorOverrideValue } from 'src/logic-functions/lib/override-repository';

// How a computed value is rendered in the widgets. Extracted from
// formula-editor.tsx so it is unit-testable (.tsx files are not collected by
// vitest) — and so the string case no longer depends on TEXT being a mirror
// kind, which it stopped being when TEXT joined the engine lane (ADR 0026).

// Values are handled in micros for CURRENCY fields (like the engine); shown to
// the user in currency units. Mirror targets carry raw non-numeric values.
export const displayValue = (
  definition: { targetFieldType: string },
  value: unknown,
): string => {
  if (value === null || value === undefined) {
    return '—';
  }
  // A string is already display-ready whatever the target: an engine TEXT
  // result, or a mirror's raw string (SELECT option, plain text, …).
  if (typeof value === 'string') {
    return value;
  }
  // Mirror targets: render the remaining raw values directly — number/boolean
  // stringified, object/array as compact JSON (design 2026-07-06).
  if (isMirrorTargetKind(definition.targetFieldType)) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return JSON.stringify(value);
  }
  const numericValue = value as number;
  if (definition.targetFieldType === 'CURRENCY') {
    return `${(numericValue / 1_000_000).toFixed(2)}`;
  }
  // DATE / DATE_TIME values are epoch-days (Excel serial model, ADR 0011) —
  // show them as their calendar/ISO scalar rather than a raw day count.
  if (definition.targetFieldType === 'DATE') {
    return epochDaysToDateString(numericValue);
  }
  if (definition.targetFieldType === 'DATE_TIME') {
    return epochDaysToIsoDateTime(numericValue);
  }
  return String(numericValue);
};

// The definition page's headline value. The numeric heartbeat (lastValue) only
// carries a number; the non-numeric lanes — an engine TEXT result or a mirror
// passthrough — store a JSON-encoded value in lastValueText instead, so a TEXT
// formula would show a permanent dash without this fallback. A corrupt or
// truncated text (the heartbeat truncates at 500 chars) degrades to the dash.
export const displayHeartbeatValue = (definition: {
  lastValue: number | null;
  lastValueText: string | null;
}): string => {
  if (definition.lastValue !== null) {
    return String(definition.lastValue);
  }
  const decoded = decodeMirrorOverrideValue(definition.lastValueText);
  if (!decoded.restorable || decoded.value === null) {
    return '—';
  }
  return typeof decoded.value === 'string'
    ? decoded.value
    : JSON.stringify(decoded.value);
};
