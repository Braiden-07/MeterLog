import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * LOGIN-CSRF — the cross-site posture PR's gate (PROJECT_BRIEF §11 step 9).
 *
 * THE ATTACK, PRECISELY. An attacker hosts a page that auto-submits a form:
 *
 *   <form action="https://app.example/api/v1/auth/login" method="POST">
 *     <input name="email"    value="attacker@evil.test">
 *     <input name="password" value="the attacker's own password">
 *   </form>
 *
 * The victim's browser performs a top-level cross-site POST. The response sets a
 * session cookie, and the victim is now browsing as the ATTACKER — every reading
 * they record, every asset they register, lands in the attacker's workspace, to
 * be collected at leisure. It is not account takeover in the usual direction; it
 * is the victim's WORK that is taken.
 *
 * WHY `SameSite=Lax` DOES NOT STOP IT, which is the part worth being exact
 * about, because the repo's recorded posture leans on Lax. Lax governs whether
 * an EXISTING cookie is SENT. This attack sends no cookie and needs none: it
 * ESTABLISHES one, and a `Set-Cookie` on a top-level navigation response is
 * accepted normally. The recorded posture's one condition — "every GET is safe"
 * — is also untouched, because this is a POST. Lax is simply not aimed at this.
 *
 * WHY THE FORM ENCODING IS THE WHOLE VECTOR. A cross-site `fetch` carrying
 * `application/json` is NOT a simple request: it triggers a CORS preflight, and
 * the attacker's origin is not on the allow-list. An HTML form cannot send JSON
 * at all — it is limited to `application/x-www-form-urlencoded`,
 * `multipart/form-data` and `text/plain`, none of which preflight. So the
 * question that decides whether this attack exists is narrow and mechanical:
 * **does the API parse a form-encoded body?**
 *
 * Nest's Express adapter enables BOTH `json()` and `urlencoded()` unless told
 * otherwise, and `main.ts` passed no `bodyParser` option. `LoginDto` is two
 * plain strings. So it did.
 */
