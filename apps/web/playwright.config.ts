import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

/** The repo root. Both servers are started from here — see `webServer` below. */
const REPO_ROOT = resolve(__dirname, '..', '..');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  /**
   * On CI, BOTH reporters, and the html one is not decoration.
   *
   * `github` annotates the failing line in the PR diff, which is what you want
   * while reading the run. It writes no files — so the workflow's
   * "Upload Playwright report" step found nothing to upload and said so, an
   * artifact step that could never produce an artifact. Adding `html` gives that
   * step something real: on a red gate you download the report and get the
   * failure with its trace (`trace: 'on-first-retry'` above) instead of
   * re-running locally and hoping it reproduces.
   *
   * `open: 'never'` because nothing can open a browser on a runner.
   */
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },

  /**
   * TWO PROJECTS, AND THE SECOND ONE IS A DIFFERENT SITE.
   *
   * ================ WHY `localhost` CANNOT TEST WHAT DEPLOYS =================
   *
   * Everything above runs on `localhost`, where `:3000` and `:3001` differ only
   * by PORT — and a port does not change the SITE. So the session cookie is
   * same-site throughout, no matter how the app is configured, and a green run
   * here is not evidence about the deployed Vercel→Render topology.
   * `ISOLATION.md` §9 says exactly that and owes a deploy smoke test.
   *
   * The `cross-site` project is the half of that debt CI can pay. It drives the
   * SAME app through hostnames that are genuinely different sites, so the
   * browser's same-site computation does real work.
   *
   * ============ THE ALIASES MUST DIFFER AT THE REGISTRABLE DOMAIN ============
   *
   * `web.test` and `api.test`, NOT `web.meterlog.test` and `api.meterlog.test`.
   *
   * Same-site is computed on the registrable domain (eTLD+1), not on the
   * hostname. `.test` is a reserved TLD and is not a multi-label public suffix,
   * so `web.test` and `api.test` are each their OWN registrable domain — two
   * different sites. Under `meterlog.test` both would share an eTLD+1 of
   * `meterlog.test`, making them the SAME site, and every assertion in this
   * project would pass while proving nothing at all.
   *
   * **That is the tidy-up to refuse.** Grouping the two under one parent domain
   * is the obvious readability improvement and it silently converts this project
   * into a tautology — green, fast, and blind to the exact regression it exists
   * to catch. If these names ever change, the replacement pair must still be two
   * distinct registrable domains.
   *
   * ================= WHAT THE RIG PROVES, AND WHAT IT CANNOT ================
   *
   * PROVES: the topology holds across a real site boundary, and — the reason it
   * earns its place — that nothing in the browser addresses the API directly
   * (§16.A condition 2). If an absolute API origin were ever introduced,
   * `credentials: 'same-origin'` means the cookie is not sent AT ALL and the
   * call 401s loudly, here, on every pull request, forever.
   *
   * CANNOT PROVE, and the smoke test owes all of it: `Secure` (this rig is HTTP,
   * and forcing `NODE_ENV=production` to get the flag would mean the cookie is
   * never sent — the trap `ci.yml` documents), Vercel's BUILD-TIME `API_ORIGIN`
   * bake, real Vercel proxying, and `NODE_ENV` on Render.
   *
   * ===================== IT NEEDS A BUILD OF ITS OWN ========================
   *
   * `rewrites()` is baked into `.next/routes-manifest.json` at `next build` and
   * a runtime `API_ORIGIN` is IGNORED — measured, not assumed: serving a build
   * made with the default while passing `API_ORIGIN=http://127.0.0.1:3999` still
   * proxied to `:3001`. So this project needs the web app built with
   * `API_ORIGIN=http://api.test:3001`, which is why CI gives it its own job
   * rather than folding it into `e2e`. (That measurement independently confirms
   * `ARCHITECTURE.md` §16.A's first condition, which had been reasoned rather
   * than tested.)
   *
   * SKIPS ITSELF, LOUDLY, when the aliases do not resolve — a developer who has
   * not edited their hosts file gets a named skip rather than a proxy error that
   * looks nothing like its cause. CI always adds them, so the guard cannot hide
   * a regression where it matters.
   */
  projects: [
    {
      name: 'e2e',
      testDir: './e2e',
    },
    {
      name: 'cross-site',
      testDir: './cross-site',
      use: {
        baseURL: process.env.CROSS_SITE_BASE_URL ?? 'http://web.test:3000',
        // Chromium resolves the aliases itself, so the BROWSER half works even
        // where the hosts file has not been edited. The Next server still needs
        // real OS resolution for `api.test`, which is why the spec probes and
        // skips rather than assuming both halves are present.
        launchOptions: {
          args: ['--host-resolver-rules=MAP web.test 127.0.0.1, MAP api.test 127.0.0.1'],
        },
      },
    },
  ],

  /**
   * PLAYWRIGHT OWNS THE APP LIFECYCLE — both halves, started and stopped for the
   * run. There is no "start the servers first" step, locally or in CI, because a
   * harness that depends on a human having done something is a harness that goes
   * green against yesterday's build.
   *
   * ================= BOTH RUN FROM THE REPO ROOT, DELIBERATELY ================
   *
   * `cwd: REPO_ROOT` is not tidiness. `ConfigModule.forRoot({ isGlobal: true })`
   * resolves `.env` relative to the PROCESS CWD, and the only `.env` in this repo
   * is the root one — there is no `apps/api/.env`. Started from `apps/api` the
   * API would find no file, fall back to an unset `DATABASE_URL`, and fail to
   * boot with an error about the database rather than about the working
   * directory. In CI the job env already populates `process.env` and ConfigModule
   * does not override what is already set, so the same command is correct in both
   * places for two different reasons.
   *
   * ===================== THEY RUN THE BUILT ARTEFACTS =========================
   *
   * `node apps/api/dist/main.js` and `next start`, not the dev servers: the
   * journeys should exercise what deploys, and `next dev` differs from
   * `next start` in ways that matter here (no production build, different caching).
   * Both therefore require `npm run build` first — CI runs it as its own step, and
   * `ISOLATION.md` §10 records it for a local run.
   *
   * `reuseExistingServer` is on locally: a developer with `npm run dev` already up
   * gets their running servers reused instead of a port clash. In CI it is off, so
   * a stray process can never silently serve a stale bundle to the gate.
   *
   * ================ THE API PROBE IS /health, NOT THE PORT ====================
   *
   * A port opens before Nest has finished wiring. Probing `/api/v1/health` waits
   * for a request the app can actually answer, which is what "ready" has to mean
   * when the very first thing every journey does is register an organisation.
   *
   * ============ `NODE_ENV` IS PINNED ON THE API, AND ONLY ON THE API =========
   *
   * The session cookie is `secure: NODE_ENV === 'production'`
   * (auth.controller.ts). A `Secure` cookie is not sent over `http://localhost`,
   * so a production-mode API here would mean every journey silently fails to
   * authenticate — and `addCookies` in the two-context test would be rejected for
   * the same reason. `NODE_ENV=production` alongside `node dist/main.js` is a
   * reflex, so it is pinned rather than inherited.
   *
   * It is pinned HERE rather than job-wide in ci.yml because `next start` manages
   * its own `NODE_ENV` and expects a production build; a global override would
   * reach the web server too and change what it serves. The process that cares is
   * the API, so the pin sits on the API.
   */
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      cwd: REPO_ROOT,
      url: 'http://localhost:3001/api/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { NODE_ENV: 'test' },
    },
    {
      command: 'npx next start -p 3000',
      cwd: resolve(REPO_ROOT, 'apps', 'web'),
      url: 'http://localhost:3000/login',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
