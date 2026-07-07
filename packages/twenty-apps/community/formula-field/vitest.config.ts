import { defineConfig } from 'vitest/config';

// Unit tests only — pure formula engine (tokenizer, parser, evaluator,
// dependency extraction, cycle detection). No server required.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    include: ['src/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['vitest.setup.ts'],
  },
});
