import { randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * Step 6, Phase 3d — the §8.3 capstone and the consolidated acceptance gate.
 *
 * Two jobs, and deliberately not a third:
 *
 *  1. **The capstone.** The isolation axes were each proven where they were built —
 *     SELECT at 3a, INSERT/UPDATE at 3b, DELETE and transitions at 3c. This asserts
 *     them as ONE scenario in ONE session, which is the artifact `ISOLATION.md`
 *     cites for the ADR-006 §8.3 claim. A reviewer should be able to read one test
 *     and see the whole property.
 *
 *  2. **Cross-cutting conventions**, asserted once across the domain surface rather
 *     than per endpoint: the error envelope, the OpenAPI document, and the
 *     pagination boundaries 3a did not reach.
 *
 * **It does NOT re-run 3a-3c's per-endpoint acceptance.** Those suites own their
 * endpoints; duplicating them here would make two places to update and give a false
 * impression of depth. `limit=0` / `limit=1000` rejection and the malformed-cursor
 * 400 are already covered at `assets-read.spec.ts` and are deliberately absent here.
 */
describe('step 6 acceptance — the §8.3 capstone and cross-cutting conventions', () => {
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

  async function register(cookie: string, serial?: string): Promise<string> {
    const res = await http()
      .post('/api/v1/assets')
      .set('Cookie', cookie)
      .send({ serialNumber: serial ?? `SN-${randomUUID().slice(0, 8)}`, type: 'meter' })
      .expect(201);
    return res.body.id;
  }

  const addReading = (cookie: string, assetId: string, readAt = '2026-05-01T00:00:00.000Z') =>
    http()
      .post(`/api/v1/assets/${assetId}/readings`)
      .set('Cookie', cookie)
      .send({ value: '100.5', unit: 'kWh', readAt });

  // =========================================================== PART 1: §8.3
  describe('ADR-006 §8.3 — the money test, consolidated', () => {
    /**
     * **THE CAPSTONE. `ISOLATION.md` cites this test by name for the §8.3 claim.**
     *
     * The property, in one sentence: a user who legitimately holds BOTH tenants,
     * acting in one of them, cannot reach the other's rows through any verb.
     *
     * **M IS AN ADMIN OF B, AND THAT IS THE ENTIRE POINT.** Every refusal below is a
     * **404, not a 403** — and the distinction is the property, not a detail of
     * error mapping:
     *
     *   * A 403 would mean "you lack permission for this row". M does not lack
     *     permission — M is an admin of the tenant that owns it. A 403 would
     *     therefore be the WRONG answer, and worse, it would be an answer that
     *     confirms the row exists.
     *   * A 404 means the row is **not in the request's universe at all**. That is
     *     what RLS actually does: under `app.current_tenant = A`, B's rows do not
     *     exist for this query. Nothing in the handler decided to refuse them.
     *
     * So the test is constructed to make permission an implausible explanation for
     * the refusals. If isolation were keyed on role or on user identity rather than
     * on the active tenant, M-as-admin-of-both would sail straight through.
     */
    it('M, admin of both A and B and active in A, touches only A across SELECT/INSERT/UPDATE/DELETE', async () => {
      // ---------- arrange: one person, two tenants, admin in both ----------
      const a = await newOrg('Tenant A', 'm@acme.test');
      const b = await newOrg('Tenant B', 'owner-b@beta.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', b.cookie)
        .send({ email: 'm@acme.test', role: 'admin' })
        .expect(201);

      // B's data, created by B's owner.
      const assetB = await register(b.cookie, 'B-0001');
      await addReading(b.cookie, assetB).expect(201);
      await http()
        .post(`/api/v1/assets/${assetB}/events`)
        .set('Cookie', b.cookie)
        .send({ eventType: 'activated' })
        .expect(201);

      // A's data, created by M. Registration left A active for M's session.
      const assetA = await register(a.cookie, 'A-0001');
      await addReading(a.cookie, assetA).expect(201);

      // ---------- SELECT ----------
      const list = await http().get('/api/v1/assets').set('Cookie', a.cookie).expect(200);
      expect(list.body.items.map((x: { serialNumber: string }) => x.serialNumber)).toEqual([
        'A-0001',
      ]);

      await http().get(`/api/v1/assets/${assetA}`).set('Cookie', a.cookie).expect(200);
      await http().get(`/api/v1/assets/${assetB}`).set('Cookie', a.cookie).expect(404);
      await http().get(`/api/v1/assets/${assetB}/events`).set('Cookie', a.cookie).expect(404);
      await http().get(`/api/v1/assets/${assetB}/readings`).set('Cookie', a.cookie).expect(404);

      // B's asset is not reachable through the list either, with soft-deleted rows
      // included — so it is not merely filtered, it is absent.
      const everything = await http()
        .get('/api/v1/assets?includeDecommissioned=true&limit=100')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(everything.body.items.map((x: { id: string }) => x.id)).not.toContain(assetB);

      // ---------- INSERT ----------
      // Lands in A. Writing into B is not EXPRESSIBLE: the tenant is never
      // client-supplied, so there is no field in which to name B.
      const mine = await register(a.cookie, 'A-0002');
      const whereMine = await migrator.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id::text AS tenant_id FROM public.assets WHERE id = $1::uuid`,
        mine,
      );
      expect(whereMine[0]!.tenant_id).toBe(a.tenantId);

      // Children of B's asset are refused as 404 — the parent does not exist here.
      await addReading(a.cookie, assetB).expect(404);
      await http()
        .post(`/api/v1/assets/${assetB}/events`)
        .set('Cookie', a.cookie)
        .send({ eventType: 'maintenance_started' })
        .expect(404);

      // ---------- UPDATE ----------
      await http()
        .patch(`/api/v1/assets/${assetB}`)
        .set('Cookie', a.cookie)
        .send({ location: 'hijacked' })
        .expect(404);

      // ---------- DELETE ----------
      await http().delete(`/api/v1/assets/${assetB}`).set('Cookie', a.cookie).expect(404);

      // ---------- B is verifiably untouched ----------
      // Read as the migration role, which RLS does not filter, so this is the state
      // of the database rather than the state A is permitted to see.
      const bAfter = await migrator.$queryRawUnsafe<
        {
          location: string | null;
          status: string;
          deleted_at: Date | null;
          readings: number;
          events: number;
        }[]
      >(
        `SELECT a.location, a.status::text AS status, a.deleted_at,
                (SELECT count(*)::int FROM public.readings r WHERE r.asset_id = a.id) AS readings,
                (SELECT count(*)::int FROM public.asset_events e WHERE e.asset_id = a.id) AS events
           FROM public.assets a WHERE a.id = $1::uuid`,
        assetB,
      );
      expect(bAfter[0]!.location).not.toBe('hijacked');
      expect(bAfter[0]!.status).toBe('active'); // B activated it; A's attempts changed nothing
      expect(bAfter[0]!.deleted_at).toBeNull();
      expect(bAfter[0]!.readings).toBe(1); // B's one reading, no extra from A
      expect(bAfter[0]!.events).toBe(3); // created, installed, activated — nothing more

      // ---------- and A's own tenant is intact ----------
      const aAssets = await http()
        .get('/api/v1/assets?limit=100')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(aAssets.body.items).toHaveLength(2);
    });

    it('M cannot activate a tenant they hold no live membership in (403)', async () => {
      // ADR-006 §8.3's unauthorized-switch case. Targets a REAL, EXISTENT tenant
      // owned by someone else — a nonexistent id would prove only that DTO
      // validation runs (the semantic-negative rule, ISOLATION §8).
      const a = await newOrg('Tenant A', 'a@acme.test');
      const c = await newOrg('Tenant C', 'c@gamma.test');
      const assetC = await register(c.cookie, 'C-0001');

      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', a.cookie)
        .send({ tenantId: c.tenantId })
        .expect(403);

      // And the failed switch did not quietly make C's data reachable.
      await http().get(`/api/v1/assets/${assetC}`).set('Cookie', a.cookie).expect(404);
      const list = await http().get('/api/v1/assets').set('Cookie', a.cookie).expect(200);
      expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(assetC);
    });

    it('switching to a tenant M DOES hold flips the whole surface, same session', async () => {
      // The mirror image, which is what shows the boundary follows the ACTIVE TENANT
      // rather than the person, the session or the cookie. Same cookie throughout.
      const a = await newOrg('Tenant A', 'm@acme.test');
      const b = await newOrg('Tenant B', 'owner-b@beta.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', b.cookie)
        .send({ email: 'm@acme.test', role: 'admin' })
        .expect(201);

      const assetA = await register(a.cookie, 'A-0001');
      const assetB = await register(b.cookie, 'B-0001');

      await http()
        .post('/api/v1/auth/switch')
        .set('Cookie', a.cookie)
        .send({ tenantId: b.tenantId })
        .expect(200);

      // Now B is visible and A is not — with the same cookie that saw the reverse.
      await http().get(`/api/v1/assets/${assetB}`).set('Cookie', a.cookie).expect(200);
      await http().get(`/api/v1/assets/${assetA}`).set('Cookie', a.cookie).expect(404);

      // And as an admin of B, M may now decommission B's asset — proving the earlier
      // 404s were never about permission.
      await http().delete(`/api/v1/assets/${assetB}`).set('Cookie', a.cookie).expect(204);
      await http().delete(`/api/v1/assets/${assetA}`).set('Cookie', a.cookie).expect(404);
    });
  });

  // ============================================== PART 2: cross-cutting envelope
  describe('the error envelope, asserted across the whole domain surface', () => {
    it('every domain error path returns { error: { code, message } } and leaks no stack', async () => {
      // One cross-cutting assertion rather than per-endpoint repetition. 3a-3c each
      // assert the CODE their endpoint returns; this asserts the SHAPE is uniform,
      // which is the PROJECT_BRIEF §6 convention and the thing a client depends on.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      const ghost = randomUUID();

      const cases: { label: string; res: request.Response }[] = [
        {
          label: '404 unknown asset',
          res: await http().get(`/api/v1/assets/${ghost}`).set('Cookie', a.cookie),
        },
        {
          label: '400 malformed uuid',
          res: await http().get('/api/v1/assets/nope').set('Cookie', a.cookie),
        },
        {
          label: '400 unknown query param',
          res: await http().get('/api/v1/assets?bogus=1').set('Cookie', a.cookie),
        },
        {
          label: '400 bad body',
          res: await http().post('/api/v1/assets').set('Cookie', a.cookie).send({ type: 'meter' }),
        },
        { label: '401 no session', res: await http().get('/api/v1/assets') },
        {
          label: '409 duplicate serial',
          res: await (async () => {
            await http()
              .post('/api/v1/assets')
              .set('Cookie', a.cookie)
              .send({ serialNumber: 'DUP', type: 'meter' })
              .expect(201);
            return http()
              .post('/api/v1/assets')
              .set('Cookie', a.cookie)
              .send({ serialNumber: 'DUP', type: 'meter' });
          })(),
        },
        {
          label: '409 illegal transition',
          res: await http()
            .post(`/api/v1/assets/${asset}/events`)
            .set('Cookie', a.cookie)
            .send({ eventType: 'maintenance_completed' }),
        },
        {
          label: '422 not postable here',
          res: await http()
            .post(`/api/v1/assets/${asset}/events`)
            .set('Cookie', a.cookie)
            .send({ eventType: 'decommissioned' }),
        },
        {
          label: '400 invalid cursor',
          res: await http()
            .get(`/api/v1/assets/${asset}/readings?cursor=!!!`)
            .set('Cookie', a.cookie),
        },
      ];

      for (const { label, res } of cases) {
        expect(res.status, label).toBeGreaterThanOrEqual(400);
        expect(res.status, `${label} must not be a 500`).toBeLessThan(500);
        expect(res.body, label).toHaveProperty('error');
        expect(typeof res.body.error.code, `${label} code`).toBe('string');
        expect(res.body.error.code.length, `${label} code non-empty`).toBeGreaterThan(0);
        expect(typeof res.body.error.message, `${label} message`).toBe('string');

        // No stack traces, no internal paths, no SQL — PROJECT_BRIEF §6's
        // "never leak stack traces to clients".
        const body = JSON.stringify(res.body);
        expect(body, `${label} leaks a stack`).not.toMatch(/\bat\s+\w+\s+\(/);
        expect(body, `${label} leaks a path`).not.toMatch(
          /node_modules|[A-Za-z]:\\\\|\/apps\/api\//,
        );
        expect(body, `${label} leaks SQL`).not.toMatch(/SELECT |INSERT INTO|pg_catalog/);
      }

      // Non-vacuity: the codes are not all the same string, so the loop really did
      // traverse distinct error paths rather than one repeated 401.
      const codes = new Set(cases.map((c) => c.res.body.error.code));
      expect(codes.size).toBeGreaterThanOrEqual(5);
    });
  });

  // ================================================ PART 2: the OpenAPI document
  describe('OpenAPI — every domain endpoint is documented (PROJECT_BRIEF §6)', () => {
    it('renders all nine domain operations, and found a non-empty document', () => {
      // The brief requires OpenAPI docs for the API. Nothing asserted that before
      // 3d, so this is a genuine gap rather than a restatement.
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('MeterLog API').setVersion('0.1.0').build(),
      );

      const paths = Object.keys(document.paths ?? {});

      // NON-VACUITY FIRST — the route-guard lesson. A Swagger check that enumerated
      // nothing would pass every assertion below while documenting nothing at all.
      expect(paths.length).toBeGreaterThan(5);

      const operations = new Set<string>();
      for (const [path, item] of Object.entries(document.paths ?? {})) {
        for (const method of Object.keys(item ?? {})) {
          operations.add(`${method.toUpperCase()} ${path}`);
        }
      }

      const expected = [
        'GET /api/v1/assets',
        'POST /api/v1/assets',
        'GET /api/v1/assets/{id}',
        'PATCH /api/v1/assets/{id}',
        'DELETE /api/v1/assets/{id}',
        'GET /api/v1/assets/{id}/events',
        'POST /api/v1/assets/{id}/events',
        'GET /api/v1/assets/{id}/readings',
        'POST /api/v1/assets/{id}/readings',
      ];

      const missing = expected.filter((op) => !operations.has(op));
      expect(
        missing,
        `domain operations absent from the OpenAPI document: ${missing.join(', ')}`,
      ).toEqual([]);
    });

    it('documents the query parameters clients need, not just the paths', () => {
      // A path entry with no parameters is a documented endpoint a client cannot
      // actually call correctly — cursor and limit are how pagination is driven.
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('MeterLog API').setVersion('0.1.0').build(),
      );

      /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAPI shape. */
      const listAssets = (document.paths?.['/api/v1/assets'] as any)?.get;
      const names = (listAssets?.parameters ?? []).map((p: { name: string }) => p.name);

      for (const expectedParam of ['cursor', 'limit', 'status', 'includeDecommissioned', 'sort']) {
        expect(names, `GET /assets is missing the ${expectedParam} parameter`).toContain(
          expectedParam,
        );
      }
    });
  });

  // ============================================ PART 2: pagination boundaries
  describe('pagination boundaries 3a did not reach', () => {
    // NOTE what is deliberately absent: `limit=0` / `limit=1000` rejection and the
    // malformed-cursor 400 are covered at assets-read.spec.ts and are not repeated.

    it('an empty collection returns items: [] and nextCursor: null', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);

      const readings = await http()
        .get(`/api/v1/assets/${asset}/readings`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(readings.body.items).toEqual([]);
      expect(readings.body.nextCursor).toBeNull();
    });

    it('a single full page ends with nextCursor: null, not a cursor to nowhere', async () => {
      // The `limit + 1` lookahead must not emit a cursor when the extra row does not
      // exist — a client following it would make one pointless request per list.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await addReading(a.cookie, asset, '2026-05-01T00:00:00.000Z').expect(201);
      await addReading(a.cookie, asset, '2026-05-02T00:00:00.000Z').expect(201);

      const exact = await http()
        .get(`/api/v1/assets/${asset}/readings?limit=2`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(exact.body.items).toHaveLength(2);
      expect(exact.body.nextCursor).toBeNull();
    });

    it('accepts limit at both boundaries — 1 and 100', async () => {
      // 3a proves 0 and 1000 are REJECTED. The accepted edge is the other half: an
      // off-by-one in the bounds would reject a legal limit and no existing test
      // would notice.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await addReading(a.cookie, asset).expect(201);

      const min = await http()
        .get(`/api/v1/assets/${asset}/readings?limit=1`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(min.body.items).toHaveLength(1);

      await http()
        .get(`/api/v1/assets/${asset}/readings?limit=100`)
        .set('Cookie', a.cookie)
        .expect(200);
    });

    it('a cursor past the end returns an empty page rather than erroring', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await addReading(a.cookie, asset).expect(201);

      const first = await http()
        .get(`/api/v1/assets/${asset}/readings?limit=1`)
        .set('Cookie', a.cookie)
        .expect(200);
      // One row, so there is no next page.
      expect(first.body.nextCursor).toBeNull();

      // A hand-built cursor positioned before everything: valid shape, no rows after.
      const exhausted = Buffer.from(
        JSON.stringify({ k: '1970-01-01 00:00:00+00', i: randomUUID() }),
        'utf8',
      ).toString('base64url');
      const empty = await http()
        .get(`/api/v1/assets/${asset}/readings?cursor=${encodeURIComponent(exhausted)}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(empty.body.items).toEqual([]);
      expect(empty.body.nextCursor).toBeNull();
    });
  });
});
