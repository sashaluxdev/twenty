import {
  computeMarkerValue,
  MARKER_FIELD_NAME,
} from 'src/logic-functions/lib/override-marker';
import { textValuesConverged } from 'src/logic-functions/lib/value-io';

// Local copy (see variation-widget.tsx / variation-sync.ts) — a shared module
// export for one private helper costs more than the two lines.
const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

export type MarkerToggleClient = {
  query: (selection: Record<string, unknown>) => Promise<unknown>;
  mutation: (selection: Record<string, unknown>) => Promise<unknown>;
};

// The widget's Definition rows, narrowed to the fields computeMarkerValue reads.
export type MarkerToggleDefinition = {
  id: string;
  name: string;
  targetField: string;
  targetObject: string;
  enabled: boolean;
  allowOverride: boolean;
  order: number | null;
};

// The dynamic client returns runtime-shaped responses (its selections are built
// at call time), so the marker is narrowed out of `unknown` rather than cast.
const markerFromResponse = (
  response: unknown,
  objectName: string,
): string | null => {
  if (typeof response !== 'object' || response === null) return null;
  const record = (response as Record<string, unknown>)[objectName];
  if (typeof record !== 'object' || record === null) return null;
  const marker = (record as Record<string, unknown>)[MARKER_FIELD_NAME];
  return typeof marker === 'string' ? marker : null;
};

// Toggle-off can converge without any record write (deactivate -> recompute ->
// no-op -> no event), so the widget writes the marker itself (spec §5.3).
export const writeMarkerAfterToggle = async ({
  client,
  objectName,
  recordId,
  definitions,
  activeOverrideFields,
}: {
  client: MarkerToggleClient;
  objectName: string;
  recordId: string;
  definitions: MarkerToggleDefinition[];
  activeOverrideFields: ReadonlySet<string>;
}): Promise<'written' | 'converged' | 'skipped'> => {
  let current: string | null;
  try {
    const response = await client.query({
      [objectName]: {
        __args: { filter: { id: { eq: recordId } } },
        id: true,
        [MARKER_FIELD_NAME]: true,
      },
    });
    current = markerFromResponse(response, objectName);
  } catch {
    // Selecting a field the object does not have throws — the marker field
    // has not been created yet, so there is nothing to maintain.
    return 'skipped';
  }

  const expected = computeMarkerValue(
    objectName,
    definitions,
    activeOverrideFields,
  );
  if (textValuesConverged(expected, current)) {
    return 'converged';
  }
  await client.mutation({
    [`update${capitalize(objectName)}`]: {
      __args: { id: recordId, data: { [MARKER_FIELD_NAME]: expected } },
      id: true,
    },
  });
  return 'written';
};
