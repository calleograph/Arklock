import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'remote', include: ['*.test.ts'], testTimeout: 150000, hookTimeout: 30000 },
});
