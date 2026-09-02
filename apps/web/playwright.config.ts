import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // No journeys yet; the two required by PROJECT_BRIEF §12 land at step 9.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
});
