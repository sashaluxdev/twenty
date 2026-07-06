import { describe, expect, it } from 'vitest';

import { nextCaretFromSelection } from 'src/front-components/lib/formula-field-input';

describe('nextCaretFromSelection', () => {
  it('uses the host selectionStart when it is a number', () => {
    // Native host: a click / arrow key exposes a real caret position.
    expect(nextCaretFromSelection(3, 12)).toBe(3);
  });

  it('accepts selectionStart 0 (caret at start of string)', () => {
    expect(nextCaretFromSelection(0, 12)).toBe(0);
  });

  it('keeps the current caret when selectionStart is undefined', () => {
    // remote-dom sandbox: selectionStart is undefined, so the diff-derived
    // caret must be left intact rather than stomped to end-of-string.
    expect(nextCaretFromSelection(undefined, 3)).toBe(3);
  });

  it('keeps the current caret when selectionStart is null', () => {
    expect(nextCaretFromSelection(null, 3)).toBe(3);
  });
});
