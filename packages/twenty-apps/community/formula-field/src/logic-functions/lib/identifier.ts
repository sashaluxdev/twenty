import { FormulaError } from 'src/engine/errors';

// Central guard for every identifier — GraphQL field / argument / operation name
// and, crucially, object/field names — that the raw serializer in
// dynamic-client.ts interpolates into a dynamically built GraphQL document.
//
// Why this exists (finding M1): any workspace member can edit FormulaDefinition
// records, so targetObject / targetField — and the object/field names inside a
// cross-record reference — reach the serializer as UNTRUSTED input, and the app
// role can read/update all records. Enforcing the identifier grammar HERE, at
// the serialization boundary, means no call path (recompute, override IO, status
// sync, the widget) can smuggle a space, brace, colon, paren or quote into the
// emitted query: injection dies with a clear error instead of producing
// malformed GraphQL or — worse — a valid but attacker-shaped document. This is
// defense in depth behind the save-time shape check in save-validation.ts.
//
// The pattern is the GraphQL Name production (/[_A-Za-z][_0-9A-Za-z]*/), which
// is exactly the identifier grammar the engine's tokenizer accepts
// (isIdentifierStart / isIdentifierPart, underscores included). Matching the
// tokenizer means a cross-record reference the engine already accepted never
// fails here, while every non-identifier character is still rejected.
const SAFE_GRAPHQL_IDENTIFIER = /^[_A-Za-z][_0-9A-Za-z]*$/;

export const isSafeGraphqlIdentifier = (name: unknown): name is string =>
  typeof name === 'string' && SAFE_GRAPHQL_IDENTIFIER.test(name);

export const assertSafeGraphqlIdentifier = (name: unknown): string => {
  if (!isSafeGraphqlIdentifier(name)) {
    throw new FormulaError(
      'TOKENIZE_ERROR',
      `Unsafe GraphQL identifier ${JSON.stringify(
        name,
      )} — object, field and argument names must match /^[_A-Za-z][_0-9A-Za-z]*$/`,
    );
  }
  return name;
};
