import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // The database suites talk to a real Postgres and manipulate roles and
    // schemas. Running them in parallel would let one file's DDL race another's
    // assertions, so they are serialised.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/*.module.ts'],
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
