import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  test: {
    environment: 'node',
    hookTimeout: 60_000,
    testTimeout: 30_000,
    maxWorkers: 4,
  },
});
