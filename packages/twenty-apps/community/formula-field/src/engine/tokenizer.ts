import { FormulaError } from 'src/engine/errors';

// The tokenizer is the first line of defense. It accepts ONLY the characters
// that make up the whitelisted grammar and rejects everything else at the exact
// offset where the illegal character appears. There is no eval/Function anywhere
// downstream, but rejecting early keeps the AST small and the failure messages
// precise (e.g. unicode homoglyph operators, `;`, single quotes, backslashes
// all die here; `"` opens a whitelisted string literal instead).

export type TokenType =
  | 'NUMBER'
  | 'PLUS'
  | 'MINUS'
  | 'STAR'
  | 'SLASH'
  | 'PERCENT'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  | 'EQUAL'
  | 'NOT_EQUAL'
  | 'FIELD'
  | 'CROSSREF'
  | 'STRING'
  | 'EOF';

export type CrossRefValue = {
  object: string;
  recordId: string;
  fieldPath: string;
};

export type Token = {
  type: TokenType;
  // Raw lexeme, for error messages.
  lexeme: string;
  position: number;
  // Populated for NUMBER.
  numberValue?: number;
  // Populated for FIELD (dotted path, e.g. "amount.amountMicros").
  fieldPath?: string;
  // Populated for CROSSREF.
  crossRef?: CrossRefValue;
  // Populated for STRING: the literal's content with the surrounding double
  // quotes stripped (the quotes stay in `lexeme`).
  stringValue?: string;
};

// Identifier segments that must never be resolved as variable names — they are
// prototype-pollution vectors (`variables["constructor"]` on a plain object
// returns the Object constructor). Rejected at tokenize time as a hard rule.
const FORBIDDEN_SEGMENTS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Upper bound on a double-quoted string literal's content length. Keeps literals
// small (they only ever feed = / != comparisons) and bounds token size well
// under MAX_EXPRESSION_LENGTH.
const MAX_STRING_LITERAL_LENGTH = 100;

const isDigit = (char: string): boolean => char >= '0' && char <= '9';

const isAsciiLetter = (char: string): boolean =>
  (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');

const isIdentifierStart = (char: string): boolean =>
  isAsciiLetter(char) || char === '_';

const isIdentifierPart = (char: string): boolean =>
  isIdentifierStart(char) || isDigit(char);

// Validates a dotted identifier path (e.g. "amount.amountMicros"). Each segment
// must be a plain ASCII identifier and none may be a forbidden segment.
const validateFieldPath = (path: string, position: number): void => {
  const segments = path.split('.');

  for (const segment of segments) {
    if (segment.length === 0) {
      throw new FormulaError(
        'TOKENIZE_ERROR',
        `Empty path segment in "${path}"`,
        position,
      );
    }

    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new FormulaError(
        'TOKENIZE_ERROR',
        `Forbidden identifier "${segment}"`,
        position,
      );
    }
  }
};

const readNumber = (
  source: string,
  start: number,
): { lexeme: string; next: number } => {
  let index = start;
  let seenDot = false;

  while (index < source.length) {
    const char = source[index];

    if (isDigit(char)) {
      index += 1;
      continue;
    }

    if (char === '.') {
      if (seenDot) {
        throw new FormulaError(
          'TOKENIZE_ERROR',
          'Malformed number: multiple decimal points',
          index,
        );
      }
      seenDot = true;
      index += 1;
      continue;
    }

    break;
  }

  const lexeme = source.slice(start, index);

  // Reject a bare "." with no digits on either side.
  if (!/\d/.test(lexeme)) {
    throw new FormulaError(
      'TOKENIZE_ERROR',
      `Malformed number "${lexeme}"`,
      start,
    );
  }

  return { lexeme, next: index };
};

const readIdentifier = (
  source: string,
  start: number,
): { lexeme: string; next: number } => {
  let index = start;

  while (index < source.length) {
    const char = source[index];

    if (isIdentifierPart(char) || char === '.') {
      index += 1;
      continue;
    }

    break;
  }

  return { lexeme: source.slice(start, index), next: index };
};

const readCrossRef = (
  source: string,
  start: number,
): { token: Token; next: number } => {
  const closeIndex = source.indexOf(']', start);

  if (closeIndex === -1) {
    throw new FormulaError(
      'TOKENIZE_ERROR',
      'Unterminated cross-record reference (missing "]")',
      start,
    );
  }

  const inner = source.slice(start + 1, closeIndex);
  const parts = inner.split(':');

  if (parts.length !== 3) {
    throw new FormulaError(
      'TOKENIZE_ERROR',
      `Cross-record reference must be [object:recordId:fieldPath], got "[${inner}]"`,
      start,
    );
  }

  const [object, recordId, fieldPath] = parts.map((part) => part.trim());

  if (!object || !isIdentifierStart(object[0])) {
    throw new FormulaError(
      'TOKENIZE_ERROR',
      `Invalid object name "${object}" in cross-record reference`,
      start,
    );
  }

  for (const char of object) {
    if (!isIdentifierPart(char)) {
      throw new FormulaError(
        'TOKENIZE_ERROR',
        `Invalid object name "${object}" in cross-record reference`,
        start,
      );
    }
  }

  if (!UUID_V4_REGEX.test(recordId)) {
    throw new FormulaError(
      'TOKENIZE_ERROR',
      `Invalid record id "${recordId}" (must be a UUID v4)`,
      start,
    );
  }

  if (!fieldPath || !isIdentifierStart(fieldPath[0])) {
    throw new FormulaError(
      'TOKENIZE_ERROR',
      `Invalid field path "${fieldPath}" in cross-record reference`,
      start,
    );
  }

  for (const char of fieldPath) {
    if (!isIdentifierPart(char) && char !== '.') {
      throw new FormulaError(
        'TOKENIZE_ERROR',
        `Invalid field path "${fieldPath}" in cross-record reference`,
        start,
      );
    }
  }

  validateFieldPath(fieldPath, start);

  return {
    token: {
      type: 'CROSSREF',
      lexeme: source.slice(start, closeIndex + 1),
      position: start,
      crossRef: { object, recordId, fieldPath },
    },
    next: closeIndex + 1,
  };
};

