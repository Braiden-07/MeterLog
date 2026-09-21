import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import { LOGIN_FAILURE_LIMIT } from '../../src/common/rate-limit/login-rate-limit.service';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * LOGIN RATE LIMITING — OPEN-16, over real HTTP through the real pipeline.
 *
 * ============== THE ROW'S MECHANISM CHANGED, AND THIS IS WHY ================
 *
 * OPEN-16 owed a limiter keyed on the client IP, "trusting `X-Forwarded-For`
 * with a FIXED trusted-hop count". The orientation probe for this PR put the
 * real `apps/web/next.config.mjs` rewrite in front of an echo origin and
 * measured what arrives, in `next dev` and in a production `next build` +
 * `next start`:
 *
 *   client sends nothing          -> API sees NO x-forwarded-for
 *   client forges `1.2.3.4`       -> API sees exactly `1.2.3.4`
 *   client forges a 2-hop chain   -> arrives verbatim, nothing appended
 *
 * Next's rewrite is a VERBATIM HEADER RELAY. There is no trustworthy client IP
 * at the API and no hop to count, so the named mechanism cannot work — and
 * implemented anyway it would bucket on attacker-controlled input, which is
 * worse than not limiting at all. The limiter is keyed on the EMAIL instead.
 *
 * ===================== WHAT THESE TESTS PIN =================================
 *
 * The MECHANISM — how the bucket key is derived — and never a hop number,
 * because in this design no hop number exists. Test (i) is the direct
 * encoding of the probe finding: vary the forged header however you like, the
 * bucket does not move, because the limiter never reads it.
 */
