import { type FormulaClient } from 'src/logic-functions/lib/types';

// In-memory fake of the CoreApiClient's query/mutation surface, enough to drive
// the recompute engine and change handlers in unit tests. It stores records per
// object and supports the exact query/mutation shapes the engine builds:
//   - singular record read:   { [object]: { __args: { filter: { id: { eq }}}, ...fields } }
//   - plural connection read: { [plural]: { __args, edges { node { id }}, pageInfo } }
//   - formulaDefinitions read (connection with node fields + filter)
//   - update mutation:        { update<Object>: { __args: { id, data }, id } }
//   - create formulaDefinition mutation

type Rec = Record<string, unknown> & { id: string };

const IRREGULAR: Record<string, string> = { person: 'people' };
const pluralize = (s: string): string => {
  if (IRREGULAR[s]) return IRREGULAR[s];
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export class FakeClient implements FormulaClient {
  // object name -> id -> record
  private store = new Map<string, Map<string, Rec>>();
  public queries = 0;
  public mutations = 0;
  // Records every value-field write as "object:id:field=value" for assertions.
  public writes: string[] = [];

  seed(object: string, records: Rec[]): void {
    const map = this.store.get(object) ?? new Map<string, Rec>();
    for (const record of records) {
      map.set(record.id, { ...record });
    }
    this.store.set(object, map);
  }

  get(object: string, id: string): Rec | undefined {
    return this.store.get(object)?.get(id);
  }

  private objectKeys(): string[] {
    return Array.from(this.store.keys());
  }

  async query(selection: any): Promise<any> {
    this.queries += 1;
    const key = Object.keys(selection)[0];
    const node = selection[key];

    // formulaDefinitions connection
    if (key === 'formulaDefinitions') {
      return { formulaDefinitions: this.connection('formulaDefinition', node) };
    }

    // plural connection for any object
    const singularForPlural = this.objectKeys().find(
      (obj) => pluralize(obj) === key,
    );
    if (singularForPlural && node.edges) {
      return { [key]: this.connection(singularForPlural, node) };
    }

    // singular record read
    const filterId = node?.__args?.filter?.id?.eq;
    const record = filterId
      ? this.store.get(key)?.get(filterId) ?? null
      : null;
    return { [key]: record ? this.project(record, node) : null };
  }

  private connection(object: string, node: any) {
    const filter = node?.__args?.filter;
    let records = Array.from(this.store.get(object)?.values() ?? []);
    if (filter) {
      records = records.filter((record) =>
        Object.entries(filter).every(([field, cond]: [string, any]) => {
          if (cond?.eq !== undefined) return record[field] === cond.eq;
          return true;
        }),
      );
    }
    const nodeSelection = node?.edges?.node ?? { id: true };
    return {
      edges: records.map((record) => ({
        node: this.project(record, nodeSelection),
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  }

  private project(record: Rec, node: any): Rec {
    const result: Rec = { id: record.id };
    for (const field of Object.keys(node)) {
      if (field === '__args' || field === 'edges' || field === 'pageInfo') {
        continue;
      }
      result[field] = record[field] ?? null;
    }
    return result;
  }

  async mutation(selection: any): Promise<any> {
    this.mutations += 1;
    const key = Object.keys(selection)[0];
    const node = selection[key];

    if (key === 'createFormulaDefinition') {
      const data = node.__args.data as Record<string, unknown>;
      const id = `formula-${this.store.get('formulaDefinition')?.size ?? 0}`;
      this.seed('formulaDefinition', [{ id, ...data } as Rec]);
      return { createFormulaDefinition: { id } };
    }

    if (key === 'updateFormulaDefinition') {
      const { id, data } = node.__args;
      const map = this.store.get('formulaDefinition');
      const record = map?.get(id);
      if (record) {
        Object.assign(record, data);
      }
      return { updateFormulaDefinition: { id } };
    }

    // update<Object>
    if (key.startsWith('update')) {
      const object = key.slice('update'.length);
      const singular = this.objectKeys().find((obj) => cap(obj) === object);
      const { id, data } = node.__args;
      if (singular) {
        const record = this.store.get(singular)?.get(id);
        if (record) {
          for (const [field, value] of Object.entries(data)) {
            record[field] = value as unknown;
            this.writes.push(`${singular}:${id}:${field}=${JSON.stringify(value)}`);
          }
        }
      }
      return { [key]: { id } };
    }

    throw new Error(`FakeClient: unhandled mutation ${key}`);
  }
}
