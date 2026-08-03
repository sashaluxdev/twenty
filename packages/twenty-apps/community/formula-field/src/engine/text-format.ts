// Canonical decimal rendering for text contexts (ADR 0026): integers bare,
// at most 15 significant digits, trailing float dust trimmed. Dates/datetimes
// reach here already coerced to serial numbers, so they render as serials.
export const MAX_COMPUTED_TEXT_LENGTH = 10_000;

export const formatNumberAsText = (value: number): string => {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  const precise = value.toPrecision(15);
  if (precise.includes('e') || precise.includes('E')) {
    return String(value);
  }
  if (!precise.includes('.')) {
    return precise;
  }
  return precise.replace(/0+$/, '').replace(/\.$/, '');
};
