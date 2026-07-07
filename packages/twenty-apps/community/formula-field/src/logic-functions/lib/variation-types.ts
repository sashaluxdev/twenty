// A VariationConfig record as the sync engine consumes it.
export type VariationConfigRecord = {
  id: string;
  // Deterministic key = targetObject (uniqueness anchor: one config per object).
  name?: string | null;
  targetObject?: string | null;
  // Name of the self-referencing relation field this config provisions
  // ("primaryRecord" by default). Stored explicitly, never re-derived.
  relationFieldName?: string | null;
  createdRelationField?: boolean | null;
  enabled?: boolean | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  status?: string | null;
  statusReason?: string | null;
};
