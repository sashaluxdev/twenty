import { defineConfig } from 'vitest/config';

// Integration tests — install the app on a live local workspace and exercise
// recompute end-to-end. Requires a running Twenty server and a configured
// remote (see src/__tests__/setup-test.ts).
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: ['src/**/*.integration-test.ts'],
    setupFiles: ['src/__tests__/setup-test.ts'],
    env: {
      TWENTY_API_URL: process.env.TWENTY_API_URL ?? 'http://127.0.0.1:3000',
      TWENTY_API_KEY: process.env.TWENTY_API_KEY ?? '',
    },
  },
});
