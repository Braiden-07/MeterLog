import { expect, test } from '@playwright/test';

import { PASSWORD, unique } from '../e2e/fixtures';

/**
 * THE CROSS-SITE RIG — the half of the deploy debt CI can pay.
 *
 * ===================== WHAT THIS EXISTS TO CATCH ===========================
 *
 * `ISOLATION.md` §9 records that a green E2E run is not evidence about the
 * deployed cookie posture, because both apps run on `localhost` there and a PORT
 * does not change the SITE. This project drives the same app through hostnames
 * that are genuinely different registrable domains, so the browser's same-site
 * computation does real work — and the regression in §16.A condition 2 ("nothing
 * in the browser addresses Render") becomes catchable on every pull request
 * instead of on a deploy.
 *
 * ================ WHAT IT PROVES AND WHAT IT HAS NEVER RUN =================
 *
 * Stated here because a green result that is read as more than it is would be
 * worse than no result. Of the smoke test's six assertions:
 *
 *   1  five document headers on a live response .............. PROVEN HERE
 *   2  HttpOnly · SameSite=Lax · no Domain .................... PROVEN HERE
 *   2  **Secure** .............................................. NEVER RUN
 *   3  the cookie survives the proxy round trip ............... PROVEN HERE
 *   4  the API refuses a cookie sent to it directly ........... PROVEN HERE
 *   5  /health/ready answers ................................... PROVEN HERE
 *   6  the production X-Forwarded-For hop count ................ NEVER RUN
 *      build-time API_ORIGIN bake on Vercel ................... NEVER RUN
 *      real Vercel routing-layer proxying ..................... NEVER RUN
 *      NODE_ENV=production on Render .......................... NEVER RUN
 *
 * `Secure` cannot run here and the reason is not laziness: this rig is HTTP, a
 * `Secure` cookie is never sent over HTTP, and forcing `NODE_ENV=production` to
 * make the flag appear would mean the cookie is never sent at all — the exact
 * trap `ci.yml` documents for the main e2e job. The four NEVER RUN lines are the
 * deploy smoke test's, and they are settled by RUN-1 against a real deployment,
 * not here.
 *
 * ================= THE ALIASES ARE THE WHOLE MECHANISM =====================
 *
 * `web.test` and `api.test` are each their own registrable domain. Grouping them
 * under a shared parent — `web.meterlog.test` / `api.meterlog.test` — would give
 * both an eTLD+1 of `meterlog.test`, make them the SAME site, and turn every
 * assertion below into a tautology that passes while proving nothing. The
 * config comment carries the full argument; it is repeated here because this is
 * the file someone edits when they want the names to read better.
 */

/** Where the API is reachable directly — a different SITE from the web origin. */
const API_DIRECT = process.env.CROSS_SITE_API_ORIGIN ?? 'http://api.test:3001';

/**
 * The rig needs two things the test cannot create: `web.test` resolving for the
 * browser (Chromium's `--host-resolver-rules` handles that) and `api.test`
 * resolving for the NEXT SERVER, which needs real OS resolution because the
 * rewrite is a server-side fetch.
 *
 * WHEN IT IS MISSING, THE BEHAVIOUR DIFFERS BY ENVIRONMENT, DELIBERATELY. In CI
 * the aliases are always added, so an unreachable proxy is a REGRESSION and the
 * run fails. Locally it is almost always a hosts file nobody has edited, so the
 * run skips with a message naming the fix — rather than failing with a proxy
 * error that looks nothing like its cause. A skip that could hide a regression
 * in CI would be the wrong trade; this one cannot, because CI never takes it.
 */
test.beforeAll(async ({ request }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL!;
  let reachable = false;
  try {
    const probe = await request.get(`${baseURL}/api/v1/health`);
    reachable = probe.ok();
  } catch {
    reachable = false;
  }

  if (!reachable && !process.env.CI) {
    test.skip(
      true,
      `the cross-site rig needs host aliases. Add to your hosts file:\n` +
        `  127.0.0.1 web.test\n  127.0.0.1 api.test\n` +
        `and rebuild the web app with API_ORIGIN=${API_DIRECT}.`,
    );
  }

  expect(
    reachable,
    `the proxy at ${baseURL} could not reach the API. In CI this is a REGRESSION, ` +
      `not a missing hosts entry — the workflow adds the aliases before this runs.`,
  ).toBe(true);
});

