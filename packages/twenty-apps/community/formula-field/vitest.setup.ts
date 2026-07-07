import { beforeEach } from 'vitest';

// The metadata objects cache in metadata-objects.ts is process-global module
// state. Without a universal reset, any spec that mocks MetadataApiClient
// inherits a prior test's cached objects (the 60s TTL never expires within a
// test file), causing order-dependent failures unless its author remembers to
// clear it manually. This hook removes that opt-in trap for every spec file.
//
// The import is deferred (inside beforeEach, not at module top level):
// metadata-objects.ts transitively imports twenty-client-sdk/metadata, which
// several specs vi.mock(). A top-level import here would run before those
// specs' hoisted vi.mock calls take effect, pinning the real SDK client into
// the module cache for the rest of the file and breaking the mock — a dynamic
// import at execution time resolves after each file's own mocks are live.
beforeEach(async () => {
  const { __clearMetadataCacheForTests } = await import(
    'src/logic-functions/lib/metadata-objects'
  );
  __clearMetadataCacheForTests();
});
