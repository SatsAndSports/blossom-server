import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    globalSetup: './tests/globalSetup.ts',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
