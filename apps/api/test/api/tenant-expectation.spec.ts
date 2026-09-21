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
 * `X-Expected-Tenant` ENFORCEMENT — G3, OPEN-15, over real HTTP.
 *
 * ========================= WHAT THE ROW OWED ================================
 *
 * Responses do not echo the tenant that scoped them, so the late-response and
 * cross-tab WRITE races could not be closed server-side: a write issued while
 * workspace A was active can land after a switch to B and be applied under B.
 * The client half shipped as inert plumbing in the frontend slice — `api.ts`
 * sends the header on every request — and the four admin writes added by the
 * admin user-management slice all send it and none enforced it. This is the
 * enforcement, paid late and deliberately in `PROJECT_BRIEF` §11 step 9.
 *
 * ================ THE HALF THAT IS EASY TO GET WRONG ========================
 *
 * A naive "enforce on any non-GET" rule ALSO catches `POST /auth/switch`, and
 * that would be a deadlock rather than a mitigation — `switchTo` sends the OLD
 * tenant as its expectation, so a client whose view has gone stale sends A while
 * the session verified B, gets a 409, and is pinned: the UI says one thing, the
 * server another, and the one request that would reconcile them is refused.
 *
 * It is tempting to assume the exempt list already prevents that, on the grounds
 * that the tenant re-verify "does not run" for exempt routes. IT DOES RUN —
 * `exempt` gates only the 401 and the NO_ACTIVE_WORKSPACE 403, which is why
 * `revocation.spec.ts` sees exempt `GET /auth/me` answer 403 MEMBERSHIP_REVOKED.
 * The switch exclusion is therefore explicit, and the last test here is its
 * regression guard.
 */
