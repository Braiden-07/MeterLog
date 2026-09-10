import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * Step 5, Phase 2 — the RBAC gate and the role-gated membership endpoints,
 * exercised over **real HTTP with real signed session cookies through the
 * globally-bound interceptor**.
 *
 * Calling `MembershipsService` or the interceptor directly would prove strictly
 * less: the gate is enforced *inside* the interceptor, so a test that reaches
 * underneath it is testing a world in which the gate does not exist. Same
 * standard as the step-4 acceptance suite.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT.
 *
 * These are the OUTER check. Every negative here proves the HTTP layer refuses
 * cleanly — a 403 rather than a 500, a 404 rather than a leak. It does NOT prove
 * the database backstop, and must never be read as doing so: the definer
 * functions are `EXECUTE`-able by `meterlog_app`, so anything holding that
 * connection can call them with no guard in front. That property is proven by
 * `test/db/membership-writes.spec.ts`, which calls the functions directly with
 * the GUCs set by hand and is marked load-bearing for that reason.
 *
 * Both suites must keep passing independently. Two checks are only two checks if
 * each is proven without the other; if a body check is ever relaxed because "the
 * guard handles it now", the direct-call suite is the tripwire that catches it,
 * and DECISION B has otherwise silently reverted to the rejected option A.
 */