describe('login-CSRF — a cross-site form POST must not establish a session', () => {
  let app: INestApplication;
  let migrator: PrismaClient;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';
  const ATTACKER = 'attacker@evil.test';

  beforeAll(async () => {
    loadEnv();
    migrator = migratorClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    // THE SAME PIPELINE PRODUCTION RUNS, and here that is not a nicety — it is
    // what makes this file's result mean anything. The mitigation is a
    // body-parser choice; a test app that built its own parsers would be
    // asserting against a boundary production does not have (src/bootstrap.ts).
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await app.close();
    await migrator.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(migrator);
  });

  /** A real, log-in-able account for the attacker to log the victim into. */
  async function seedAttacker(): Promise<void> {
    await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: 'Evil Corp', email: ATTACKER, password: PASSWORD })
      .expect(201);
  }

  const sessionCookie = (res: request.Response): string | undefined => {
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    return setCookie?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  };

  /**
   * The cross-site form POST, exactly as a browser would send it.
   *
   * `Origin` and `Sec-Fetch-Site` are set to what a real cross-site navigation
   * carries. The server reads neither today — they are here so the simulation is
   * honest about what it claims to be, and so a future origin check has a test
   * already sending the header it would key on.
   */
  const crossSiteFormLogin = () =>
    http()
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Sec-Fetch-Mode', 'navigate')
      .type('form')
      .send({ email: ATTACKER, password: PASSWORD });

  it('the fixture is real — the same credentials DO work as JSON', async () => {
    // Non-vacuity, and it is load-bearing in both directions. Without it, a
    // rejection below could mean "the account does not exist" or "the password
    // is wrong" rather than "form encoding is refused", and the whole file would
    // prove nothing about the vector it claims to close.
    await seedAttacker();

    const legitimate = await http()
      .post('/api/v1/auth/login')
      .send({ email: ATTACKER, password: PASSWORD })
      .expect(200);

    expect(sessionCookie(legitimate), 'a JSON login must establish a session').toBeDefined();
  });

  it('THE GATE — a cross-site FORM-ENCODED login is refused and sets no cookie', async () => {
    await seedAttacker();

    const res = await crossSiteFormLogin();

    // 400: the form body is never parsed, so `email` and `password` are absent
    // and the DTO refuses at the boundary — the same shape as any other
    // malformed request (`forbidNonWhitelisted`), not a bespoke CSRF branch.
    expect(res.status, 'a form-encoded login must be refused').toBe(400);

    // AND THE ASSERTION THAT ACTUALLY MATTERS. A non-200 alone is not the
    // property: what must be true is that NO SESSION WAS ESTABLISHED. A refusal
    // that still set a cookie would be the vulnerability with a red status code.
    expect(
      sessionCookie(res),
      'no session may be established by a cross-site form POST',
    ).toBeUndefined();
  });

  it('the refusal is the PARSER, not the credentials — a form post with VALID json-shaped data also fails', async () => {
    // Disambiguation, the 42501 lesson applied to HTTP: "it was rejected" is not
    // evidence of WHY. If the refusal came from bad credentials rather than the
    // encoding, this test would still pass above while the vector stayed open
    // for an attacker who owns a real account — which is precisely the attacker
    // in this threat model. So: real account, real password, form encoding, and
    // the 400 is therefore attributable to the encoding alone.
    await seedAttacker();

    const res = await crossSiteFormLogin();
    expect(res.status).toBe(400);

    // The same request, JSON-encoded and otherwise byte-identical, succeeds.
    const asJson = await http()
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: ATTACKER, password: PASSWORD })
      .expect(200);
    expect(sessionCookie(asJson)).toBeDefined();
  });

  it('a legitimate JSON login still works — the floor did not break the front door', async () => {
    // The fix must not be satisfiable by breaking login for everybody. This is
    // the assertion that goes red if `json()` is ever dropped along with
    // `urlencoded()`.
    await seedAttacker();

    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email: ATTACKER, password: PASSWORD })
      .expect(200);

    expect(sessionCookie(res)).toBeDefined();
    expect(res.body.user.email).toBe(ATTACKER);
    expect(res.body.activeWorkspace.name).toBe('Evil Corp');
  });

  /**
   * ============== OPEN-20 — THE OTHER HALF OF THE SAME POSTURE ==============
   *
   * These live beside the login-CSRF tests rather than in a file of their own
   * because they are not a separate concern: the JSON floor above and the
   * absence of CORS below close one threat from opposite ends, and each is
   * insufficient alone.
   *
   *   - CORS never stopped the form POST. A top-level form submission is not
   *     subject to the same-origin policy at all; the allow-list was never in
   *     that request's path.
   *   - The JSON floor never stopped a preflighted `fetch` from an ALLOW-LISTED
   *     origin. While `credentials: true` named an origin, that origin could
   *     send `application/json` cross-site with the cookie attached.
   *
   * With both changes there is no cross-origin path to a state-changing route:
   * the no-preflight encodings are unparsed, and the preflighting one is refused
   * by a browser that gets no `Access-Control-Allow-Origin` back.
   */
  describe('no credentialed CORS (OPEN-20)', () => {
    it('a cross-origin preflight is not answered with permission', async () => {
      // THE NEGATIVE THE DELETION EARNS. An `OPTIONS` preflight for a
      // credentialed cross-origin POST must come back WITHOUT the two headers a
      // browser requires before it will send the real request. Asserting their
      // ABSENCE is the whole point — a 200/204 status alone says nothing,
      // because a preflight with no permission headers is still a valid HTTP
      // response; it is the missing headers that make the browser refuse.
      const res = await http()
        .options('/api/v1/auth/login')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

      expect(
        res.headers['access-control-allow-origin'],
        'no origin may be allow-listed — the browser is same-origin via the rewrite',
      ).toBeUndefined();
      expect(
        res.headers['access-control-allow-credentials'],
        'credentialed cross-origin access must not be advertised',
      ).toBeUndefined();
    });

    it('the formerly allow-listed origin gets no special treatment either', async () => {
      // NON-VACUITY, and it is the assertion that would have caught a partial
      // removal. `http://localhost:3000` was the default allow-list entry, so a
      // test using some arbitrary origin would pass even if the allow-list were
      // still installed. This uses the exact origin that USED to be privileged.
      const res = await http()
        .post('/api/v1/auth/login')
        .set('Origin', 'http://localhost:3000')
        .send({ email: 'nobody@acme.test', password: 'wrong password entirely' });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('same-origin requests are unaffected — the rewrite path still works', async () => {
      // Removing CORS must not break the actual client. The browser reaches the
      // API through the Next rewrite, so its requests carry no `Origin` that
      // matters and never needed CORS in the first place. This is the proof that
      // the deletion cost nothing.
      await seedAttacker();

      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: ATTACKER, password: PASSWORD })
        .expect(200);
      expect(sessionCookie(res)).toBeDefined();
    });
  });

  it('the floor covers every state-changing route, not just login', async () => {
    // `POST /auth/login` is the highest-severity instance, not the only one. A
    // form-encoded POST to `register` would create an organisation; the parser
    // choice is global, so this asserts the floor is global too rather than a
    // patch on one handler.
    const res = await http()
      .post('/api/v1/auth/register')
      .type('form')
      .send({ tenantName: 'Drive-by Ltd', email: 'drive-by@evil.test', password: PASSWORD });

    expect(res.status).toBe(400);

    const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM public.users WHERE email = 'drive-by@evil.test'::citext`,
    );
    expect(row!.n, 'a form-encoded register must not create anything').toBe(0);
  });
});
