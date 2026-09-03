import { describe, expect, it, vi } from 'vitest';
import { ensureMarkerFieldExists } from 'src/logic-functions/lib/ensure-marker-field';

// findFields takes an injectable metadata client ({ query, mutation }) —
// build a stub that answers the objects query, then capture the create call.
const metadataStub = (existingFieldNames: string[]) => {
  const mutation = vi.fn().mockResolvedValue({
    createOneField: { id: 'new-field', name: 'fxOverrides' },
  });
  const query = vi.fn().mockResolvedValue({
    objects: {
      edges: [
        {
          node: {
            id: 'obj-1',
            nameSingular: 'opportunity',
            fields: {
              edges: existingFieldNames.map((name, index) => ({
                node: { id: `fld-${index}`, name, isActive: true },
              })),
            },
          },
        },
      ],
    },
  });
  return { query, mutation };
};

describe('ensureMarkerFieldExists', () => {
  it('creates the field with the exact contract when missing', async () => {
    const stub = metadataStub(['dealScore']);
    const result = await ensureMarkerFieldExists('opportunity', stub);
    expect(result).toBe('created');
    const input = stub.mutation.mock.calls[0][0].createOneField.__args.input.field;
    expect(input).toMatchObject({
      objectMetadataId: 'obj-1',
      type: 'TEXT',
      name: 'fxOverrides',
      label: 'Overrides',
      icon: 'IconPinned',
      isUIEditable: false,
    });
  });

  it("returns 'exists' without mutating when the field is already there", async () => {
    const stub = metadataStub(['fxOverrides']);
    const result = await ensureMarkerFieldExists('opportunity', stub);
    expect(result).toBe('exists');
    expect(stub.mutation).not.toHaveBeenCalled();
  });

  it("returns 'failed' (never throws) when metadata is unavailable", async () => {
    const stub = metadataStub([]);
    stub.query.mockRejectedValue(new Error('metadata down'));
    await expect(ensureMarkerFieldExists('opportunity', stub)).resolves.toBe('failed');
  });

  it("returns 'failed' when the create mutation is rejected", async () => {
    const stub = metadataStub(['dealScore']);
    stub.mutation.mockRejectedValue(new Error('forbidden'));
    await expect(ensureMarkerFieldExists('opportunity', stub)).resolves.toBe('failed');
  });
});
