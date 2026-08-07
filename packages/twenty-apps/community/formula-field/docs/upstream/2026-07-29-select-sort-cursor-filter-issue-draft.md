Title: Editing a Select field fails when the view is sorted by it

---

## Bug Description

On a table view sorted by a Select field, editing that field on a record shows an error toast and the change is not saved:

`Unexpected value for select filter : {"lt":"NEW"}`

It only happens once the view has paginated (scrolled past the first page). A hard reload makes it go away until you scroll again. The record silently keeps its old value.

<!-- attach toast.png -->

## Steps to Reproduce

1. Open an object with enough records to paginate (e.g. Opportunities, ~100 records).
2. On a Table view, sort by a Select field (e.g. Stage, ascending). No filter needed.
3. Scroll past the first page so the cursor query fires.
4. Change the Stage of any row from the table.

Error toast appears, value reverts.

## Expected behavior

The record saves, like editing a Select field on an unsorted view.

## Technical inputs

- `computeCursorArgFilter.ts` — `computeOperator` picks `gt`/`lt` from the sort and pagination direction only, with no regard for field type, so sorting by a Select produces a cursor filter of `{ stage: { lt: 'NEW' } }`.
- That filter is stored in the Apollo cache as part of the `findMany` root query args, then replayed on every record update by `triggerUpdateRecordOptimisticEffect`.
- `isMatchingSelectFilter` (twenty-shared) only handles `in` / `is` / `eq` / `neq` and throws in its `default` branch. Views with no sort only get an `id` cursor, which is why this reproduces only on Select-sorted views.
- The throw is synchronous in `useUpdateOneRecord` before `apolloCoreClient.mutate` is called, which is why the write is lost rather than just noisy.

Seen on cloud (app.twenty.com); the code path is present on current `main`.