describe('X-Expected-Tenant enforcement (OPEN-15 — writes only, switch-safe)', () => {
  let app: INestApplication;
  let migrator: PrismaClient;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';

  const ADMIN = 'admin@acme.test';
  const OWNER_B = 'owner-b@beta.test';

  beforeAll(async () => {
    loadEnv();
    migrator = migratorClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
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
   * ONE ADMIN HOLDING TWO WORKSPACES, active in A — the exact shape the race
   * needs, and the only shape in which a "stale" claim is even expressible.
   *
   * Built the way the product builds it: two orgs with two different owners, then
   * B's owner invites A's admin. Registering the same email twice cannot work —
   * `register` creates the user as well as the tenant, so the second call is a
   * 409 on the existing email.
   *
   * The explicit switch at the end is NOT ceremony. A session holding more than
   * one membership starts with `activeTenantId: null` ("0 memberships, or >1 and
   * none picked yet" — SessionData), and every tenant-scoped write from such a
   * session is refused NO_ACTIVE_WORKSPACE long before reaching the enforcement
   * this file is about. Without the switch these tests would pass on the wrong
   * 4xx.
   */
  async function twoWorkspaceAdmin(): Promise<{
    cookie: string;
    tenantA: string;
    tenantB: string;
  }> {
    const a = await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: 'Acme Metering', email: ADMIN, password: PASSWORD })
      .expect(201);
    const tenantA = a.body.tenantId as string;

    const b = await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: 'Beta Utilities', email: OWNER_B, password: PASSWORD })
      .expect(201);
    const tenantB = b.body.tenantId as string;

    // B's owner grants the same person admin of B. The invitee already has a
    // password, so this is a live membership rather than a pending one.
    const ownerCookie = await login(OWNER_B);
    await http()
      .post('/api/v1/users')
      .set('Cookie', ownerCookie)
      .send({ email: ADMIN, role: 'admin' })
      .expect(201);

    const cookie = await login(ADMIN);
    const me = await http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    const ids = (me.body.workspaces as { tenantId: string }[]).map((w) => w.tenantId).sort();
    expect(ids, 'the fixture needs both workspaces live for this person').toEqual(
      [tenantA, tenantB].sort(),
    );

    // Choose A, so B is the stale claim in every test below.
    const switched = await http()
      .post('/api/v1/auth/switch')
      .set('Cookie', cookie)
      .send({ tenantId: tenantA })
      .expect(200);
    expect(switched.body.activeWorkspace.tenantId).toBe(tenantA);

    return { cookie, tenantA, tenantB };
  }

  it('the fixture is real — the admin holds two workspaces and can write in the active one', async () => {
    // Non-vacuity: every negative below reads a 409 as enforcement firing. If the
    // write were broken outright they would pass for the wrong reason.
    const { cookie, tenantA } = await twoWorkspaceAdmin();

    const invited = await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .set('X-Expected-Tenant', tenantA)
      .send({ email: 'tech@acme.test', role: 'technician' });

    expect(invited.status, 'a write naming the ACTIVE tenant must succeed').toBe(201);
  });

  it('THE RACE, CLOSED — a write claiming tenant A on a session verified as B is 409, and the database is unchanged', async () => {
    const { cookie, tenantB } = await twoWorkspaceAdmin();

    const before = await migrator.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM public.memberships`,
    );

    const refused = await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      // The stale claim: the tenant the caller BELIEVED was active.
      .set('X-Expected-Tenant', tenantB)
      .send({ email: 'sneaky@acme.test', role: 'technician' });

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TENANT_MISMATCH');

    // THE HALF THAT ACTUALLY MATTERS. A 409 with the row already written closes
    // nothing — the whole point of OPEN-15 is that the write must not land under
    // the wrong tenant. Read it back rather than trusting the status code.
    const after = await migrator.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM public.memberships`,
    );
    expect(after[0]!.count, 'the refused write still created a membership').toBe(before[0]!.count);

    const planted = await migrator.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM public.users WHERE email = $1::citext`,
      'sneaky@acme.test',
    );
    expect(planted[0]!.count, 'the refused write still created a user').toBe(0n);
  });

  it('absent header means NO CLAIM, and no claim is allowed', async () => {
    // Swagger, curl and every non-browser caller send nothing. Refusing them
    // would break clients that never made a claim. The web client cannot send an
    // EMPTY claim either — api.ts only sets the header when truthy — so there is
    // no third state.
    const { cookie } = await twoWorkspaceAdmin();

    const created = await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .send({ email: 'headerless@acme.test', role: 'technician' });

    expect(created.status, 'a write with no expectation must proceed normally').toBe(201);
  });

  it('READS are not enforced — they send the header today and it must be ignored', async () => {
    // `tenantQuery` attaches the expectation to every read. Late reads are
    // already handled client-side by cache generation, and enforcing here is
    // scope the row does not ask for — so a stale claim on a GET must NOT 409.
    const { cookie, tenantB } = await twoWorkspaceAdmin();

    const read = await http()
      .get('/api/v1/users')
      .set('Cookie', cookie)
      .set('X-Expected-Tenant', tenantB);

    expect(read.status, 'a read carrying a stale expectation must still be served').toBe(200);
  });

  it('SWITCH STILL WORKS — a switch carrying a STALE expectation is not 409ed', async () => {
    // THE DEADLOCK REGRESSION GUARD. `switchTo` sends `expectedTenant:
    // activeTenantId()` — the OLD tenant — so under a naive by-method rule this
    // request 409s exactly when the client's view is stale, which is the one
    // moment it must not: the switch is the recovery action.
    const { cookie, tenantB } = await twoWorkspaceAdmin();

    const switched = await http()
      .post('/api/v1/auth/switch')
      .set('Cookie', cookie)
      // Deliberately stale: names a tenant that is NOT the verified active one.
      .set('X-Expected-Tenant', tenantB)
      .send({ tenantId: tenantB });

    expect(switched.status, 'the switch must not be refused for a stale claim').toBe(200);
    expect(switched.body.activeWorkspace.tenantId, 'and it must actually switch').toBe(tenantB);
  });

  it('enforcement covers the other three admin writes, not just the invite', async () => {
    // One route enforcing is not the row paid. PATCH, DELETE and the token mint
    // all send the header from the client, so all three must refuse a stale one.
    const { cookie, tenantA, tenantB } = await twoWorkspaceAdmin();
    const stale = tenantB;

    const invited = await http()
      .post('/api/v1/users')
      .set('Cookie', cookie)
      .set('X-Expected-Tenant', tenantA)
      .send({ email: 'target@acme.test', role: 'technician' })
      .expect(201);
    expect(invited.status).toBe(201);

    const pending = await http()
      .get('/api/v1/users/pending')
      .set('Cookie', cookie)
      .expect(200);
    const membershipId = (pending.body as { membershipId: string }[])[0]!.membershipId;

    const mint = await http()
      .post(`/api/v1/users/pending/${membershipId}/token`)
      .set('Cookie', cookie)
      .set('X-Expected-Tenant', stale);
    expect(mint.status, 'POST /users/pending/:id/token').toBe(409);
    expect(mint.body.error.code).toBe('TENANT_MISMATCH');

    const changed = await http()
      .patch(`/api/v1/users/${membershipId}`)
      .set('Cookie', cookie)
      .set('X-Expected-Tenant', stale)
      .send({ role: 'auditor' });
    expect(changed.status, 'PATCH /users/:id').toBe(409);

    const revoked = await http()
      .delete(`/api/v1/users/${membershipId}`)
      .set('Cookie', cookie)
      .set('X-Expected-Tenant', stale);
    expect(revoked.status, 'DELETE /users/:id').toBe(409);

    // And the role is untouched by the refused PATCH — the DB-unchanged half
    // again, on a route where the write is an UPDATE rather than an INSERT.
    const role = await migrator.$queryRawUnsafe<{ role: string }[]>(
      `SELECT role::text AS role FROM public.memberships WHERE id = $1::uuid`,
      membershipId,
    );
    expect(role[0]!.role, 'the refused PATCH changed the role anyway').toBe('technician');
  });
});
