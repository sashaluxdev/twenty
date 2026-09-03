import { MetadataApiClient } from 'twenty-client-sdk/metadata';

export type FieldMetadataInfo = {
  id: string;
  name: string;
  isActive: boolean;
};

// Minimal metadata client surface: enough to look up / mutate fields. Lets the
// helpers below be reused from a front component with an injected client.
export type MetadataQueryClient = {
  // Loose shapes mirror the genql client's runtime-built selections; the
  // callers narrow the response fields themselves.
  query: (selection: any) => Promise<any>;
};

// One metadata query (ObjectFilter cannot filter by name); client-side pick.
// The metadata client is injectable so the same lookup serves both the
// logic-function runtime (default app-token client) and unit tests / front
// components that hand in their own client.
export const findFields = async (
  objectName: string,
  fieldNames: string[],
  metadataClient: MetadataQueryClient = new MetadataApiClient(),
): Promise<{
  objectMetadataId: string | null;
  fields: Map<string, FieldMetadataInfo>;
}> => {
  const result = new Map<string, FieldMetadataInfo>();
  let objectMetadataId: string | null = null;
  try {
    const client = metadataClient;
    const response = await client.query({
      objects: {
        __args: { filter: {}, paging: { first: 1000 } },
        edges: {
          node: {
            id: true,
            nameSingular: true,
            fields: {
              __args: { paging: { first: 1000 }, filter: {} },
              edges: {
                node: { id: true, name: true, isActive: true },
              },
            },
          },
        },
      },
    });
    const objectNode = (response?.objects?.edges ?? [])
      .map((edge: { node?: { id?: string; nameSingular?: string } }) => edge?.node)
      .find((node: { nameSingular?: string } | undefined) => node?.nameSingular === objectName);
    objectMetadataId = (objectNode as { id?: string } | undefined)?.id ?? null;
    for (const fieldEdge of (objectNode as any)?.fields?.edges ?? []) {
      const field = fieldEdge?.node;
      if (field?.id && fieldNames.includes(field.name)) {
        result.set(field.name, {
          id: field.id,
          name: field.name,
          isActive: field.isActive !== false,
        });
      }
    }
  } catch {
    // Metadata unavailable -> act on nothing (safe no-op).
  }
  return { objectMetadataId, fields: result };
};
