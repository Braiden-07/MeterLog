import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { execAll, loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * Step 5, Phase 3 — revocation takes effect on the next request, driven by a
 * REAL `revoke_member` write through the `DELETE /users/:id` endpoint.
 *
 * **Why this is not a restatement of step 4.** Phase 3/4 of step 4 proved the
 * same fail-closed property, but the revocation itself was a hand-written
 * `UPDATE ... SET deleted_at = now()` executed by the migration role — a fixture
 * standing in for a feature that did not exist yet. The membership-write
 * functions exist now, so the revoke is performed the way a real admin performs
 * it: over HTTP, through the RBAC gate, through `revoke_member`, as the app role.
 * That closes the last gap between the proof and the product.
 *
 * **The property under test is a pooled-connection property, and it only exists
 * on a REUSED backend.** `app.current_user` / `app.current_tenant` are set with
 * `SET LOCAL`, so they revert at transaction end — to the **empty string**, not
 * to NULL, on a connection that has carried them before. A request that lands on
 * a fresh backend would fail closed for the trivial reason that nothing was ever
 * set, and would pass whether or not the per-request re-verification works. So
 * the client is pinned to `connection_limit=1` and `pg_backend_pid` is asserted
 * identical across the two requests, baseline-subtracted so a stray connection
 * from another suite cannot make the assertion vacuous.
 *
 * There is a second, sharper reason the pinning matters here. The admin's
 * `DELETE` runs on that same single backend, **in between** M's two requests. So
 * request 2 arrives on a connection whose last transaction belonged to a
 * different user, in a different role, with that user's id left behind in the
 * GUCs. If the re-verify ever read identity from the connection instead of from
 * the session, or failed to re-establish it per request, this is the shape that
 * would catch it.
 */
const PINNED = 'connection_limit=1&pool_timeout=10';

describe('revocation over HTTP, driven by a real revoke (step-5 phase 3)', () => {
  let app: INestApplication;
  let migrator: PrismaClient;
  let baselinePids: Set<number>;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';

  beforeAll(async () => {
    loadEnv();
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is not set.');

    migrator = migratorClient();
    baselinePids = await appRolePids();

    process.env.DATABASE_URL = `${base}${base.includes('?') ? '&' : '?'}${PINNED}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
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
  });

  beforeEach(wipe);

  async function wipe(): Promise<void> {
    // Shared catalog-derived teardown: TRUNCATE ... CASCADE lets Postgres resolve
    // the FK order, so this no longer breaks when a new domain table lands.
    await resetDatabase(migrator);
  }

  async function appRolePids(): Promise<Set<number>> {
    const rows = await migrator.$queryRawUnsafe<{ pid: number }[]>(
      `SELECT pid FROM pg_stat_activity WHERE usename = 'meterlog_app'`,
    );
    return new Set(rows.map((r) => r.pid));
  }

  /** Backends this API instance holds — whatever was already open is subtracted. */
  async function apiPids(): Promise<number[]> {
    const now = await appRolePids();
    return [...now].filter((pid) => !baselinePids.has(pid)).sort();
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

  it("an admin revoking M over HTTP makes M's NEXT request fail closed, on the same backend", async () => {
    // --- fixture: an admin and a technician, both real, both via the product ---
    await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: 'Acme Metering', email: 'admin@acme.test', password: PASSWORD })
      .expect(201);
    const adminCookie = await login('admin@acme.test');

    const invited = await http()
      .post('/api/v1/users')
      .set('Cookie', adminCookie)
      .send({ email: 'm@acme.test', role: 'technician' })
      .expect(201);
    const membershipId: string = invited.body.membershipId;

    // The invited identity carries the sentinel hash and cannot authenticate, by
    // design (ADR-006 §7). Give M a usable credential the only way available
    // until the set-password flow lands: copy the admin's hash as the migration
    // role. This is fixture plumbing, not a product path.
    await migrator.$executeRawUnsafe(
      `UPDATE public.users SET password_hash =
         (SELECT password_hash FROM public.users WHERE email = 'admin@acme.test'::citext)
       WHERE email = 'm@acme.test'::citext`,
    );
    const mCookie = await login('m@acme.test');

    // --- request 1: M works, and we learn which backend served it ---
    const first = await http().get('/api/v1/users').set('Cookie', mCookie).expect(200);
    expect(first.body).toHaveLength(2);

    const pidsAfterFirst = await apiPids();
    expect(pidsAfterFirst, 'the API should hold exactly one pooled connection').toHaveLength(1);

    // --- the revoke: a real admin, over HTTP, through the gate and the definer ---
    const before = await deletedAt(membershipId);
    expect(before, "M's membership should be live before the revoke").toBeNull();

    await http().delete(`/api/v1/users/${membershipId}`).set('Cookie', adminCookie).expect(204);

    // Asserted, so a revoke that silently no-ops cannot make the 403 below look
    // like a proof of anything. This is the write the whole test is about.
    const after = await deletedAt(membershipId);
    expect(after, 'the revoke did not actually soft-delete the membership').not.toBeNull();

    // The row survives — a soft delete, which is what re-invite depends on.
    const [stillThere] = await migrator.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM public.memberships WHERE id = $1::uuid`,
      membershipId,
    );
    expect(stillThere!.n).toBe(1);

    // --- request 2: M fails closed, on the SAME backend ---
    const second = await http().get('/api/v1/users').set('Cookie', mCookie);
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('MEMBERSHIP_REVOKED');

    // The assertion the whole proof rests on. Request 2 ran on the backend that
    // served request 1 — and, in between, served the ADMIN's delete. Without
    // this, a fresh connection would produce the same 403 for a reason that has
    // nothing to do with revocation.
    expect(await apiPids(), 'requests did not share a pooled connection').toEqual(pidsAfterFirst);
  });

  it('M does not 403-loop: the cleared active tenant leaves an empty workspace list', async () => {
    // The 403 clears the session's active tenant, so the request after it is a
    // normal 200 with nothing in it rather than a permanent error state. Proven
    // in step 4 against a fixture revoke; re-proven here behind a real one.
    await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: 'Acme Metering', email: 'admin@acme.test', password: PASSWORD })
      .expect(201);
    const adminCookie = await login('admin@acme.test');

    const invited = await http()
      .post('/api/v1/users')
      .set('Cookie', adminCookie)
      .send({ email: 'm@acme.test', role: 'technician' })
      .expect(201);
    await migrator.$executeRawUnsafe(
      `UPDATE public.users SET password_hash =
         (SELECT password_hash FROM public.users WHERE email = 'admin@acme.test'::citext)
       WHERE email = 'm@acme.test'::citext`,
    );
    const mCookie = await login('m@acme.test');

    await http().get('/api/v1/auth/me').set('Cookie', mCookie).expect(200);
    await http()
      .delete(`/api/v1/users/${invited.body.membershipId}`)
      .set('Cookie', adminCookie)
      .expect(204);

    await http().get('/api/v1/auth/me').set('Cookie', mCookie).expect(403);

    const third = await http().get('/api/v1/auth/me').set('Cookie', mCookie).expect(200);
    expect(third.body.activeWorkspace).toBeNull();
    expect(third.body.workspaces).toEqual([]);
  });

  it("the revoking admin's own session is unaffected", async () => {
    // Pairs with the two above: without it, they would still pass if the revoke
    // had broken the tenant for everyone rather than for M.
    await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: 'Acme Metering', email: 'admin@acme.test', password: PASSWORD })
      .expect(201);
    const adminCookie = await login('admin@acme.test');

    const invited = await http()
      .post('/api/v1/users')
      .set('Cookie', adminCookie)
      .send({ email: 'm@acme.test', role: 'technician' })
      .expect(201);

    await http()
      .delete(`/api/v1/users/${invited.body.membershipId}`)
      .set('Cookie', adminCookie)
      .expect(204);

    const me = await http().get('/api/v1/auth/me').set('Cookie', adminCookie).expect(200);
    expect(me.body.activeWorkspace).toMatchObject({ name: 'Acme Metering', role: 'admin' });

    const list = await http().get('/api/v1/users').set('Cookie', adminCookie).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].email).toBe('admin@acme.test');
  });

  async function deletedAt(membershipId: string): Promise<Date | null> {
    const [row] = await migrator.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
      `SELECT deleted_at FROM public.memberships WHERE id = $1::uuid`,
      membershipId,
    );
    return row?.deleted_at ?? null;
  }
});