test.describe('the session cookie across a real site boundary', () => {
  test('the document carries all five security headers on a live response', async ({ request }) => {
    // ASSERTION 1. `security-headers.spec.ts` pins the CONFIGURATION and says in
    // its own header that it "does NOT prove the headers arrive on a live
    // response… That proof is owed to the Playwright slice". This is that proof.
    const res = await request.get('/login');
    expect(res.status()).toBe(200);

    const headers = res.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['strict-transport-security']).toBe('max-age=31536000');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  test('login sets a host-only Lax cookie, and it survives the proxy round trip', async ({
    browser,
    baseURL,
  }) => {
    // `baseURL` COMES FROM THE FIXTURE, NOT FROM `process.env`. A manual
    // `browser.newContext()` does NOT inherit the project's `use` options, so
    // the baseURL has to be passed in — and reading it from an env var instead
    // sets it to `undefined` wherever that var is unset, which is every machine
    // except the one where it was written. CI found exactly that.
    const context = await browser.newContext({ baseURL });
    try {
      const email = `smoke-${unique('crosssite')}@smoke.invalid`;

      // Step 0 — a real registration through the real proxy. The same shape the
      // e2e fixtures use, and for the same reason: a row inserted behind the
      // API's back would be the one thing here that had never met RLS.
      const registered = await context.request.post('/api/v1/auth/register', {
        data: { tenantName: unique('crosssite-org'), email, password: PASSWORD },
      });
      expect(registered.status(), 'registration must succeed through the proxy').toBe(201);

      // ASSERTION 2 (minus Secure — see the file header). The cookie must be
      // HttpOnly, SameSite=Lax, and carry NO Domain: no Domain is what makes it
      // HOST-ONLY, and host-only is what assertion 4 below depends on.
      const signedIn = await context.request.post('/api/v1/auth/login', {
        data: { email, password: PASSWORD },
      });
      expect(signedIn.status(), 'login must succeed through the proxy').toBe(200);

      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === 'meterlog_sid');
      expect(session, 'login must set meterlog_sid').toBeDefined();
      expect(session!.httpOnly, 'falsifies: the cookie is HttpOnly').toBe(true);
      expect(session!.sameSite, 'falsifies: the cookie is SameSite=Lax').toBe('Lax');
      // Host-only presents as a leading-dot-free domain equal to the host.
      expect(session!.domain, 'falsifies: nobody widened the cookie with a Domain').not.toMatch(
        /^\./,
      );

      // ASSERTION 3 — THE POSTURE. A cookie set THROUGH the proxy is sent back
      // THROUGH it. This is §16.A condition 1's local analogue: if the proxy
      // were not in the path, this is where it would 401.
      const me = await context.request.get('/api/v1/auth/me');
      expect(me.status(), 'falsifies: the proxy carries the session both ways').toBe(200);
      // `/auth/me` returns `{ user, activeWorkspace, workspaces }` — the identity
      // is NESTED, and asserting the wrong shape is how this test would pass on a
      // 200 that carried nothing.
      expect(((await me.json()) as { user: { email: string } }).user.email).toBe(email);

      // ASSERTION 4 — THE NEGATIVE CONTROL, and the load-bearing half.
      //
      // The SAME jar, aimed DIRECTLY at the API on a different registrable
      // domain. The cookie is host-only to the web origin, so it is not sent,
      // and the API answers 401. Without this, assertion 3 would pass just as
      // happily in a topology where the cookie was cross-site and working for
      // the wrong reason — which is precisely the deployed shape this whole rig
      // exists to distinguish from the local one.
      //
      // It is also the permanent guard for §16.A condition 2: if anyone ever
      // gives the browser an absolute API origin, `credentials: 'same-origin'`
      // means the cookie stops being sent and the app 401s loudly, here.
      const direct = await context.request.get(`${API_DIRECT}/api/v1/auth/me`);
      expect(
        direct.status(),
        'falsifies: a session cookie is NOT valid against the API directly — ' +
          'if this is 200, the cookie is reaching a different site and the ' +
          'topology is not what ARCHITECTURE §16.A describes',
      ).toBe(401);
    } finally {
      await context.close();
    }
  });

  test('the readiness probe answers through the proxy', async ({ request }) => {
    // ASSERTION 5. Unauthenticated, booleans only.
    const res = await request.get('/api/v1/health/ready');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ready: true, db: true, redis: true });
  });
});
