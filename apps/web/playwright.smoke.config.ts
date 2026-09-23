import { defineConfig } from '@playwright/test';

/**
 * THE DEPLOY SMOKE TEST — a SEPARATE config, and the separation is structural.
 *
 * ================= WHY NOT A PROJECT IN `playwright.config.ts` =============
 *
 * `webServer` there is TOP-LEVEL, and Playwright has no per-project `webServer`.
 * A project added to that config inherits both local servers — so running the
 * smoke test against a deployed URL would first build nothing, boot the API and
 * `next start`, and require a local Postgres and Redis, in order to make HTTP
 * calls to a machine on the internet. This config declares no `webServer` at
 * all: every target is remote, supplied by the workflow.
 *
 * =========================== IT RUNS ON DEMAND =============================
 *
 * Entered by `workflow_dispatch` only (`.github/workflows/smoke.yml`). Never on
 * push, and never a required status check. The first run is EXPECTED to possibly
 * fail, and that failure is the finding — wiring it to a deploy would turn an
 * acceptance gate into an incident.
 *
 * ===================== TWO SETTINGS DIFFER, ON PURPOSE =====================
 *
 * `retries: 0` — the main config retries twice in CI, which is right for a
 * browser journey against a disposable database and wrong here: a retry would
 * re-run a registration and a login against PRODUCTION, leaving more residue
 * and possibly charging the login rate limiter for an address it just created.
 *
 * `fullyParallel: false` — the assertions are ordered and stateful. Assertion 3
 * depends on the cookie jar assertion 2 filled; running them concurrently would
 * make the result depend on scheduling.
 */
export default defineConfig({
  testDir: './smoke',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // One worker, because the file is a sequence rather than a set.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    // Supplied by the workflow. There is deliberately NO default: a smoke test
    // that silently falls back to localhost would report a healthy deployment
    // after testing a machine that is not deployed.
    baseURL: process.env.SMOKE_BASE_URL,
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
});
