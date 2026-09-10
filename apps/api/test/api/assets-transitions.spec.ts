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
 * Step 6, Phase 3c — the lifecycle transition engine, over real HTTP.
 *
 * The novel core of Phase 3: everything before this was CRUD onto proven
 * machinery. Here the (from -> to) graph decides what happened, and §9.2's
 * "transition not state" trap has to be shown to be unrepresentable rather than
 * merely avoided.
 */
describe('asset lifecycle transitions (step-6 phase 3c)', () => {
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
         (SELECT password_hash FROM public.users WHERE email = $2)
       WHERE email = $1`,
      email,
      adminEmail,
    );
    return login(email);
  }

  /** Registers an asset through the API, so it has its genesis pair. */
  async function register(cookie: string): Promise<string> {
    const res = await http()
      .post('/api/v1/assets')
      .set('Cookie', cookie)
      .send({ serialNumber: `SN-${randomUUID().slice(0, 8)}`, type: 'meter' })
      .expect(201);
    return res.body.id;
  }

  const post = (cookie: string, id: string, eventType: string) =>
    http().post(`/api/v1/assets/${id}/events`).set('Cookie', cookie).send({ eventType });

  /** The event log for an asset, oldest first, read as the migration role. */
  async function log(assetId: string): Promise<{ event_type: string; payload: unknown }[]> {
    return migrator.$queryRawUnsafe(
      `SELECT event_type::text AS event_type, payload
         FROM public.asset_events WHERE asset_id = $1::uuid
        ORDER BY created_at, event_type`,
      assetId,
    );
  }

  async function statusOf(assetId: string): Promise<{ status: string; deleted_at: Date | null }> {
    const rows = await migrator.$queryRawUnsafe<{ status: string; deleted_at: Date | null }[]>(
      `SELECT status::text AS status, deleted_at FROM public.assets WHERE id = $1::uuid`,
      assetId,
    );
    return rows[0]!;
  }

  // ======================================================= THE LOAD-BEARING TEST
  describe('the naive-map killer', () => {
    /**
     * **LOAD-BEARING. Do not delete, merge, or "simplify" this test.**
     *
     * It is the only thing that catches the single most plausible wrong
     * implementation of this phase, and the failure mode it catches is SILENT in
     * every other assertion.
     *
     * The trap (ARCHITECTURE §9.2): `activated` and `maintenance_completed` BOTH
     * land on status `active`. An implementation that derives the event type from
     * the resulting status —
     *
     *     statusToEventType[newStatus]   // { active: 'activated', ... }
     *
     * — has two correct answers for one key and must silently pick one. It would
     * record a repaired meter as having been `activated`.
     *
     * **Why nothing else catches it:** the status transitions are still correct, so
     * every status assertion passes. The log still replays to the right status, so
     * the replay reconciliation passes. The event count is right, the payloads have
     * plausible shapes, the API returns 201. The ONLY observable difference is the
     * fifth event's TYPE — which is exactly what this asserts.
     */
    it('installed -> active -> maintenance -> active records maintenance_completed, NOT a second activated', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);

      await post(a.cookie, asset, 'activated').expect(201);
      await post(a.cookie, asset, 'maintenance_started').expect(201);
      await post(a.cookie, asset, 'maintenance_completed').expect(201);

      const types = (await log(asset)).map((e) => e.event_type);

      expect(types).toEqual([
        'created',
        'installed',
        'activated',
        'maintenance_started',
        'maintenance_completed',
      ]);

      // Stated separately and loudly: under a status-keyed map this would be
      // 'activated', the asset would still be `active`, and nothing else would
      // notice that the history had lost the difference between commissioning a
      // meter and finishing a repair on it.
      expect(types[4]).toBe('maintenance_completed');
      expect(types[4]).not.toBe('activated');

      // Two events land on `active` and they carry DIFFERENT from-statuses — the
      // positive form of the same property.
      const events = await log(asset);
      expect(events[2]!.payload).toEqual({ from: 'installed', to: 'active' });
      expect(events[4]!.payload).toEqual({ from: 'maintenance', to: 'active' });

      expect((await statusOf(asset)).status).toBe('active');
    });
  });

  // ================================================================ legal edges
  describe('every legal edge', () => {
    it('activated: installed -> active', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      const res = await post(a.cookie, asset, 'activated').expect(201);
      expect(res.body.eventType).toBe('activated');
      expect(res.body.payload).toEqual({ from: 'installed', to: 'active' });
      expect((await statusOf(asset)).status).toBe('active');
    });

    it('maintenance_started: active -> maintenance', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await post(a.cookie, asset, 'activated').expect(201);
      const res = await post(a.cookie, asset, 'maintenance_started').expect(201);
      expect(res.body.payload).toEqual({ from: 'active', to: 'maintenance' });
      expect((await statusOf(asset)).status).toBe('maintenance');
    });

    it('maintenance_completed: maintenance -> active', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await post(a.cookie, asset, 'activated').expect(201);
      await post(a.cookie, asset, 'maintenance_started').expect(201);
      const res = await post(a.cookie, asset, 'maintenance_completed').expect(201);
      expect(res.body.payload).toEqual({ from: 'maintenance', to: 'active' });
      expect((await statusOf(asset)).status).toBe('active');
    });

    it('a transition never sets deleted_at — only DELETE does', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await post(a.cookie, asset, 'activated').expect(201);
      await post(a.cookie, asset, 'maintenance_started').expect(201);
      expect((await statusOf(asset)).deleted_at).toBeNull();
    });
  });

  // ============================================================== illegal edges
  describe('illegal edges — 409 ASSET_TRANSITION_ILLEGAL', () => {
    it('activated on an already-active asset', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await post(a.cookie, asset, 'activated').expect(201);

      const res = await post(a.cookie, asset, 'activated').expect(409);
      expect(res.body.error.code).toBe('ASSET_TRANSITION_ILLEGAL');
      expect(res.body.error.details).toMatchObject({ from: 'active', to: 'active' });

      // And nothing was written — a 409 must not leave a half-applied transition.
      expect((await log(asset)).map((e) => e.event_type)).toEqual([
        'created',
        'installed',
        'activated',
      ]);
    });

    it('installed -> maintenance is disallowed by the graph', async () => {
      // Deliberately absent edge: `maintenance` means withdrawn from service, and
      // an uncommissioned asset is already out of service.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      const res = await post(a.cookie, asset, 'maintenance_started').expect(409);
      expect(res.body.error.code).toBe('ASSET_TRANSITION_ILLEGAL');
      expect(res.body.error.details).toMatchObject({ from: 'installed' });
    });

    it('maintenance_completed on an asset never in maintenance', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await post(a.cookie, asset, 'activated').expect(201);
      await post(a.cookie, asset, 'maintenance_completed').expect(409);
    });

    it('EVERY postable transition is refused on a decommissioned asset — terminal', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await http().delete(`/api/v1/assets/${asset}`).set('Cookie', a.cookie).expect(204);

      for (const eventType of ['activated', 'maintenance_started', 'maintenance_completed']) {
        const res = await post(a.cookie, asset, eventType).expect(409);
        expect(res.body.error.code).toBe('ASSET_TRANSITION_ILLEGAL');
        expect(res.body.error.details).toMatchObject({ from: 'decommissioned' });
      }

      // Terminal means terminal: the log is exactly genesis + decommission.
      expect((await log(asset)).map((e) => e.event_type)).toEqual([
        'created',
        'installed',
        'decommissioned',
      ]);
    });
  });

  // ======================================================= the three error codes
  describe('error layering — three codes, three causes', () => {
    it('400 for a value that is not an event type at all', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await post(a.cookie, asset, 'teleported').expect(400);
      await http()
        .post(`/api/v1/assets/${asset}/events`)
        .set('Cookie', a.cookie)
        .send({})
        .expect(400);
    });

    it('422 for created / installed — genesis-only, naming POST /assets', async () => {
      // This is what the full-enum DTO buys. Had the DTO been narrowed to the three
      // postable values, these would be generic 400s indistinguishable from the
      // typo above, and the caller would be told a perfectly valid event type does
      // not exist.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);

      for (const eventType of ['created', 'installed']) {
        const res = await post(a.cookie, asset, eventType).expect(422);
        expect(res.body.error.code).toBe('ASSET_EVENT_GENESIS_ONLY');
        expect(res.body.error.message).toMatch(/POST \/assets/);
      }
    });

    it('422 for decommissioned — naming DELETE /assets/:id', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      const res = await post(a.cookie, asset, 'decommissioned').expect(422);
      expect(res.body.error.code).toBe('ASSET_EVENT_USE_DELETE');
      expect(res.body.error.message).toMatch(/DELETE \/assets/);
    });

    it('the three codes are genuinely distinct — 400 vs 422 vs 409', async () => {
      // The step-5 lesson: byte-identical refusals from different layers made the
      // RBAC gate untestable. Each cause here must be tellable from the others.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await post(a.cookie, asset, 'activated').expect(201);

      const notAnEvent = await post(a.cookie, asset, 'nonsense');
      const notPostable = await post(a.cookie, asset, 'decommissioned');
      const illegalEdge = await post(a.cookie, asset, 'activated');

      expect(notAnEvent.status).toBe(400);
      expect(notPostable.status).toBe(422);
      expect(illegalEdge.status).toBe(409);

      const codes = [notPostable.body.error.code, illegalEdge.body.error.code];
      expect(new Set(codes).size).toBe(2);
    });
  });

  // ================================================================== DELETE
  describe('DELETE /assets/:id — decommission', () => {
    for (const [label, steps] of [
      ['installed', [] as string[]],
      ['active', ['activated']],
      ['maintenance', ['activated', 'maintenance_started']],
    ] as const) {
      it(`decommissions from ${label}, setting both columns and emitting the event`, async () => {
        const a = await newOrg('Acme', 'admin@acme.test');
        const asset = await register(a.cookie);
        for (const step of steps) await post(a.cookie, asset, step).expect(201);

        await http().delete(`/api/v1/assets/${asset}`).set('Cookie', a.cookie).expect(204);

        const after = await statusOf(asset);
        expect(after.status).toBe('decommissioned');
        // Both columns — the biconditional CHECK would have rejected either alone.
        expect(after.deleted_at).not.toBeNull();

        const events = await log(asset);
        const last = events[events.length - 1]!;
        expect(last.event_type).toBe('decommissioned');
        expect(last.payload).toEqual({ from: label, to: 'decommissioned' });
      });
    }

    it('a second DELETE is 409, not an idempotent no-op', async () => {
      // `decommissioned` is terminal, and the row still exists. Silently succeeding
      // would emit a second `decommissioned` event and corrupt the log.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await http().delete(`/api/v1/assets/${asset}`).set('Cookie', a.cookie).expect(204);

      const res = await http()
        .delete(`/api/v1/assets/${asset}`)
        .set('Cookie', a.cookie)
        .expect(409);
      expect(res.body.error.code).toBe('ASSET_TRANSITION_ILLEGAL');

      const decommissions = (await log(asset)).filter((e) => e.event_type === 'decommissioned');
      expect(decommissions).toHaveLength(1);
    });

    it('a decommissioned asset stays readable, and drops out of the default list', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await http().delete(`/api/v1/assets/${asset}`).set('Cookie', a.cookie).expect(204);

      await http().get(`/api/v1/assets/${asset}`).set('Cookie', a.cookie).expect(200);
      const list = await http().get('/api/v1/assets').set('Cookie', a.cookie).expect(200);
      expect(list.body.items).toHaveLength(0);
      const withDecommissioned = await http()
        .get('/api/v1/assets?includeDecommissioned=true')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(withDecommissioned.body.items).toHaveLength(1);
    });

    it('decommissioning frees the serial for re-registration', async () => {
      // Closes the loop with the phase-1 partial unique index, whose entire
      // justification was this journey — and which is why `decommissioned` is
      // terminal: the returning asset is a NEW ROW.
      const a = await newOrg('Acme', 'admin@acme.test');
      const serial = 'SN-REUSE';
      const first = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send({ serialNumber: serial, type: 'meter' })
        .expect(201);

      await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send({ serialNumber: serial, type: 'meter' })
        .expect(409);

      await http().delete(`/api/v1/assets/${first.body.id}`).set('Cookie', a.cookie).expect(204);

      const second = await http()
        .post('/api/v1/assets')
        .set('Cookie', a.cookie)
        .send({ serialNumber: serial, type: 'meter' })
        .expect(201);
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  // ====================================================== the CHECK as the floor
  describe('the biconditional CHECK is the floor under the endpoint', () => {
    it('the 422 on POST /events is the friendly error; the CHECK is the guarantee', async () => {
      // Belt and suspenders, proven independently. Even if the 422 were removed and
      // POST /events happily set status='decommissioned', it would not set
      // deleted_at — and the database would refuse the row.
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);

      // The friendly half.
      await post(a.cookie, asset, 'decommissioned').expect(422);

      // The floor, proven WITHOUT the endpoint: a privileged connection doing
      // exactly what a bypassed endpoint would do.
      const failure = await migrator
        .$executeRawUnsafe(
          `UPDATE public.assets SET status = 'decommissioned' WHERE id = $1::uuid`,
          asset,
        )
        .then(() => null)
        .catch((e: unknown) => e);

      expect(failure).not.toBeNull();
      expect((failure as { meta?: { code?: string } }).meta?.code).toBe('23514');
      expect((failure as { meta?: { message?: string } }).meta?.message).toMatch(
        /assets_decommissioned_iff_deleted/,
      );

      // The asset is untouched.
      expect((await statusOf(asset)).status).toBe('installed');
    });
  });

  // ===================================================================== RBAC
  describe('RBAC — the two cells 3b could not reach', () => {
    it('POST /events: admin and technician pass, auditor 403', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const tech = await addMember(a.cookie, 'admin@acme.test', 'tech@acme.test', 'technician');
      const audit = await addMember(a.cookie, 'admin@acme.test', 'audit@acme.test', 'auditor');

      const byAdmin = await register(a.cookie);
      await post(a.cookie, byAdmin, 'activated').expect(201);

      const byTech = await register(tech);
      await post(tech, byTech, 'activated').expect(201);

      const res = await post(audit, byAdmin, 'maintenance_started').expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
      expect(res.body.error.message).toMatch(/permission/i);
    });

    it('DELETE: admin only — technician 403, auditor 403', async () => {
      // §9.1 draws the admin-only line at the destructive act. A technician may
      // register and transition an asset but may not retire one.
      const a = await newOrg('Acme', 'admin@acme.test');
      const tech = await addMember(a.cookie, 'admin@acme.test', 'tech@acme.test', 'technician');
      const audit = await addMember(a.cookie, 'admin@acme.test', 'audit@acme.test', 'auditor');
      const asset = await register(a.cookie);

      for (const cookie of [tech, audit]) {
        const res = await http()
          .delete(`/api/v1/assets/${asset}`)
          .set('Cookie', cookie)
          .expect(403);
        expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
      }

      // Neither attempt decommissioned it.
      const before = await statusOf(asset);
      expect(before.status).toBe('installed');
      expect(before.deleted_at).toBeNull();

      await http().delete(`/api/v1/assets/${asset}`).set('Cookie', a.cookie).expect(204);
    });

    it('401 unauthenticated on both, distinct from 403', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      const noSession = await http()
        .post(`/api/v1/assets/${asset}/events`)
        .send({ eventType: 'activated' })
        .expect(401);
      expect(noSession.body.error.code).toBe('UNAUTHENTICATED');
      await http().delete(`/api/v1/assets/${asset}`).expect(401);
    });

    it('a NULL role (no active tenant) is 403, NOT 500', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const asset = await register(a.cookie);
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE user_id = $1::uuid`,
        a.userId,
      );

      const ev = await post(a.cookie, asset, 'activated');
      const del = await http().delete(`/api/v1/assets/${asset}`).set('Cookie', a.cookie);
      for (const res of [ev, del]) {
        expect(res.status).toBe(403);
        expect(res.status).not.toBe(500);
        expect(['MEMBERSHIP_REVOKED', 'FORBIDDEN_ROLE']).toContain(res.body.error.code);
      }
    });
  });

  // ============================================================ 8.3 write axis
  describe('ADR-006 §8.3 write axis — transitions and decommission', () => {
    it('M active in A gets 404 (not 403) on B asset for POST /events and DELETE', async () => {
      const a = await newOrg('Tenant A', 'm@acme.test');
      const b = await newOrg('Tenant B', 'owner-b@beta.test');
      await http()
        .post('/api/v1/users')
        .set('Cookie', b.cookie)
        .send({ email: 'm@acme.test', role: 'admin' })
        .expect(201);

      const assetB = await register(b.cookie);

      // 404, NOT 403: this is not a permissions refusal. M is even an ADMIN of B —
      // the row simply does not exist for a request whose active tenant is A.
      await post(a.cookie, assetB, 'activated').expect(404);
      await http().delete(`/api/v1/assets/${assetB}`).set('Cookie', a.cookie).expect(404);

      // B's asset is untouched: still installed, not deleted, genesis log only.
      const after = await statusOf(assetB);
      expect(after.status).toBe('installed');
      expect(after.deleted_at).toBeNull();
      expect((await log(assetB)).map((e) => e.event_type)).toEqual(['created', 'installed']);
    });
  });

  // ==================================================== replay reconciliation
  describe('replay reconciliation — §9.2 made executable', () => {
    /**
     * Every asset's `status` must equal the status derived from the latest event
     * that carries a `to`. This is §9.2's invariant — "every status an asset has
     * held has an event that put it there" — exercised as a LOG rather than asserted
     * as a convention, and it is what makes the service-layer emission (decision 3)
     * trustworthy without a trigger.
     *
     * **TWO PRECONDITIONS, or it false-positives.**
     *
     * 1. **Derive from the latest STATUS-BEARING event**, i.e. one whose payload has
     *    a `to`. `created` carries `{}` by design (decision 10) and shares the
     *    genesis `created_at` with `installed`, so including it would make the
     *    "latest" ambiguous at genesis. Status-bearing events are one per
     *    transaction, so among them there is no tie.
     * 2. **API-created assets only.** `seedIsolationContext` inserts assets with no
     *    events at all, deliberately — they are pagination/isolation scaffolding,
     *    not lifecycle fixtures. Run against a database containing them, the replay
     *    would flag status-with-no-event and light up on scaffolding. `beforeEach`
     *    clears everything, and this test creates only through the API.
     */
    it('status equals the replayed status for every asset, across many lifecycles', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');

      const installed = await register(a.cookie);

      const active = await register(a.cookie);
      await post(a.cookie, active, 'activated').expect(201);

      const inMaintenance = await register(a.cookie);
      await post(a.cookie, inMaintenance, 'activated').expect(201);
      await post(a.cookie, inMaintenance, 'maintenance_started').expect(201);

      const repaired = await register(a.cookie);
      await post(a.cookie, repaired, 'activated').expect(201);
      await post(a.cookie, repaired, 'maintenance_started').expect(201);
      await post(a.cookie, repaired, 'maintenance_completed').expect(201);

      const retired = await register(a.cookie);
      await post(a.cookie, retired, 'activated').expect(201);
      await http().delete(`/api/v1/assets/${retired}`).set('Cookie', a.cookie).expect(204);

      const mismatches = await migrator.$queryRawUnsafe<
        { id: string; actual: string; replayed: string | null }[]
      >(`
        SELECT a.id::text AS id,
               a.status::text AS actual,
               (SELECT e.payload ->> 'to'
                  FROM public.asset_events e
                 WHERE e.asset_id = a.id
                   AND e.payload ? 'to'
                 ORDER BY e.created_at DESC, e.id DESC
                 LIMIT 1) AS replayed
          FROM public.assets a
      `);

      // Non-vacuity: the query must actually have found assets and replayed a
      // status for each, or "no mismatches" means nothing.
      expect(mismatches).toHaveLength(5);
      for (const row of mismatches) {
        expect(row.replayed, `asset ${row.id} has no status-bearing event`).not.toBeNull();
      }

      const bad = mismatches.filter((r) => r.actual !== r.replayed);
      expect(
        bad.map((r) => `${r.id}: status=${r.actual} replayed=${r.replayed}`),
        'an asset status disagrees with its event log — a status was changed without emitting',
      ).toEqual([]);

      // And the specific expectations, so a uniformly-wrong implementation cannot
      // satisfy the comparison by being wrong on both sides.
      const byId = new Map(mismatches.map((r) => [r.id, r.actual]));
      expect(byId.get(installed)).toBe('installed');
      expect(byId.get(active)).toBe('active');
      expect(byId.get(inMaintenance)).toBe('maintenance');
      expect(byId.get(repaired)).toBe('active');
      expect(byId.get(retired)).toBe('decommissioned');
    });
  });
});