// Reads a double-quoted string literal. Content is taken verbatim (no escape
// processing): every character up to the next `"` is kept as-is, so spaces,
// `[`, `.`, `'` and other grammar characters survive unchanged. A newline or
// end-of-input before the closing quote is an unterminated literal.
const readString = (
  source: string,
  start: number,
): { token: Token; next: number } => {
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];

    if (char === '"') {
      const value = source.slice(start + 1, index);

      if (value.length > MAX_STRING_LITERAL_LENGTH) {
        throw new FormulaError(
          'TOKENIZE_ERROR',
          `String literal exceeds ${MAX_STRING_LITERAL_LENGTH} characters`,
          start,
        );
      }

      return {
        token: {
          type: 'STRING',
          lexeme: source.slice(start, index + 1),
          position: start,
          stringValue: value,
        },
        next: index + 1,
      };
    }

    if (char === '\n' || char === '\r') {
      throw new FormulaError(
        'TOKENIZE_ERROR',
        'Unterminated string literal',
        start,
      );
    }

    index += 1;
  }

  throw new FormulaError(
    'TOKENIZE_ERROR',
    'Unterminated string literal',
    start,
  );
};

const SINGLE_CHAR_TOKENS: Record<string, TokenType> = {
  '+': 'PLUS',
  '-': 'MINUS',
  '*': 'STAR',
  '/': 'SLASH',
  '%': 'PERCENT',
  '(': 'LPAREN',
  ')': 'RPAREN',
  ',': 'COMMA',
};

// Comparison operators need one character of lookahead ('>' vs '>='), so they
// cannot live in the single-char map. '==' is accepted as an alias of '=' at
// tokenize time; the parser only ever sees EQUAL. A lone '!' has no meaning in
// the grammar (there is no unary NOT) and is rejected here.
const readComparisonOperator = (
  source: string,
  start: number,
): { token: Token; next: number } | null => {
  const char = source[start];
  const nextChar = source[start + 1];

  if (char === '>') {
    return nextChar === '='
      ? { token: { type: 'GREATER_THAN_OR_EQUAL', lexeme: '>=', position: start }, next: start + 2 }
      : { token: { type: 'GREATER_THAN', lexeme: '>', position: start }, next: start + 1 };
  }

  if (char === '<') {
    return nextChar === '='
      ? { token: { type: 'LESS_THAN_OR_EQUAL', lexeme: '<=', position: start }, next: start + 2 }
      : { token: { type: 'LESS_THAN', lexeme: '<', position: start }, next: start + 1 };
  }

  if (char === '=') {
    return nextChar === '='
      ? { token: { type: 'EQUAL', lexeme: '==', position: start }, next: start + 2 }
      : { token: { type: 'EQUAL', lexeme: '=', position: start }, next: start + 1 };
  }

  if (char === '!') {
    if (nextChar === '=') {
      return { token: { type: 'NOT_EQUAL', lexeme: '!=', position: start }, next: start + 2 };
    }
    throw new FormulaError(
      'TOKENIZE_ERROR',
      'Unexpected character "!" (only valid as part of "!=")',
      start,
    );
  }

  return null;
};

export const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    // Only ASCII space and tab are treated as whitespace. Anything exotic
    // (non-breaking space, unicode separators) is rejected below.
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }

    const singleType = SINGLE_CHAR_TOKENS[char];

    if (singleType) {
      tokens.push({ type: singleType, lexeme: char, position: index });
      index += 1;
      continue;
    }

    const comparison = readComparisonOperator(source, index);

    if (comparison) {
      tokens.push(comparison.token);
      index = comparison.next;
      continue;
    }

    if (isDigit(char) || char === '.') {
      const { lexeme, next } = readNumber(source, index);
      tokens.push({
        type: 'NUMBER',
        lexeme,
        position: index,
        numberValue: Number(lexeme),
      });
      index = next;
      continue;
    }

    if (char === '[') {
      const { token, next } = readCrossRef(source, index);
      tokens.push(token);
      index = next;
      continue;
    }

    if (char === '"') {
      const { token, next } = readString(source, index);
      tokens.push(token);
      index = next;
      continue;
    }

    if (isIdentifierStart(char)) {
      const { lexeme, next } = readIdentifier(source, index);

      if (lexeme.endsWith('.') || lexeme.startsWith('.')) {
        throw new FormulaError(
          'TOKENIZE_ERROR',
          `Malformed field reference "${lexeme}"`,
          index,
        );
      }

      validateFieldPath(lexeme, index);
      tokens.push({
        type: 'FIELD',
        lexeme,
        position: index,
        fieldPath: lexeme,
      });
      index = next;
      continue;
    }

    // Reached only by illegal characters: `;`, `{`, `}`, `$`, backtick, single
    // quote, backslash, unicode homoglyph operators (U+2212, fullwidth +/-),
    // etc. (`"` opens a string literal above, so it does not land here.)
    throw new FormulaError(
      'TOKENIZE_ERROR',
      `Unexpected character "${char}" (U+${char
        .codePointAt(0)!
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')})`,
      index,
    );
  }

  tokens.push({ type: 'EOF', lexeme: '', position: source.length });

  return tokens;
};
