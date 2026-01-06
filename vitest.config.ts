import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    globalSetup: './tests/globalSetup.ts',
    testTimeout: 30000,
    hookTimeout: 30000,
    // Run test files sequentially to avoid overwhelming the single test server
    // and to ensure the file-scoped fixture doesn't have race conditions
    fileParallelism: false,
  },
});
