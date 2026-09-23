import { expect, test } from '@playwright/test';

/**
 * THE DEPLOY SMOKE TEST — the acceptance gate for slice 1's same-origin proxy.
 *
 * ===================== WHAT THIS FILE IS FOR ===============================
 *
 * `ARCHITECTURE.md` §16.A lists four conditions the deployed session cookie
 * depends on, and closes by saying that until this test has run, "everything
 * above is a design rather than a result". `ISOLATION.md` §9 says the same from
 * the other side: a green E2E run is not evidence about the deployed cookie
 * posture, and step 10 owes a deploy smoke test that is. This is it.
 *
 * **EVERY ASSERTION NAMES THE PRECONDITION IT FALSIFIES.** The failure mode this
 * guards against is not a crash — it is "login silently fails on first deploy",
 * where each piece looks fine alone: login returns 200, the page renders, and
 * only the next call 401s. So a red result here must say WHICH of §16.A's
 * conditions did not hold, not merely which status code was wrong.
 *
 * ================= WHAT HAS NEVER RUN ANYWHERE, UNTIL THIS =================
 *
 * The cross-site rig in `apps/web/cross-site/` proves assertions 1, 2 (minus
 * `Secure`), 3, 4 and 5 on every pull request against real host aliases. It
 * cannot prove, and this file is the only thing that can:
 *
 *   - **`Secure`** — the rig is HTTP, and `secure` is gated on
 *     `NODE_ENV === 'production'` (§16.1 calls it unverifiable by CI by
 *     construction, and check (c) is what this automates).
 *   - **The build-time `API_ORIGIN` bake on Vercel** — `rewrites()` is compiled
 *     into the routing manifest at `next build`; a runtime-only value ships the
 *     localhost fallback and every API call fails. Measured locally and true:
 *     serving a build made with the default while passing a different runtime
 *     `API_ORIGIN` still proxied to the baked host.
 *   - **Real Vercel routing-layer proxying**, including `Set-Cookie` passing
 *     back through it intact.
 *   - **`NODE_ENV=production` on Render.**
 *   - **The production `X-Forwarded-For` hop count** — see assertion 6, which is
 *     deliberately NOT a green assertion.
 *
 * ====================== IT TOUCHES PRODUCTION STATE ========================
 *
 * Step 0 registers a real organisation through the live API. **Every run leaves
 * one tenant and one user in the production database, permanently** — v1.0 has
 * no hard delete (ADR-008), so they cannot be removed even in principle. That is
 * accepted rather than unnoticed, and the mitigation is legibility: every
 * identity created here carries a `smoke-` prefix and an `@smoke.invalid`
 * address, so the residue is greppable and unmistakably synthetic. `.invalid` is
 * a reserved TLD that can never resolve, so no mail can ever be sent to one.
 *
 * Registering per run rather than using a pre-provisioned account is deliberate:
 * it means the setup is itself an assertion that registration works in
 * production, and it keeps a long-lived production password out of CI secrets.
 */

/** Set by the workflow from its `render_url` input. Guarded before any test. */
const API_DIRECT = process.env.SMOKE_API_ORIGIN;

const PASSWORD = 'correct horse battery staple';

/** Greppable, obviously synthetic, and on a TLD that can never resolve. */
function smokeIdentity(): { email: string; tenantName: string } {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `smoke-${stamp}@smoke.invalid`,
    tenantName: `smoke-${stamp}`,
  };
}

test.describe.configure({ mode: 'serial' });

