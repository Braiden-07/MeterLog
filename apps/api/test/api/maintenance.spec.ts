import { randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * Step 6, Phase 4 (6b) — `maintenance_records` over real HTTP.
 *
 * The fourth and final v1.0 domain child, and the only one with a general
 * SELECT / INSERT / UPDATE / soft-DELETE surface (ADR-008). Two properties here are
 * new to the domain and get the scrutiny:
 *
 *   * **A general field edit** — `PATCH` that changes a value rather than advancing
 *     a state machine, which means tenant isolation has to hold on `UPDATE` for the
 *     first time.
 *   * **A soft delete whose hard counterpart does not exist**, proven by the
 *     `permission denied` negative at the DB layer (`isolation.spec.ts`).
 *
 * The pagination boundary tests ship WITH the endpoint rather than later: Finding 7
 * (the cursor that lost rows) does not get to recur on a new list endpoint.
 */
describe('maintenance records API (step-6 phase 4)', () => {
  let app: INestApplication;
  let migrator: PrismaClient;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';

  beforeAll(async () => {
    loadEnv();
    migrator = migratorClient();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await app.close();
    await migrator.$disconnect();
  });

  beforeEach(() => resetDatabase(migrator));

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

  async function newOrg(
    tenantName: string,
    email: string,
  ): Promise<{ cookie: string; tenantId: string; userId: string }> {
    const created = await http()
      .post('/api/v1/auth/register')
      .send({ tenantName, email, password: PASSWORD })
      .expect(201);
    return {
      cookie: await login(email),
      tenantId: created.body.tenantId,
      userId: created.body.userId,
    };
  }

  async function addMember(
    adminCookie: string,
    adminEmail: string,
    email: string,
    role: 'admin' | 'technician' | 'auditor',
  ): Promise<string> {
    await http().post('/api/v1/users').set('Cookie', adminCookie).send({ email, role }).expect(201);
    await migrator.$executeRawUnsafe(
      `UPDATE public.users SET password_hash =
         (SELECT password_hash FROM public.users WHERE email = $2) WHERE email = $1`,
      email,
      adminEmail,
    );
    return login(email);
  }

  async function registerAsset(cookie: string): Promise<string> {
    const res = await http()
      .post('/api/v1/assets')
      .set('Cookie', cookie)
      .send({ serialNumber: `SN-${randomUUID().slice(0, 8)}`, type: 'meter' })
      .expect(201);
    return res.body.id;
  }

  const createRecord = (
    cookie: string,
    assetId: string,
    description = 'annual service',
    performedAt = '2026-04-01T09:00:00.000Z',
  ) =>
    http()
      .post('/api/v1/maintenance-records')
      .set('Cookie', cookie)
      .send({ assetId, description, performedAt });

  async function rowOf(id: string): Promise<{
    tenant_id: string;
    asset_id: string;
    description: string;
    deleted_at: Date | null;
  }> {
    const rows = await migrator.$queryRawUnsafe<
      { tenant_id: string; asset_id: string; description: string; deleted_at: Date | null }[]
    >(
      `SELECT tenant_id::text AS tenant_id, asset_id::text AS asset_id, description, deleted_at
         FROM public.maintenance_records WHERE id = $1::uuid`,
      id,
    );
    return rows[0]!;
  }

  // ================================================================ the surface
  describe('create, read, edit', () => {
    it('creates a record against an asset in the caller tenant', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);

      const res = await createRecord(a.cookie, asset, 'replaced dial').expect(201);
      expect(res.body.assetId).toBe(asset);
      expect(res.body.description).toBe('replaced dial');
      expect(res.body.createdBy).toBe(a.userId);
      expect(res.body.deletedAt).toBeNull();

      const row = await rowOf(res.body.id);
      expect(row.tenant_id).toBe(a.tenantId);
    });

    it('rejects a client-supplied tenantId as an unknown field', async () => {
      // The tenant comes from app.current_tenant; there is no field in which to
      // name another one, so a cross-tenant write is inexpressible rather than
      // merely refused.
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Beta', 'admin@beta.test');
      const asset = await registerAsset(a.cookie);

      await http()
        .post('/api/v1/maintenance-records')
        .set('Cookie', a.cookie)
        .send({
          assetId: asset,
          description: 'x',
          performedAt: '2026-04-01T09:00:00.000Z',
          tenantId: b.tenantId,
        })
        .expect(400);
    });

    it('404s a create naming an asset in another tenant — never a foreign insert', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Beta', 'admin@beta.test');
      const assetB = await registerAsset(b.cookie);

      const res = await createRecord(a.cookie, assetB).expect(404);
      expect(res.body.error.code).toBe('ASSET_NOT_FOUND');

      const count = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.maintenance_records`,
      );
      expect(count[0]!.n).toBe(0);
    });

    it('PATCH edits a field — the first general field edit in the domain', async () => {
      // On `assets`, PATCH edits metadata and `status` is a transition that must
      // emit an event. Here PATCH changes a value and nothing is emitted, because
      // correcting a description is not a lifecycle event (§9.2).
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset, 'before').expect(201);

      const eventsBefore = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.asset_events`,
      );

      const res = await http()
        .patch(`/api/v1/maintenance-records/${created.body.id}`)
        .set('Cookie', a.cookie)
        .send({ description: 'after', performedAt: '2026-05-02T10:00:00.000Z' })
        .expect(200);

      expect(res.body.description).toBe('after');
      expect(new Date(res.body.performedAt).toISOString()).toBe('2026-05-02T10:00:00.000Z');

      const eventsAfter = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.asset_events`,
      );
      expect(eventsAfter[0]!.n).toBe(eventsBefore[0]!.n);
    });

    it('PATCH { assetId } is 400 — records are not reparentable, and the DTO is the guard', async () => {
      // `forbidNonWhitelisted` only refuses fields the DTO does not DECLARE, so it
      // does nothing the moment someone adds `assetId` "so a mis-filed record can be
      // moved". The real guard is the absence of the field, and this test pins it.
      //
      // Why it must stay absent: a maintenance record documents work done on one
      // physical asset. Moving it rewrites two histories at once. A mis-filed record
      // is soft-deleted and re-created (ADR-008).
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const other = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset).expect(201);

      await http()
        .patch(`/api/v1/maintenance-records/${created.body.id}`)
        .set('Cookie', a.cookie)
        .send({ assetId: other })
        .expect(400);

      expect((await rowOf(created.body.id)).asset_id).toBe(asset);
    });

    it('PATCH { tenantId } and { deletedAt } are 400', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Beta', 'admin@beta.test');
      const asset = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset).expect(201);
      const url = `/api/v1/maintenance-records/${created.body.id}`;

      await http().patch(url).set('Cookie', a.cookie).send({ tenantId: b.tenantId }).expect(400);
      await http()
        .patch(url)
        .set('Cookie', a.cookie)
        .send({ deletedAt: new Date().toISOString() })
        .expect(400);

      const row = await rowOf(created.body.id);
      expect(row.tenant_id).toBe(a.tenantId);
      expect(row.deleted_at).toBeNull();
    });

    it('validates the payload', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const url = '/api/v1/maintenance-records';

      await http().post(url).set('Cookie', a.cookie).send({ assetId: asset }).expect(400);
      await http()
        .post(url)
        .set('Cookie', a.cookie)
        .send({ assetId: asset, description: '', performedAt: '2026-04-01T09:00:00.000Z' })
        .expect(400);
      await http()
        .post(url)
        .set('Cookie', a.cookie)
        .send({ assetId: 'not-a-uuid', description: 'x', performedAt: '2026-04-01T09:00:00.000Z' })
        .expect(400);
      await http()
        .post(url)
        .set('Cookie', a.cookie)
        .send({ assetId: asset, description: 'x', performedAt: 'nope' })
        .expect(400);
    });
  });

  // ============================================================== soft delete
  describe('soft delete — the row persists (ADR-008)', () => {
    it('DELETE returns 204, the row survives, and it leaves the default list', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset).expect(201);

      await http()
        .delete(`/api/v1/maintenance-records/${created.body.id}`)
        .set('Cookie', a.cookie)
        .expect(204);

      // THE ROW PERSISTS — this is the whole point of soft delete, and the reason
      // hard delete is deferred until something can audit it (OPEN-9).
      const row = await rowOf(created.body.id);
      expect(row.deleted_at).not.toBeNull();
      expect(row.description).toBe('annual service');

      const list = await http()
        .get('/api/v1/maintenance-records')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(list.body.items).toHaveLength(0);

      const withDeleted = await http()
        .get('/api/v1/maintenance-records?includeDeleted=true')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(withDeleted.body.items).toHaveLength(1);
    });

    it('GET /:id still returns a soft-deleted record — list scope, not existence', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset).expect(201);
      await http()
        .delete(`/api/v1/maintenance-records/${created.body.id}`)
        .set('Cookie', a.cookie)
        .expect(204);

      const res = await http()
        .get(`/api/v1/maintenance-records/${created.body.id}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(res.body.deletedAt).not.toBeNull();
    });

    it('a second DELETE is idempotent, unlike decommissioning an asset', async () => {
      // Deliberately different from `DELETE /assets/:id`, which 409s because it is a
      // lifecycle TRANSITION and a second `decommissioned` event would corrupt the
      // log. This writes no event and has no state machine, so re-deleting changes
      // nothing observable.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset).expect(201);
      const url = `/api/v1/maintenance-records/${created.body.id}`;

      await http().delete(url).set('Cookie', a.cookie).expect(204);
      const first = await rowOf(created.body.id);
      await http().delete(url).set('Cookie', a.cookie).expect(204);
      const second = await rowOf(created.body.id);

      // The original deleted_at is preserved — the second call did not re-stamp it.
      expect(second.deleted_at).toEqual(first.deleted_at);
    });

    it('decommissioning an asset does NOT remove its maintenance history', async () => {
      // The reason both FKs are ON DELETE RESTRICT and nothing cascades: the
      // maintenance history of a failed asset is precisely what an auditor wants
      // after it fails.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset).expect(201);

      await http().delete(`/api/v1/assets/${asset}`).set('Cookie', a.cookie).expect(204);

      const still = await http()
        .get(`/api/v1/maintenance-records/${created.body.id}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(still.body.deletedAt).toBeNull();
    });
  });

  // ============================================================== pagination
  describe('pagination — Finding 7 applied from day one', () => {
    it('walks the whole set with no repeats and no gaps', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      for (let i = 0; i < 12; i++) {
        await createRecord(
          a.cookie,
          asset,
          `visit ${i}`,
          new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
        ).expect(201);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page++) {
        const url: string = `/api/v1/maintenance-records?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await http().get(url).set('Cookie', a.cookie).expect(200);
        seen.push(...res.body.items.map((r: { id: string }) => r.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }

      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
    });

    it('orders records sharing a performed_at deterministically — the id tiebreaker', async () => {
      // FINDING 7's lesson applied rather than rediscovered. Two records at the same
      // instant is ordinary (a technician logging a morning's work), and without the
      // id in the cursor tuple a page boundary between them loses a row.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const same = '2026-03-03T00:00:00.000Z';
      const ids = [
        (await createRecord(a.cookie, asset, 'a', same).expect(201)).body.id,
        (await createRecord(a.cookie, asset, 'b', same).expect(201)).body.id,
      ].sort();

      const p1 = await http()
        .get('/api/v1/maintenance-records?limit=1')
        .set('Cookie', a.cookie)
        .expect(200);
      const p2 = await http()
        .get(`/api/v1/maintenance-records?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
        .set('Cookie', a.cookie)
        .expect(200);

      const walked = [p1.body.items[0].id, p2.body.items[0].id];
      expect([...walked].sort()).toEqual(ids);
      expect(walked[0] > walked[1]).toBe(true);
    });

    it('microsecond-precision timestamps survive the cursor round trip', async () => {
      // The exact shape of Finding 7: `created_at` is server-generated by now(), so
      // it carries microseconds that a JS Date would truncate. Sorting by it and
      // paginating one at a time is what exposed the original bug.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      for (let i = 0; i < 3; i++) await createRecord(a.cookie, asset, `v${i}`).expect(201);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const url: string = `/api/v1/maintenance-records?sort=createdAt&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await http().get(url).set('Cookie', a.cookie).expect(200);
        seen.push(...res.body.items.map((r: { id: string }) => r.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(3);
    });

    it('rows sharing a created_at to the MICROSECOND both survive the cursor', async () => {
      // ADDED AFTER A MUTATION ESCAPED, and the escape is the interesting part.
      //
      // Restoring Finding 7's bug here — building the cursor from a JS `Date`, which
      // truncates Postgres microseconds to milliseconds — reddened NOTHING. The test
      // above creates its rows through separate HTTP requests, so their `created_at`
      // values differ by a millisecond or more and truncation loses nothing; the
      // `performed_at` tie test uses whole-millisecond ISO strings, where truncation
      // is exactly lossless.
      //
      // **That is the same blind spot that let Finding 7 through phase 3a's sweep.**
      // Writing a test "for the lesson" with millisecond-granular fixtures does not
      // test the lesson. The bug needs two rows inside the SAME millisecond, which
      // only a single multi-row statement reliably produces — exactly the shape of
      // the genesis pair that originally exposed it.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);

      const seeded = await migrator.$queryRawUnsafe<{ id: string; created_at: Date }[]>(
        `INSERT INTO public.maintenance_records
           (tenant_id, asset_id, description, performed_at, created_by)
         VALUES ($1::uuid, $2::uuid, 'first',  now(), $3::uuid),
                ($1::uuid, $2::uuid, 'second', now(), $3::uuid)
         RETURNING id::text AS id, created_at`,
        a.tenantId,
        asset,
        a.userId,
      );

      // Non-vacuity: the premise of the test is that these two share a created_at.
      // If a future Postgres made now() per-row, this assertion fails loudly rather
      // than the test quietly going back to proving nothing.
      expect(seeded).toHaveLength(2);
      expect(seeded[0]!.created_at.getTime()).toBe(seeded[1]!.created_at.getTime());
      const ids = seeded.map((r) => r.id).sort();

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page++) {
        const url: string = `/api/v1/maintenance-records?sort=createdAt&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await http().get(url).set('Cookie', a.cookie).expect(200);
        seen.push(...res.body.items.map((r: { id: string }) => r.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }

      // Both rows, exactly once each. Under the truncating cursor the second page
      // comes back empty and one row is silently lost.
      expect(seen).toHaveLength(2);
      expect([...seen].sort()).toEqual(ids);
    });

    it('boundaries: empty, single full page, limit at 1 and 100, cursor past the end', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);

      // Empty.
      const empty = await http()
        .get('/api/v1/maintenance-records')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(empty.body.items).toEqual([]);
      expect(empty.body.nextCursor).toBeNull();

      await createRecord(a.cookie, asset, 'one', '2026-01-01T00:00:00.000Z').expect(201);
      await createRecord(a.cookie, asset, 'two', '2026-01-02T00:00:00.000Z').expect(201);

      // A single page that exactly consumes the set must not hand back a cursor to
      // nowhere — that costs every client one pointless request per list.
      const exact = await http()
        .get('/api/v1/maintenance-records?limit=2')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(exact.body.items).toHaveLength(2);
      expect(exact.body.nextCursor).toBeNull();

      // Accepted boundaries.
      await http().get('/api/v1/maintenance-records?limit=1').set('Cookie', a.cookie).expect(200);
      await http().get('/api/v1/maintenance-records?limit=100').set('Cookie', a.cookie).expect(200);
      // Rejected boundaries.
      await http().get('/api/v1/maintenance-records?limit=0').set('Cookie', a.cookie).expect(400);
      await http().get('/api/v1/maintenance-records?limit=101').set('Cookie', a.cookie).expect(400);

      // Cursor past the end.
      const exhausted = Buffer.from(
        JSON.stringify({ k: '1970-01-01 00:00:00+00', i: randomUUID() }),
        'utf8',
      ).toString('base64url');
      const past = await http()
        .get(`/api/v1/maintenance-records?cursor=${encodeURIComponent(exhausted)}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(past.body.items).toEqual([]);
      expect(past.body.nextCursor).toBeNull();
    });

    it('rejects a malformed cursor with 400 and the envelope', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const res = await http()
        .get('/api/v1/maintenance-records?cursor=!!!')
        .set('Cookie', a.cookie)
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });

    it('filters by assetId and a performed_at range', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const one = await registerAsset(a.cookie);
      const two = await registerAsset(a.cookie);
      await createRecord(a.cookie, one, 'old', '2026-01-01T00:00:00.000Z').expect(201);
      await createRecord(a.cookie, one, 'new', '2026-06-01T00:00:00.000Z').expect(201);
      await createRecord(a.cookie, two, 'other', '2026-06-01T00:00:00.000Z').expect(201);

      const byAsset = await http()
        .get(`/api/v1/maintenance-records?assetId=${one}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(byAsset.body.items).toHaveLength(2);

      const byRange = await http()
        .get('/api/v1/maintenance-records?from=2026-05-01T00:00:00.000Z')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(byRange.body.items).toHaveLength(2);
    });
  });

  // ==================================================================== RBAC
  describe('RBAC', () => {
    it('admin and technician may write; auditor gets 403 on all three writes', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const tech = await addMember(a.cookie, 'admin@acme.test', 'tech@acme.test', 'technician');
      const audit = await addMember(a.cookie, 'admin@acme.test', 'audit@acme.test', 'auditor');
      const asset = await registerAsset(a.cookie);

      const byAdmin = await createRecord(a.cookie, asset).expect(201);
      const byTech = await createRecord(tech, asset).expect(201);
      await http()
        .patch(`/api/v1/maintenance-records/${byTech.body.id}`)
        .set('Cookie', tech)
        .send({ description: 'edited by tech' })
        .expect(200);
      await http()
        .delete(`/api/v1/maintenance-records/${byTech.body.id}`)
        .set('Cookie', tech)
        .expect(204);

      // The auditor is read-ONLY, not read-restricted.
      await http().get('/api/v1/maintenance-records').set('Cookie', audit).expect(200);
      await http()
        .get(`/api/v1/maintenance-records/${byAdmin.body.id}`)
        .set('Cookie', audit)
        .expect(200);

      for (const res of [
        await createRecord(audit, asset),
        await http()
          .patch(`/api/v1/maintenance-records/${byAdmin.body.id}`)
          .set('Cookie', audit)
          .send({ description: 'by auditor' }),
        await http().delete(`/api/v1/maintenance-records/${byAdmin.body.id}`).set('Cookie', audit),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
      }

      // Nothing the auditor attempted landed.
      const admin = await rowOf(byAdmin.body.id);
      expect(admin.description).toBe('annual service');
      expect(admin.deleted_at).toBeNull();
    });

    it('401 unauthenticated, distinct from 403', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset).expect(201);

      const res = await http().get('/api/v1/maintenance-records').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      await http()
        .post('/api/v1/maintenance-records')
        .send({ assetId: asset, description: 'x', performedAt: '2026-04-01T09:00:00.000Z' })
        .expect(401);
      await http().delete(`/api/v1/maintenance-records/${created.body.id}`).expect(401);
    });

    it('a NULL role (no active tenant) is 403, NOT 500', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await registerAsset(a.cookie);
      const created = await createRecord(a.cookie, asset).expect(201);

      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE user_id = $1::uuid`,
        a.userId,
      );

      for (const res of [
        await createRecord(a.cookie, asset),
        await http()
          .patch(`/api/v1/maintenance-records/${created.body.id}`)
          .set('Cookie', a.cookie)
          .send({ description: 'x' }),
        await http()
          .delete(`/api/v1/maintenance-records/${created.body.id}`)
          .set('Cookie', a.cookie),
      ]) {
        expect(res.status).toBe(403);
        expect(res.status).not.toBe(500);
        expect(['MEMBERSHIP_REVOKED', 'FORBIDDEN_ROLE']).toContain(res.body.error.code);
      }
    });

    it('404s a well-formed id that does not exist, and 400s a malformed one', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const res = await http()
        .get(`/api/v1/maintenance-records/${randomUUID()}`)
        .set('Cookie', a.cookie)
        .expect(404);
      expect(res.body.error.code).toBe('MAINTENANCE_RECORD_NOT_FOUND');
      await http()
        .get('/api/v1/maintenance-records/not-a-uuid')
        .set('Cookie', a.cookie)
        .expect(400);
    });
  });
});
