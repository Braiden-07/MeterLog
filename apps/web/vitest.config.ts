import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    /**
     * `lib/**` IS LOAD-BEARING IN THIS LIST, AND ITS ABSENCE WAS A VACUITY BUG.
     *
     * The include pattern used to be `app/**` + `components/**` only, while the
     * pair `test` script carried `--passWithNoTests`. A spec under `lib/` — which
     * is where the cache-eviction proof lives, because it is deliberately not a
     * component — was collected by nothing, and the run exited 0 reporting
     * success. A security test that no runner picks up is worse than no test: it
     * reads as covered.
     *
     * `--passWithNoTests` is gone from the script for the same reason. An empty
     * frontend suite must now fail, so the next misplaced spec is loud.
     */
    include: ['app/**/*.spec.{ts,tsx}', 'components/**/*.spec.{ts,tsx}', 'lib/**/*.spec.{ts,tsx}'],
    // Playwright owns e2e; Vitest must not try to run those files.
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