test.describe('deploy smoke — the deployed cross-origin cookie posture', () => {
  let email: string;

  test('0 — the inputs are present and well-formed', async ({ baseURL }) => {
    // THE STEP-ZERO GUARD. A smoke run that silently drops the negative control
    // is the VACUOUS version of itself, and it looks green — so a missing or
    // malformed input fails here, loudly, before anything else runs.
    expect(baseURL, 'SMOKE_BASE_URL (the vercel_url input) must be set').toBeTruthy();
    expect(API_DIRECT, 'SMOKE_API_ORIGIN (the render_url input) must be set').toBeTruthy();

    for (const [label, url] of [
      ['vercel_url', baseURL!],
      ['render_url', API_DIRECT!],
    ] as const) {
      expect(url, `${label} must be https — a plain-HTTP origin cannot carry a Secure cookie`)
        .toMatch(/^https:\/\//);
      expect(
        new URL(url).pathname,
        `${label} must stop at the origin: the paths are appended by the test`,
      ).toBe('/');
    }
  });

  test('1 — the document carries all five security headers on a live response', async ({
    request,
  }) => {
    // Closes the gap `security-headers.spec.ts` names against itself: it pins
    // the configuration and says the proof that the headers ARRIVE is owed to
    // the Playwright slice.
    const res = await request.get('/login');
    expect(res.status(), 'falsifies: the deployed web origin serves the login page').toBe(200);

    const headers = res.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['strict-transport-security']).toBe('max-age=31536000');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  test('2 — login sets HttpOnly · Secure · SameSite=Lax, with NO Domain', async ({
    browser,
    baseURL,
  }) => {
    // §16.1's check (c), automated. That check is a `curl … | grep set-cookie`
    // that must contain HttpOnly, Secure and SameSite=Lax; the NO-Domain half is
    // added here because it is what keeps the cookie HOST-ONLY, which assertion
    // 4 depends on and which nothing else would notice being widened.
    // `baseURL` from the fixture: a manual `browser.newContext()` does not
    // inherit the config's `use` options, so a relative path would throw
    // "Invalid URL" without it.
    const context = await browser.newContext({ baseURL });
    try {
      const identity = smokeIdentity();
      email = identity.email;

      const registered = await context.request.post('/api/v1/auth/register', {
        data: { ...identity, email, password: PASSWORD },
      });
      expect(
        registered.status(),
        'falsifies: the deployed API accepts a registration through the proxy — ' +
          'a non-201 here usually means API_ORIGIN is wrong or unset at BUILD time ' +
          '(§16.A condition 1), so the rewrite is pointing at the localhost fallback',
      ).toBe(201);

      const signedIn = await context.request.post('/api/v1/auth/login', {
        data: { email, password: PASSWORD },
      });
      expect(signedIn.status(), 'falsifies: login succeeds against the deployment').toBe(200);

      const raw = signedIn.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
      const cookieHeader = raw.map((h) => h.value).find((v) => v.startsWith('meterlog_sid='));
      expect(cookieHeader, 'falsifies: login sets meterlog_sid').toBeTruthy();

      expect(cookieHeader, 'falsifies: HttpOnly is set (§16.1 check c)').toMatch(/HttpOnly/i);
      expect(
        cookieHeader,
        'falsifies: §16.A condition 3 — NODE_ENV is literally "production" on Render, ' +
          'and condition 4 — the API origin terminates HTTPS. Without Secure, a signed ' +
          'session cookie can travel over a plain-HTTP hop.',
      ).toMatch(/;\s*Secure/i);
      expect(cookieHeader, 'falsifies: SameSite=Lax (§16.1 check c)').toMatch(/SameSite=Lax/i);
      expect(
        cookieHeader,
        'falsifies: the cookie is HOST-ONLY. A Domain= attribute means someone widened ' +
          'it, and assertion 4 below would then be meaningless.',
      ).not.toMatch(/;\s*Domain=/i);
    } finally {
      await context.close();
    }
  });

  test('3 — the cookie set through the proxy is sent back through it (THE POSTURE)', async ({
    browser,
    baseURL,
  }) => {
    // THE ASSERTION THE WHOLE SLICE EXISTS FOR. A real login through the
    // deployed Vercel origin, then a real API call through the same origin with
    // the SAME jar. This is what "the same-origin proxy works in production"
    // means, and it has never been true or false — only designed.
    const context = await browser.newContext({ baseURL });
    try {
      const identity = smokeIdentity();

      await context.request.post('/api/v1/auth/register', {
        data: { ...identity, password: PASSWORD },
      });
      const signedIn = await context.request.post('/api/v1/auth/login', {
        data: { email: identity.email, password: PASSWORD },
      });
      expect(signedIn.status()).toBe(200);

      const me = await context.request.get('/api/v1/auth/me');
      expect(
        me.status(),
        'falsifies: §16.A conditions 1 and 2 together — the session survives a round trip ' +
          'through the deployed proxy. A 401 here with a 200 above is the SILENT failure ' +
          'this test exists for: login appeared to work and the session did not stick, ' +
          'which is what a cross-SITE cookie looks like from the outside.',
      ).toBe(200);
      // Nested under `user` — `/auth/me` answers
      // `{ user, activeWorkspace, workspaces }`. Asserting the identity rather than
      // just the status is what stops a 200 carrying somebody else's session, or
      // nothing at all, from reading as success.
      expect(((await me.json()) as { user: { email: string } }).user.email).toBe(identity.email);

      // ASSERTION 4 — THE NEGATIVE CONTROL. The load-bearing half.
      //
      // The same jar, aimed DIRECTLY at Render. The cookie is host-only to the
      // Vercel origin, so it must not be sent and the API must refuse. Without
      // this, assertion 3 passes identically in a topology where the cookie is
      // cross-site and happens to work — and §16.A says so itself: "the third
      // assertion being what stops the first two passing for the wrong reason".
      const direct = await context.request.get(`${API_DIRECT}/api/v1/auth/me`);
      expect(
        direct.status(),
        'falsifies: the session cookie is NOT valid against Render directly. A 200 here ' +
          'means the cookie is reaching a second site — the browser is not confined to ' +
          'the web origin, and §16.A condition 2 does not hold in production.',
      ).toBe(401);
    } finally {
      await context.close();
    }
  });

  test('5 — the readiness probe answers through the deployment', async ({ request }) => {
    const res = await request.get('/api/v1/health/ready');
    expect(
      res.status(),
      'falsifies: the deployed API can reach Postgres AND Redis. A 503 here names ' +
        'which dependency is down in the body.',
    ).toBe(200);
    expect(await res.json()).toEqual({ ready: true, db: true, redis: true });
  });

  test('6 — X-Forwarded-For is SENT; what the API observed is a manual step', async ({
    browser,
    baseURL,
  }) => {
    // ============ NOT A GREEN ASSERTION, AND THAT IS THE HONEST SHAPE ========
    //
    // OPEN-16 is DONE by per-email limiting, but its record correction rests on
    // a probe that measured NEXT'S OWN rewrite in `next dev` and local
    // `next start` — it found a verbatim header relay with no hop to count. On
    // Vercel the rewrite is handled by the platform's ROUTING LAYER, which is
    // not the thing that was probed, and which plausibly adds its own
    // `x-forwarded-for`. That is unmeasured and measurable only here.
    //
    // THIS TEST CANNOT CLOSE IT, and pretending otherwise would be worse than
    // leaving it open. Nothing in the API reports the header back: pino-http
    // logs request headers (the redact list drops only `cookie` and
    // `authorization`, so a forged XFF lands intact), but reading that log is
    // the author's step, not an assertion's. The alternative — an endpoint that
    // echoes headers — is an app change AND an unauthenticated information leak,
    // so it is refused rather than deferred.
    //
    // What this test does is make the measurement CHEAP and REPEATABLE: it sends
    // a forged value that cannot occur naturally, then prints exactly where to
    // look for it.
    const forged = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: { 'x-forwarded-for': forged },
    });
    try {
      const identity = smokeIdentity();
      await context.request.post('/api/v1/auth/register', {
        data: { ...identity, password: PASSWORD },
      });

      // A deliberately FAILED login: the limiter charges only failures, so this
      // is the request guaranteed to produce a logged request line plus the
      // limiter's own `login.failure` event.
      const failed = await context.request.post('/api/v1/auth/login', {
        data: { email: identity.email, password: 'deliberately-wrong-password' },
      });
      expect(failed.status(), 'the probe request must be a failed login').toBe(401);

      // The only "assertion" is that the probe was issued. The finding is in the
      // log, and the instructions are the deliverable.
      console.log(
        [
          '',
          '═══ ASSERTION 6 — MANUAL STEP, OPEN-16 production nuance ═══',
          `A failed login was sent through the deployment carrying:`,
          `    X-Forwarded-For: ${forged}`,
          '',
          'NOW INSPECT THE RENDER REQUEST LOG for that value, and record which:',
          `  (a) the API observed exactly "${forged}"  -> Vercel is a verbatim relay,`,
          '        as measured locally. The per-email axis stays correct and OPEN-16',
          '        needs no change.',
          `  (b) the API observed "<vercel-ip>, ${forged}" or similar  -> Vercel APPENDS,`,
          '        so a real client IP exists at a FIXED hop from the right. An IP axis',
          '        becomes possible and OPEN-16 should be reopened to weigh it.',
          '  (c) no x-forwarded-for at all -> neither; record that too.',
          '',
          'Write the answer into OPEN-16 in docs/DECISIONS.md. Until then the',
          'production hop count is UNMEASURED, not "verbatim relay".',
          '═══════════════════════════════════════════════════════════',
          '',
        ].join('\n'),
      );
    } finally {
      await context.close();
    }
  });

  test('records the production residue this run created', async () => {
    // Said out loud, every run, because it is permanent. v1.0 has no hard
    // delete (ADR-008), so these rows cannot be removed even in principle.
    console.log(
      `\nThis run created smoke identities under @smoke.invalid (e.g. ${email}).\n` +
        `They are PERMANENT: v1.0 has no hard delete. Grep production for ` +
        `"smoke-" / "@smoke.invalid" to enumerate the residue.\n`,
    );
    expect(email).toContain('@smoke.invalid');
  });
});
