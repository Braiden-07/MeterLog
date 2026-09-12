import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  appClient,
  capturePgFailure,
  migratorClient,
  resetDatabase,
  withContext,
  withTenant,
} from './helpers';

/**
 * THE STEP-7A GATE — audit capture, proven at the database layer (ADR-009…012).
 *
 * Every property here is proven against a live Postgres with its negative quoted,
 * and the negatives use the 42501-disambiguation discipline phase 4 established:
 * assert the SQLSTATE **and** the message, and exclude the other mechanism.
 * `42501` is `insufficient_privilege` and Postgres raises it both for "a policy
 * refused this row" and for "this role was never granted this command". A
 * negative asserting only the code passes when the other layer did the refusing.
 *
 * WHY THIS SUITE IS A BESPOKE FILE AND NOT MATRIX FIXTURES. `audit_log` is
 * registered in `ISOLATION_BESPOKE_TABLES`, for the same reason `users`,
 * `tenants` and `memberships` are: the generic matrix seeds through the APP role,
 * and the app role holds no `INSERT` on `audit_log` at all. The matrix's INSERT
 * case asserts an RLS `WITH CHECK` rejection and explicitly asserts
 * `permission denied` ABSENT — so a fixture here would fail about grants while
 * claiming to be about isolation, and the only way to make it pass would be to
 * grant the app role the privilege ADR-010 exists to withhold.
 *
 * So the audit rows in this file are seeded the only way anything can seed them:
 * by performing REAL mutations and letting the trigger write them. That is not a
 * limitation of the suite, it is the mechanism under test.
 */

/** A real argon2id hash shape. Load-bearing — see the redaction describe block. */
const REAL_HASH_A =
  '$argon2id$v=19$m=19456,t=2,p=1$YXVkaXRzYWx0QQ$Zm91bmRlckFzZWNyZXRoYXNodmFsdWVB';
const REAL_HASH_B =
  '$argon2id$v=19$m=19456,t=2,p=1$YXVkaXRzYWx0Qg$Zm91bmRlckJzZWNyZXRoYXNodmFsdWVC';
/** A THIRD distinct secret, so the global scan has three to hunt for, not two. */
const REAL_HASH_C = '$argon2id$v=19$m=19456,t=2,p=1$YXVkaXRzYWx0Qw$aW52aXRlZHNlY3JldGhhc2h2YWx1ZUM';

interface Registered {
  tenantId: string;
  userId: string;
  membershipId: string;
}

interface AuditRow {
  id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  table_name: string;
  row_id: string;
  action: string;
  payload: { before: Record<string, unknown> | null; after: Record<string, unknown> };
}

