import { formatNumberAsText, MAX_COMPUTED_TEXT_LENGTH } from 'src/engine/text-format';

describe('formatNumberAsText', () => {
  it('renders integers bare, never with a decimal point', () => {
    expect(formatNumberAsText(42)).toBe('42');
    expect(formatNumberAsText(0)).toBe('0');
    expect(formatNumberAsText(-7)).toBe('-7');
    expect(formatNumberAsText(20665)).toBe('20665');
  });

  it('trims float dust to at most 15 significant digits', () => {
    expect(formatNumberAsText(0.1 + 0.2)).toBe('0.3');
    expect(formatNumberAsText(123.4000000000001)).toBe('123.4');
  });

  it('keeps meaningful fractional digits', () => {
    expect(formatNumberAsText(3.14)).toBe('3.14');
    expect(formatNumberAsText(1 / 3)).toBe('0.333333333333333');
    expect(formatNumberAsText(0.000012)).toBe('0.000012');
  });

  it('falls back to default rendering for exponent-range magnitudes', () => {
    expect(formatNumberAsText(1e21)).toBe('1e+21');
    expect(formatNumberAsText(1e-7)).toBe('1e-7');
  });

  it('exposes the computed-text cap', () => {
    expect(MAX_COMPUTED_TEXT_LENGTH).toBe(10_000);
  });
});
