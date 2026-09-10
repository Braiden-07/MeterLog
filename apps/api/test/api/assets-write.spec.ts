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
 * Step 6, Phase 3b — the basic write surface, the RBAC matrix, and the genesis
 * emission, over real HTTP with real signed cookies through the bound interceptor.
 *
 * These are the writes whose emission is trivial (`POST /assets` — a fixed pair,
 * no graph) or absent (readings, metadata PATCH). The novel (from -> to) transition
 * logic is quarantined in phase 3c, which is the point of the seam.
 */
describe('assets write surface (step-6 phase 3b)', () => {
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
   * Adds someone to a workspace in a given role and returns their cookie.
   *
   * The password is set as the migration role because an invited account carries a
   * sentinel hash and cannot log in (the step-5 forward debt). That debt is about
   * credentials; this suite is about ROLES, so the sentinel is worked around rather
   * than worked on.
   */
  async function addMember(
    adminCookie: string,
    adminEmail: string,
    email: string,
    role: 'admin' | 'technician' | 'auditor',
  ): Promise<string> {
    await http().post('/api/v1/users').set('Cookie', adminCookie).send({ email, role }).expect(201);
    await migrator.$executeRawUnsafe(
      `UPDATE public.users SET password_hash =
         (SELECT password_hash FROM public.users WHERE email = $2)
       WHERE email = $1`,
      email,
      adminEmail,
    );
    return login(email);
  }

  const newAsset = (serial = `SN-${randomUUID().slice(0, 8)}`) => ({
    serialNumber: serial,
    type: 'meter',
    location: 'Building C',
  });

  // ====================================================== the genesis emission
  describe('POST /assets — the genesis pair, one transaction, three rows', () => {
    it('writes exactly one asset and exactly two events, with the §9.2 shape', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');

      const res = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset('SN-0001'))
        .expect(201);

      expect(res.body.status).toBe('installed');
      expect(res.body.deletedAt).toBeNull();
      const assetId = res.body.id;

      // Read back as the MIGRATION role: the assertions are about what is actually
      // on disk, not about what the API chose to echo.
      const assets = await migrator.$queryRawUnsafe<
        { id: string; status: string; deleted_at: Date | null; tenant_id: string }[]
      >(`SELECT id::text AS id, status::text AS status, deleted_at, tenant_id::text AS tenant_id
           FROM public.assets`);
      expect(assets).toHaveLength(1);
      expect(assets[0]!.status).toBe('installed');
      expect(assets[0]!.deleted_at).toBeNull();
      expect(assets[0]!.tenant_id).toBe(a.tenantId);

      const events = await migrator.$queryRawUnsafe<
        {
          event_type: string;
          payload: unknown;
          created_by: string;
          tenant_id: string;
          asset_id: string;
          created_at: Date;
        }[]
      >(`SELECT event_type::text AS event_type, payload, created_by::text AS created_by,
                tenant_id::text AS tenant_id, asset_id::text AS asset_id, created_at
           FROM public.asset_events ORDER BY event_type`);

      // EXACTLY TWO. Not one (which would leave the asset's first status
      // unexplained and the log unreplayable) and not three.
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.event_type)).toEqual(['created', 'installed']);

      // Decision-10 payloads.
      expect(events.find((e) => e.event_type === 'created')!.payload).toEqual({});
      expect(events.find((e) => e.event_type === 'installed')!.payload).toEqual({
        from: null,
        to: 'installed',
      });

      for (const e of events) {
        expect(e.created_by).toBe(a.userId);
        expect(e.tenant_id).toBe(a.tenantId);
        expect(e.asset_id).toBe(assetId);
      }

      // THE SHARED created_at IS THE EVIDENCE OF THE SINGLE TRANSACTION. Two rows
      // written by two separate statements at two separate moments could not share
      // a timestamp to the microsecond.
      expect(events[0]!.created_at.getTime()).toBe(events[1]!.created_at.getTime());
    });

    it('the genesis pair is the guaranteed cursor tie — both come back exactly once', async () => {
      // Closes the loop with phase 3a's tiebreaker: the two genesis events share a
      // created_at, so paginating events at limit=1 forces the page boundary
      // between two tied rows. This is the real-data version of 3a's seeded case.
      const a = await newOrg('Acme', 'admin@acme.test');
      const created = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 4; i++) {
        const url: string = `/api/v1/assets/${created.body.id}/events?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await http().get(url).set('Cookie', a.cookie).expect(200);
        seen.push(...page.body.items.map((e: { id: string }) => e.id));
        cursor = page.body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(2);
      expect(new Set(seen).size).toBe(2);
    });

    it('installed_at is client-supplied and NOT defaulted to now()', async () => {
      // Decision 14: a server-generated domain timestamp is a lie about the
      // physical world. Registering today an asset installed last week is ordinary.
      const a = await newOrg('Acme', 'admin@acme.test');

      const withDate = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send({ ...newAsset(), installedAt: '2020-03-04T10:00:00.000Z' })
        .expect(201);
      expect(new Date(withDate.body.installedAt).toISOString()).toBe('2020-03-04T10:00:00.000Z');

      const without = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);
      expect(without.body.installedAt).toBeNull();
    });

    it('rejects a client-supplied tenantId as an unknown field', async () => {
      // The tenant is never client-supplied: it comes from app.current_tenant. The
      // DTO has no tenantId, so a cross-tenant write is not even EXPRESSIBLE — and
      // forbidNonWhitelisted makes the attempt a 400 rather than a silent drop.
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Beta', 'admin@beta.test');
      await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send({ ...newAsset(), tenantId: b.tenantId })
        .expect(400);
    });

    it('rejects a client-supplied status as an unknown field', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send({ ...newAsset(), status: 'active' })
        .expect(400);
    });

    it('409s a duplicate live serial in the same tenant, and allows it in another', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Beta', 'admin@beta.test');

      await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset('DUP-1'))
        .expect(201);

      const dup = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset('DUP-1'))
        .expect(409);
      expect(dup.body.error.code).toBe('ASSET_SERIAL_EXISTS');

      // Uniqueness is per tenant — the same serial in B is fine.
      await http()
        .post('/api/v1/assets')
        .set('Cookie', b.cookie)
        .send(newAsset('DUP-1'))
        .expect(201);
    });

    it('validates the payload: missing serialNumber, blank type', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send({ type: 'meter' })
        .expect(400);
      await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send({ serialNumber: 'X', type: '' })
        .expect(400);
    });
  });

  // =========================================================== readings write
  describe('POST /assets/:id/readings — emits nothing', () => {
    it('creates a reading and leaves asset_events untouched', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      const before = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.asset_events`,
      );

      const res = await http()
        .post(`/api/v1/assets/${asset.body.id}/readings`)
        .set('Cookie', a.cookie)
        .send({ value: '10432.75', unit: 'kWh', readAt: '2026-04-01T08:30:00.000Z' })
        .expect(201);

      expect(res.body.value).toBe('10432.75');
      expect(res.body.unit).toBe('kWh');
      expect(res.body.createdBy).toBe(a.userId);

      const after = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.asset_events`,
      );
      // A reading is an OBSERVATION, not a lifecycle change. Emitting an event here
      // would corrupt a replay of the log.
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it('preserves decimal precision — value is a string end to end', async () => {
      // `value` is unbounded numeric so a cumulative meter total cannot be
      // truncated. Routing it through a JS number would reintroduce exactly that
      // loss at the API boundary, which is why the DTO takes a decimal string.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      const big = '123456789012345678901234.123456789';
      const res = await http()
        .post(`/api/v1/assets/${asset.body.id}/readings`)
        .set('Cookie', a.cookie)
        .send({ value: big, unit: 'kWh', readAt: '2026-04-01T08:30:00.000Z' })
        .expect(201);
      expect(res.body.value).toBe(big);

      const stored = await migrator.$queryRawUnsafe<{ v: string }[]>(
        `SELECT value::text AS v FROM public.readings`,
      );
      expect(stored[0]!.v).toBe(big);
    });

    it('404s a reading against an asset in another tenant', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Beta', 'admin@beta.test');
      const assetB = await http()
        .post('/api/v1/assets')
        .set('Cookie', b.cookie)
        .send(newAsset())
        .expect(201);

      await http()
        .post(`/api/v1/assets/${assetB.body.id}/readings`)
        .set('Cookie', a.cookie)
        .send({ value: '1', unit: 'kWh', readAt: '2026-04-01T08:30:00.000Z' })
        .expect(404);
    });

    it('validates value/unit/readAt', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);
      const url = `/api/v1/assets/${asset.body.id}/readings`;

      await http()
        .post(url)
        .set('Cookie', a.cookie)
        .send({ unit: 'kWh', readAt: '2026-04-01T08:30:00.000Z' })
        .expect(400);
      await http()
        .post(url)
        .set('Cookie', a.cookie)
        .send({ value: 'abc', unit: 'kWh', readAt: '2026-04-01T08:30:00.000Z' })
        .expect(400);
      await http()
        .post(url)
        .set('Cookie', a.cookie)
        .send({ value: '1', unit: 'kWh', readAt: 'not-a-date' })
        .expect(400);
    });
  });

  // ============================================================== PATCH
  describe('PATCH /assets/:id — metadata only, emits nothing', () => {
    it('updates type, location and installedAt without emitting', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      const before = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.asset_events`,
      );

      const res = await http()
        .patch(`/api/v1/assets/${asset.body.id}`)
        .set('Cookie', a.cookie)
        .send({ type: 'pump', location: 'Roof', installedAt: '2021-01-01T00:00:00.000Z' })
        .expect(200);

      expect(res.body.type).toBe('pump');
      expect(res.body.location).toBe('Roof');
      expect(new Date(res.body.installedAt).toISOString()).toBe('2021-01-01T00:00:00.000Z');
      // Status untouched by a metadata edit.
      expect(res.body.status).toBe('installed');

      const after = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.asset_events`,
      );
      // §9.2's own example: a typo in `location` is an AUDIT concern (step 7), not
      // a lifecycle event. Nothing happened to the physical asset.
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it('PATCH { status } is 400 — AND THE DTO SHAPE IS THE GUARD, not the pipe', async () => {
      // Read this before "simplifying" UpdateAssetDto.
      //
      // `forbidNonWhitelisted` only refuses fields the DTO does not DECLARE. It
      // does nothing the moment someone adds `status` to UpdateAssetDto "so the UI
      // can set it" — the pipe would then happily accept it and this endpoint would
      // become a second status-write path with no emission, silently breaking the
      // §9.2 invariant that every status an asset held has an event that put it
      // there.
      //
      // So the real guard is the ABSENCE of `status` from the DTO, and this test is
      // what pins that absence. It is not testing that ValidationPipe works.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      await http()
        .patch(`/api/v1/assets/${asset.body.id}`)
        .set('Cookie', a.cookie)
        .send({ status: 'active' })
        .expect(400);

      // And the status really is unchanged — the 400 is not a cosmetic rejection
      // over a write that partly happened.
      const rows = await migrator.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status::text AS status FROM public.assets`,
      );
      expect(rows[0]!.status).toBe('installed');
    });

    it('PATCH { deletedAt } is 400 — decommissioning is a transition, not a field', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      await http()
        .patch(`/api/v1/assets/${asset.body.id}`)
        .set('Cookie', a.cookie)
        .send({ deletedAt: new Date().toISOString() })
        .expect(400);

      const rows = await migrator.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
        `SELECT deleted_at FROM public.assets`,
      );
      expect(rows[0]!.deleted_at).toBeNull();
    });

    it('PATCH { serialNumber } is 400 — identity is not metadata', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);
      await http()
        .patch(`/api/v1/assets/${asset.body.id}`)
        .set('Cookie', a.cookie)
        .send({ serialNumber: 'RENAMED' })
        .expect(400);
    });

    it('404s a PATCH against another tenant asset', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Beta', 'admin@beta.test');
      const assetB = await http()
        .post('/api/v1/assets')
        .set('Cookie', b.cookie)
        .send(newAsset())
        .expect(201);

      await http()
        .patch(`/api/v1/assets/${assetB.body.id}`)
        .set('Cookie', a.cookie)
        .send({ location: 'hijacked' })
        .expect(404);

      const rows = await migrator.$queryRawUnsafe<{ location: string | null }[]>(
        `SELECT location FROM public.assets`,
      );
      expect(rows[0]!.location).not.toBe('hijacked');
    });
  });

  // ================================================================ the CHECK
  describe('the decommission biconditional CHECK', () => {
    it('every asset 3b creates satisfies it', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      for (let i = 0; i < 3; i++) {
        await http().post('/api/v1/assets').set('Cookie', a.cookie).send(newAsset()).expect(201);
      }
      const bad = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.assets
          WHERE (status = 'decommissioned') <> (deleted_at IS NOT NULL)`,
      );
      expect(bad[0]!.n).toBe(0);
    });

    it('is enforced by the DATABASE, against the migration role too', async () => {
      // The point of putting this in a constraint rather than the service: it holds
      // against a privileged connection, a future definer function, a bulk import,
      // and an UPDATE typed into psql — none of which go through any endpoint.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      const statusOnly = await migrator
        .$executeRawUnsafe(
          `UPDATE public.assets SET status = 'decommissioned' WHERE id = $1::uuid`,
          asset.body.id,
        )
        .then(() => null)
        .catch((e: { meta?: { code?: string; message?: string } }) => e);
      expect(statusOnly).not.toBeNull();
      expect((statusOnly as { meta?: { code?: string } }).meta?.code).toBe('23514');

      const deletedOnly = await migrator
        .$executeRawUnsafe(
          `UPDATE public.assets SET deleted_at = now() WHERE id = $1::uuid`,
          asset.body.id,
        )
        .then(() => null)
        .catch((e: unknown) => e);
      expect(deletedOnly).not.toBeNull();
      expect((deletedOnly as { meta?: { code?: string } }).meta?.code).toBe('23514');

      // Both together is accepted — the constraint forbids DISAGREEMENT, not
      // decommissioning.
      await migrator.$executeRawUnsafe(
        `UPDATE public.assets SET status = 'decommissioned', deleted_at = now() WHERE id = $1::uuid`,
        asset.body.id,
      );
    });
  });

  // ===================================================================== RBAC
  describe('RBAC — the three write cells 3b introduces', () => {
    it('admin and technician may write; auditor gets 403 on all three', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const techCookie = await addMember(
        a.cookie,
        'admin@acme.test',
        'tech@acme.test',
        'technician',
      );
      const auditCookie = await addMember(
        a.cookie,
        'admin@acme.test',
        'audit@acme.test',
        'auditor',
      );

      // --- admin: all three succeed
      const adminAsset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);
      await http()
        .patch(`/api/v1/assets/${adminAsset.body.id}`)
        .set('Cookie', a.cookie)
        .send({ location: 'by admin' })
        .expect(200);
      await http()
        .post(`/api/v1/assets/${adminAsset.body.id}/readings`)
        .set('Cookie', a.cookie)
        .send({ value: '1', unit: 'kWh', readAt: '2026-04-01T00:00:00.000Z' })
        .expect(201);

      // --- technician: all three succeed (registering an asset you are installing
      // is field work; §9.1's one genuinely open cell, resolved that way)
      const techAsset = await http()
        .post('/api/v1/assets')
        .set('Cookie', techCookie)
        .send(newAsset())
        .expect(201);
      await http()
        .patch(`/api/v1/assets/${techAsset.body.id}`)
        .set('Cookie', techCookie)
        .send({ location: 'by tech' })
        .expect(200);
      await http()
        .post(`/api/v1/assets/${techAsset.body.id}/readings`)
        .set('Cookie', techCookie)
        .send({ value: '2', unit: 'kWh', readAt: '2026-04-01T00:00:00.000Z' })
        .expect(201);

      // --- auditor: 403 on all three. THE CASE MOST LIKELY TO BE QUIETLY MISSED.
      // §7 defines an auditor as read-only; reads stay open (3a), writes do not.
      const post = await http()
        .post('/api/v1/assets')
        .set('Cookie', auditCookie)
        .send(newAsset())
        .expect(403);
      const patch = await http()
        .patch(`/api/v1/assets/${adminAsset.body.id}`)
        .set('Cookie', auditCookie)
        .send({ location: 'by auditor' })
        .expect(403);
      const reading = await http()
        .post(`/api/v1/assets/${adminAsset.body.id}/readings`)
        .set('Cookie', auditCookie)
        .send({ value: '3', unit: 'kWh', readAt: '2026-04-01T00:00:00.000Z' })
        .expect(403);

      // Distinguishable by CODE, not merely by status (the step-5 lesson: two
      // byte-identical 403s from different layers made the RBAC gate untestable).
      for (const res of [post, patch, reading]) {
        expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
        expect(res.body.error.message).toMatch(/permission/i);
      }

      // And the auditor's attempts wrote NOTHING.
      const counts = await migrator.$queryRawUnsafe<{ assets: number; readings: number }[]>(
        `SELECT (SELECT count(*)::int FROM public.assets) AS assets,
                (SELECT count(*)::int FROM public.readings) AS readings`,
      );
      expect(counts[0]!.assets).toBe(2);
      expect(counts[0]!.readings).toBe(2);
    });

    it('auditor reads still succeed — read-only, not read-restricted', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const auditCookie = await addMember(
        a.cookie,
        'admin@acme.test',
        'audit@acme.test',
        'auditor',
      );
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      await http().get('/api/v1/assets').set('Cookie', auditCookie).expect(200);
      await http().get(`/api/v1/assets/${asset.body.id}`).set('Cookie', auditCookie).expect(200);
      await http()
        .get(`/api/v1/assets/${asset.body.id}/events`)
        .set('Cookie', auditCookie)
        .expect(200);
    });

    it('401 unauthenticated — distinct from 403, and never a 500', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      const noSession = await http().post('/api/v1/assets').send(newAsset()).expect(401);
      expect(noSession.body.error.code).toBe('UNAUTHENTICATED');
      await http().patch(`/api/v1/assets/${asset.body.id}`).send({ location: 'x' }).expect(401);
      await http()
        .post(`/api/v1/assets/${asset.body.id}/readings`)
        .send({ value: '1', unit: 'kWh', readAt: '2026-04-01T00:00:00.000Z' })
        .expect(401);
    });

    it('a NULL role (no active tenant) is 403, NOT 500', async () => {
      // The CanActivate-ordering defect one layer up. A role gate evaluated before
      // the interceptor resolved the membership would ask for a role that does not
      // exist yet and 500 on every request, the admin's included (measured at the
      // step-5 gate). @RequiresRole is therefore enforced INSIDE the interceptor,
      // and a null role must FAIL THE GATE rather than error before it: there is no
      // workspace in which the caller holds the required role, so 403 is correct.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset())
        .expect(201);

      // Revoke the only membership, which leaves the live session with no active
      // tenant and therefore a null role on its next request.
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE user_id = $1::uuid`,
        a.userId,
      );

      for (const res of [
        await http().post('/api/v1/assets').set('Cookie', a.cookie).send(newAsset()),
        await http()
          .patch(`/api/v1/assets/${asset.body.id}`)
          .set('Cookie', a.cookie)
          .send({ location: 'x' }),
        await http()
          .post(`/api/v1/assets/${asset.body.id}/readings`)
          .set('Cookie', a.cookie)
          .send({ value: '1', unit: 'kWh', readAt: '2026-04-01T00:00:00.000Z' }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.status).not.toBe(500);
        // Revocation is detected before the role gate, so the code names the real
        // reason rather than blaming the role.
        expect(['MEMBERSHIP_REVOKED', 'FORBIDDEN_ROLE']).toContain(res.body.error.code);
      }
    });
  });

  // ========================================================== 8.3 write axis
  describe('ADR-006 §8.3 write axis (the endpoints 3b introduces)', () => {
    it('M, member of A and B and active in A, cannot write into B', async () => {
      const a = await newOrg('Tenant A', 'm@acme.test');
      const b = await newOrg('Tenant B', 'owner-b@beta.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', b.cookie)
        .send({ email: 'm@acme.test', role: 'technician' })
        .expect(201);

      const assetB = await http()
        .post('/api/v1/assets')
        .set('Cookie', b.cookie)
        .send(newAsset('B-ONLY'))
        .expect(201);

      // M is active in A. B's asset is invisible, so both writes 404 — NOT 403:
      // this is not a permissions refusal, the row does not exist for this request.
      await http()
        .patch(`/api/v1/assets/${assetB.body.id}`)
        .set('Cookie', a.cookie)
        .send({ location: 'hijacked' })
        .expect(404);
      await http()
        .post(`/api/v1/assets/${assetB.body.id}/readings`)
        .set('Cookie', a.cookie)
        .send({ value: '1', unit: 'kWh', readAt: '2026-04-01T00:00:00.000Z' })
        .expect(404);

      // B's asset is untouched and gained no reading.
      const bRows = await migrator.$queryRawUnsafe<{ location: string | null; readings: number }[]>(
        `SELECT a.location, (SELECT count(*)::int FROM public.readings r WHERE r.asset_id = a.id) AS readings
           FROM public.assets a WHERE a.id = $1::uuid`,
        assetB.body.id,
      );
      expect(bRows[0]!.location).not.toBe('hijacked');
      expect(bRows[0]!.readings).toBe(0);

      // And M's own POST lands in A, never B — the tenant is not client-supplied,
      // so writing into B is not expressible rather than merely refused.
      const mine = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send(newAsset('A-MINE'))
        .expect(201);
      const where = await migrator.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id::text AS tenant_id FROM public.assets WHERE id = $1::uuid`,
        mine.body.id,
      );
      expect(where[0]!.tenant_id).toBe(a.tenantId);
      expect(where[0]!.tenant_id).not.toBe(b.tenantId);
    });
  });
});
