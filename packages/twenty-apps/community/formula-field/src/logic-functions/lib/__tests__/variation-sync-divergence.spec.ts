import { beforeEach, describe, expect, it } from 'vitest';

import { detectVariationDivergence } from 'src/logic-functions/lib/variation-sync';
import { FakeClient } from 'src/logic-functions/lib/__tests__/fake-client';

describe('detectVariationDivergence', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
    client.setObjectsWithFields([
      {
        id: 'obj-company',
        nameSingular: 'company',
        labelIdentifierFieldMetadataId: 'field-name',
        fields: [
          { id: 'field-name', name: 'name', type: 'TEXT', isActive: true, isSystem: false },
          { id: 'field-employees', name: 'employees', type: 'NUMBER', isActive: true, isSystem: false },
          { id: 'field-domain', name: 'domainName', type: 'LINKS', isActive: true, isSystem: false },
          { id: 'field-budget', name: 'budget', type: 'CURRENCY', isActive: true, isSystem: false },
          { id: 'field-renew', name: 'renewDate', type: 'DATE', isActive: true, isSystem: false },
          { id: 'field-primary', name: 'primaryRecord', type: 'RELATION', isActive: true, isSystem: false },
        ],
      },
    ]);
  });

  it('pins a NUMBER override (numeric slot) when a human edits a variation field away from the primary', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 75, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { employees: 75 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    const override = client.get('formulaOverride', 'ov-employees') ?? Array.from((client as any).store?.get?.('formulaOverride')?.values?.() ?? []).find((o: any) => o.targetField === 'employees');
    expect(override.overrideValue).toBe(75);
    expect(override.overrideValueText).toBeNull();
    expect(override.active).toBe(true);
  });

  it('pins a text override (JSON slot) when a human edits a composite (LINKS) variation field', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'acme.com', secondaryLinks: [] }, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', domainName: { primaryLinkLabel: '', primaryLinkUrl: 'custom.com', secondaryLinks: [] }, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { domainName: { primaryLinkLabel: '', primaryLinkUrl: 'custom.com', secondaryLinks: [] } },
      updatedFields: ['domainName'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    const stored: any = Array.from((client as any).store.get('formulaOverride').values()).find(
      (o: any) => o.targetField === 'domainName',
    );
    expect(stored.overrideValue).toBeNull();
    expect(JSON.parse(stored.overrideValueText)).toEqual({
      primaryLinkLabel: '',
      primaryLinkUrl: 'custom.com',
      secondaryLinks: [],
    });
  });

  it('pins a text override (JSON slot) when a human edits a CURRENCY variation field', async () => {
    // Variation sync never evaluates, so CURRENCY -- despite being an
    // ENGINE_FAMILY kind for the formula engine -- goes through the SAME
    // overrideValueText JSON slot as any other composite (contrast
    // currency-target.spec.ts, where the formula engine's own override path
    // pins the numeric amountMicros instead).
    client.seed('company', [
      { id: 'p1', name: 'Acme', budget: { amountMicros: 10_000_000, currencyCode: 'USD' }, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', budget: { amountMicros: 5_000_000, currencyCode: 'USD' }, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { budget: { amountMicros: 5_000_000, currencyCode: 'USD' } },
      updatedFields: ['budget'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    const stored: any = Array.from((client as any).store.get('formulaOverride').values()).find(
      (o: any) => o.targetField === 'budget',
    );
    expect(stored.overrideValue).toBeNull();
    expect(JSON.parse(stored.overrideValueText)).toEqual({
      amountMicros: 5_000_000,
      currencyCode: 'USD',
    });
  });

  it('pins a text override (JSON slot) when a human edits a DATE variation field', async () => {
    // Same contrast as CURRENCY above: date-target.spec.ts's formula-engine
    // override stores epoch-days numerically; here the raw "yyyy-MM-dd" scalar
    // round-trips untouched as JSON text.
    client.seed('company', [
      { id: 'p1', name: 'Acme', renewDate: '2026-08-02', primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', renewDate: '2026-12-25', primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { renewDate: '2026-12-25' },
      updatedFields: ['renewDate'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    const stored: any = Array.from((client as any).store.get('formulaOverride').values()).find(
      (o: any) => o.targetField === 'renewDate',
    );
    expect(stored.overrideValue).toBeNull();
    expect(JSON.parse(stored.overrideValueText)).toBe('2026-12-25');
  });

  it('does NOT create an override when the value equals the primary (app echo)', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 50, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { employees: 50 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    expect(client.mutations).toBe(0);
  });

  it('does NOT create an override when there is no actor (API-key write)', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 75, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { employees: 75 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: null,
      relationFieldName: 'primaryRecord',
    });

    expect(client.mutations).toBe(0);
  });

  it('fetches the variation ONCE for a two-field edit and pins both overrides', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, domainName: { primaryLinkLabel: '', primaryLinkUrl: 'acme.com', secondaryLinks: [] }, primaryRecordId: null },
      { id: 'v1', name: 'Acme (variation)', employees: 75, domainName: { primaryLinkLabel: '', primaryLinkUrl: 'custom.com', secondaryLinks: [] }, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: {
        employees: 75,
        domainName: { primaryLinkLabel: '', primaryLinkUrl: 'custom.com', secondaryLinks: [] },
      },
      updatedFields: ['employees', 'domainName'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    // Both diverging fields produced an override row.
    const overrides = Array.from(
      (client as any).store.get('formulaOverride').values(),
    ) as any[];
    expect(overrides.map((o) => o.targetField).sort()).toEqual([
      'domainName',
      'employees',
    ]);

    // The variation ('v1') was read exactly ONCE for the pair — a single
    // consistent snapshot, not one staggered read per field.
    const variationReads = client.querySelections.filter(
      (sel: any) => sel.company?.__args?.filter?.id?.eq === 'v1',
    ).length;
    expect(variationReads).toBe(1);

    // Total query breakdown for a 2-field human divergence:
    //   1x formulaDefinitions  (computeSyncableFields -> loadAllEnabledFormulas)
    //   1x companies connection (fetchPrimaryRecordInclTrashed, primary incl trashed)
    //   1x company singular     (ONE batched fresh-fetch of the variation)
    //   2x formulaOverrides     (findOverride, once per field during upsert)
    // = 5 queries; the variation read is the single `company` singular above.
    expect(client.queries).toBe(5);
  });

  it('skips a superseded stale echo (stored value already moved past the event value)', async () => {
    client.seed('company', [
      { id: 'p1', name: 'Acme', employees: 50, primaryRecordId: null },
      // Stored value (75) has already moved past what this stale event reports (60).
      { id: 'v1', name: 'Acme (variation)', employees: 75, primaryRecordId: 'p1' },
    ]);

    await detectVariationDivergence({
      client,
      targetObject: 'company',
      variationRecordId: 'v1',
      primaryRecordId: 'p1',
      after: { employees: 60 },
      updatedFields: ['employees'],
      actorWorkspaceMemberId: 'wm-1',
      relationFieldName: 'primaryRecord',
    });

    expect(client.mutations).toBe(0);
  });
});
