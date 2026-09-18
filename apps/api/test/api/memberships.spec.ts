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
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    // The SAME pipeline production runs — prefix, parsers, headers,
    // validation — rather than a hand-copy of it (src/bootstrap.ts).
    configureApp(app);
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

    it('a SINGLE-workspace admin sees only their own tenant — and this fixture cannot see G1', async () => {
      // RETITLED AT G1 (OPEN-13). This used to read "scoped by RLS, not by a
      // WHERE clause", and that claim is no longer true of the endpoint: `list()`
      // now carries an explicit `app.current_tenant` predicate. The fixture is
      // kept exactly as it was, because what it demonstrates is now the OPPOSITE
      // of what its old title claimed — it is the shape of fixture that CANNOT
      // catch the bug.
      //
      // Both admins here belong to exactly ONE workspace each, so the self axis
      // and the tenant axis select the same rows and the OR of two permissive
      // policies is indistinguishable from either one alone. The test below is
      // the same scenario with the one variable that matters changed.
      const { cookie } = await newOrg('Acme', 'admin@acme.test');
      await newOrg('Beta', 'admin@beta.test');

      const res = await http().get('/api/v1/users').set('Cookie', cookie).expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].email).toBe('admin@acme.test');
    });

    it("G1 (OPEN-13) — a MULTI-workspace admin sees ONLY the active tenant's members", async () => {
      // THE OPEN-13 NEGATIVE. `memberships_self_read` (keyed on
      // `app.current_user`) and `memberships_tenant` (keyed on
      // `app.current_tenant`) are both PERMISSIVE `FOR SELECT` policies, so they
      // OR — and a user who belongs to several workspaces therefore has their own
      // rows from EVERY workspace visible under any one tenant's context.
      //
      // Against the pre-G1 endpoint this returns TWO rows for Acme: Acme's own
      // membership plus the caller's Beta membership arriving over the self axis.
      // `Member` exposes no `tenantId` (deliberately — ADR-006 §7 keeps the
      // response about people in this workspace), so the foreign row is not
      // merely extra, it is INDISTINGUISHABLE in the body: it renders as the same
      // person listed twice with two roles and no way to tell which workspace
      // either belongs to. That is why the assertion is on the row COUNT and the
      // role, not on a tenant field — there is none to assert.
      const { cookie: betaCookie } = await newOrg('Beta', 'multi@beta.test');
      const { cookie: acmeCookie, tenantId: acme } = await newOrg('Acme', 'admin@acme.test');

      // The SAME person now holds a second membership, in Acme, as a technician.
      await http()
        .post('/api/v1/users')
        .set('Cookie', acmeCookie)
        .send({ email: 'multi@beta.test', role: 'technician' })
        .expect(201);
      expect(await membershipOf('multi@beta.test', acme)).toMatchObject({ role: 'technician' });

      // Acting in BETA — where they are the admin and the only member.
      const res = await http().get('/api/v1/users').set('Cookie', betaCookie).expect(200);

      expect(
        res.body,
        "the caller's Acme membership must not appear in Beta's member list",
      ).toHaveLength(1);
      expect(res.body[0].email).toBe('multi@beta.test');
      expect(res.body[0].role, 'the role shown must be the one held in the ACTIVE workspace').toBe(
        'admin',
      );

      // Non-vacuity: the second membership really exists and really is visible to
      // the database under this caller's self axis. Without this the assertion
      // above would pass against a fixture that simply never created it.
      const [selfRows] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.memberships m
           JOIN public.users u ON u.id = m.user_id
          WHERE u.email = 'multi@beta.test'::citext AND m.deleted_at IS NULL`,
      );
      expect(selfRows!.n, 'the caller must genuinely hold two live memberships').toBe(2);
    });

    it('G1 is SERVICE-LAYER — /auth/me still lists every workspace, cross-tenant', async () => {
      // THE DIFFERENTIAL CONTROL. This is the negative that reds if the OPEN-13
      // fix is ever "simplified" into an RLS tightening.
      //
      // `readWorkspaces` (auth.service.ts) carries NO tenant predicate — only
      // `user_id` and `deleted_at IS NULL` — and rides the self axis on purpose,
      // because the workspace switcher's entire job is to show workspaces the
      // caller is NOT currently active in. Putting a tenant term into
      // `memberships_self_read` would scope `list()` correctly and collapse this
      // list to one entry in the same stroke, breaking the switcher.
      //
      // So: same fixture as the test above, same caller, same active tenant —
      // and the OPPOSITE expectation. The member list must narrow; the workspace
      // list must not.
      const { cookie: betaCookie } = await newOrg('Beta', 'multi@beta.test');
      const { cookie: acmeCookie } = await newOrg('Acme', 'admin@acme.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', acmeCookie)
        .send({ email: 'multi@beta.test', role: 'technician' })
        .expect(201);

      const me = await http().get('/api/v1/auth/me').set('Cookie', betaCookie).expect(200);

      expect(
        me.body.workspaces,
        'the workspace list is cross-tenant BY DESIGN — this is the switcher',
      ).toHaveLength(2);
      expect(me.body.workspaces.map((w: { name: string }) => w.name).sort()).toEqual([
        'Acme',
        'Beta',
      ]);
      expect(me.body.activeWorkspace.name).toBe('Beta');
      expect(me.body.activeWorkspace.role).toBe('admin');
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

      // STEP 8: `userCreated` is no longer on the wire — it was an
      // account-existence oracle over the WHOLE system, not just this tenant
      // (ADR-016). The effect it used to report is asserted against the database
      // instead, which is stronger evidence anyway: the identity exists, it is
      // pending, and the membership is attached.
      expect(res.body).toEqual({ message: 'Invitation sent.' });
      expect(await membershipOf('newcomer@acme.test', tenantId)).toMatchObject({
        role: 'technician',
      });

      const [created] = await migrator.$queryRawUnsafe<{ pending: boolean }[]>(
        `SELECT (password_set_at IS NULL) AS pending FROM public.users
          WHERE email = 'newcomer@acme.test'::citext`,
      );
      expect(created, 'no identity was created for the unknown email').toBeDefined();
      expect(
        created?.pending,
        'an invite-created identity must be PENDING — that is what makes it eligible for a token',
      ).toBe(true);
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

      // STEP 8: the response is now IDENTICAL to the unknown-email case above —
      // same body, same 201 — which is the uniformity property itself, asserted
      // here rather than described. "A duplicate identity was not created" is
      // asserted against the database below, where it always belonged.
      expect(res.body).toEqual({ message: 'Invitation sent.' });
      expect(await membershipOf('multi@beta.test', acme)).toMatchObject({ role: 'auditor' });

      // One human, two memberships — and the original one is untouched.
      const [count] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.users WHERE email = 'multi@beta.test'::citext`,
      );
      expect(count!.n).toBe(1);

      // AND THE CREDENTIAL IS UNTOUCHED. This is the property that makes inviting
      // an existing address safe: it must not reset their password, and it must
      // not make them pending (which would make them mintable for a token). The
      // invite path is never a password-reset path (ADR-016).
      const [person] = await migrator.$queryRawUnsafe<{ pending: boolean }[]>(
        `SELECT (password_set_at IS NULL) AS pending FROM public.users
          WHERE email = 'multi@beta.test'::citext`,
      );
      expect(
        person?.pending,
        'inviting an existing credentialled user must NOT make them pending',
      ).toBe(false);
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

      // Now the session genuinely has no active workspace. Until G2 the role gate
      // refused this with a null role (`FORBIDDEN_ROLE`); the interceptor's
      // default-deny now refuses it first, before any role is consulted, with the
      // code that names the state (OPEN-18). Still a 403 — never permissive.
      const res = await http()
        .post('/api/v1/users')
        .set('Cookie', cookie)
        .send({ email: 'x@acme.test', role: 'technician' })
        .expect(403);
      expect(res.body.error.code).toBe('NO_ACTIVE_WORKSPACE');
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