describe('memberships API (step-5 phase 2 — RBAC)', () => {
  let app: INestApplication;
  let migrator: PrismaClient;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';

  beforeAll(async () => {
    loadEnv();
    migrator = migratorClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Mirrors main.ts, so the acceptance tests exercise the real request pipeline.
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await wipe();
    await app.close();
    await migrator.$disconnect();
  });

  beforeEach(wipe);

  async function wipe(): Promise<void> {
    // Shared catalog-derived teardown: TRUNCATE ... CASCADE lets Postgres resolve
    // the FK order, so this no longer breaks when a new domain table lands.
    await resetDatabase(migrator);
  }

  async function login(email: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = setCookie?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    if (!cookie) throw new Error(`no session cookie issued for ${email}`);
    return cookie;
  }

  /**
   * Registers an organisation and returns its admin's cookie plus the tenant id.
   * Registration is the only path that mints an admin without going through the
   * endpoints under test, which keeps the fixtures from assuming what they prove.
   */
  async function newOrg(
    tenantName: string,
    email: string,
  ): Promise<{ cookie: string; tenantId: string }> {
    const created = await http()
      .post('/api/v1/auth/register')
      .send({ tenantName, email, password: PASSWORD })
      .expect(201);
    return { cookie: await login(email), tenantId: created.body.tenantId };
  }

  /** A person's live membership row in a given tenant, read as the migration role. */
  async function membershipOf(
    email: string,
    tenantId: string,
  ): Promise<{ id: string; role: string } | null> {
    const rows = await migrator.$queryRawUnsafe<{ id: string; role: string }[]>(
      `SELECT m.id, m.role::text AS role
         FROM public.memberships m
         JOIN public.users u ON u.id = m.user_id
        WHERE u.email = $1::citext AND m.tenant_id = $2::uuid AND m.deleted_at IS NULL`,
      email,
      tenantId,
    );
    return rows[0] ?? null;
  }

  /** Gives an existing person a password they can actually log in with. */
  async function setPassword(email: string, cookieSource: string): Promise<void> {
    const [row] = await migrator.$queryRawUnsafe<{ password_hash: string }[]>(
      `SELECT password_hash FROM public.users WHERE email = $1::citext`,
      cookieSource,
    );
    await migrator.$executeRawUnsafe(
      `UPDATE public.users SET password_hash = $2 WHERE email = $1::citext`,
      email,
      row!.password_hash,
    );
  }

  // =========================================================================
  describe('the read is deliberately NOT role-gated (ADR-006 §3)', () => {
    it('a technician can list co-members, and sees identity and role', async () => {
      const { cookie: adminCookie, tenantId } = await newOrg('Acme', 'admin@acme.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', adminCookie)
        .send({ email: 'tech@acme.test', role: 'technician' })
        .expect(201);
      await setPassword('tech@acme.test', 'admin@acme.test');

      const techCookie = await login('tech@acme.test');
      const res = await http().get('/api/v1/users').set('Cookie', techCookie).expect(200);

      // Co-member visibility is the accepted team-SaaS default, not an oversight.
      expect(res.body).toHaveLength(2);
      expect(res.body.map((m: { email: string }) => m.email).sort()).toEqual([
        'admin@acme.test',
        'tech@acme.test',
      ]);
      expect(res.body.find((m: { email: string }) => m.email === 'admin@acme.test').role).toBe(
        'admin',
      );
      expect(await membershipOf('tech@acme.test', tenantId)).not.toBeNull();
    });

    it('the list is scoped to the active workspace by RLS, not by a WHERE clause', async () => {
      const { cookie } = await newOrg('Acme', 'admin@acme.test');
      await newOrg('Beta', 'admin@beta.test');

      const res = await http().get('/api/v1/users').set('Cookie', cookie).expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].email).toBe('admin@acme.test');
    });
  });

  // =========================================================================
  describe('positives — an admin of A manages A', () => {
    it('invites an UNKNOWN email: creates the identity and the membership', async () => {
      const { cookie, tenantId } = await newOrg('Acme', 'admin@acme.test');

      const res = await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'newcomer@acme.test', role: 'technician' })
        .expect(201);

      expect(res.body.userCreated).toBe(true);
      expect(await membershipOf('newcomer@acme.test', tenantId)).toMatchObject({
        role: 'technician',
      });
    });

    it('invites an EXISTING email: attaches a membership to the same person', async () => {
      // The multi-org mechanism (OPEN-1). The person already exists because they
      // registered their own organisation.
      const { tenantId: acme, cookie } = await newOrg('Acme', 'admin@acme.test');
      await newOrg('Beta', 'multi@beta.test');

      const res = await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'multi@beta.test', role: 'auditor' })
        .expect(201);

      expect(res.body.userCreated, 'a duplicate identity was created').toBe(false);
      expect(await membershipOf('multi@beta.test', acme)).toMatchObject({ role: 'auditor' });

      // One human, two memberships — and the original one is untouched.
      const [count] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.users WHERE email = 'multi@beta.test'::citext`,
      );
      expect(count!.n).toBe(1);
    });

    it('changes a role', async () => {
      const { cookie, tenantId } = await newOrg('Acme', 'admin@acme.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'tech@acme.test', role: 'technician' })
        .expect(201);
      const target = await membershipOf('tech@acme.test', tenantId);

      await http()
        .patch(`/api/v1/users/${target!.id}`)
        .set('Cookie', cookie)
        .send({ role: 'auditor' })
        .expect(204);

      expect(await membershipOf('tech@acme.test', tenantId)).toMatchObject({ role: 'auditor' });
    });

    it('revokes a membership, and it is a SOFT delete', async () => {
      const { cookie, tenantId } = await newOrg('Acme', 'admin@acme.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'tech@acme.test', role: 'technician' })
        .expect(201);
      const target = await membershipOf('tech@acme.test', tenantId);

      await http().delete(`/api/v1/users/${target!.id}`).set('Cookie', cookie).expect(204);

      expect(await membershipOf('tech@acme.test', tenantId)).toBeNull();
      const [row] = await migrator.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
        `SELECT deleted_at FROM public.memberships WHERE id = $1::uuid`,
        target!.id,
      );
      expect(row, 'the membership row was hard-deleted').toBeDefined();
      expect(row!.deleted_at).not.toBeNull();
    });

    it('the last-admin guard surfaces as a clean 409, not a 500', async () => {
      const { cookie, tenantId } = await newOrg('Acme', 'admin@acme.test');
      const self = await membershipOf('admin@acme.test', tenantId);

      const res = await http()
        .patch(`/api/v1/users/${self!.id}`)
        .set('Cookie', cookie)
        .send({ role: 'technician' })
        .expect(409);

      expect(res.body.error.code).toBe('LAST_ADMIN');
      expect(await membershipOf('admin@acme.test', tenantId)).toMatchObject({ role: 'admin' });
    });
  });

  // =========================================================================
  describe('negative — a non-admin is refused with a clean 403, NOT a 500', () => {
    /**
     * The whole point of enforcing the gate inside the interceptor. A
     * `CanActivate` guard runs BEFORE the interceptor, so it would ask for a role
     * that has not been resolved yet, `requireRequestContext()` would throw, and
     * the exception filter would turn that into a **500 on every gated route** —
     * the Phase 4 defect in new clothes. The status code is the assertion that
     * catches it, so each case asserts 403 explicitly rather than "not 2xx".
     */
    let techCookie: string;
    let adminMembershipId: string;
    let ownMembershipId: string;

    beforeEach(async () => {
      const { cookie: adminCookie, tenantId } = await newOrg('Acme', 'admin@acme.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', adminCookie)
        .send({ email: 'tech@acme.test', role: 'technician' })
        .expect(201);
      await setPassword('tech@acme.test', 'admin@acme.test');

      techCookie = await login('tech@acme.test');
      adminMembershipId = (await membershipOf('admin@acme.test', tenantId))!.id;
      ownMembershipId = (await membershipOf('tech@acme.test', tenantId))!.id;
    });

    it('POST /users → 403', async () => {
      const res = await http()
        .post('/api/v1/users')
        .set('Cookie', techCookie)
        .send({ email: 'planted@acme.test', role: 'admin' })
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
      const [count] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.users WHERE email = 'planted@acme.test'::citext`,
      );
      expect(count!.n, 'the refused invite still created an identity').toBe(0);
    });

    it('PATCH /users/:id → 403, including self-promotion to admin', async () => {
      // The escalation DECISION B exists to prevent, now attempted through the
      // front door instead of through raw SQL.
      const res = await http()
        .patch(`/api/v1/users/${ownMembershipId}`)
        .set('Cookie', techCookie)
        .send({ role: 'admin' })
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
      const [row] = await migrator.$queryRawUnsafe<{ role: string }[]>(
        `SELECT role::text AS role FROM public.memberships WHERE id = $1::uuid`,
        ownMembershipId,
      );
      expect(row!.role, 'the technician escalated to admin over HTTP').toBe('technician');
    });

    it('DELETE /users/:id → 403', async () => {
      const res = await http()
        .delete(`/api/v1/users/${adminMembershipId}`)
        .set('Cookie', techCookie)
        .expect(403);

      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
      const [row] = await migrator.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
        `SELECT deleted_at FROM public.memberships WHERE id = $1::uuid`,
        adminMembershipId,
      );
      expect(row!.deleted_at, 'a technician revoked the admin').toBeNull();
    });

    it('GET /users still succeeds for the same technician — the gate is on writes only', async () => {
      // Pairs with the three above. Without it, all four could pass because the
      // whole controller was unreachable rather than because the writes are gated.
      await http().get('/api/v1/users').set('Cookie', techCookie).expect(200);
    });
  });

  // =========================================================================
  describe('negative — semantic cross-tenant, over HTTP', () => {
    /**
     * An admin of A aiming at a REAL, LIVE membership in a REAL, existent tenant
     * B. A malformed uuid would prove only that `ParseUUIDPipe` runs, and a
     * random uuid would prove only that a lookup missed — neither says anything
     * about the boundary.
     *
     * The database already refuses this on its own (Phase 1 proved it directly,
     * with no guard in front). What is being proven here is that the HTTP path
     * ALSO refuses cleanly, and that the refusal is a 404 rather than a 500 or a
     * leak — not that this is the only thing refusing.
     */
    let adminOfA: string;
    let bMembershipId: string;
    let betaTenant: string;

    beforeEach(async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Beta', 'admin@beta.test');
      adminOfA = a.cookie;
      betaTenant = b.tenantId;
      bMembershipId = (await membershipOf('admin@beta.test', b.tenantId))!.id;
    });

    it('the target is real and live — the negative is not vacuous', async () => {
      expect(await membershipOf('admin@beta.test', betaTenant)).toMatchObject({ role: 'admin' });
    });

    it("PATCH against tenant B's membership → 404, and B is unchanged", async () => {
      const res = await http()
        .patch(`/api/v1/users/${bMembershipId}`)
        .set('Cookie', adminOfA)
        .send({ role: 'technician' })
        .expect(404);

      // 404 and not 403: "belongs to another tenant" and "does not exist" share
      // one code by design, so the endpoint cannot be used to probe for
      // membership ids in tenants the caller cannot see.
      expect(res.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
      expect(await membershipOf('admin@beta.test', betaTenant)).toMatchObject({ role: 'admin' });
    });

    it("DELETE against tenant B's membership → 404, and B keeps its admin", async () => {
      const res = await http()
        .delete(`/api/v1/users/${bMembershipId}`)
        .set('Cookie', adminOfA)
        .expect(404);

      expect(res.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
      expect(await membershipOf('admin@beta.test', betaTenant)).toMatchObject({ role: 'admin' });
    });

    it("a nonexistent-but-well-formed membership id is indistinguishable from B's", async () => {
      const res = await http()
        .patch('/api/v1/users/00000000-0000-4000-8000-000000000000')
        .set('Cookie', adminOfA)
        .send({ role: 'technician' })
        .expect(404);

      expect(res.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');
    });
  });

  // =========================================================================
  describe('the gate needs identity and an active workspace', () => {
    it('no session → 401, not 403 and not 500', async () => {
      // @RequiresRole implies @RequiresSession: an unauthenticated caller is an
      // authentication failure, not an authorization one.
      await http()
        .post('/api/v1/users')
        .send({ email: 'x@acme.test', role: 'technician' })
        .expect(401);
    });

    it('authenticated with NO active workspace → 403 on a gated write', async () => {
      // OPEN-2: a person with zero live memberships logs in successfully with no
      // active tenant. There is then no workspace in which they hold any role, so
      // the gate must refuse rather than treat a null role as permissive.
      const { cookie, tenantId } = await newOrg('Acme', 'solo@acme.test');
      const self = await membershipOf('solo@acme.test', tenantId);
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE id = $1::uuid`,
        self!.id,
      );

      // The membership is gone, so the interceptor's re-verify clears the active
      // tenant and this request 403s on that path first.
      await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'x@acme.test', role: 'technician' })
        .expect(403);

      // Now the session genuinely has no active workspace. The gate is what
      // refuses this one, with a null role.
      const res = await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'x@acme.test', role: 'technician' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
    });
  });

  // =========================================================================
  describe('role follows the ACTIVE membership, not the person', () => {
    it('the same person is admin in one workspace and refused in the other', async () => {
      // The property ADR-006 exists for, now visible through RBAC: one human,
      // two workspaces, two different answers to "may I invite?".
      const beta = await newOrg('Beta', 'multi@beta.test');
      const acme = await newOrg('Acme', 'admin@acme.test');

      await http()
        .post('/api/v1/users')
        .set('Cookie', acme.cookie)
        .send({ email: 'multi@beta.test', role: 'technician' })
        .expect(201);

      const cookie = await login('multi@beta.test');

      // Two memberships now, so login resolves NO active workspace (OPEN-2) and
      // the workspace must be chosen explicitly. Asserted rather than assumed —
      // if this ever auto-selected, the switch below would be silently testing
      // whichever tenant happened to win.
      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.activeWorkspace).toBeNull();
      expect(me.body.workspaces).toHaveLength(2);

      // Beta — their own org, where they are admin.
      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie)
        .send({ tenantId: beta.tenantId })
        .expect(200);

      await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'hire@beta.test', role: 'technician' })
        .expect(201);

      // Switch to Acme, where the same person is only a technician.
      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie)
        .send({ tenantId: acme.tenantId })
        .expect(200);

      const res = await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'hire@acme.test', role: 'technician' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');

      // And nothing was planted in Acme.
      expect(await membershipOf('hire@acme.test', acme.tenantId)).toBeNull();
      expect(await membershipOf('hire@beta.test', beta.tenantId)).not.toBeNull();
    });

    it('a role changed underneath a live session is picked up on the NEXT request', async () => {
      // The gate reads RequestContext.role, which is re-read from the database
      // each request — never the copy in the session, which goes stale the moment
      // an admin changes it. Demoting the caller must therefore start refusing
      // immediately, with no re-login.
      const { cookie, tenantId } = await newOrg('Acme', 'admin@acme.test');

      await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'first@acme.test', role: 'technician' })
        .expect(201);

      const self = await membershipOf('admin@acme.test', tenantId);
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET role = 'technician' WHERE id = $1::uuid`,
        self!.id,
      );

      const res = await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'second@acme.test', role: 'technician' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
      expect(await membershipOf('second@acme.test', tenantId)).toBeNull();
    });
  });
});
