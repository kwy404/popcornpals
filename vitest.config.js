import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.js'],
    environment: 'node',
    setupFiles: ['test/setup.js'],
    testTimeout: 20000,
  },
});
