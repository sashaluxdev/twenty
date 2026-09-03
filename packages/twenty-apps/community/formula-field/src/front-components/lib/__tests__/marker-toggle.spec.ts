import { describe, expect, it, vi } from 'vitest';

import {
  type MarkerToggleDefinition,
  writeMarkerAfterToggle,
} from 'src/front-components/lib/marker-toggle';

const RECORD_ID = 'record-1';

const definitionRow = (
  overrides: Partial<MarkerToggleDefinition> & { id: string },
): MarkerToggleDefinition => ({
  name: 'Discount',
  targetField: 'fxDiscount',
  targetObject: 'opportunity',
  enabled: true,
  allowOverride: true,
  order: 0,
  ...overrides,
});

// The widget hands in the dynamic core client; the tests hand in this stub so
// the read/compare/write decision is observable without a server.
const clientReadingMarker = (marker: string | null) => ({
  query: vi.fn(async () => ({
    opportunity: { id: RECORD_ID, fxOverrides: marker },
  })),
  mutation: vi.fn(async () => ({ updateOpportunity: { id: RECORD_ID } })),
});

const clientWithFailingMarkerQuery = () => ({
  query: vi.fn(async () => {
    throw new Error(
      'Cannot query field "fxOverrides" on type "Opportunity".',
    );
  }),
  mutation: vi.fn(async () => ({ updateOpportunity: { id: RECORD_ID } })),
});

describe('writeMarkerAfterToggle', () => {
  it("writes the marker when it differs ('written')", async () => {
    const client = clientReadingMarker(null);

    const outcome = await writeMarkerAfterToggle({
      client,
      objectName: 'opportunity',
      recordId: RECORD_ID,
      definitions: [definitionRow({ id: 'definition-1', name: 'Discount' })],
      activeOverrideFields: new Set(['fxDiscount']),
    });

    expect(outcome).toBe('written');
    expect(client.query).toHaveBeenCalledWith({
      opportunity: {
        __args: { filter: { id: { eq: RECORD_ID } } },
        id: true,
        fxOverrides: true,
      },
    });
    expect(client.mutation).toHaveBeenCalledTimes(1);
    expect(client.mutation).toHaveBeenCalledWith({
      updateOpportunity: {
        __args: { id: RECORD_ID, data: { fxOverrides: 'Discount' } },
        id: true,
      },
    });
  });

  it("does not mutate when converged, blank-vs-null included ('converged')", async () => {
    const alreadyMarked = clientReadingMarker('Discount');

    expect(
      await writeMarkerAfterToggle({
        client: alreadyMarked,
        objectName: 'opportunity',
        recordId: RECORD_ID,
        definitions: [definitionRow({ id: 'definition-1', name: 'Discount' })],
        activeOverrideFields: new Set(['fxDiscount']),
      }),
    ).toBe('converged');
    expect(alreadyMarked.mutation).not.toHaveBeenCalled();

    // Toggling the last pin off computes '' while the stored field reads back
    // as SQL NULL — both mean "no overrides", so this must not churn a write.
    const noOverrides = clientReadingMarker(null);

    expect(
      await writeMarkerAfterToggle({
        client: noOverrides,
        objectName: 'opportunity',
        recordId: RECORD_ID,
        definitions: [definitionRow({ id: 'definition-1', name: 'Discount' })],
        activeOverrideFields: new Set<string>(),
      }),
    ).toBe('converged');
    expect(noOverrides.mutation).not.toHaveBeenCalled();
  });

  it("returns 'skipped' and never mutates when the marker query errors (field absent)", async () => {
    const client = clientWithFailingMarkerQuery();

    const outcome = await writeMarkerAfterToggle({
      client,
      objectName: 'opportunity',
      recordId: RECORD_ID,
      definitions: [definitionRow({ id: 'definition-1', name: 'Discount' })],
      activeOverrideFields: new Set(['fxDiscount']),
    });

    expect(outcome).toBe('skipped');
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it('maps definitions through the same enabled/allowOverride/order rules as the server', async () => {
    const client = clientReadingMarker(null);

    const outcome = await writeMarkerAfterToggle({
      client,
      objectName: 'opportunity',
      recordId: RECORD_ID,
      definitions: [
        definitionRow({
          id: 'definition-disabled',
          name: 'Disabled',
          targetField: 'fxDisabled',
          enabled: false,
          order: 0,
        }),
        definitionRow({
          id: 'definition-locked',
          name: 'Locked',
          targetField: 'fxLocked',
          allowOverride: false,
          order: 1,
        }),
        definitionRow({
          id: 'definition-foreign',
          name: 'Foreign',
          targetField: 'fxForeign',
          targetObject: 'company',
          order: 2,
        }),
        definitionRow({
          id: 'definition-second',
          name: 'Second',
          targetField: 'fxSecond',
          order: 4,
        }),
        definitionRow({
          id: 'definition-first',
          name: 'First',
          targetField: 'fxFirst',
          order: 3,
        }),
      ],
      activeOverrideFields: new Set([
        'fxDisabled',
        'fxLocked',
        'fxForeign',
        'fxSecond',
        'fxFirst',
      ]),
    });

    expect(outcome).toBe('written');
    expect(client.mutation).toHaveBeenCalledWith({
      updateOpportunity: {
        __args: { id: RECORD_ID, data: { fxOverrides: 'First, Second' } },
        id: true,
      },
    });
  });
});