describe('login rate limiting (OPEN-16 — per-email, the XFF fallback branch)', () => {
  let app: INestApplication;
  let migrator: PrismaClient;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';
  const WRONG = 'not the password at all';

  const VICTIM = 'victim@acme.test';
  const BYSTANDER = 'bystander@acme.test';

  beforeAll(async () => {
    loadEnv();
    migrator = migratorClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    // The SAME pipeline production runs. For this file that is the whole point:
    // the limiter is mounted by `configureApp`, so a test app that built its own
    // middleware stack would be asserting against a limiter that is not there.
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await app.close();
    await migrator.$disconnect();
  });

  beforeEach(async () => {
    // Clears the login-failure buckets too — they are Redis state that TRUNCATE
    // cannot reach, so the shared teardown owns them rather than this file
    // keeping its own list of fixture emails (test/db/helpers.ts).
    await resetDatabase(migrator);

    // Two real accounts, in two tenants, so "email B still works" is a statement
    // about the limiter and not about one of them failing to exist.
    await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: 'Acme Metering', email: VICTIM, password: PASSWORD })
      .expect(201);
    await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: 'Bystander Ltd', email: BYSTANDER, password: PASSWORD })
      .expect(201);
  });

  /** One failed attempt, optionally carrying a forged `X-Forwarded-For`. */
  async function failLogin(email: string, forgedXff?: string): Promise<number> {
    const req = http().post('/api/v1/auth/login');
    if (forgedXff !== undefined) req.set('X-Forwarded-For', forgedXff);
    const res = await req.send({ email, password: WRONG });
    return res.status;
  }

  it('the fixture is real — a correct password logs in, and a wrong one is a plain 401', async () => {
    // Non-vacuity. Every test below reads a 429 as "the limiter fired"; if the
    // route were broken outright, those would pass for the wrong reason.
    const ok = await http().post('/api/v1/auth/login').send({ email: VICTIM, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(
      (ok.headers['set-cookie'] as unknown as string[] | undefined)?.some((c) =>
        c.startsWith(`${SESSION_COOKIE}=`),
      ),
    ).toBe(true);

    const bad = await http().post('/api/v1/auth/login').send({ email: VICTIM, password: WRONG });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it(`refuses the attempt after ${LOGIN_FAILURE_LIMIT} failures, in the project error envelope`, async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      expect(await failLogin(VICTIM), `attempt ${i + 1} should still be a plain 401`).toBe(401);
    }

    const refused = await http().post('/api/v1/auth/login').send({ email: VICTIM, password: WRONG });
    expect(refused.status).toBe(429);
    // The middleware runs UPSTREAM of HttpExceptionFilter, so it writes this
    // envelope itself. A client must not need a second parser for one API.
    expect(refused.body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' },
    });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('(i) a forged X-Forwarded-For does NOT buy a fresh bucket — a different one on every attempt', async () => {
    // THE PROBE FINDING, ENCODED. Next relays whatever XFF the caller typed, so
    // an IP-keyed limiter would see a brand-new client each time and never fire.
    // This limiter reads no header at all, so the bucket is unmoved.
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      const forged = `203.0.113.${i + 1}`;
      expect(await failLogin(VICTIM, forged), `attempt ${i + 1} from forged ${forged}`).toBe(401);
    }

    const refused = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.77')
      .send({ email: VICTIM, password: WRONG });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');

    // And a multi-hop chain does no better — there is no depth at which the
    // limiter starts reading it.
    const chained = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '8.8.8.8, 7.7.7.7, 6.6.6.6')
      .send({ email: VICTIM, password: WRONG });
    expect(chained.status).toBe(429);
  });

  it('(ii) it is not a shared bucket — exhausting one email leaves another untouched', async () => {
    // The negative that makes the per-email axis meaningful rather than a global
    // ceiling by another name. A global counter WOULD fail this test, which is
    // why one is refused outright (see the service comment): it would hand any
    // anonymous caller a site-wide login outage.
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      expect(await failLogin(VICTIM)).toBe(401);
    }
    expect(await failLogin(VICTIM), 'the victim is now over budget').toBe(429);

    // Same connection, same (absent) XFF, different email.
    const bystanderFails = await http()
      .post('/api/v1/auth/login')
      .send({ email: BYSTANDER, password: WRONG });
    expect(bystanderFails.status, 'a bystander must still REACH the handler').toBe(401);
    expect(bystanderFails.body.error.code).toBe('INVALID_CREDENTIALS');

    const bystanderSucceeds = await http()
      .post('/api/v1/auth/login')
      .send({ email: BYSTANDER, password: PASSWORD });
    expect(bystanderSucceeds.status, 'and must still be able to log in').toBe(200);
  });

  it('(iii) failures only — a successful login does not consume budget', async () => {
    // One short of the limit, so the very next charge would tip it over.
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i += 1) {
      expect(await failLogin(VICTIM)).toBe(401);
    }

    // If a success were charged, the bucket would now be full and the SECOND
    // success below would be refused. It must not be: a user who finally
    // remembers their password has to stay logged in.
    const first = await http().post('/api/v1/auth/login').send({ email: VICTIM, password: PASSWORD });
    expect(first.status).toBe(200);

    const second = await http()
      .post('/api/v1/auth/login')
      .send({ email: VICTIM, password: PASSWORD });
    expect(second.status, 'a success charged the bucket — budget is being spent on good logins').toBe(
      200,
    );

    // The budget is still there and still real: one more FAILURE tips it, and
    // the one after that is refused. Proves the success was free without also
    // proving the limiter stopped working.
    expect(await failLogin(VICTIM)).toBe(401);
    expect(await failLogin(VICTIM)).toBe(429);
  });

  it('(iv) CROSS-PR — a form-encoded login is still 1a’s clean 400, not a 500', async () => {
    // THE ONLY TEST WHERE 1a AND 1b INTERACT.
    //
    // 1a's floor (`bodyParser: false` + `json()` only) leaves a form-encoded POST
    // deliberately UNPARSED so the DTO refuses it and the caller gets an ordinary
    // 400 — that IS the login-CSRF mitigation. 1b then derives its bucket key
    // from the body, so it is positioned to break that 400 if it reaches into a
    // body that was never parsed.
    //
    // THIS IS A REGRESSION GUARD, NOT A RED-THEN-GREEN NEGATIVE, and saying so
    // matters. It passes both with and without the limiter, by design: its job is
    // to prove 1b did not damage 1a. It was checked against the naive
    // implementation too — dropping the object check in `emailFromBody` does NOT
    // make it red, because body-parser sets `req.body = {}` before its skip
    // branches (`lib/types/json.js:108`), so the naive read yields `undefined`
    // rather than throwing. The guard is retained as defence against a dependency
    // internal, not as a fix for a live 500.
    //
    // Asserted here rather than left to `login-csrf.spec.ts` because that file
    // knows nothing about the limiter; this one is where the interaction is
    // named.
    const res = await http()
      .post('/api/v1/auth/login')
      .type('form')
      .send({ email: VICTIM, password: PASSWORD });

    expect(res.status, 'the limiter must not convert 1a’s 400 into a 500').toBe(400);
    expect(res.headers['set-cookie'], 'and certainly must not issue a session').toBeUndefined();

    // Unparseable requests are not charged either — there is no account being
    // guessed at, so there is nothing to bill. A legitimate login still works
    // immediately afterwards.
    const ok = await http().post('/api/v1/auth/login').send({ email: VICTIM, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('the key is the normalised email — case and surrounding space do not mint a new bucket', async () => {
    // Otherwise `Victim@Acme.test ` is a free second budget, and the per-email
    // axis is defeated by the shift key.
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      expect(await failLogin(VICTIM)).toBe(401);
    }

    const shouted = await http()
      .post('/api/v1/auth/login')
      .send({ email: ' VICTIM@ACME.TEST ', password: WRONG });
    expect(shouted.status).toBe(429);
  });

  it('an unknown email is limited too — the limiter does not disclose which accounts exist', async () => {
    // If only real accounts were counted, the 429/401 split would become an
    // account-enumeration oracle — the exact uniformity `set-password.spec.ts`
    // protects on the timing axis.
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      expect(await failLogin('ghost@acme.test')).toBe(401);
    }
    expect(await failLogin('ghost@acme.test')).toBe(429);
  });
});
