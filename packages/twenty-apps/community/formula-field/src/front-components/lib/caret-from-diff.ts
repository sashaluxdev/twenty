// Recovers the caret index from the before/after values of a single-region edit
// (the only shape a keystroke, paste, or cut produces). Needed because the
// remote-dom sandbox never mirrors host selectionStart into the app worker, so
// the caret must be inferred from the value diff alone (see formula-field-input).
//
// The result is the index immediately AFTER the changed region, i.e. where a
// keystroke leaves the caret. For a mid-string edit we anchor on the common
// suffix and bias the caret to the LEFT edge of the changed region — that is the
// position the just-typed identifier ends at, which is what autocomplete reads.
// Pure appends and deletions at the tail are snapped to end-of-text: a naive
// suffix match over-counts inside a repeated-character run (e.g. "aaa" -> "aaaa"
// would otherwise report index 1 instead of 4), so those are handled explicitly.

const commonSuffixLength = (a: string, b: string): number => {
  let index = 0;
  while (
    index < a.length &&
    index < b.length &&
    a[a.length - 1 - index] === b[b.length - 1 - index]
  ) {
    index++;
  }
  return index;
};

export const caretFromDiff = (
  previousValue: string,
  nextValue: string,
): number => {
  // Pure append at the end (covers the no-op case when the values are equal).
  if (nextValue.startsWith(previousValue)) return nextValue.length;
  // Pure deletion at the end (covers clear-all).
  if (previousValue.startsWith(nextValue)) return nextValue.length;
  // General mid-string edit: caret sits after the changed region, left-biased.
  return nextValue.length - commonSuffixLength(previousValue, nextValue);
};
