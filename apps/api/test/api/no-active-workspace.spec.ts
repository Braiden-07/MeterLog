import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import { AssetsService } from '../../src/assets/assets.service';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * G2 — a session with NO ACTIVE WORKSPACE on a tenant-scoped route (OPEN-18).
 *
 * ADR-006 §5 has always specified the answer: "Tenant-scoped requests then 403 via
 * the existing no-active-tenant fail-closed path". The code did not do it. With no
 * tenant GUC set, RLS returns zero rows, so an un-gated list answered
 * `200 {"items":[],"nextCursor":null}` and a by-id read answered `404` — measured
 * against the unfixed interceptor before this file's fix landed. Only role-gated
 * routes 403'd, and only because a null role fails the role gate.
 *
 * That is fail-closed for ISOLATION (nothing leaked) and wrong for a CLIENT: an
 * empty 200 is indistinguishable from "this workspace has no assets", so a query
 * cache stores it as a success. Worst of all after a revoke — the first request
 * 403s `MEMBERSHIP_REVOKED` and clears the session's active tenant, and a retry
 * then sails through as an empty success. TanStack Query retries a failed query
 * three times by default, so the revoked user's screen would settle on "no data"
 * rather than on "you have no workspace".
 *
 * The fix is DEFAULT-DENY in the tenant-context interceptor: every route that is
 * not explicitly exempt refuses a no-workspace session with
 * `403 NO_ACTIVE_WORKSPACE`, BEFORE the handler, the pipes, or the role gate run.
 */
