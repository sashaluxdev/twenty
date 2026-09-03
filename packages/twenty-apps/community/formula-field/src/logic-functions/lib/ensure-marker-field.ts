import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { findFields } from 'src/logic-functions/lib/find-fields';
import {
  MARKER_FIELD_DESCRIPTION,
  MARKER_FIELD_ICON,
  MARKER_FIELD_LABEL,
  MARKER_FIELD_NAME,
} from 'src/logic-functions/lib/override-marker';

// findFields' MetadataQueryClient is query-only; ensuring the marker field
// also needs to mutate, so this is a local superset (mirrors the pattern in
// delete-definition-completely.ts's MetadataMutationClient). Method-shorthand
// syntax (not arrow-typed properties) so TS checks params bivariantly —
// MetadataApiClient's genql-generated query/mutation are generic over the
// selection shape and don't structurally match a plain `(x: unknown) => ...`
// property type.
type MarkerMetadataClient = {
  query(selection: unknown): Promise<unknown>;
  mutation(selection: unknown): Promise<unknown>;
};

export type EnsureMarkerFieldResult = 'created' | 'exists' | 'failed';

// Lazy, once-ever-per-object creation of the Overrides marker (spec §5.1).
// Uncached lookup first — mutations need live state, not the 60s catalog.
// isUIEditable is create-time-only (ADR 0028), so it must be in this input.
export const ensureMarkerFieldExists = async (
  objectName: string,
  metadataClient: MarkerMetadataClient = new MetadataApiClient(),
): Promise<EnsureMarkerFieldResult> => {
  try {
    const { objectMetadataId, fields } = await findFields(
      objectName,
      [MARKER_FIELD_NAME],
      metadataClient,
    );
    if (!objectMetadataId) return 'failed';
    if (fields.has(MARKER_FIELD_NAME)) return 'exists';
    await metadataClient.mutation({
      createOneField: {
        __args: {
          input: {
            field: {
              objectMetadataId,
              type: 'TEXT',
              name: MARKER_FIELD_NAME,
              label: MARKER_FIELD_LABEL,
              description: MARKER_FIELD_DESCRIPTION,
              icon: MARKER_FIELD_ICON,
              isUIEditable: false,
            },
          },
        },
        id: true,
        name: true,
      },
    });
    return 'created';
  } catch {
    return 'failed';
  }
};
