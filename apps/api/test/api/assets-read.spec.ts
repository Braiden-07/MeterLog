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
 * Step 6, Phase 3a — the asset read surface, over real HTTP with real signed
 * session cookies through the globally-bound interceptor.
 *
 * Same standard as the step-4 and step-5 acceptance suites: calling the service
 * directly would test a world in which the interceptor does not exist, and the
 * interceptor is the only thing that sets `app.current_tenant`. A read suite that
 * bypassed it would prove nothing about isolation at all.
 *
 * The headline here is the READ AXIS of ADR-006 §8.3 — the shared-user case. The
 * full SELECT/UPDATE/DELETE/INSERT matrix is the phase 3d capstone; the read half
 * is proven now, while there is nothing else to go wrong.
 */
describe('assets read surface (step-6 phase 3a)', () => {
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

  /**
   * Seeds an asset as the MIGRATION role.
   *
   * No write endpoint exists until phase 3b, so fixtures are seeded privileged —
   * the same approach every db suite uses. This is deliberate for a read phase:
   * the reads are proven against data they did not create, so a bug that affected
   * both writing and reading symmetrically could not hide.
   */
  async function seedAsset(
    tenantId: string,
    overrides: Partial<{
      serial: string;
      type: string;
      status: string;
      createdAt: string;
      deleted: boolean;
    }> = {},
  ): Promise<string> {
    const serial = overrides.serial ?? `SN-${randomUUID().slice(0, 8)}`;
    const rows = await migrator.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO public.assets (tenant_id, serial_number, type, status, created_at, deleted_at)
       VALUES ($1::uuid, $2, $3, $4::public.asset_status,
               coalesce($5::timestamptz, now()), CASE WHEN $6 THEN now() ELSE NULL END)
       RETURNING id::text AS id`,
      tenantId,
      serial,
      overrides.type ?? 'meter',
      overrides.status ?? 'installed',
      overrides.createdAt ?? null,
      overrides.deleted ?? false,
    );
    return rows[0]!.id;
  }

  async function seedReading(
    tenantId: string,
    assetId: string,
    userId: string,
    readAt: string,
  ): Promise<string> {
    const rows = await migrator.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO public.readings (tenant_id, asset_id, value, unit, read_at, created_by)
       VALUES ($1::uuid, $2::uuid, 1.5, 'kWh', $3::timestamptz, $4::uuid)
       RETURNING id::text AS id`,
      tenantId,
      assetId,
      readAt,
      userId,
    );
    return rows[0]!.id;
  }

  async function seedEvent(
    tenantId: string,
    assetId: string,
    userId: string,
    eventType: string,
    createdAt: string,
  ): Promise<string> {
    const rows = await migrator.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO public.asset_events (tenant_id, asset_id, event_type, created_by, created_at)
       VALUES ($1::uuid, $2::uuid, $3::public.asset_event_type, $4::uuid, $5::timestamptz)
       RETURNING id::text AS id`,
      tenantId,
      assetId,
      eventType,
      userId,
      createdAt,
    );
    return rows[0]!.id;
  }

  // ===================================================================== 8.3
  describe('ADR-006 §8.3 read axis — the shared-user headline', () => {
    it('a user active in A sees A and never B, across all four reads', async () => {
      // M holds a LEGITIMATE membership in both tenants. That is what makes this
      // strictly stronger than "different users cannot cross tenants": there is no
      // user-level boundary to fall back on, only the active-tenant GUC.
      const a = await newOrg('Tenant A', 'm@acme.test');
      const b = await newOrg('Tenant B', 'owner-b@beta.test');

      await http()
        .post('/api/v1/users')
        .set('Cookie', b.cookie)
        .send({ email: 'm@acme.test', role: 'technician' })
        .expect(201);

      const assetA = await seedAsset(a.tenantId, { serial: 'A-0001' });
      const assetB = await seedAsset(b.tenantId, { serial: 'B-0001' });
      await seedReading(a.tenantId, assetA, a.userId, '2026-01-01T00:00:00Z');
      await seedReading(b.tenantId, assetB, b.userId, '2026-01-01T00:00:00Z');
      await seedEvent(a.tenantId, assetA, a.userId, 'created', '2026-01-01T00:00:00Z');
      await seedEvent(b.tenantId, assetB, b.userId, 'created', '2026-01-01T00:00:00Z');

      // M is active in A (registration made A the active workspace).
      const list = await http().get('/api/v1/assets').set('Cookie', a.cookie).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].serialNumber).toBe('A-0001');

      // B's asset is invisible by id, even though M genuinely holds B.
      await http().get(`/api/v1/assets/${assetB}`).set('Cookie', a.cookie).expect(404);
      await http().get(`/api/v1/assets/${assetB}/readings`).set('Cookie', a.cookie).expect(404);
      await http().get(`/api/v1/assets/${assetB}/events`).set('Cookie', a.cookie).expect(404);

      // A's own asset and children are readable.
      await http().get(`/api/v1/assets/${assetA}`).set('Cookie', a.cookie).expect(200);
      const rA = await http()
        .get(`/api/v1/assets/${assetA}/readings`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(rA.body.items).toHaveLength(1);

      // And the mirror image after switching: the SAME session, now active in B,
      // sees B and not A. Proves the boundary follows the active tenant rather
      // than the person or the session.
      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', a.cookie)
        .send({ tenantId: b.tenantId })
        .expect(200);

      const afterSwitch = await http().get('/api/v1/assets').set('Cookie', a.cookie).expect(200);
      expect(afterSwitch.body.items).toHaveLength(1);
      expect(afterSwitch.body.items[0].serialNumber).toBe('B-0001');
      await http().get(`/api/v1/assets/${assetA}`).set('Cookie', a.cookie).expect(404);
    });
  });

  // ============================================================ list scope
  describe('the soft-delete filter is a LIST-SCOPE default, not an existence check', () => {
    it('excludes decommissioned assets from the list by default', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await seedAsset(a.tenantId, { serial: 'LIVE-1' });
      await seedAsset(a.tenantId, { serial: 'GONE-1', status: 'decommissioned', deleted: true });

      const res = await http().get('/api/v1/assets').set('Cookie', a.cookie).expect(200);
      expect(res.body.items.map((x: { serialNumber: string }) => x.serialNumber)).toEqual([
        'LIVE-1',
      ]);
    });

    it('includes them with ?includeDecommissioned=true', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await seedAsset(a.tenantId, { serial: 'LIVE-1' });
      await seedAsset(a.tenantId, { serial: 'GONE-1', status: 'decommissioned', deleted: true });

      const res = await http()
        .get('/api/v1/assets?includeDecommissioned=true')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(res.body.items).toHaveLength(2);
    });

    it('?includeDecommissioned=false does NOT fail open', async () => {
      // A query param arrives as the string "false", which is truthy. Without an
      // explicit transform this filter would switch ON when a client tried to
      // switch it off — a default that fails open on the soft-delete boundary.
      const a = await newOrg('Acme', 'admin@acme.test');
      await seedAsset(a.tenantId, { serial: 'GONE-1', status: 'decommissioned', deleted: true });

      const res = await http()
        .get('/api/v1/assets?includeDecommissioned=false')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(res.body.items).toHaveLength(0);
    });

    it('GET /assets/:id and the child reads return a decommissioned asset', async () => {
      // Soft delete hides a row from the DEFAULT LIST. It does not un-exist it:
      // the URL keeps working and the history stays auditable, which is the whole
      // reason for soft delete over a real one.
      const a = await newOrg('Acme', 'admin@acme.test');
      const gone = await seedAsset(a.tenantId, {
        serial: 'GONE-1',
        status: 'decommissioned',
        deleted: true,
      });
      await seedReading(a.tenantId, gone, a.userId, '2026-01-01T00:00:00Z');
      await seedEvent(a.tenantId, gone, a.userId, 'decommissioned', '2026-01-01T00:00:00Z');

      const one = await http().get(`/api/v1/assets/${gone}`).set('Cookie', a.cookie).expect(200);
      expect(one.body.serialNumber).toBe('GONE-1');
      expect(one.body.deletedAt).not.toBeNull();

      const readings = await http()
        .get(`/api/v1/assets/${gone}/readings`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(readings.body.items).toHaveLength(1);

      const events = await http()
        .get(`/api/v1/assets/${gone}/events`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(events.body.items).toHaveLength(1);
    });
  });

  // =========================================================== pagination
  describe('cursor pagination', () => {
    it('walks the whole set with no repeats and no gaps', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);
      for (let i = 0; i < 25; i++) {
        await seedReading(
          a.tenantId,
          asset,
          a.userId,
          new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const url: string = `/api/v1/assets/${asset}/readings?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await http().get(url).set('Cookie', a.cookie).expect(200);
        seen.push(...res.body.items.map((r: { id: string }) => r.id));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }

      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it('an insert mid-pagination neither skips nor duplicates a row', async () => {
      // THE REASON KEYSET WAS CHOSEN OVER OFFSET. `readings` is append-only and
      // insert-heavy, so rows arriving between page requests are the normal case,
      // not a race. Under OFFSET, inserting a NEWER row (which sorts first in a
      // DESC listing) shifts every subsequent window by one and the client
      // silently misses a row. Keyset pages from the last row seen, so the new row
      // simply is not part of this walk.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);
      const original: string[] = [];
      for (let i = 0; i < 12; i++) {
        original.push(
          await seedReading(
            a.tenantId,
            asset,
            a.userId,
            new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
          ),
        );
      }

      const first = await http()
        .get(`/api/v1/assets/${asset}/readings?limit=5`)
        .set('Cookie', a.cookie)
        .expect(200);
      const seen: string[] = first.body.items.map((r: { id: string }) => r.id);

      // A newer reading arrives between pages — it sorts to the very front.
      await seedReading(a.tenantId, asset, a.userId, '2026-06-01T00:00:00Z');

      let cursor: string | null = first.body.nextCursor;
      while (cursor) {
        const res: request.Response = await http()
          .get(`/api/v1/assets/${asset}/readings?limit=5&cursor=${encodeURIComponent(cursor)}`)
          .set('Cookie', a.cookie)
          .expect(200);
        seen.push(...res.body.items.map((r: { id: string }) => r.id));
        cursor = res.body.nextCursor;
      }

      // No duplicates, and every row that existed when the walk started was seen.
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of original) expect(seen).toContain(id);
    });

    it('orders identical timestamps deterministically via the id tiebreaker', async () => {
      // The tie is GUARANTEED for events, not occasional: ARCHITECTURE §9.2 has
      // registration emit `created` and `installed` in one transaction, so every
      // asset's genesis is two rows sharing a created_at to the microsecond. A
      // page boundary landing between them without a tiebreaker skips or repeats.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);
      const same = '2026-02-02T00:00:00Z';
      const ids = [
        await seedEvent(a.tenantId, asset, a.userId, 'created', same),
        await seedEvent(a.tenantId, asset, a.userId, 'installed', same),
      ].sort();

      // Page size 1 forces the boundary to fall between the two tied rows.
      const p1 = await http()
        .get(`/api/v1/assets/${asset}/events?limit=1`)
        .set('Cookie', a.cookie)
        .expect(200);
      const p2 = await http()
        .get(
          `/api/v1/assets/${asset}/events?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
        )
        .set('Cookie', a.cookie)
        .expect(200);

      const walked = [p1.body.items[0].id, p2.body.items[0].id];
      expect(walked).toHaveLength(2);
      expect([...walked].sort()).toEqual(ids);
      // DESC on the tiebreaker: the larger id comes first.
      expect(walked[0] > walked[1]).toBe(true);
    });

    it('orders identical read_at readings deterministically too', async () => {
      // ADDED AFTER A MUTATION ESCAPED. The events tiebreaker was covered because
      // §9.2's genesis pair guarantees a tie; readings had no such case, so
      // dropping `r.id` from the readings ORDER BY and cursor tuple changed
      // nothing and the sweep went green on a real defect.
      //
      // Readings tie in practice: a bulk upload, or two meters recorded at the
      // same rounded minute. Without the tiebreaker the page boundary between
      // them is arbitrary and a row is skipped or repeated.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);
      const same = '2026-03-03T00:00:00Z';
      const ids = [
        await seedReading(a.tenantId, asset, a.userId, same),
        await seedReading(a.tenantId, asset, a.userId, same),
      ].sort();

      const p1 = await http()
        .get(`/api/v1/assets/${asset}/readings?limit=1`)
        .set('Cookie', a.cookie)
        .expect(200);
      const p2 = await http()
        .get(
          `/api/v1/assets/${asset}/readings?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
        )
        .set('Cookie', a.cookie)
        .expect(200);

      const walked = [p1.body.items[0].id, p2.body.items[0].id];
      expect([...walked].sort()).toEqual(ids);
      expect(walked[0] > walked[1]).toBe(true);
    });

    it('rejects a malformed cursor with 400 and the error envelope', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);
      const res = await http()
        .get(`/api/v1/assets/${asset}/readings?cursor=not-a-cursor`)
        .set('Cookie', a.cookie)
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });

    it('a cursor from another tenant reveals nothing — it selects position, not permission', async () => {
      const a = await newOrg('Tenant A', 'a@acme.test');
      const b = await newOrg('Tenant B', 'b@beta.test');
      const assetB = await seedAsset(b.tenantId);
      await seedReading(b.tenantId, assetB, b.userId, '2026-01-01T00:00:00Z');

      const bPage = await http()
        .get(`/api/v1/assets/${assetB}/readings?limit=1`)
        .set('Cookie', b.cookie)
        .expect(200);

      const assetA = await seedAsset(a.tenantId);
      // A replays B's cursor against A's own asset: valid shape, foreign position.
      const res = await http()
        .get(
          `/api/v1/assets/${assetA}/readings?cursor=${encodeURIComponent(bPage.body.nextCursor ?? '')}`,
        )
        .set('Cookie', a.cookie);
      expect([200, 400]).toContain(res.status);
      if (res.status === 200) expect(res.body.items).toHaveLength(0);
    });
  });

  // ============================================================== filters
  describe('filters and sorting', () => {
    it('filters assets by status, type and serial_number', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await seedAsset(a.tenantId, { serial: 'M-1', type: 'meter', status: 'installed' });
      await seedAsset(a.tenantId, { serial: 'P-1', type: 'pump', status: 'active' });

      const byStatus = await http()
        .get('/api/v1/assets?status=active')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(byStatus.body.items.map((x: { serialNumber: string }) => x.serialNumber)).toEqual([
        'P-1',
      ]);

      const byType = await http()
        .get('/api/v1/assets?type=pump')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(byType.body.items).toHaveLength(1);

      const bySerial = await http()
        .get('/api/v1/assets?serialNumber=M-1')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(bySerial.body.items).toHaveLength(1);
    });

    it('sorts by serialNumber ascending when asked, created_at desc by default', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await seedAsset(a.tenantId, { serial: 'B-2', createdAt: '2026-01-01T00:00:00Z' });
      await seedAsset(a.tenantId, { serial: 'A-1', createdAt: '2026-02-01T00:00:00Z' });

      const bySerial = await http()
        .get('/api/v1/assets?sort=serialNumber')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(bySerial.body.items.map((x: { serialNumber: string }) => x.serialNumber)).toEqual([
        'A-1',
        'B-2',
      ]);

      const byDefault = await http().get('/api/v1/assets').set('Cookie', a.cookie).expect(200);
      expect(byDefault.body.items.map((x: { serialNumber: string }) => x.serialNumber)).toEqual([
        'A-1',
        'B-2',
      ]);
    });

    it('filters readings by a read_at range', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);
      await seedReading(a.tenantId, asset, a.userId, '2026-01-01T00:00:00Z');
      await seedReading(a.tenantId, asset, a.userId, '2026-06-01T00:00:00Z');

      const res = await http()
        .get(`/api/v1/assets/${asset}/readings?from=2026-05-01T00:00:00Z`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(res.body.items).toHaveLength(1);
    });

    it('filters events by event_type', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);
      await seedEvent(a.tenantId, asset, a.userId, 'created', '2026-01-01T00:00:00Z');
      await seedEvent(a.tenantId, asset, a.userId, 'activated', '2026-01-02T00:00:00Z');

      const res = await http()
        .get(`/api/v1/assets/${asset}/events?eventType=activated`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].eventType).toBe('activated');
    });

    it('rejects an unknown query parameter with 400 (forbidNonWhitelisted)', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await http().get('/api/v1/assets?bogus=1').set('Cookie', a.cookie).expect(400);
    });

    it('rejects an out-of-range limit', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await http().get('/api/v1/assets?limit=0').set('Cookie', a.cookie).expect(400);
      await http().get('/api/v1/assets?limit=1000').set('Cookie', a.cookie).expect(400);
    });
  });

  // ========================================================== read access
  describe('access and status codes', () => {
    it('401s every read without a session', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);
      await http().get('/api/v1/assets').expect(401);
      await http().get(`/api/v1/assets/${asset}`).expect(401);
      await http().get(`/api/v1/assets/${asset}/events`).expect(401);
      await http().get(`/api/v1/assets/${asset}/readings`).expect(401);
    });

    it('404s a well-formed id that does not exist, with the error envelope', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const res = await http()
        .get(`/api/v1/assets/${randomUUID()}`)
        .set('Cookie', a.cookie)
        .expect(404);
      expect(res.body.error.code).toBe('ASSET_NOT_FOUND');
      expect(res.body.error).toHaveProperty('message');
    });

    it('400s a malformed uuid rather than 404 or 500', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await http().get('/api/v1/assets/not-a-uuid').set('Cookie', a.cookie).expect(400);
    });

    it('reads are open to ALL THREE roles — no role gate on any of them', async () => {
      // ARCHITECTURE §9.1: admin, technician and auditor read the same rows. The
      // absence of @RequiresRole is a decision, and this is what pins it: an
      // auditor is read-ONLY, not read-restricted.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await seedAsset(a.tenantId);

      for (const role of ['technician', 'auditor'] as const) {
        const email = `${role}@acme.test`;
        await http()
          .post('/api/v1/users')
          .set('Cookie', a.cookie)
          .send({ email, role })
          .expect(201);
        // Invited accounts carry a sentinel hash and cannot log in (step-5 debt),
        // so the password is set directly as the migration role to exercise the
        // ROLE, which is what this test is about.
        await migrator.$executeRawUnsafe(
          `UPDATE public.users SET password_hash = (SELECT password_hash FROM public.users WHERE email = 'admin@acme.test') WHERE email = $1`,
          email,
        );
        const cookie = await login(email);
        await http().get('/api/v1/assets').set('Cookie', cookie).expect(200);
        await http().get(`/api/v1/assets/${asset}`).set('Cookie', cookie).expect(200);
        await http().get(`/api/v1/assets/${asset}/events`).set('Cookie', cookie).expect(200);
        await http().get(`/api/v1/assets/${asset}/readings`).set('Cookie', cookie).expect(200);
      }
    });
  });
});
