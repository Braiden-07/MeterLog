import { randomUUID } from 'node:crypto';

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
 * THE STEP-7B GATE — the audit read surface over real HTTP.
 *
 * 7a built capture and proved it at the database layer: the trigger writes, the
 * app role cannot, role-at-time survives a revoke, redaction holds. None of that
 * said anything about who may READ the trail, because nothing could read it.
 *
 * This file is the other half. It proves the gate ADR-012 recorded and ADR-014
 * enforces — **admin and auditor, nobody else** — and it proves the premise the
 * whole module exists for is readable, not merely stored.
 *
 * ---
 *
 * **THE AUDITOR POSITIVE IS THE LOAD-BEARING TEST IN THIS FILE.** Every RBAC
 * negative below — technician 403, non-member 403, cross-tenant empty — passes
 * IDENTICALLY against an admin-only implementation. So a module that shipped the
 * gate as `@RequiresRole('admin')` would have a completely green suite and a real
 * bug: the auditor role, which `PROJECT_BRIEF` :28 names as one of three and
 * :263 says may view the trail, would be a technician who cannot write.
 *
 * It is also the ONLY test in the entire suite that distinguishes an auditor from
 * a read-only technician: every other endpoint deliberately treats them alike
 * (see `AssetsController`'s note that its reads carry no role gate on purpose).
 * Demonstrated, not asserted — the same standard `register_tenant`'s definer
 * insert was held to.
 *
 * ~~**THE TWO 403s ARE THE SAME SHAPE, AND THAT IS DELIBERATE.** A technician and a
 * non-member both get `403 FORBIDDEN_ROLE` from ONE branch in the interceptor:
 * `(!role || !requiredRoles.includes(role))`. A non-member has `role === null`
 * (OPEN-2: zero live memberships logs in fine and lands with no active tenant); a
 * technician has a role not in the list. They are separated here by SETUP and
 * asserted to be indistinguishable on the wire, because splitting them into
 * `NO_ACTIVE_WORKSPACE` vs `FORBIDDEN_ROLE` would rebuild the enumeration oracle
 * that ADR-006's `MB002` was flattened to avoid — the response would start
 * answering "does this workspace exist and are you simply the wrong role in it?"~~
 *
 * **SUPERSEDED BY G2 (OPEN-18) — the two 403s are now DISTINCT, and the paragraph
 * above is struck rather than deleted so this file records what it used to assert.**
 * The property was never sustainable under G2. The durability fix makes every
 * tenant-scoped route refuse a no-workspace session, and a workspace-holder is
 * never 403'd on an un-gated read like `GET /assets` — so a 403 there means "no
 * workspace" whatever string it carries. Keeping `FORBIDDEN_ROLE` would have lost
 * the parity silently while this comment went on claiming it; the code now names
 * the state instead. It is not the `MB002` oracle: the request names no workspace
 * (the tenant comes from the caller's own session), so it can reveal only that
 * session's state, which `GET /auth/me` already returns — proven, not argued, by
 * the oracle test in `test/api/no-active-workspace.spec.ts`.
 */
describe('audit read surface (step-7 phase 7b)', () => {
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
   * Invites a member and gives them a usable password, THROUGH THE PRODUCT.
   *
   * STEP 8 REPLACED THE HASH COPY THIS USED TO DO. The old fixture copied the
   * admin's `password_hash` as the migration role, because `invite_member` writes
   * a sentinel that authenticates against nothing and OPEN-7 left no path back.
   * The docblock here said "until the set-password flow lands at step 8" — it has
   * landed, so this now invites, reads the minted token from the pending-invite
   * list, redeems it, and logs in.
   *
   * `adminEmail` is retained in the signature and deliberately unused: the admin
   * whose hash was being copied is no longer relevant, but the parameter keeps
   * every call site unchanged and the diff honest about what actually changed.
   */
  async function addMember(
    adminCookie: string,
    _adminEmail: string,
    email: string,
    role: 'admin' | 'technician' | 'auditor',
  ): Promise<{ cookie: string; userId: string }> {
    await http()
      .post('/api/v1/users')
      .set('Cookie', adminCookie)
      .send({ email, role })
      .expect(201);

    // MIGRATED AT THE PENDING SPLIT (OPEN-14). The list is metadata only now, so
    // the fixture reads the membership id from it and then mints EXPLICITLY. The
    // extra call is the whole point of the split: looking no longer issues.
    const pending = await http()
      .get('/api/v1/users/pending')
      .set('Cookie', adminCookie)
      .expect(200);
    const invite = (
      pending.body as { email: string; membershipId: string; userId: string }[]
    ).find((p) => p.email === email);
    if (!invite) throw new Error(`${email} did not appear in the pending-invite list`);

    const minted = await http()
      .post(`/api/v1/users/pending/${invite.membershipId}/token`)
      .set('Cookie', adminCookie)
      .send()
      .expect(201);

    await http()
      .post('/api/v1/auth/set-password')
      .send({ token: minted.body.token, password: PASSWORD })
      .expect(204);

    return { cookie: await login(email), userId: invite.userId };
  }

  const registerAsset = async (cookie: string): Promise<string> => {
    const res = await http()
      .post('/api/v1/assets')
      .set('Cookie', cookie)
      .send({ serialNumber: `SN-${randomUUID().slice(0, 8)}`, type: 'meter' })
      .expect(201);
    return res.body.id;
  };

  const audit = (cookie: string, qs = '') => http().get(`/api/v1/audit${qs}`).set('Cookie', cookie);

  // =========================================================================
  // 1. ENFORCEMENT — ADR-012's recorded gate, now enforced
  // =========================================================================
  describe('the admin/auditor gate', () => {
    it('AUDITOR reads the trail — the test this module would ship broken without', async () => {
      // See the file header. Every negative below passes against an admin-only
      // implementation; this is the only thing that catches one.
      const a = await newOrg('Acme', 'admin@acme.test');
      const auditor = await addMember(a.cookie, 'admin@acme.test', 'auditor@acme.test', 'auditor');
      await registerAsset(a.cookie);

      const res = await audit(auditor.cookie).expect(200);

      // Non-vacuous: the auditor must actually SEE rows. A 200 with an empty page
      // would satisfy "auditor is not refused" while proving nothing about the
      // read, and would pass against a gate that admitted auditors and a query
      // that returned nothing.
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.some((r: { action: string }) => r.action === 'asset.created')).toBe(
        true,
      );
    });

    it('ADMIN reads the trail', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await registerAsset(a.cookie);

      const res = await audit(a.cookie).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    });

    it('TECHNICIAN is refused — 403 FORBIDDEN_ROLE', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const tech = await addMember(a.cookie, 'admin@acme.test', 'tech@acme.test', 'technician');
      await registerAsset(a.cookie);

      const res = await audit(tech.cookie).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');

      // The rows exist and are visible to someone — so this is the GATE refusing,
      // not an empty trail. Without this the test passes against a broken query.
      const asAdmin = await audit(a.cookie).expect(200);
      expect(asAdmin.body.items.length).toBeGreaterThan(0);
    });

    it('NON-MEMBER is refused with a DISTINCT code — MEMBERSHIP_REVOKED, then NO_ACTIVE_WORKSPACE (G2)', async () => {
      // OPEN-2: zero live memberships logs in successfully (200) and lands with
      // no active tenant.
      //
      // RETITLED AND FLIPPED BY G2 (OPEN-18). This test was "NON-MEMBER is refused
      // with the SAME shape — the OPEN-2 no-active-tenant path", and it asserted the
      // settled state answered FORBIDDEN_ROLE. Its reasoning, struck and kept:
      //
      //   ~~A role-gated route then refuses through the existing fail-closed path,
      //   with no special casing — `role` is null, so the gate's `!role` arm fires.
      //   ASSERTED IDENTICAL TO THE TECHNICIAN CASE ON PURPOSE. Two conditions, one
      //   answer: giving the non-member a distinct code would let a caller probe
      //   "is this workspace real and am I merely the wrong role?" — the
      //   enumeration-oracle shape `MB002` exists to prevent.~~
      //
      // Why it changed is in the file header: under G2 the parity could not survive
      // on the un-gated routes whichever code shipped, and the oracle test shows the
      // distinct code reveals nothing about any workspace.
      const a = await newOrg('Acme', 'admin@acme.test');
      const outsider = await addMember(
        a.cookie,
        'admin@acme.test',
        'outsider@acme.test',
        'technician',
      );
      await registerAsset(a.cookie);

      // Revoke the only membership: the person now has zero live memberships.
      const memberships = await http().get('/api/v1/users').set('Cookie', a.cookie).expect(200);
      const target = (memberships.body.items ?? memberships.body).find(
        (m: { email: string }) => m.email === 'outsider@acme.test',
      );
      await http()
        .delete(`/api/v1/users/${target.membershipId ?? target.id}`)
        .set('Cookie', a.cookie)
        .expect(204);

      // THERE ARE TWO FACES HERE, AND CONFLATING THEM IS A REAL MISTAKE — this
      // test asserted only the second and was red until it asserted both.
      //
      // (1) The session still NAMES tenant A, because it was issued before the
      //     revoke. The interceptor's per-request re-verify (step 3) runs before
      //     the role gate and finds no live membership, so the answer is
      //     `MEMBERSHIP_REVOKED` — and the same branch CLEARS the session's
      //     active tenant on its way out.
      const first = await audit(outsider.cookie).expect(403);
      expect(first.body.error.code).toBe('MEMBERSHIP_REVOKED');

      // (2) Now the session genuinely has no active workspace, which is the
      //     settled OPEN-2 state: zero live memberships, nothing selected.
      //
      //     ~~`role` is null, so the ROLE GATE refuses — `FORBIDDEN_ROLE`,
      //     byte-identical to what the technician above receives.~~
      //
      //     Since G2 the interceptor refuses this BEFORE the role gate, with its
      //     own code: `NO_ACTIVE_WORKSPACE`.
      const settled = await audit(outsider.cookie).expect(403);
      expect(settled.body.error.code).toBe('NO_ACTIVE_WORKSPACE');

      // ~~Both are 403, and the SETTLED state is indistinguishable from the
      // wrong-role case. That is the property worth protecting: a caller in the
      // no-workspace state cannot tell "this workspace exists and I am the wrong
      // role" from "I have no workspace at all", so the endpoint answers no
      // questions about which workspaces exist. Splitting these into distinct
      // codes would rebuild the enumeration oracle `MB002` was flattened to
      // avoid.~~
      //
      // Both are still 403, and the settled state is now DISTINGUISHABLE from the
      // wrong-role case on purpose: "choose a workspace" and "you may not" call for
      // different client responses.
      //
      // `MEMBERSHIP_REVOKED` is not a leak: it is only reachable by a session that
      // ALREADY held that membership, so it tells its holder something they knew.
      // The same tolerance covers `NO_ACTIVE_WORKSPACE`, which tells its holder
      // their own session state.
      expect(first.status).toBe(settled.status);
      expect(settled.body.error.code).not.toBe('FORBIDDEN_ROLE');
    });
  });

  // =========================================================================
  // 2. ISOLATION — the money negative
  // =========================================================================
  describe('tenant isolation', () => {
    it('an admin of B reading the trail sees NOTHING of A — the money negative', async () => {
      // Isolation here is RLS, not a handler predicate: `AuditService` carries no
      // `tenant_id` in its WHERE clause, deliberately, so this test is evidence
      // about the POLICY. A redundant application filter would keep this green
      // after the policy broke.
      const a = await newOrg('Acme', 'admin@acme.test');
      const b = await newOrg('Globex', 'admin@globex.test');

      const assetA = await registerAsset(a.cookie);

      const fromA = await audit(a.cookie).expect(200);
      const fromB = await audit(b.cookie).expect(200);

      // A sees its own rows...
      expect(fromA.body.items.length).toBeGreaterThan(0);
      expect(fromA.body.items.some((r: { rowId: string }) => r.rowId === assetA)).toBe(true);

      // ...and B sees none of them. Asserted as "none of A's rows" rather than
      // "empty", because B has its own bootstrap membership row — an empty
      // assertion would be checking the wrong thing and would fail for the right
      // reason at the wrong moment.
      expect(fromB.body.items.some((r: { rowId: string }) => r.rowId === assetA)).toBe(false);

      // Non-vacuity from the other side: the rows B cannot see genuinely exist.
      const total = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.audit_log WHERE row_id = $1::uuid`,
        assetA,
      );
      expect(total[0]!.n).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. BOOTSTRAP INVISIBILITY (ADR-013)
  // =========================================================================
  describe('bootstrap rows are write-only from the application', () => {
    it('the owner sees bootstrap rows; the tenant read returns none of them', async () => {
      // NON-VACUITY IS THE WHOLE TEST. "A tenant read returns zero bootstrap
      // rows" passes trivially if no bootstrap row was ever written — the
      // readWorkspaces insensitivity lesson. So the POSITIVE is established
      // first, as the migration role, and only then is the absence asserted.
      const a = await newOrg('Acme', 'admin@acme.test');

      // (1) POSITIVE — the rows exist, seen by the only role that can see them.
      const bootstrap = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.audit_log WHERE tenant_id IS NULL`,
      );
      expect(
        bootstrap[0]!.n,
        'no NULL-tenant bootstrap row exists — the absence assertion below would be vacuous',
      ).toBeGreaterThan(0);

      // And they are what ADR-013 says they are: the pre-auth identity write.
      const shape = await migrator.$queryRawUnsafe<{ action: string; actor: string | null }[]>(
        `SELECT action::text AS action, actor_user_id::text AS actor
           FROM public.audit_log WHERE tenant_id IS NULL`,
      );
      expect(shape.every((r) => r.action === 'user.created')).toBe(true);
      expect(shape.every((r) => r.actor === null)).toBe(true);

      // (2) ABSENCE — invisible to the application, permanently, for every caller.
      const res = await audit(a.cookie).expect(200);
      expect(res.body.items.some((r: { action: string }) => r.action === 'user.created')).toBe(
        false,
      );

      // The tenant's own trail still records the bootstrap through the
      // membership row, which carries a real tenant_id — so nothing is lost from
      // the tenant's point of view.
      expect(
        res.body.items.some((r: { action: string }) => r.action === 'membership.created'),
      ).toBe(true);
    });
  });

  // =========================================================================
  // 4. THE CAPSTONE — the premise, readable
  // =========================================================================
  describe('the maintenance-edit capstone', () => {
    it('an edit that emits NO lifecycle event is readable by admin and auditor, and by nobody else', async () => {
      // THE MODULE'S REASON FOR BEING, at the HTTP layer.
      //
      // ISOLATION.md §9: correcting a maintenance description is not something
      // that happened to the physical asset, so it emits NO `asset_events` row.
      // A trail derived from the event log is silent for this entire class of
      // change. 7a proved the row is WRITTEN; this proves it is READ, and read by
      // exactly the right people.
      const a = await newOrg('Acme', 'admin@acme.test');
      const auditor = await addMember(a.cookie, 'admin@acme.test', 'auditor@acme.test', 'auditor');
      const tech = await addMember(a.cookie, 'admin@acme.test', 'tech@acme.test', 'technician');
      const b = await newOrg('Globex', 'admin@globex.test');

      const asset = await registerAsset(a.cookie);
      const created = await http()
        .post('/api/v1/maintenance-records')
        .set('Cookie', a.cookie)
        .send({
          assetId: asset,
          description: 'annual service',
          performedAt: '2026-04-01T09:00:00.000Z',
        })
        .expect(201);
      const recordId = created.body.id;

      const eventsBefore = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.asset_events`,
      );

      await http()
        .patch(`/api/v1/maintenance-records/${recordId}`)
        .set('Cookie', a.cookie)
        .send({ description: 'annual service — corrected' })
        .expect(200);

      // (a) THE GAP IS REAL — the lifecycle log did not move.
      const eventsAfter = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.asset_events`,
      );
      expect(eventsAfter[0]!.n).toBe(eventsBefore[0]!.n);

      const findEdit = (body: { items: { action: string; rowId: string }[] }) =>
        body.items.find((r) => r.action === 'maintenance.updated' && r.rowId === recordId);

      // (b) ADMIN sees it.
      const asAdmin = await audit(a.cookie, `?tableName=maintenance_records&rowId=${recordId}`);
      expect(asAdmin.status).toBe(200);
      expect(findEdit(asAdmin.body)).toBeDefined();

      // (c) AUDITOR sees it — the face that matters, and the one an admin-only
      // implementation would fail.
      const asAuditor = await audit(
        auditor.cookie,
        `?tableName=maintenance_records&rowId=${recordId}`,
      );
      expect(asAuditor.status).toBe(200);
      const auditorRow = findEdit(asAuditor.body);
      expect(auditorRow).toBeDefined();

      // (d) TECHNICIAN is refused outright.
      await audit(tech.cookie, `?tableName=maintenance_records&rowId=${recordId}`).expect(403);

      // (e) CROSS-TENANT sees nothing — B is an admin, so this is isolation
      // refusing rather than the role gate.
      const asB = await audit(b.cookie, `?tableName=maintenance_records&rowId=${recordId}`);
      expect(asB.status).toBe(200);
      expect(asB.body.items).toEqual([]);
    });
  });

  // =========================================================================
  // 5. ROLE-AT-TIME OVER HTTP (ADR-009 / OPEN-4, the visible payoff)
  // =========================================================================
  describe('actor_role in the read DTO', () => {
    it('carries the role held AT THE TIME, and does not move when the role changes', async () => {
      // The HTTP face of 7a's database-layer proof. `actor_role` is the one field
      // no other table can reconstruct: joining to `memberships` at read time
      // returns TODAY's answer.
      const a = await newOrg('Acme', 'admin@acme.test');
      const tech = await addMember(a.cookie, 'admin@acme.test', 'tech@acme.test', 'technician');
      const asset = await registerAsset(a.cookie);

      // The technician records a reading — an ordinary technician action.
      await http()
        .post(`/api/v1/assets/${asset}/readings`)
        .set('Cookie', tech.cookie)
        .send({ value: '41.5', unit: 'kWh', readAt: '2026-05-01T10:00:00.000Z' })
        .expect(201);

      const before = await audit(a.cookie, '?action=reading.created').expect(200);
      expect(before.body.items).toHaveLength(1);
      expect(before.body.items[0].actorRole).toBe('technician');
      expect(before.body.items[0].actorUserId).toBe(tech.userId);

      // Promote them.
      const members = await http().get('/api/v1/users').set('Cookie', a.cookie).expect(200);
      const row = (members.body.items ?? members.body).find(
        (m: { email: string }) => m.email === 'tech@acme.test',
      );
      await http()
        .patch(`/api/v1/users/${row.membershipId ?? row.id}`)
        .set('Cookie', a.cookie)
        .send({ role: 'admin' })
        .expect(204);

      // The audit row still reads technician.
      const after = await audit(a.cookie, '?action=reading.created').expect(200);
      expect(after.body.items[0].actorRole).toBe('technician');
    });
  });

  // =========================================================================
  // 6. FILTERS
  // =========================================================================
  describe('filters', () => {
    it('action, actor and date-range each narrow correctly and stay tenant-scoped', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const tech = await addMember(a.cookie, 'admin@acme.test', 'tech@acme.test', 'technician');
      const asset = await registerAsset(a.cookie);
      await http()
        .post(`/api/v1/assets/${asset}/readings`)
        .set('Cookie', tech.cookie)
        .send({ value: '1.5', unit: 'kWh', readAt: '2026-05-01T10:00:00.000Z' })
        .expect(201);

      // action
      const byAction = await audit(a.cookie, '?action=reading.created').expect(200);
      expect(byAction.body.items.length).toBeGreaterThan(0);
      expect(
        byAction.body.items.every((r: { action: string }) => r.action === 'reading.created'),
      ).toBe(true);

      // actor — the technician's writes only
      const byActor = await audit(a.cookie, `?actorUserId=${tech.userId}`).expect(200);
      expect(byActor.body.items.length).toBeGreaterThan(0);
      expect(
        byActor.body.items.every((r: { actorUserId: string }) => r.actorUserId === tech.userId),
      ).toBe(true);

      // date range, half-open — a window ending before everything happened is
      // empty, and a window containing it is not. Both directions, so the filter
      // is shown to DO something rather than merely not crash.
      const empty = await audit(
        a.cookie,
        '?from=2020-01-01T00:00:00.000Z&to=2020-01-02T00:00:00.000Z',
      );
      expect(empty.status).toBe(200);
      expect(empty.body.items).toEqual([]);

      const wide = await audit(a.cookie, '?from=2020-01-01T00:00:00.000Z').expect(200);
      expect(wide.body.items.length).toBeGreaterThan(0);

      // drill-down by table alone
      const byTable = await audit(a.cookie, '?tableName=readings').expect(200);
      expect(byTable.body.items.length).toBeGreaterThan(0);
      expect(
        byTable.body.items.every((r: { tableName: string }) => r.tableName === 'readings'),
      ).toBe(true);
    });
  });

  // =========================================================================
  // 7. BAD REQUESTS — no 400-shaped question may answer as an empty 200
  // =========================================================================
  describe('invalid input is a 400, never an empty 200', () => {
    it('unknown action → 400', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await audit(a.cookie, '?action=asset.exploded').expect(400);
    });

    it('rowId without tableName → 400', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await audit(a.cookie, `?rowId=${randomUUID()}`).expect(400);
      // And the pair IS accepted, so the 400 above is the cross-field rule rather
      // than the uuid failing to parse.
      await audit(a.cookie, `?tableName=assets&rowId=${randomUUID()}`).expect(200);
    });

    it('malformed cursor → 400', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await audit(a.cookie, '?cursor=not-a-real-cursor').expect(400);
    });

    it('limit=abc, limit=0 and limit=-5 → 400', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await audit(a.cookie, '?limit=abc').expect(400);
      await audit(a.cookie, '?limit=0').expect(400);
      await audit(a.cookie, '?limit=-5').expect(400);
    });

    it('unknown query parameter → 400 (forbidNonWhitelisted)', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      await audit(a.cookie, '?actorEmail=someone@example.test').expect(400);
    });
  });

  // =========================================================================
  // 8. PAGINATION
  // =========================================================================
  describe('pagination', () => {
    it('an oversized limit is CLAMPED to 200 with 200 OK, not rejected', async () => {
      // ADR-014. The rest of the API rejects an oversized limit; audit clamps,
      // because a rejected request leaves the caller no forward path. The
      // envelope's `limit` is the effective one — without it this assertion could
      // not tell "clamped" from "there were only that many rows".
      const a = await newOrg('Acme', 'admin@acme.test');
      const res = await audit(a.cookie, '?limit=5000').expect(200);
      expect(res.body.limit).toBe(200);
    });

    it('the default page size is 50', async () => {
      const a = await newOrg('Acme', 'admin@acme.test');
      const res = await audit(a.cookie).expect(200);
      expect(res.body.limit).toBe(50);
    });

    it('THE BOUNDARY CASE — rows sharing a created_at paginate with no skip and no repeat', async () => {
      // THE REASON THE CURSOR IS COMPOSITE, proven directly rather than inferred.
      //
      // A single logical mutation fires several triggers in ONE transaction, so
      // rows sharing a `created_at` to the microsecond are routine on this table
      // — registering an asset writes `assets` plus TWO `asset_events` genesis
      // rows, all with the same transaction timestamp. Ordering by timestamp
      // alone leaves them arbitrarily ordered between queries, and a page
      // boundary landing inside the group skips or repeats a row. That is
      // Finding 7, and here it is the common case rather than one table's quirk.
      //
      // So: force a page boundary INSIDE such a group and walk the whole trail.
      const a = await newOrg('Acme', 'admin@acme.test');
      await registerAsset(a.cookie);

      // Confirm the premise of the test — there really is a same-timestamp group.
      const groups = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM (
           SELECT created_at FROM public.audit_log
            GROUP BY created_at HAVING count(*) > 1
         ) g`,
      );
      expect(
        groups[0]!.n,
        'no two audit rows share a created_at — the boundary this test exists for does not occur',
      ).toBeGreaterThan(0);

      const all = await audit(a.cookie, '?limit=200').expect(200);
      const expected: string[] = all.body.items.map((r: { id: string }) => r.id);
      expect(expected.length).toBeGreaterThan(2);

      // Walk one row at a time, so a boundary falls between EVERY adjacent pair —
      // including inside the tied group, wherever it sits.
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard += 1) {
        const qs: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await audit(a.cookie, qs).expect(200);
        walked.push(...page.body.items.map((r: { id: string }) => r.id));
        cursor = page.body.nextCursor;
        if (!cursor) break;
      }

      // No skip: every row arrived. No repeat: none arrived twice. Same order.
      expect(walked).toEqual(expected);
      expect(new Set(walked).size).toBe(walked.length);
    });
  });
});
