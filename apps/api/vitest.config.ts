import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 90000,
  },
});
