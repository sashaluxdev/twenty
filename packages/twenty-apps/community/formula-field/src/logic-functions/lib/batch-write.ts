import { pluralize } from 'src/logic-functions/lib/plural';
import { type FormulaClient } from 'src/logic-functions/lib/types';
import { withRetry } from 'src/logic-functions/lib/with-retry';

// MUTATION_MAXIMUM_AFFECTED_RECORDS. Surfaced by the server through
// client-config as a client-side guardrail rather than enforced in the
// mutation path, so we respect it ourselves.
export const MUTATION_CHUNK_SIZE = 100;

export type PendingWrite = { recordId: string; data: Record<string, unknown> };
export type BatchWriteFailure = { recordId: string; error: string };

const pascalCase = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

const chunk = <TItem>(items: TItem[], size: number): TItem[][] => {
  const chunks: TItem[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const writeOne = async (
  client: FormulaClient,
  targetObject: string,
  write: PendingWrite,
): Promise<BatchWriteFailure | null> => {
  try {
    await withRetry(() =>
      client.mutation({
        [`update${pascalCase(targetObject)}`]: {
          __args: { id: write.recordId, data: write.data },
          id: true,
        },
      }),
    );
    return null;
  } catch (error) {
    return { recordId: write.recordId, error: (error as Error).message };
  }
};

// Groups by the SERIALIZED payload, not by computed value: buildTargetWriteData
// folds the record's current raw value into the payload (currency-code
// preservation), so equal values can need unequal payloads.
export const flushBatchedWrites = async (
  client: FormulaClient,
  targetObject: string,
  writes: PendingWrite[],
): Promise<BatchWriteFailure[]> => {
  if (writes.length === 0) {
    return [];
  }

  const groups = new Map<
    string,
    { data: Record<string, unknown>; ids: string[] }
  >();
  for (const write of writes) {
    const key = JSON.stringify(write.data);
    const group = groups.get(key);
    if (group) {
      group.ids.push(write.recordId);
    } else {
      groups.set(key, { data: write.data, ids: [write.recordId] });
    }
  }

  const batchMutationName = `update${pascalCase(pluralize(targetObject))}`;
  const failures: BatchWriteFailure[] = [];

  for (const group of groups.values()) {
    for (const ids of chunk(group.ids, MUTATION_CHUNK_SIZE)) {
      try {
        await withRetry(() =>
          client.mutation({
            [batchMutationName]: {
              __args: { filter: { id: { in: ids } }, data: group.data },
              id: true,
            },
          }),
        );
      } catch {
        // One rejected batch must not fail the 99 good records in it: retry the
        // chunk record by record and report only what genuinely fails.
        for (const recordId of ids) {
          const failure = await writeOne(client, targetObject, {
            recordId,
            data: group.data,
          });
          if (failure) {
            failures.push(failure);
          }
        }
      }
    }
  }

  return failures;
};
