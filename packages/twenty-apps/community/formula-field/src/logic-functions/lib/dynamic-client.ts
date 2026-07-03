import { CoreApiClient } from 'twenty-client-sdk/core';

import { assertSafeGraphqlIdentifier } from 'src/logic-functions/lib/identifier';
import { loadAllObjectsWithFields } from 'src/logic-functions/lib/metadata-objects';
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
    // Argument-object keys (e.g. the `data` payload's field names, filter keys)
    // are identifiers in the emitted document — guard them (finding M1). This is
    // the boundary value-io's `{ [targetField]: value }` writes flow through.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(
        ([key, entryValue]) =>
          `${assertSafeGraphqlIdentifier(key)}: ${serializeArgumentValue(
            entryValue,
          )}`,
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
    // Every selection key (object / operation / field name) and argument name is
    // an identifier in the emitted document — guard them all so no untrusted
    // object/field name can inject GraphQL (finding M1).
    if (value === true) {
      parts.push(assertSafeGraphqlIdentifier(key));
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
                  `${assertSafeGraphqlIdentifier(argKey)}: ${serializeArgumentValue(
                    argValue,
                  )}`,
              )
              .join(', ')})`
          : '';
      parts.push(
        `${assertSafeGraphqlIdentifier(key)}${argsString} ${serializeSelection(
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
// by nameSingular, so ALL objects are loaded (paginated, via
// loadAllObjectsWithFields) and cached briefly: a field created mid-session is
// picked up within a minute.
const FIELD_KINDS_TTL_MS = 60_000;

// finding m4: this cache is process-global, and a single worker process serves
// MANY workspaces. Keying it by workspace stops workspace A's field kinds from
// being served to workspace B within the TTL (which would build wrong
// sub-selections -> silent null reads). The workspace subdomain / app-token
// workspaceId claim is the cheapest identifier the logic-function runtime
// exposes; the front-component sandbox (a single workspace per process, and no
// process.env) falls back to a constant, which is safe there.
const workspaceCacheKey = (): string => {
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  if (env?.TWENTY_WORKSPACE_SUBDOMAIN) {
    return env.TWENTY_WORKSPACE_SUBDOMAIN;
  }
  const token = env?.TWENTY_APP_ACCESS_TOKEN;
  if (token && typeof Buffer !== 'undefined') {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf8'),
      );
      if (typeof payload?.workspaceId === 'string') {
        return payload.workspaceId;
      }
    } catch {
      // Malformed token -> fall through to the shared key.
    }
  }
  return 'global';
};

type FieldKindsEntry = {
  byObject: Map<string, Map<string, string>>;
  loadedAt: number;
};
const fieldKindsCacheByWorkspace = new Map<string, FieldKindsEntry>();

const loadFieldKinds = async (
  objectName: string,
): Promise<Map<string, string>> => {
  const cacheKey = workspaceCacheKey();
  const cached = fieldKindsCacheByWorkspace.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < FIELD_KINDS_TTL_MS) {
    return cached.byObject.get(objectName) ?? new Map();
  }

  try {
    const objects = await loadAllObjectsWithFields();
    const byObject = new Map<string, Map<string, string>>();
    for (const object of objects) {
      const kinds = new Map<string, string>();
      for (const field of object.fields) {
        kinds.set(field.name, field.type);
      }
      byObject.set(object.nameSingular, kinds);
    }
    fieldKindsCacheByWorkspace.set(cacheKey, { byObject, loadedAt: Date.now() });
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
