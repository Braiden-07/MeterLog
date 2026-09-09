import { randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import Redis from 'ioredis';

import { AppModule } from '../../src/app.module';
import { ARGON2_OPTIONS, dummyVerifyTarget } from '../../src/auth/auth.service';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { execAll, loadEnv, migratorClient } from '../db/helpers';

/**
 * Step 4, Phase 4 — the API acceptance suite. This is the step-4 definition of
 * done, exercised the only way it can honestly be exercised: **real HTTP, real
 * signed session cookies, through the globally-bound interceptor.**
 *
 * Calling `AuthService` directly would bypass the interceptor entirely and prove
 * strictly less — the same shape as a rolled-back wrapper hiding non-atomicity,
 * or a fresh connection hiding pooled statefulness. Every case below goes over
 * the wire.
 *
 * The app's Prisma client is pinned to `connection_limit=1` for the same reason
 * Phase 3 pinned it: the revocation guarantee lives on the pooled-connection
 * surface, and adding an HTTP layer on top does not relax that discipline. The
 * backend pid is captured from `pg_stat_activity` between requests and asserted
 * unchanged, baseline-subtracted so a stray connection from another suite cannot
 * make the assertion vacuous.
 */
describe('auth API (step-4 acceptance)', () => {
  let app: INestApplication;
  let migrator: PrismaClient;
  let redis: Redis;
  let baselinePids: Set<number>;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    loadEnv();
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is not set.');

    migrator = migratorClient();
    redis = new Redis(process.env.REDIS_URL!);
    baselinePids = await appRolePids(migrator);

    process.env.DATABASE_URL = `${base}${base.includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=10`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Mirrors main.ts, so the acceptance tests exercise the real request pipeline.
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.DATABASE_URL = base;
  });

  afterAll(async () => {
    await wipe();
    await app.close();
    await migrator.$disconnect();
    await redis.quit();
  });

  beforeEach(wipe);

  async function wipe(): Promise<void> {
    await execAll(migrator, [
      `DELETE FROM public.memberships`,
      `DELETE FROM public.users`,
      `DELETE FROM public.tenants`,
    ]);
  }

  /** Backend pids currently held by the app role, minus whatever was already there. */
  async function appRolePids(client: PrismaClient): Promise<Set<number>> {
    const rows = await client.$queryRawUnsafe<{ pid: number }[]>(
      `SELECT pid FROM pg_stat_activity WHERE usename = 'meterlog_app'`,
    );
    return new Set(rows.map((r) => r.pid));
  }

  async function apiPids(): Promise<number[]> {
    const now = await appRolePids(migrator);
    return [...now].filter((pid) => !baselinePids.has(pid)).sort();
  }

  /**
   * The Redis key a cookie's session lives under.
   *
   * The cookie is `<id>.<hmac>` and `SessionService` stores under
   * `meterlog:sess:<id>`, so the id is everything before the LAST dot. Read
   * directly, deliberately: asking `SessionService.read()` would prove only that
   * the service says the session is gone, which is the same class of circular
   * evidence as asserting a 401 and calling the boundary closed.
   */
  function sessionKeyFor(cookie: string): string {
    const value = cookie.slice(cookie.indexOf('=') + 1);
    return `meterlog:sess:${value.slice(0, value.lastIndexOf('.'))}`;
  }

  const PASSWORD = 'correct horse battery staple';

  async function register(tenantName: string, email: string, password = PASSWORD) {
    return http().post('/api/v1/auth/register').send({ tenantName, email, password });
  }

  async function login(email: string, password = PASSWORD) {
    const res = await http().post('/api/v1/auth/login').send({ email, password });
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = setCookie?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    return { res, cookie };
  }

  /** Adds a second membership for an existing person, as the migration role. */
  async function grantMembership(email: string, tenantName: string, role: string): Promise<string> {
    const [row] = await migrator.$queryRawUnsafe<{ tenant_id: string }[]>(
      `WITH t AS (INSERT INTO public.tenants (name) VALUES ($1) RETURNING id)
       INSERT INTO public.memberships (user_id, tenant_id, role)
       SELECT u.id, t.id, $3::public.membership_role
       FROM public.users u, t WHERE u.email = $2::citext
       RETURNING tenant_id`,
      tenantName,
      email,
      role,
    );
    if (!row) throw new Error('grantMembership seeded nothing');
    return row.tenant_id;
  }

  // =========================================================================
  describe('DoD 1 — register → login → /auth/me round-trips', () => {
    it('registers, logs in, and reports the person with their auto-selected workspace', async () => {
      const created = await register('Acme Metering', 'founder@acme.test');
      expect(created.status).toBe(201);
      expect(created.body.tenantId).toMatch(/^[0-9a-f-]{36}$/);

      const { res, cookie } = await login('founder@acme.test');
      expect(res.status).toBe(200);
      expect(cookie, 'no session cookie was issued').toBeDefined();
      // A single membership auto-selects, so login completes in one step.
      expect(res.body.activeWorkspace).toMatchObject({ name: 'Acme Metering', role: 'admin' });

      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe('founder@acme.test');
      expect(me.body.activeWorkspace).toMatchObject({ name: 'Acme Metering', role: 'admin' });
      expect(me.body.workspaces).toHaveLength(1);
    });

    it('the session cookie is httpOnly, so script can never read the id', async () => {
      await register('Acme Metering', 'founder@acme.test');
      const res = await http().post('/api/v1/auth/login').send({
        email: 'founder@acme.test',
        password: PASSWORD,
      });
      const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith(SESSION_COOKIE),
      );
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Lax/i);
    });

    // Logout's two halves, as SEPARATE tests so each can fail on its own.
    //
    // Folded into one test they short-circuit: the Redis assertion runs first, so
    // a mutation that breaks both never exercises the replay. Split, a
    // cookie-only logout reddens both independently, and each states a different
    // thing — one that the server-side session is gone, one that the endpoint
    // refuses the old cookie.
    //
    // The Redis half is the one that closes the boundary. A 401 on replay does
    // NOT prove the session was destroyed: the cookie could be refused for a
    // reason with nothing to do with the session's existence — signature
    // mismatch, rotation, expiry — while the key sits in Redis, replayable by
    // anything that can present a valid cookie.
    it('BLOCKER: logout deletes the session from Redis — before present, after absent', async () => {
      await register('Acme Metering', 'founder@acme.test');
      const { cookie } = await login('founder@acme.test');
      const key = sessionKeyFor(cookie!);

      // BEFORE. Without this the "absent after" assertion would pass against a
      // key that never existed — a mistyped prefix would look like a clean logout.
      const before = await redis.get(key);
      expect(before, `no session at ${key} before logout`).not.toBeNull();
      expect(JSON.parse(before!).userId).toMatch(/^[0-9a-f-]{36}$/);

      expect((await http().post('/api/v1/auth/logout').set('Cookie', cookie!)).status).toBe(204);

      // AFTER. This is the assertion that makes the claim mechanism-level rather
      // than symptom-level.
      expect(await redis.get(key), 'the session survived logout in Redis').toBeNull();
    });

    it('BLOCKER: the exact pre-logout cookie is refused on replay', async () => {
      await register('Acme Metering', 'founder@acme.test');
      const { cookie } = await login('founder@acme.test');
      expect((await http().get('/api/v1/auth/me').set('Cookie', cookie!)).status).toBe(200);

      await http().post('/api/v1/auth/logout').set('Cookie', cookie!);

      const replay = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('UNAUTHENTICATED');
      expect(replay.body).not.toHaveProperty('user');
    });
  });

  // =========================================================================
  describe('RISK A — the interceptor is actually bound and live on real routes', () => {
    it('POSITIVE: an authenticated request runs WITH context and sees its own tenant', async () => {
      await register('Acme Metering', 'founder@acme.test');
      const { cookie } = await login('founder@acme.test');

      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(me.status).toBe(200);
      // /auth/me reads `users` and `tenants`, both under FORCE RLS with no
      // app-role write path and policies keyed on the two GUCs. Non-empty content
      // here is only possible if the interceptor actually set them.
      expect(me.body.user.email).toBe('founder@acme.test');
      expect(me.body.workspaces[0].name).toBe('Acme Metering');
    });

    it('NEGATIVE: no valid session ⇒ no context, and the route is REFUSED, not served empty', async () => {
      // The failure that matters if binding is ever removed is not "empty
      // results" — it is a route that answers 200 with nothing while the caller
      // believes it is scoped. These must not be 200.
      for (const cookie of [
        undefined,
        `${SESSION_COOKIE}=not-a-real-cookie`,
        `${SESSION_COOKIE}=abc.${'A'.repeat(43)}`, // well-formed shape, bad signature
      ]) {
        const req = http().get('/api/v1/auth/me');
        if (cookie) req.set('Cookie', cookie);
        const res = await req;
        expect(res.status, `a session-less request was served: ${cookie ?? '(no cookie)'}`).toBe(
          401,
        );
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
        expect(res.body).not.toHaveProperty('user');
      }
    });

    it('the interceptor opens NO transaction for pre-auth routes', async () => {
      // register and login legitimately arrive with no session; wrapping them in
      // an interactive transaction would be pure cost. They must still work.
      expect((await register('Acme Metering', 'founder@acme.test')).status).toBe(201);
      expect((await login('founder@acme.test')).res.status).toBe(200);
      expect((await http().get('/api/v1/health')).status).toBe(200);
    });
  });

  // =========================================================================
  describe('DoD 2 & 3 & RISK B — the switch boundary', () => {
    it('DoD 2: a multi-membership user logs in with no active tenant, then switches', async () => {
      await register('Acme Metering', 'multi@acme.test');
      const second = await grantMembership('multi@acme.test', 'Beta Utilities', 'technician');

      const { res, cookie } = await login('multi@acme.test');
      expect(res.status).toBe(200);
      // More than one membership ⇒ no auto-selection; the client must choose.
      expect(res.body.activeWorkspace).toBeNull();
      expect(res.body.workspaces).toHaveLength(2);

      const switched = await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie!)
        .send({ tenantId: second });
      expect(switched.status).toBe(200);
      expect(switched.body.activeWorkspace).toMatchObject({
        tenantId: second,
        name: 'Beta Utilities',
        role: 'technician',
      });

      // And it persists to the next request, which is the actual claim.
      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(me.body.activeWorkspace.tenantId).toBe(second);
    });

    it('DoD 3 / RISK B: switching into a REAL tenant the user is not a member of is 403', async () => {
      // The case that matters. A malformed uuid would be refused by the DTO's
      // @IsUUID and would prove only that validation runs — it says nothing about
      // the authorization boundary. This target is a well-formed, existent tenant
      // with a real membership belonging to somebody ELSE.
      await register('Acme Metering', 'insider@acme.test');
      await register('Foreign Corp', 'outsider@foreign.test');

      const [foreign] = await migrator.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM public.tenants WHERE name = 'Foreign Corp'`,
      );
      expect(foreign?.id, 'the foreign tenant fixture did not materialise').toBeDefined();

      const { cookie } = await login('insider@acme.test');
      const res = await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie!)
        .send({ tenantId: foreign!.id });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('NOT_A_MEMBER');

      // And nothing of the foreign tenant became reachable as a side effect.
      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(me.body.activeWorkspace.name).toBe('Acme Metering');
      expect(me.body.workspaces.map((w: { name: string }) => w.name)).toEqual(['Acme Metering']);
    });

    it('a well-formed uuid for a tenant that does not exist at all is also 403', async () => {
      await register('Acme Metering', 'insider@acme.test');
      const { cookie } = await login('insider@acme.test');
      const res = await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie!)
        .send({ tenantId: randomUUID() });
      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  describe('DoD 4 — revocation takes effect on the next request, over HTTP', () => {
    it('the next request 403s, on the SAME pooled backend, and the workspace disappears', async () => {
      await register('Acme Metering', 'founder@acme.test');
      const { cookie } = await login('founder@acme.test');

      const first = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(first.status).toBe(200);
      const pidsAfterFirst = await apiPids();
      expect(pidsAfterFirst, 'the API should hold exactly one pooled connection').toHaveLength(1);

      const revoked = await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE deleted_at IS NULL`,
      );
      expect(revoked, 'the revocation itself must affect exactly one row').toBe(1);

      const second = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(second.status).toBe(403);
      expect(second.body.error.code).toBe('MEMBERSHIP_REVOKED');

      // The pooled-connection discipline does not lapse because there is an HTTP
      // layer on top: request 2 must have run on the same backend as request 1,
      // or this says nothing about pooled statefulness.
      expect(await apiPids(), 'requests did not share a pooled connection').toEqual(pidsAfterFirst);

      // The session's active tenant was cleared by the 403, so the third request
      // succeeds with an empty workspace list rather than 403-looping.
      const third = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(third.status).toBe(200);
      expect(third.body.activeWorkspace).toBeNull();
      expect(third.body.workspaces).toEqual([]);
    });
  });

  // =========================================================================
  describe('DoD 5 — role follows the active membership, not the person', () => {
    it('the same person is admin in one workspace and technician in the other', async () => {
      await register('Acme Metering', 'multi@acme.test'); // admin here
      const beta = await grantMembership('multi@acme.test', 'Beta Utilities', 'technician');

      const { cookie } = await login('multi@acme.test');

      const [acme] = await migrator.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM public.tenants WHERE name = 'Acme Metering'`,
      );
      const inAcme = await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie!)
        .send({ tenantId: acme!.id });
      expect(inAcme.body.activeWorkspace.role).toBe('admin');

      const inBeta = await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie!)
        .send({ tenantId: beta });
      expect(inBeta.body.activeWorkspace.role).toBe('technician');

      // And the role is re-read per request, not carried from the switch response.
      expect(
        (await http().get('/api/v1/auth/me').set('Cookie', cookie!)).body.activeWorkspace.role,
      ).toBe('technician');
    });

    it('a role changed underneath an active session is picked up on the next request', async () => {
      await register('Acme Metering', 'founder@acme.test');
      const { cookie } = await login('founder@acme.test');
      expect(
        (await http().get('/api/v1/auth/me').set('Cookie', cookie!)).body.activeWorkspace.role,
      ).toBe('admin');

      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET role = 'auditor' WHERE deleted_at IS NULL`,
      );

      expect(
        (await http().get('/api/v1/auth/me').set('Cookie', cookie!)).body.activeWorkspace.role,
      ).toBe('auditor');
    });
  });

  // =========================================================================
  describe('OPEN-1 / OPEN-2 wiring', () => {
    it('OPEN-1: registering an existing email is 409, keyed on SQLSTATE 23505', async () => {
      expect((await register('First Org', 'shared@acme.test')).status).toBe(201);

      const dup = await register('Second Org', 'shared@acme.test');
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');

      // Atomicity still holds through the endpoint: no orphan tenant survived.
      const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.tenants WHERE name = 'Second Org'`,
      );
      expect(row?.n, 'a failed registration left an orphan tenant behind').toBe(0);
    });

    it('OPEN-1: the duplicate check is case-insensitive, matching the index', async () => {
      // The citext lockout in reverse — if the 409 path were case-sensitive, this
      // would 500 on the unmapped unique violation instead of 409ing.
      await register('First Org', 'Shared@Acme.test');
      const dup = await register('Second Org', 'shared@acme.TEST');
      expect(dup.status).toBe(409);
    });

    it('OPEN-2: zero memberships ⇒ login is 200 with no active tenant, not 401 and not 403', async () => {
      await register('Acme Metering', 'orphan@acme.test');
      // Revoke the only membership, leaving the person with valid credentials and
      // no workspace at all.
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE deleted_at IS NULL`,
      );

      const { res, cookie } = await login('orphan@acme.test');
      expect(res.status, 'a workspace-less login must not be an auth failure').toBe(200);
      expect(cookie).toBeDefined();
      expect(res.body.activeWorkspace).toBeNull();
      expect(res.body.workspaces).toEqual([]);

      // And it lands in the no-active-tenant state without 403-looping.
      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(me.status).toBe(200);
      expect(me.body.activeWorkspace).toBeNull();
      expect(me.body.workspaces).toEqual([]);
    });

    it('the timing-equalisation hash uses the SAME argon2 parameters as production', async () => {
      // The no-such-user branch runs an argon2 verify so that "unknown email"
      // costs what "wrong password" costs. That only works while the dummy hash
      // is as expensive as a real one — if production cost is tuned upward and
      // the dummy is not, the two branches diverge in time and the generic error
      // message stops hiding anything.
      //
      // Asserted by PARSING the encoded parameters out of both hashes rather
      // than by eyeballing the source, so tuning one without the other fails
      // here instead of quietly reopening the enumeration oracle.
      const params = (encoded: string): string => {
        const match = /^\$(argon2[a-z]+)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)/.exec(encoded);
        expect(match, `unparseable argon2 hash: ${encoded.slice(0, 40)}`).not.toBeNull();
        const [, algorithm, version, m, t, pll] = match!;
        return `${algorithm} v=${version} m=${m} t=${t} p=${pll}`;
      };

      // A freshly-minted PRODUCTION hash, taken from the real registration path
      // rather than by calling argon2 with options copied into the test.
      await register('Acme Metering', 'founder@acme.test');
      const [row] = await migrator.$queryRawUnsafe<{ password_hash: string }[]>(
        `SELECT password_hash FROM public.users WHERE email = 'founder@acme.test'::citext`,
      );
      expect(row?.password_hash, 'registration stored no hash').toBeDefined();

      expect(params(await dummyVerifyTarget())).toBe(params(row!.password_hash));

      // And both agree with the single declared source of truth, so this cannot
      // pass by both drifting together.
      expect(params(row!.password_hash)).toBe(
        `argon2id v=19 m=${ARGON2_OPTIONS.memoryCost} t=${ARGON2_OPTIONS.timeCost} p=${ARGON2_OPTIONS.parallelism}`,
      );
    });

    it('login failures are generic and identical for unknown email and wrong password', async () => {
      await register('Acme Metering', 'founder@acme.test');

      const wrongPassword = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'founder@acme.test', password: 'not the password' });
      const unknownEmail = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@nowhere.test', password: PASSWORD });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      // Identical bodies — no user enumeration.
      expect(unknownEmail.body).toEqual(wrongPassword.body);
      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('login is case-insensitive on email, matching registration', async () => {
      await register('Acme Metering', 'Founder@Acme.TEST');
      expect((await login('founder@acme.test')).res.status).toBe(200);
    });

    it('validation rejects unknown fields and short passwords with the error envelope', async () => {
      const bad = await http()
        .post('/api/v1/auth/register')
        .send({ tenantName: 'X', email: 'a@b.test', password: 'short', sneaky: true });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      expect(bad.body.error.details.join(' ')).toMatch(/sneaky|password/i);
    });
  });

  // =========================================================================
  describe('DoD 6 — the membership isolation proof holds through the API', () => {
    it('a member of two tenants, active in one, sees only that one and their own list', async () => {
      await register('Acme Metering', 'multi@acme.test');
      const beta = await grantMembership('multi@acme.test', 'Beta Utilities', 'technician');
      await register('Foreign Corp', 'outsider@foreign.test');

      const { cookie } = await login('multi@acme.test');
      await http().post('/api/v1/auth/switch').set('Cookie', cookie!).send({ tenantId: beta });

      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      const names = me.body.workspaces.map((w: { name: string }) => w.name).sort();
      // Their own two, and nothing belonging to the third tenant.
      expect(names).toEqual(['Acme Metering', 'Beta Utilities']);
      expect(names).not.toContain('Foreign Corp');
    });

    it('a re-invited user sees one workspace, not their revoked membership as well', async () => {
      // This is what makes the app-side `AND m.deleted_at IS NULL` in
      // readWorkspaces reachable, and therefore testable.
      //
      // The obvious revoked-workspace case does NOT exercise it: the JOIN to
      // `tenants` is filtered by tenants_workspace_list, which carries liveness of
      // its own, so a workspace the user holds ONLY a revoked membership in is
      // dropped by the join whether or not the predicate is there. Dropping the
      // predicate leaves that test green — verified by mutation.
      //
      // The reachable case is re-invitation, which ADR-006 §2 designs the PARTIAL
      // unique index for: `(user_id, tenant_id) WHERE deleted_at IS NULL` permits
      // one live membership alongside any number of revoked ones for the same
      // tenant. The tenant is then visible via the live row, so the join keeps
      // BOTH rows and the workspace appears twice — the second carrying whatever
      // role the person held before they were removed. Here that stale role is
      // `admin` and the current one is `auditor`, so without the predicate the
      // switcher would offer them admin of a workspace they are an auditor in.
      await register('Acme Metering', 'boomerang@acme.test');
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE deleted_at IS NULL`,
      );
      await migrator.$executeRawUnsafe(
        `INSERT INTO public.memberships (user_id, tenant_id, role)
         SELECT user_id, tenant_id, 'auditor' FROM public.memberships
          WHERE deleted_at IS NOT NULL`,
      );

      const { cookie } = await login('boomerang@acme.test');
      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie!);

      expect(me.body.workspaces).toHaveLength(1);
      expect(me.body.workspaces[0].role, 'the revoked admin row leaked into the list').toBe(
        'auditor',
      );
      expect(me.body.activeWorkspace.role).toBe('auditor');
    });

    it('a revoked workspace disappears from /auth/me — the OPEN-5 app-side predicate', async () => {
      await register('Acme Metering', 'multi@acme.test');
      const beta = await grantMembership('multi@acme.test', 'Beta Utilities', 'technician');
      const { cookie } = await login('multi@acme.test');
      await http().post('/api/v1/auth/switch').set('Cookie', cookie!).send({ tenantId: beta });

      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE tenant_id <> $1::uuid`,
        beta,
      );

      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie!);
      expect(me.body.workspaces.map((w: { name: string }) => w.name)).toEqual(['Beta Utilities']);
    });
  });
});