describe('audit capture at the database layer (step 7 phase 7a)', () => {
  let app: PrismaClient;
  let migrator: PrismaClient;

  /**
   * Registration is the ONLY way to create a tenant with its first admin, and it
   * is deliberately used here rather than migrator-role inserts: it is also the
   * pre-auth path whose interaction with capture is the subject of its own
   * describe block below, and it writes a REAL password hash, which is what makes
   * the redaction proof non-vacuous.
   */
  const register = async (name: string, email: string, hash: string): Promise<Registered> => {
    const rows = await app.$queryRawUnsafe<
      { tenant_id: string; user_id: string; membership_id: string }[]
    >(
      `SELECT tenant_id::text, user_id::text, membership_id::text
         FROM public.register_tenant($1, $2::citext, $3)`,
      name,
      email,
      hash,
    );
    const row = rows[0];
    if (!row) throw new Error(`register_tenant returned no row for ${email}`);
    return { tenantId: row.tenant_id, userId: row.user_id, membershipId: row.membership_id };
  };

  /**
   * Audit rows are read on the MIGRATOR, and that is load-bearing rather than
   * convenient. `audit_log` is under FORCE ROW LEVEL SECURITY, so an app-client
   * read outside a tenant context returns zero rows whatever the table holds —
   * an assertion built on it would be vacuous forever. The same reason
   * `assertNoResidualRows` counts on the migrator.
   *
   * The tenant-ISOLATION block below deliberately does the opposite: it reads as
   * the app role, because there the filtering IS the property under test.
   */
  const auditRows = async (where = 'true', ...params: unknown[]): Promise<AuditRow[]> =>
    migrator.$queryRawUnsafe<AuditRow[]>(
      `SELECT id::text, tenant_id::text, actor_user_id::text, actor_role::text,
              table_name, row_id::text, action::text, payload
         FROM public.audit_log
        WHERE ${where}
        ORDER BY created_at, table_name`,
      ...params,
    );

  beforeAll(() => {
    app = appClient();
    migrator = migratorClient();
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await app.$disconnect();
    await migrator.$disconnect();
  });

  beforeEach(async () => {
    // Per-test reset, because almost every assertion here counts audit rows and
    // residue from a neighbouring test would make a count assertion mean nothing.
    await resetDatabase(migrator);
  });

  // =========================================================================
  // 1. CAPTURE WORKS — the counter-face of immutability
  // =========================================================================
  describe('capture', () => {
    it('an app-role mutation writes an audit row with action, actor and role-at-time', async () => {
      // THE COUNTER-FACE OF ADR-010. The app role cannot write `audit_log` — that
      // is the next block — and yet the row appears, because the SECURITY DEFINER
      // trigger is the writer. Both halves have to hold at once or the mechanism
      // is either broken or pointless.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      await resetAuditOnly();

      const serial = `SN-${randomUUID()}`;
      await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO public.assets (tenant_id, serial_number, type, status)
           VALUES ($1::uuid, $2, 'meter', 'installed')`,
          a.tenantId,
          serial,
        ),
      );

      const rows = await auditRows(`table_name = 'assets'`);
      expect(rows).toHaveLength(1);

      const row = rows[0]!;
      expect(row.action).toBe('asset.created');
      expect(row.tenant_id).toBe(a.tenantId);
      expect(row.actor_user_id).toBe(a.userId);
      // ROLE AT TIME OF ACTION, by lookup — no app.current_role GUC anywhere.
      expect(row.actor_role).toBe('admin');
      expect(row.table_name).toBe('assets');
      expect(row.payload.before).toBeNull();
      expect(row.payload.after.serial_number).toBe(serial);
      expect(row.payload.after.status).toBe('installed');
    });

    it('an UPDATE records ONLY the columns whose values actually changed', async () => {
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      const assetId = await seedAsset(a);
      await resetAuditOnly();

      await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE public.assets SET location = 'Bay 3' WHERE id = $1::uuid`,
          assetId,
        ),
      );

      const rows = await auditRows(`table_name = 'assets'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('asset.updated');

      // A changed-column diff, not a full-row snapshot: `serial_number` did not
      // change, so it is absent from BOTH sides. That is what makes the trail
      // readable, and it is also what makes redaction total — a withheld column
      // cannot even be inferred from a "something changed here".
      expect(Object.keys(rows[0]!.payload.after)).toEqual(['location']);
      expect(rows[0]!.payload.after.location).toBe('Bay 3');
      expect(rows[0]!.payload.before).toEqual({ location: null });
    });

    it('a soft delete is recorded as the delete action, not as a generic update', async () => {
      // v1.0 has no hard delete (OPEN-9), so every removal arrives at the trigger
      // as an UPDATE of `deleted_at`. The trail records WHAT HAPPENED rather than
      // what SQL was issued — otherwise an auditor reading the log would have to
      // reconstruct "this was a deletion" from a diff.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      const assetId = await seedAsset(a);
      const recordId = await seedMaintenance(a, assetId);
      await resetAuditOnly();

      await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE public.maintenance_records SET deleted_at = now(), updated_at = now()
            WHERE id = $1::uuid`,
          recordId,
        ),
      );

      const rows = await auditRows(`table_name = 'maintenance_records'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('maintenance.deleted');
      expect(rows[0]!.actor_role).toBe('admin');
    });

    it('THE PREMISE — a maintenance edit emits no lifecycle event and IS captured anyway', async () => {
      // THIS IS THE PHASE'S WHOLE REASON FOR BEING, reduced to one test.
      //
      // ISOLATION.md section 9 states it: correcting a maintenance description is
      // not something that happened to the physical asset, so it emits NO
      // `asset_events` row. Any audit trail DERIVED from the event log is
      // therefore silent for this entire class of change — and this is the
      // mutation such a derivation would most certainly miss, because there is
      // nothing in `asset_events` to drive from.
      //
      // Asserted in both directions, because the second half alone would not show
      // that the gap was real.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      const assetId = await seedAsset(a);
      const recordId = await seedMaintenance(a, assetId);

      const eventsBefore = await countRows('asset_events');
      await resetAuditOnly();

      await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE public.maintenance_records
              SET description = 'annual service — corrected', updated_at = now()
            WHERE id = $1::uuid`,
          recordId,
        ),
      );

      // (a) THE GAP IS REAL: the lifecycle log did not move.
      expect(await countRows('asset_events')).toBe(eventsBefore);

      // (b) THE GAP IS CLOSED: the trail did.
      const rows = await auditRows(`table_name = 'maintenance_records'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('maintenance.updated');
      expect(rows[0]!.payload.after.description).toBe('annual service — corrected');
      expect(rows[0]!.payload.before).toMatchObject({ description: 'annual service' });
    });
  });

  // =========================================================================
  // 2. IMMUTABLE BY GRANT — the centerpiece (ADR-010)
  // =========================================================================
  describe('immutable by grant — forge, alter, suppress', () => {
    /**
     * Each of the three asserts SQLSTATE **and** message, and excludes the RLS
     * message. Here it must be the GRANT that refuses: there is a `FOR SELECT`
     * policy on this table, so a policy-shaped refusal would mean something other
     * than the missing privilege did the work — and the missing privilege is the
     * entire decision (ADR-010).
     */
    const assertRefusedByGrant = (failure: { sqlstate: string; message: string }) => {
      expect(failure.sqlstate).toBe('42501');
      expect(failure.message).toMatch(/permission denied for table audit_log/);
      expect(failure.message).not.toMatch(/row-level security/i);
    };

    it('FORGE — the app role cannot INSERT an audit row', async () => {
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);

      const failure = await capturePgFailure(
        withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.audit_log
               (tenant_id, actor_user_id, table_name, row_id, action, payload)
             VALUES ($1::uuid, $2::uuid, 'assets', gen_random_uuid(), 'asset.created', '{}'::jsonb)`,
            a.tenantId,
            a.userId,
          ),
        ),
      );

      // An INSERT the policy would have WELCOMED — own tenant, own actor, valid
      // action. The row is refused for the only reason left: no privilege.
      assertRefusedByGrant(failure);
    });

    it('ALTER — the app role cannot UPDATE an audit row', async () => {
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      await seedAsset(a);

      const before = await auditRows(`table_name = 'assets'`);
      expect(before.length).toBeGreaterThan(0);

      const failure = await capturePgFailure(
        withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE public.audit_log SET action = 'asset.updated' WHERE id = $1::uuid`,
            before[0]!.id,
          ),
        ),
      );

      assertRefusedByGrant(failure);

      // NOT AN EMPTY UPDATE — the row is real, visible under this tenant, and
      // untouched. Without this the test would pass against a grant that existed
      // and a policy that hid every row, which is a different mechanism.
      const after = await auditRows(`id = $1::uuid`, before[0]!.id);
      expect(after).toHaveLength(1);
      expect(after[0]!.action).toBe(before[0]!.action);
    });

    it('SUPPRESS — the app role cannot DELETE an audit row', async () => {
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      await seedAsset(a);

      const before = await auditRows();
      expect(before.length).toBeGreaterThan(0);

      const failure = await capturePgFailure(
        withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM public.audit_log`),
        ),
      );

      assertRefusedByGrant(failure);

      const after = await auditRows();
      expect(after).toHaveLength(before.length);
    });

    it('the app role CAN read its own tenant rows — 9 is not satisfied by an untouchable table', async () => {
      // Pairs with the three above exactly as catalog assertion 10 pairs with 9.
      // "Cannot write" is satisfied by a table nobody can reach at all, which
      // would be fail-closed and broken: the step-7b read surface would 500 or
      // return nothing, and none of the three negatives above would notice.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      await seedAsset(a);

      const visible = await withTenant(app, a.tenantId, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM public.audit_log WHERE table_name = 'assets'`,
        ),
      );
      expect(visible[0]!.n).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. ROLE AT THE TIME OF THE ACTION — OPEN-4 as a property (ADR-009)
  // =========================================================================
  describe('role-at-time-of-action', () => {
    it('a technician acts, is promoted to admin, and the audit row still reads technician', async () => {
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);

      // A real second identity, invited as a technician through the definer path.
      const invited = await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$queryRawUnsafe<{ membership_id: string; user_id: string }[]>(
          `SELECT membership_id::text, user_id::text
             FROM public.invite_member($1::citext, 'technician', $2)`,
          'tech@acme.test',
          REAL_HASH_B,
        ),
      );
      const techUser = invited[0]!.user_id;
      const techMembership = invited[0]!.membership_id;

      const assetId = await seedAsset(a);
      await resetAuditOnly();

      // The technician records a reading — an ordinary technician action.
      await withContext(app, { userId: techUser, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO public.readings (tenant_id, asset_id, value, unit, read_at, created_by)
           VALUES ($1::uuid, $2::uuid, 41.5, 'kWh', now(), $3::uuid)`,
          a.tenantId,
          assetId,
          techUser,
        ),
      );

      const atTime = await auditRows(`table_name = 'readings'`);
      expect(atTime).toHaveLength(1);
      expect(atTime[0]!.actor_role).toBe('technician');

      // NOW THE ROLE CHANGES. This is the whole question OPEN-4 asked.
      await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(`SELECT public.change_member_role($1::uuid, 'admin')`, techMembership),
      );

      // The membership now says admin...
      const current = await migrator.$queryRawUnsafe<{ role: string }[]>(
        `SELECT role::text AS role FROM public.memberships WHERE id = $1::uuid`,
        techMembership,
      );
      expect(current[0]!.role).toBe('admin');

      // ...and the audit row still says technician. The snapshot does not move.
      const after = await auditRows(`table_name = 'readings'`);
      expect(after[0]!.actor_role).toBe('technician');

      // AND THE JOIN A READER MIGHT BE TEMPTED TO WRITE GIVES THE WRONG ANSWER.
      // This is why `actor_role` is denormalized and must stay so: recovering the
      // role by joining to `memberships` at read time returns what is true NOW,
      // which is precisely not what an audit trail is for.
      const naiveJoin = await migrator.$queryRawUnsafe<{ role: string }[]>(
        `SELECT m.role::text AS role
           FROM public.audit_log al
           JOIN public.memberships m
             ON m.user_id = al.actor_user_id AND m.tenant_id = al.tenant_id
          WHERE al.table_name = 'readings'`,
      );
      expect(naiveJoin[0]!.role).toBe('admin');
      expect(naiveJoin[0]!.role).not.toBe(after[0]!.actor_role);
    });

    it('a member acts, is REVOKED, and the audit row still reads the role they held', async () => {
      // The harder half. A role change leaves a row to join to, so a naive reader
      // gets a wrong answer. A revoke leaves a row whose liveness filter excludes
      // it, so a naive reader gets NO answer — the action becomes unattributable.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);

      const invited = await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$queryRawUnsafe<{ membership_id: string; user_id: string }[]>(
          `SELECT membership_id::text, user_id::text
             FROM public.invite_member($1::citext, 'technician', $2)`,
          'leaver@acme.test',
          REAL_HASH_B,
        ),
      );
      const leaver = invited[0]!.user_id;
      const leaverMembership = invited[0]!.membership_id;

      const assetId = await seedAsset(a);
      await resetAuditOnly();

      await withContext(app, { userId: leaver, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO public.maintenance_records
             (tenant_id, asset_id, description, performed_at, created_by)
           VALUES ($1::uuid, $2::uuid, 'replaced seal', now(), $3::uuid)`,
          a.tenantId,
          assetId,
          leaver,
        ),
      );

      await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(`SELECT public.revoke_member($1::uuid)`, leaverMembership),
      );

      const revoked = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.memberships
          WHERE id = $1::uuid AND deleted_at IS NOT NULL`,
        leaverMembership,
      );
      expect(revoked[0]!.n).toBe(1);

      const rows = await auditRows(`table_name = 'maintenance_records'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_user_id).toBe(leaver);
      expect(rows[0]!.actor_role).toBe('technician');

      // The live-membership lookup now finds nothing at all: without the snapshot
      // the action would be permanently unattributable to a role.
      const liveLookup = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n
           FROM public.memberships
          WHERE user_id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`,
        leaver,
        a.tenantId,
      );
      expect(liveLookup[0]!.n).toBe(0);
    });

    it('the revoke itself is captured with the ADMIN who performed it', async () => {
      // Three of the eleven mutation types are definer functions with no service
      // in front of them (ADR-009). Capture has to work there too, and it is the
      // case a service-layer audit would have needed a second implementation for.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);

      const invited = await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$queryRawUnsafe<{ membership_id: string }[]>(
          `SELECT membership_id::text FROM public.invite_member($1::citext, 'auditor', $2)`,
          'auditor@acme.test',
          REAL_HASH_B,
        ),
      );
      await resetAuditOnly();

      await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(`SELECT public.revoke_member($1::uuid)`, invited[0]!.membership_id),
      );

      const rows = await auditRows(`table_name = 'memberships'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('membership.revoked');
      expect(rows[0]!.actor_user_id).toBe(a.userId);
      expect(rows[0]!.actor_role).toBe('admin');
      expect(rows[0]!.row_id).toBe(invited[0]!.membership_id);
    });
  });

  // =========================================================================
  // 4. THE SYSTEM ACTOR — registration with capture live (ADR-009)
  // =========================================================================
  describe('the nullable / system actor', () => {
    it('registration SUCCEEDS with capture live and writes the NULL-actor system row', async () => {
      // THE FAILURE MODE THIS GUARDS AGAINST IS NOT A MISSING ROW — IT IS A
      // BROKEN REGISTRATION. `register_tenant` runs pre-authentication, so
      // `app.current_user` is unset and there is no actor by construction. A
      // NOT NULL `actor_user_id` would make the trigger's INSERT fail, the
      // exception would propagate, and the ONLY way into the product would be
      // closed — by the audit module.
      //
      // So the first assertion is that registration worked at all.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      expect(a.tenantId).toBeTruthy();
      expect(a.userId).toBeTruthy();
      expect(a.membershipId).toBeTruthy();

      const persisted = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT (SELECT count(*) FROM public.tenants WHERE id = $1::uuid)
              + (SELECT count(*) FROM public.users   WHERE id = $2::uuid)
              + (SELECT count(*) FROM public.memberships WHERE id = $3::uuid) AS n`,
        a.tenantId,
        a.userId,
        a.membershipId,
      );
      expect(Number(persisted[0]!.n)).toBe(3);

      const rows = await auditRows();
      const membership = rows.find((r) => r.action === 'membership.created')!;
      const user = rows.find((r) => r.action === 'user.created')!;

      // The system row, in the shape ADR-009 pins: NULL actor, NULL role.
      expect(membership.actor_user_id).toBeNull();
      expect(membership.actor_role).toBeNull();
      expect(membership.tenant_id).toBe(a.tenantId);
      expect(membership.payload.after.role).toBe('admin');

      // And the `users` row is tenant-NULL as well, because `users` carries no
      // tenant_id (ADR-006 section 2) and registration inserts it BEFORE the
      // membership with no tenant context set. All three NULLs mean one thing:
      // a pre-authentication bootstrap action.
      expect(user.actor_user_id).toBeNull();
      expect(user.actor_role).toBeNull();
      expect(user.tenant_id).toBeNull();
    });

    it('the tenant-NULL system row is invisible to app-role reads, and the tenant-scoped one is not', async () => {
      // The consequence of the nullable tenant, asserted rather than left to be
      // discovered. A `users` bootstrap row belongs to no tenant, so no tenant
      // sees it — while the bootstrap is still recorded in that tenant's trail by
      // the `membership.created` row, which carries a real tenant_id.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);

      const seen = await withTenant(app, a.tenantId, (tx) =>
        tx.$queryRawUnsafe<{ action: string }[]>(
          `SELECT action::text AS action FROM public.audit_log ORDER BY action`,
        ),
      );

      expect(seen.map((r) => r.action)).toEqual(['membership.created']);
    });
  });

  // =========================================================================
  // 5. REDACTION, NON-VACUOUSLY (ADR-011)
  // =========================================================================
  describe('redaction', () => {
    it('the SOURCE row genuinely carries the secret, and the audit row does not', async () => {
      // NON-VACUITY FIRST, AND IT IS THE POINT OF THE TEST. A redaction assertion
      // is worth nothing if no fixture carries the secret: the source row would
      // have an empty hash, the audit row would lack it, and the assertion would
      // pass just as happily against a trigger with the allowlist deleted. That is
      // Finding 7's lesson — seven mutations passed against fixtures whose DATA
      // SHAPE was the blind spot.
      //
      // So: assert the secret is really there, in full, before asserting its
      // absence anywhere else.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);

      const source = await migrator.$queryRawUnsafe<{ password_hash: string }[]>(
        `SELECT password_hash FROM public.users WHERE id = $1::uuid`,
        a.userId,
      );
      expect(source).toHaveLength(1);
      expect(source[0]!.password_hash).toBe(REAL_HASH_A);
      expect(source[0]!.password_hash.length).toBeGreaterThan(40);

      // Now the audit row for that very identity write.
      const rows = await auditRows(`table_name = 'users' AND row_id = $1::uuid`, a.userId);
      expect(rows).toHaveLength(1);

      const after = rows[0]!.payload.after;
      // The row IS captured — email and timestamps are there, so this is not
      // passing because the payload is empty.
      expect(after.email).toBe('founder@acme.test');
      expect(after.id).toBe(a.userId);
      // And the secret is not.
      expect(Object.keys(after)).not.toContain('password_hash');
      expect(JSON.stringify(rows[0]!.payload)).not.toContain(REAL_HASH_A);
    });

    it('GLOBAL SCAN — no audit_log row anywhere contains any password_hash value', async () => {
      // The per-row assertion above covers the path it exercises. This covers
      // EVERY row from EVERY path, against EVERY hash in the database — so a leak
      // through a mutation nobody thought to test is caught too.
      //
      // Several identities and several hashes, including the sentinel hashes
      // `invite_member` writes, so the scan has real material to find.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      await register('Globex', 'founder@globex.test', REAL_HASH_B);

      await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `SELECT public.invite_member($1::citext, 'technician', $2)`,
          'tech@acme.test',
          REAL_HASH_C,
        ),
      );

      const hashes = await migrator.$queryRawUnsafe<{ password_hash: string }[]>(
        `SELECT DISTINCT password_hash FROM public.users`,
      );
      // NON-VACUITY, AND THIS GUARD HAS ALREADY EARNED ITS PLACE: the first
      // version of this test reused one hash literal across two identities, so
      // there were three users and only TWO distinct secrets, and it failed here
      // rather than quietly scanning for less than it claimed. Three identities,
      // three DISTINCT hashes — one per registration plus the invite.
      expect(hashes.length).toBeGreaterThanOrEqual(3);
      for (const h of hashes) expect(h.password_hash.length).toBeGreaterThan(20);

      const leaks = await migrator.$queryRawUnsafe<{ id: string; table_name: string }[]>(
        `SELECT al.id::text, al.table_name
           FROM public.audit_log al
          WHERE EXISTS (
            SELECT 1 FROM public.users u
             WHERE al.payload::text LIKE '%' || u.password_hash || '%'
          )`,
      );

      expect(
        leaks,
        `audit rows containing a password hash — the trail has become a privilege-escalation path (ADR-011): ${leaks
          .map((l) => `${l.table_name}/${l.id}`)
          .join(', ')}`,
      ).toEqual([]);

      // And the scan is reaching rows at all.
      const scanned = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.audit_log WHERE table_name = 'users'`,
      );
      expect(scanned[0]!.n).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  // 6. TENANT ISOLATION ON audit_log, AT THE DATABASE LAYER
  // =========================================================================
  describe('tenant isolation', () => {
    it('M, admin of BOTH tenants and active in A, sees only A audit rows', async () => {
      // The isolation matrix extended to the trail. Read as the APP role here,
      // deliberately — unlike everywhere else in this file, the RLS filtering IS
      // the property under test, so reading on the migrator would prove nothing.
      //
      // SEMANTIC, NOT SYNTACTIC (ISOLATION.md section 8): M holds a REAL, LIVE
      // admin membership in B. Tenant B's rows are ones M is genuinely entitled to
      // see — in tenant B's context. A test using a stranger, or a nonexistent
      // tenant, would prove only that unrelated data is unrelated.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      const b = await register('Globex', 'founder@globex.test', REAL_HASH_B);

      // M is invited into BOTH, as admin of each.
      const inA = await withContext(app, { userId: a.userId, tenantId: a.tenantId }, (tx) =>
        tx.$queryRawUnsafe<{ user_id: string }[]>(
          `SELECT user_id::text FROM public.invite_member($1::citext, 'admin', $2)`,
          'm@example.test',
          REAL_HASH_B,
        ),
      );
      const m = inA[0]!.user_id;

      await withContext(app, { userId: b.userId, tenantId: b.tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `SELECT public.invite_member($1::citext, 'admin', $2)`,
          'm@example.test',
          REAL_HASH_B,
        ),
      );

      const assetA = await seedAsset(a);
      const assetB = await seedAsset(b);
      expect(assetA).not.toBe(assetB);

      // M reads the trail with tenant A active.
      const seen = await withContext(app, { userId: m, tenantId: a.tenantId }, (tx) =>
        tx.$queryRawUnsafe<{ tenant_id: string | null; n: number }[]>(
          `SELECT tenant_id::text, count(*)::int AS n FROM public.audit_log GROUP BY 1`,
        ),
      );

      // NON-VACUITY: M must see SOMETHING, or "sees only A" is satisfied by
      // seeing nothing — the tautology a missing grant would also produce.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.map((r) => r.tenant_id)).toEqual([a.tenantId]);

      // And tenant B's rows genuinely exist — so the zero above is filtering, not
      // absence. Counted on the migrator, which is the only cross-tenant view.
      const bRows = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.audit_log WHERE tenant_id = $1::uuid`,
        b.tenantId,
      );
      expect(bRows[0]!.n).toBeGreaterThan(0);
    });

    it('with NO tenant context the trail is empty — fail closed, not an error', async () => {
      // The canonical `NULLIF(..., '')` property (ADR-004), on the new table. On a
      // POOLED connection an unset GUC is the EMPTY STRING rather than NULL, and
      // `''::uuid` raises 22P02 — so without the NULLIF this is a 500 instead of
      // zero rows, and only after a connection has been reused.
      const a = await register('Acme', 'founder@acme.test', REAL_HASH_A);
      await seedAsset(a);

      const rows = await app.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.audit_log`,
      );
      expect(rows[0]!.n).toBe(0);

      // The rows are really there.
      const all = await auditRows();
      expect(all.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // helpers, kept below the assertions they serve
  // =========================================================================

  /**
   * Clears `audit_log` between a fixture's setup and the mutation under test, so
   * a count assertion measures the mutation rather than the scaffolding.
   *
   * ON THE MIGRATOR, NECESSARILY — and it is worth being explicit that this is
   * the one privilege no application role has. The app role cannot do this, which
   * is the property the suite above proves three times over.
   */
  const resetAuditOnly = async (): Promise<void> => {
    await migrator.$executeRawUnsafe(`DELETE FROM public.audit_log`);
  };

  const countRows = async (table: string): Promise<number> => {
    const rows = await migrator.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM public."${table}"`,
    );
    return rows[0]!.n;
  };

  /** An asset owned by the registrant's tenant, written through the app role. */
  const seedAsset = async (owner: Registered): Promise<string> => {
    const rows = await withContext(app, { userId: owner.userId, tenantId: owner.tenantId }, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO public.assets (tenant_id, serial_number, type, status)
         VALUES ($1::uuid, $2, 'meter', 'installed')
         RETURNING id::text AS id`,
        owner.tenantId,
        `SN-${randomUUID()}`,
      ),
    );
    return rows[0]!.id;
  };

  const seedMaintenance = async (owner: Registered, assetId: string): Promise<string> => {
    const rows = await withContext(app, { userId: owner.userId, tenantId: owner.tenantId }, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO public.maintenance_records
           (tenant_id, asset_id, description, performed_at, created_by)
         VALUES ($1::uuid, $2::uuid, 'annual service', now(), $3::uuid)
         RETURNING id::text AS id`,
        owner.tenantId,
        assetId,
        owner.userId,
      ),
    );
    return rows[0]!.id;
  };
});
