import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { type FormulaClient } from 'src/logic-functions/lib/types';

// FormulaClient over RAW GraphQL instead of the generated genql client.
//
// Why: the genql client validates every selection against the type map frozen
// into the bundle at deploy time, so a field created AFTER deploy (the wizard
// creates value fields at runtime via the metadata API) makes it throw
// client-side ("type X does not have a field Y") even though the server
// schema already knows the field. The engine builds its selections
// dynamically anyway, so we serialize them to GraphQL ourselves and send them
// through the SDK client's transport (which keeps its auth: env token in
// logic functions, host token bridge in front components).

// The transport is typed private but is a plain runtime method.
type RawGraphqlTransport = {
  executeGraphqlRequestWithOptionalRefresh: (args: {
    operation: { query: string; variables?: Record<string, unknown> };
  }) => Promise<{
    data?: Record<string, unknown> | null;
    errors?: Array<{ message?: string }>;
  }>;
};

// GraphQL value literal from a plain JS value. Strings JSON-stringify (valid
// GraphQL StringValue); objects/arrays recurse (also valid for JSON scalars
// like the dependencies field). Enums are not used by the engine's queries.
export const serializeArgumentValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeArgumentValue).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(
        ([key, entryValue]) => `${key}: ${serializeArgumentValue(entryValue)}`,
      );
    return `{ ${entries.join(', ')} }`;
  }
  throw new Error(`Cannot serialize GraphQL argument of type ${typeof value}`);
};

// Serializes a genql-style selection object ({ field: true, nested: { __args,
// sub: true } }) into a GraphQL selection set string.
export const serializeSelection = (
  selection: Record<string, unknown>,
): string => {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(selection)) {
    if (key === '__args' || value === undefined || value === false) {
      continue;
    }
    if (value === true) {
      parts.push(key);
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      const args = (value as { __args?: Record<string, unknown> }).__args;
      const argEntries = Object.entries(args ?? {}).filter(
        ([, argValue]) => argValue !== undefined,
      );
      const argsString =
        argEntries.length > 0
          ? `(${argEntries
              .map(
                ([argKey, argValue]) =>
                  `${argKey}: ${serializeArgumentValue(argValue)}`,
              )
              .join(', ')})`
          : '';
      parts.push(
        `${key}${argsString} ${serializeSelection(
          value as Record<string, unknown>,
        )}`,
      );
    }
  }

  return `{ ${parts.join(' ')} }`;
};

const execute = async (
  transport: RawGraphqlTransport,
  operationType: 'query' | 'mutation',
  selection: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const query = `${operationType} ${serializeSelection(selection)}`;
  const payload = await transport.executeGraphqlRequestWithOptionalRefresh({
    operation: { query },
  });
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      payload.errors
        .map((error) => error.message ?? 'Unknown GraphQL error')
        .join('; '),
    );
  }
  return payload.data ?? null;
};

// Field kinds (name -> FieldMetadataType) per object, from the metadata API.
// Needed to sub-select composite dependency fields (CURRENCY) when fetching
// records — the server does NOT error on a scalar selection of a composite,
// it silently returns null, which made formulas with currency inputs compute
// nothing (no error!) on activation. The metadata ObjectFilter cannot filter
// by nameSingular, so ALL objects are fetched in one query and cached
// briefly: a field created mid-session is picked up within a minute.
const FIELD_KINDS_TTL_MS = 60_000;
let fieldKindsCache: {
  byObject: Map<string, Map<string, string>>;
  loadedAt: number;
} | null = null;

const loadFieldKinds = async (
  objectName: string,
): Promise<Map<string, string>> => {
  if (
    fieldKindsCache &&
    Date.now() - fieldKindsCache.loadedAt < FIELD_KINDS_TTL_MS
  ) {
    return fieldKindsCache.byObject.get(objectName) ?? new Map();
  }

  try {
    const client = new MetadataApiClient();
    const response = await client.query({
      objects: {
        __args: { filter: {}, paging: { first: 1000 } },
        edges: {
          node: {
            nameSingular: true,
            fields: {
              __args: { paging: { first: 1000 }, filter: {} },
              edges: { node: { name: true, type: true } },
            },
          },
        },
      },
    });
    const byObject = new Map<string, Map<string, string>>();
    for (const objectEdge of response?.objects?.edges ?? []) {
      const node = objectEdge?.node;
      if (!node?.nameSingular) continue;
      const kinds = new Map<string, string>();
      for (const fieldEdge of node.fields?.edges ?? []) {
        if (fieldEdge?.node?.name && fieldEdge?.node?.type) {
          kinds.set(fieldEdge.node.name, fieldEdge.node.type);
        }
      }
      byObject.set(node.nameSingular, kinds);
    }
    fieldKindsCache = { byObject, loadedAt: Date.now() };
    return byObject.get(objectName) ?? new Map();
  } catch {
    // Metadata unavailable -> fall back to scalar selections; do not cache.
    return new Map();
  }
};

// Drop-in FormulaClient. Reuses CoreApiClient purely as an authenticated
// transport to POST /graphql.
export const createDynamicCoreClient = (): FormulaClient => {
  const transport = new CoreApiClient() as unknown as RawGraphqlTransport;
  return {
    query: (selection: Record<string, unknown>) =>
      execute(transport, 'query', selection),
    mutation: (selection: Record<string, unknown>) =>
      execute(transport, 'mutation', selection),
    fieldKinds: loadFieldKinds,
  };
};