describe('G2 — no active workspace is a durable, distinct 403 (OPEN-18)', () => {
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
    await resetDatabase(migrator);
    await app.close();
    await migrator.$disconnect();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase(migrator);
  });

  // -- fixtures ---------------------------------------------------------------

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

  /** Registers an organisation; returns its admin's cookie and the tenant id. */
  async function newOrg(name: string, email: string): Promise<{ cookie: string; tenantId: string }> {
    const created = await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: name, email, password: PASSWORD })
      .expect(201);
    return { cookie: await login(email), tenantId: created.body.tenantId };
  }

  /** Attaches an EXISTING identity to the admin's workspace. */
  async function attach(adminCookie: string, email: string, role: string): Promise<string> {
    await http()
      .post('/api/v1/users')
      .set('Cookie', adminCookie)
      .send({ email, role })
      .expect(201);
    const members = await http().get('/api/v1/users').set('Cookie', adminCookie).expect(200);
    const row = (members.body as { email: string; membershipId: string }[]).find(
      (m) => m.email === email,
    );
    if (!row) throw new Error(`${email} did not appear in the member list`);
    return row.membershipId;
  }

  async function registerAsset(cookie: string): Promise<string> {
    const res = await http()
      .post('/api/v1/assets')
      .set('Cookie', cookie)
      .send({ serialNumber: `SN-${randomUUID().slice(0, 8)}`, type: 'meter', location: 'Plant 1' })
      .expect(201);
    return res.body.id as string;
  }

  /**
   * M: a person with TWO live memberships and therefore no active workspace after
   * login (ADR-006 §5, the "many" branch). The state is asserted, not assumed —
   * a login that auto-selected would make every test below prove nothing.
   */
  async function noWorkspaceCaller(): Promise<{ cookie: string; otherOrg: { cookie: string; tenantId: string } }> {
    await newOrg('M Home', 'm@home.test');
    const other = await newOrg('Yonder', 'admin@yonder.test');
    await attach(other.cookie, 'm@home.test', 'technician');

    const cookie = await login('m@home.test');
    const me = await http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.activeWorkspace, 'fixture: M must have NO active workspace').toBeNull();
    expect(me.body.workspaces).toHaveLength(2);
    return { cookie, otherOrg: other };
  }

  // =========================================================================
  describe('default-deny on every tenant-scoped route', () => {
    it('every tenant-scoped READ answers 403 NO_ACTIVE_WORKSPACE — not 200-empty, not 404', async () => {
      const { cookie } = await noWorkspaceCaller();
      const id = randomUUID();

      // The un-gated reads are the ones that used to leak a false success: the
      // two lists answered 200 {"items":[]}, the by-id reads 404, and GET /users
      // 200 with the caller's own memberships from every workspace.
      const reads = [
        '/api/v1/assets',
        `/api/v1/assets/${id}`,
        `/api/v1/assets/${id}/events`,
        `/api/v1/assets/${id}/readings`,
        '/api/v1/maintenance-records',
        `/api/v1/maintenance-records/${id}`,
        '/api/v1/users',
        '/api/v1/users/pending',
        '/api/v1/audit',
      ];

      for (const path of reads) {
        const res = await http().get(path).set('Cookie', cookie);
        expect(res.status, `GET ${path} must be refused, not answered`).toBe(403);
        expect(res.body.items, `GET ${path} must carry no page`).toBeUndefined();
        expect(res.body.error.code, `GET ${path}`).toBe('NO_ACTIVE_WORKSPACE');
      }
    });

    it('gated WRITES get the same answer — the deny runs before the role gate', async () => {
      const { cookie } = await noWorkspaceCaller();
      // Thunks, not pre-built requests: supertest binds the server when a request
      // is constructed and releases it when that request ends.
      const writes = [
        () => http().post('/api/v1/assets').set('Cookie', cookie).send({ serialNumber: 'SN-1', type: 'meter', location: 'x' }),
        () => http().post('/api/v1/users').set('Cookie', cookie).send({ email: 'x@home.test', role: 'technician' }),
        () =>
          http()
            .post('/api/v1/maintenance-records')
            .set('Cookie', cookie)
            .send({ assetId: randomUUID(), description: 'x', performedAt: '2026-01-01T00:00:00.000Z' }),
      ];
      for (const send of writes) {
        const res = await send();
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('NO_ACTIVE_WORKSPACE');
      }
    });

    it('the SAME caller is served once a workspace is chosen — the route works, the state was the refusal', async () => {
      const { cookie, otherOrg } = await noWorkspaceCaller();
      await http().get('/api/v1/assets').set('Cookie', cookie).expect(403);
      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie)
        .send({ tenantId: otherOrg.tenantId })
        .expect(200);
      const res = await http().get('/api/v1/assets').set('Cookie', cookie).expect(200);
      expect(res.body.items).toEqual([]);
    });
  });

  // =========================================================================
  describe('THE ORACLE TEST — the no-workspace answer cannot vary with the id', () => {
    it('GET /assets/:id is byte-identical for a foreign asset, a formerly-held asset, and a random uuid — and the handler never runs', async () => {
      // (a) a real asset in a tenant M never belonged to
      const foreign = await newOrg('Xenon', 'admin@xenon.test');
      const foreignAsset = await registerAsset(foreign.cookie);

      // (b) a real asset in a tenant M USED to belong to, now revoked
      const former = await newOrg('Former', 'admin@former.test');
      const formerAsset = await registerAsset(former.cookie);

      const { cookie } = await noWorkspaceCaller();
      const formerMembership = await attach(former.cookie, 'm@home.test', 'technician');
      await http()
        .delete(`/api/v1/users/${formerMembership}`)
        .set('Cookie', former.cookie)
        .expect(204);

      // (c) a random well-formed uuid
      const random = randomUUID();

      // SHOW THE POSITIVE FIRST. The three ids must be genuinely different to
      // anything that reads them, or identical answers below would prove
      // nothing: a handler with a workspace distinguishes all three.
      await http().get(`/api/v1/assets/${foreignAsset}`).set('Cookie', foreign.cookie).expect(200);
      await http().get(`/api/v1/assets/${formerAsset}`).set('Cookie', former.cookie).expect(200);
      await http().get(`/api/v1/assets/${formerAsset}`).set('Cookie', foreign.cookie).expect(404);
      await http().get(`/api/v1/assets/${random}`).set('Cookie', foreign.cookie).expect(404);

      // The fixture state M is in when asking: still no active workspace, and
      // the revoked membership is gone from their list.
      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.activeWorkspace).toBeNull();
      expect(me.body.workspaces).toHaveLength(2);

      // The handler is spied so "nothing in the response can vary on the uuid"
      // is observed rather than argued: if the refusal comes from before the
      // handler, the service is never asked about any of the ids.
      const findOne = vi.spyOn(app.get(AssetsService), 'findOne');

      const answers = [];
      for (const id of [foreignAsset, formerAsset, random]) {
        answers.push(await http().get(`/api/v1/assets/${id}`).set('Cookie', cookie));
      }

      const [a, b, c] = answers;
      expect(a!.status).toBe(403);
      expect(b!.status).toBe(a!.status);
      expect(c!.status).toBe(a!.status);
      // Byte-identical, compared on the raw body text rather than parsed JSON.
      expect(b!.text).toBe(a!.text);
      expect(c!.text).toBe(a!.text);
      expect(findOne, 'the handler ran — the refusal is not coming from before it').not.toHaveBeenCalled();

      // A malformed id is refused identically too: the deny precedes the
      // ParseUUIDPipe, so not even the SHAPE of the id is evaluated.
      const malformed = await http().get('/api/v1/assets/not-a-uuid').set('Cookie', cookie);
      expect(malformed.status).toBe(a!.status);
      expect(malformed.text).toBe(a!.text);

      // Non-vacuity of the spy: it does see a call when the handler runs.
      await http().get(`/api/v1/assets/${foreignAsset}`).set('Cookie', foreign.cookie).expect(200);
      expect(findOne).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  describe('distinct from the role gate', () => {
    it('NO_ACTIVE_WORKSPACE differs from FORBIDDEN_ROLE on an otherwise-identical role-denied request', async () => {
      // Wrong role: a technician with an ACTIVE workspace asks for the trail.
      const org = await newOrg('Acme', 'admin@acme.test');
      await newOrg('Tech Home', 'tech@acme.test');
      await attach(org.cookie, 'tech@acme.test', 'technician');
      const techCookie = await login('tech@acme.test');
      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', techCookie)
        .send({ tenantId: org.tenantId })
        .expect(200);
      const wrongRole = await http().get('/api/v1/audit').set('Cookie', techCookie);

      // No workspace: the same route, the same method, no body.
      const { cookie } = await noWorkspaceCaller();
      const noWorkspace = await http().get('/api/v1/audit').set('Cookie', cookie);

      expect(wrongRole.status).toBe(403);
      expect(noWorkspace.status).toBe(403);
      expect(wrongRole.body.error.code).toBe('FORBIDDEN_ROLE');
      // "Pick a workspace" and "you are not allowed" must be tellable apart.
      expect(noWorkspace.body.error.code, 'the no-workspace refusal is indistinguishable from the role gate').not.toBe(
        wrongRole.body.error.code,
      );
    });
  });

  // =========================================================================
  describe('durability — the slice-1 dependency', () => {
    it('after a revoke, a client retrying 3x NEVER gets 200 {"items":[]} — every attempt is 403', async () => {
      const org = await newOrg('Acme', 'admin@acme.test');
      await newOrg('M Home', 'm@home.test');
      const membership = await attach(org.cookie, 'm@home.test', 'technician');

      const cookie = await login('m@home.test');
      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie)
        .send({ tenantId: org.tenantId })
        .expect(200);
      // Served while the membership is live.
      await http().get('/api/v1/assets').set('Cookie', cookie).expect(200);

      await http().delete(`/api/v1/users/${membership}`).set('Cookie', org.cookie).expect(204);

      // One request plus TanStack Query's default three retries.
      const attempts = [];
      for (let i = 0; i < 4; i++) {
        attempts.push(await http().get('/api/v1/assets').set('Cookie', cookie));
      }

      for (const [i, res] of attempts.entries()) {
        expect(res.status, `attempt ${i + 1} converted the refusal into a success`).toBe(403);
        expect(res.body.items, `attempt ${i + 1} returned a page`).toBeUndefined();
      }
      // The code names the real reason at each step: the first request still
      // claims the revoked workspace; it clears the claim on its way out, and
      // every retry is then in the no-workspace state. The STATUS is what a
      // client's retry logic sees, and it never changes.
      expect(attempts.map((r) => r.body.error.code)).toEqual([
        'MEMBERSHIP_REVOKED',
        'NO_ACTIVE_WORKSPACE',
        'NO_ACTIVE_WORKSPACE',
        'NO_ACTIVE_WORKSPACE',
      ]);
    });
  });

  // =========================================================================
  describe('the exempt routes are unaffected', () => {
    it('auth and health all answer normally for a no-workspace session', async () => {
      const { cookie, otherOrg } = await noWorkspaceCaller();

      await http().get('/api/v1/health').set('Cookie', cookie).expect(200);

      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.activeWorkspace).toBeNull();

      await http()
        .post('/api/v1/auth/login')
        .set('Cookie', cookie)
        .send({ email: 'm@home.test', password: PASSWORD })
        .expect(200);

      await http()
        .post('/api/v1/auth/register')
        .set('Cookie', cookie)
        .send({ tenantName: 'Another', email: 'new@another.test', password: PASSWORD })
        .expect(201);

      // A bogus token is a 400 from the token check — reaching it at all is the
      // point: the request was not refused for the session's state.
      const setPassword = await http()
        .post('/api/v1/auth/set-password')
        .set('Cookie', cookie)
        .send({ token: 'f'.repeat(64), password: PASSWORD });
      expect(setPassword.status).toBe(400);

      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', cookie)
        .send({ tenantId: otherOrg.tenantId })
        .expect(200);

      await http().post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    });
  });
});
