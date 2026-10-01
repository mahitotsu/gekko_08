import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
