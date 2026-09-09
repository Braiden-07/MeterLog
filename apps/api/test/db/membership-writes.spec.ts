import { randomUUID } from 'node:crypto';

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ARGON2_OPTIONS } from '../../src/auth/auth.service';

import { appClient, execAll, loadEnv, migratorClient } from './helpers';

/**
 * Step 5 Phase 1 — the membership-write definer functions and their §7
 * body-level authorization, proven against live Postgres.
 *
 * THE ENTIRE POINT OF THIS FILE IS *HOW* THE NEGATIVES ARE PRODUCED.
 *
 * Every call below is made as `meterlog_app`, over a plain database connection,
 * with `app.current_user` / `app.current_tenant` set BY HAND. There is no
 * interceptor, no Nest, no HTTP, and no RBAC guard anywhere in this process —
 * the RBAC layer is Phase 2 and does not exist yet.
 *
 * That is not a convenience; it is the property under test. ADR-006 §7:
 *
 *   > A guard in Nest is not a substitute: the function is `EXECUTE`-able by
 *   > `meterlog_app`, so anything holding that connection can call it directly,
 *   > guard or no guard.
 *
 * DECISION B moved the write-correctness burden into these function bodies and
 * left nothing underneath them — the app role has no write privilege and no write
 * policy on `memberships`, and the definer policy is `USING (true) WITH CHECK
 * (true)`, which constrains nothing. So a negative that ran through an HTTP guard
 * would be proving the guard, and would leave B indistinguishable from option A
 * (the rejected "leave it to RBAC" design) while looking green. The guard is the
 * OUTER of two checks. This file proves the INNER one, with provably nothing in
 * front of it.
 *
 * Seeding runs as the migration role because the app role deliberately cannot
 * write any of these tables.
 */

/**
 * Pinned like `interceptor.spec.ts`, and for the same reason: the empty-string
 * GUC case only reproduces on a REUSED connection, and the concurrency test needs
 * two connections it can actually hold open against each other.
 */
const PINNED = 'connection_limit=1&pool_timeout=10';

function pinnedAppClient(): PrismaClient {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  return new PrismaClient({ datasources: { db: { url: `${url}&${PINNED}` } } });
}

/**
 * Sets exactly the GUCs it is given, INCLUDING empty strings.
 *
 * `helpers.withContext` skips falsy values, which is right for its callers and
 * wrong here: `''` is the specific pooled-connection value this suite has to be
 * able to send deliberately.
 */
async function withExactContext<T>(
  client: PrismaClient,
  ctx: { userId?: string; tenantId?: string },
  body: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, ctx.userId);
    }
    if (ctx.tenantId !== undefined) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, ctx.tenantId);
    }
    return body(tx as unknown as PrismaClient);
  });
}

interface InviteResult {
  membership_id: string;
  user_id: string;
  user_created: boolean;
}

const invite = (tx: PrismaClient, email: string, role: string, hash: string) =>
  tx.$queryRawUnsafe<InviteResult[]>(
    `SELECT * FROM public.invite_member($1::citext, $2::public.membership_role, $3::text)`,
    email,
    role,
    hash,
  );

const changeRole = (tx: PrismaClient, membershipId: string, role: string) =>
  tx.$executeRawUnsafe(
    `SELECT public.change_member_role($1::uuid, $2::public.membership_role)`,
    membershipId,
    role,
  );

const revoke = (tx: PrismaClient, membershipId: string) =>
  tx.$executeRawUnsafe(`SELECT public.revoke_member($1::uuid)`, membershipId);

/** Polls until `check` is true, or gives up. Returns whether it became true. */
async function waitFor(check: () => Promise<boolean>, budgetMs = 3000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('membership write functions — §7 body-level authorization', () => {
  let app: PrismaClient;
  let migrator: PrismaClient;

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const adminA = randomUUID();
  const techA = randomUUID();
  const adminB = randomUUID();
  /** A real person with no membership anywhere — the invite-existing-email case. */
  const outsider = randomUUID();

  const mAdminA = randomUUID();
  const mTechA = randomUUID();
  const mAdminB = randomUUID();

  /**
   * The sentinel, derived from ARGON2_OPTIONS exactly as `invite_member`'s caller
   * will derive it in Phase 2 — never a literal. A hardcoded hash is the drift
   * vector killed at the step-4 gate.
   */
  let sentinel: string;

  beforeAll(async () => {
    app = appClient();
    migrator = migratorClient();
    sentinel = await argonHash(randomUUID(), ARGON2_OPTIONS);
  });

  afterAll(async () => {
    await execAll(migrator, [
      `DELETE FROM public.memberships`,
      `DELETE FROM public.users`,
      `DELETE FROM public.tenants`,
    ]);
    await app.$disconnect();
    await migrator.$disconnect();
  });

  beforeEach(async () => {
    // Full re-seed rather than incremental cleanup: several tests deliberately
    // mutate roles and revoke rows, and a half-reset fixture is how a "passing"
    // authorization test ends up asserting against the wrong world.
    await execAll(migrator, [
      `DELETE FROM public.memberships`,
      `DELETE FROM public.users`,
      `DELETE FROM public.tenants`,
      `INSERT INTO public.tenants (id, name) VALUES
         ('${tenantA}', 'Tenant A'), ('${tenantB}', 'Tenant B')`,
      `INSERT INTO public.users (id, email, password_hash) VALUES
         ('${adminA}',   'admin-a@acme.test', 'seeded-not-a-real-hash'),
         ('${techA}',    'tech-a@acme.test',  'seeded-not-a-real-hash'),
         ('${adminB}',   'admin-b@beta.test', 'seeded-not-a-real-hash'),
         ('${outsider}', 'Outsider@Acme.TEST', 'seeded-not-a-real-hash')`,
      // Tenant A starts with exactly ONE admin, so the last-admin guard is live by
      // default and any test that needs two has to say so.
      `INSERT INTO public.memberships (id, user_id, tenant_id, role) VALUES
         ('${mAdminA}', '${adminA}', '${tenantA}', 'admin'),
         ('${mTechA}',  '${techA}',  '${tenantA}', 'technician'),
         ('${mAdminB}', '${adminB}', '${tenantB}', 'admin')`,
    ]);
  });

  const liveRole = async (membershipId: string): Promise<string | null> => {
    const rows = await migrator.$queryRawUnsafe<{ role: string }[]>(
      `SELECT role::text AS role FROM public.memberships
        WHERE id = $1::uuid AND deleted_at IS NULL`,
      membershipId,
    );
    return rows[0]?.role ?? null;
  };

  const liveAdminCount = async (tenantId: string): Promise<number> => {
    const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM public.memberships
        WHERE tenant_id = $1::uuid AND role = 'admin' AND deleted_at IS NULL`,
      tenantId,
    );
    return row?.n ?? -1;
  };

  // -------------------------------------------------------------------------
  // (a) THE CALLER IS AN ADMIN OF THE ACTIVE TENANT.
  //
  // The backstop proof. A technician holding the app connection calls each
  // function directly, with a perfectly valid context for a tenant they really
  // are a member of. Nothing but the function body stands between them and the
  // write.
  // -------------------------------------------------------------------------
  describe('(a) a non-admin caller is rejected — the DB backstop, with no guard in front', () => {
    it('invite_member refuses a technician of the active tenant', async () => {
      await expect(
        withExactContext(app, { userId: techA, tenantId: tenantA }, (tx) =>
          invite(tx, 'newcomer@acme.test', 'technician', sentinel),
        ),
      ).rejects.toThrow(/MB001/);

      const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.users WHERE email = 'newcomer@acme.test'::citext`,
      );
      expect(row?.n, 'the refused invite still created an identity').toBe(0);
    });

    it('change_member_role refuses a technician promoting THEMSELVES to admin', async () => {
      // This is the exact statement DECISION B exists to make impossible. Before
      // B it was `UPDATE public.memberships SET role = 'admin' WHERE user_id =
      // <self>` and it returned `UPDATE 1` against a live database. The write path
      // it used no longer exists; this is the only path left, and it refuses.
      await expect(
        withExactContext(app, { userId: techA, tenantId: tenantA }, (tx) =>
          changeRole(tx, mTechA, 'admin'),
        ),
      ).rejects.toThrow(/MB001/);

      expect(await liveRole(mTechA), 'the technician escalated to admin').toBe('technician');
    });

    it('revoke_member refuses a technician revoking the admin', async () => {
      await expect(
        withExactContext(app, { userId: techA, tenantId: tenantA }, (tx) => revoke(tx, mAdminA)),
      ).rejects.toThrow(/MB001/);

      expect(await liveRole(mAdminA)).toBe('admin');
    });

    it('a caller with NO membership at all in the active tenant is rejected', async () => {
      // The outsider is a real, existent user — not a fabricated uuid. A
      // nonexistent caller would prove only that a uuid failed to match.
      await expect(
        withExactContext(app, { userId: outsider, tenantId: tenantA }, (tx) =>
          changeRole(tx, mTechA, 'admin'),
        ),
      ).rejects.toThrow(/MB001/);
    });

    it('a REVOKED admin is no longer an admin — liveness is part of check (a)', async () => {
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE id = $1::uuid`,
        mAdminA,
      );

      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
          changeRole(tx, mTechA, 'admin'),
        ),
      ).rejects.toThrow(/MB001/);
    });
  });

  // -------------------------------------------------------------------------
  // (b) THE TARGET ROW BELONGS TO THE ACTIVE TENANT.
  //
  // Semantic negatives throughout: the target is a REAL, LIVE membership in a
  // REAL, EXISTENT tenant that the caller is genuinely not an admin of. A
  // malformed or nonexistent uuid would prove only that a lookup missed.
  // -------------------------------------------------------------------------
  describe('(b) an admin of A cannot touch tenant B through the function', () => {
    it('the cross-tenant target is real and live — the negative is not vacuous', async () => {
      expect(await liveRole(mAdminB), "tenant B's membership must exist for the next tests").toBe(
        'admin',
      );
    });

    it("change_member_role: admin of A cannot demote B's admin", async () => {
      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
          changeRole(tx, mAdminB, 'technician'),
        ),
      ).rejects.toThrow(/MB002/);

      expect(await liveRole(mAdminB), "tenant B's admin was modified from tenant A").toBe('admin');
    });

    it("revoke_member: admin of A cannot revoke B's admin", async () => {
      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) => revoke(tx, mAdminB)),
      ).rejects.toThrow(/MB002/);

      expect(await liveRole(mAdminB)).toBe('admin');
      expect(await liveAdminCount(tenantB)).toBe(1);
    });

    it('"belongs to another tenant" is indistinguishable from "does not exist"', async () => {
      // Both MB002. A distinct code would turn the function into an oracle for
      // membership ids in tenants the caller cannot see.
      const ghost = randomUUID();
      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
          changeRole(tx, ghost, 'technician'),
        ),
      ).rejects.toThrow(/MB002/);
    });

    it('invite_member: the cross-tenant case collapses onto check (a)', async () => {
      // invite takes no tenant argument — the new membership's tenant_id comes
      // from the verified GUC. So an admin of A "aiming at" B can only do it by
      // setting the active tenant to B, where they are not an admin: MB001, not
      // MB002. Asserted so the collapse is a recorded property rather than a gap
      // someone later reads as a missing test.
      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantB }, (tx) =>
          invite(tx, 'planted@beta.test', 'admin', sentinel),
        ),
      ).rejects.toThrow(/MB001/);

      expect(await liveAdminCount(tenantB), 'an admin of A planted a membership in B').toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // FAIL CLOSED ON ABSENT CONTEXT — both the NULL and the empty-string shape.
  // -------------------------------------------------------------------------
  describe('absent context fails closed', () => {
    it('no GUCs set at all — rejected', async () => {
      await expect(
        withExactContext(app, {}, (tx) => changeRole(tx, mTechA, 'admin')),
      ).rejects.toThrow(/MB001/);
    });

    it('EMPTY-STRING GUCs — rejected, and not with a uuid cast error', async () => {
      const error = await withExactContext(app, { userId: '', tenantId: '' }, (tx) =>
        changeRole(tx, mTechA, 'admin'),
      ).catch((e: Error) => e);

      // MB001, not 22P02. Without NULLIF(..., '') this is ''::uuid → "invalid
      // input syntax for type uuid" → a 500 in Phase 2 instead of a refusal.
      expect(String(error)).toMatch(/MB001/);
      expect(String(error)).not.toMatch(/22P02/);
    });

    it('EMPTY-STRING arrives naturally on a REUSED connection, and still fails closed', async () => {
      // The invariant from CLAUDE.md, applied to the new functions. A GUC that has
      // been SET LOCAL once reverts to '' — not NULL — at transaction end, so the
      // empty-string branch is what a second request on a pooled connection
      // actually hits. A fresh connection would return NULL and prove nothing.
      const pinned = pinnedAppClient();
      try {
        const firstPid = await pinned.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, adminA);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantA);
          const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>(
            `SELECT pg_backend_pid()::int AS pid`,
          );
          return row!.pid;
        });

        // Second transaction on the SAME connection sets nothing. The GUCs are now
        // '' rather than unset.
        const result = await pinned.$transaction(async (tx) => {
          const [row] = await tx.$queryRawUnsafe<{ pid: number; u: string | null }[]>(
            `SELECT pg_backend_pid()::int AS pid, current_setting('app.current_user', true) AS u`,
          );
          const error = await changeRole(tx as unknown as PrismaClient, mTechA, 'admin').catch(
            (e: Error) => e,
          );
          return { pid: row!.pid, guc: row!.u, error: String(error) };
        });

        // The tell that reuse actually happened — without it this test passes
        // whether or not the connection was reused.
        expect(result.pid, 'the second transaction landed on a different connection').toBe(
          firstPid,
        );
        expect(result.guc, 'the GUC did not revert to the empty string as expected').toBe('');
        expect(result.error).toMatch(/MB001/);
        expect(result.error).not.toMatch(/22P02/);
      } finally {
        await pinned.$disconnect();
      }
    });
  });

  // -------------------------------------------------------------------------
  // ATOMICITY — under AUTOCOMMIT.
  // -------------------------------------------------------------------------
  describe('invite_member atomicity', () => {
    it('a failure on the membership insert leaves NO orphan identity', async () => {
      // AUTOCOMMIT, deliberately. The GUCs are set at SESSION scope
      // (set_config(..., is_local => false)) rather than SET LOCAL, so the
      // function can be called as a bare statement with no wrapping transaction.
      //
      // A rolled-back wrapper would discard the orphan user for us and the test
      // would pass against a NON-atomic function — the same vacuity trap the
      // step-4 registration gate names. The only transaction here is the implicit
      // single-statement one the function runs in.
      const solo = pinnedAppClient();
      try {
        await solo.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, false)`, adminA);
        await solo.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, false)`, tenantA);

        // Forced with a CHECK no row can satisfy, the same technique the step-4
        // third-insert test uses. NOT VALID so the seeded rows are not re-checked
        // and check (a) still finds the caller's admin membership.
        await migrator.$executeRawUnsafe(
          `ALTER TABLE public.memberships
             ADD CONSTRAINT tmp_force_membership_insert_failure CHECK (false) NOT VALID`,
        );
        try {
          await expect(
            solo.$queryRawUnsafe(
              `SELECT * FROM public.invite_member($1::citext, 'technician', $2::text)`,
              'orphan@acme.test',
              sentinel,
            ),
          ).rejects.toThrow(/tmp_force_membership_insert_failure/i);

          const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM public.users WHERE email = 'orphan@acme.test'::citext`,
          );
          expect(row?.n, 'an identity survived a failed invite — the function is not atomic').toBe(
            0,
          );
        } finally {
          await migrator.$executeRawUnsafe(
            `ALTER TABLE public.memberships DROP CONSTRAINT tmp_force_membership_insert_failure`,
          );
        }
      } finally {
        await solo.$disconnect();
      }
    });

    it('the atomicity test would notice a non-atomic function', async () => {
      // Guards the guard: prove the census actually sees a committed identity, so
      // the assertion above cannot be green merely because the query is wrong.
      await migrator.$executeRawUnsafe(
        `INSERT INTO public.users (email, password_hash) VALUES ('census@acme.test', 'x')`,
      );
      const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.users WHERE email = 'census@acme.test'::citext`,
      );
      expect(row?.n).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // THE LAST-ADMIN GUARD (Decision 1, option A).
  // -------------------------------------------------------------------------
  describe('the last-admin guard', () => {
    it('the only admin cannot demote themselves', async () => {
      expect(await liveAdminCount(tenantA)).toBe(1);

      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
          changeRole(tx, mAdminA, 'technician'),
        ),
      ).rejects.toThrow(/MB003/);

      expect(await liveRole(mAdminA)).toBe('admin');
      expect(await liveAdminCount(tenantA)).toBe(1);
    });

    it('the only admin cannot revoke themselves', async () => {
      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) => revoke(tx, mAdminA)),
      ).rejects.toThrow(/MB003/);

      expect(await liveAdminCount(tenantA)).toBe(1);
    });

    it('HAND OVER THEN LEAVE: promote a second admin, then self-revoke, both succeed', async () => {
      // The behaviour option A exists to permit, and the reason a blanket
      // no-self-action rule was not chosen.
      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        changeRole(tx, mTechA, 'admin'),
      );
      expect(await liveAdminCount(tenantA)).toBe(2);

      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        revoke(tx, mAdminA),
      );

      expect(await liveRole(mAdminA)).toBeNull();
      expect(await liveAdminCount(tenantA)).toBe(1);
    });

    it('demoting ANOTHER admin is never the last-admin case (the structural collapse)', async () => {
      // Clause (a) means the caller is themselves a live admin, and the partial
      // unique index means one live membership per (user, tenant) — so a second
      // live admin exists by construction whenever the target is someone else.
      // Asserted rather than merely argued.
      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        changeRole(tx, mTechA, 'admin'),
      );

      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        changeRole(tx, mTechA, 'technician'),
      );

      expect(await liveRole(mTechA)).toBe('technician');
      expect(await liveAdminCount(tenantA)).toBe(1);
    });

    it('CONCURRENT: two last-two-admins self-demotions — one wins, one is refused', async () => {
      // The READ COMMITTED race the `FOR UPDATE` lock exists for. A bare count(*)
      // passes the sequential tests above and fails this one: both transactions
      // would read "2 admins", both would proceed, and the tenant would land on
      // zero admins with neither call erroring.
      //
      // The interleaving is FORCED, not hoped for:
      //   1. T1 calls the function and then STOPS, holding its locks uncommitted.
      //   2. T2 calls the function and blocks on those locks.
      //   3. A third connection asserts T2 is genuinely waiting on a Lock in
      //      pg_stat_activity — the tell, in the same role pg_backend_pid plays in
      //      the reuse tests. Without it, a test that merely ran T1 then T2 in
      //      sequence would look identical and prove nothing about the race.
      //   4. Only then is T1 released.
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET role = 'admin' WHERE id = $1::uuid`,
        mTechA,
      );
      expect(await liveAdminCount(tenantA)).toBe(2);

      const c1 = pinnedAppClient();
      const c2 = pinnedAppClient();

      // The app role carries statement_timeout = 4s, so T2's blocked statement
      // must be released well inside that; and idle_in_transaction_session_timeout
      // = 10s caps how long T1 may hold. Both are comfortably met.
      const txOptions = { maxWait: 5_000, timeout: 9_000 };

      let releaseT1!: () => void;
      const t1Gate = new Promise<void>((resolve) => {
        releaseT1 = resolve;
      });
      let t1HasLocks!: () => void;
      const t1Locked = new Promise<void>((resolve) => {
        t1HasLocks = resolve;
      });
      let t2HasStarted!: () => void;
      const t2Started = new Promise<void>((resolve) => {
        t2HasStarted = resolve;
      });
      let t2Pid = 0;

      try {
        const t1 = c1.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, adminA);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantA);
          await changeRole(tx as unknown as PrismaClient, mAdminA, 'technician');
          t1HasLocks();
          await t1Gate;
        }, txOptions);

        await t1Locked;

        const t2 = c2.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, techA);
          await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantA);
          const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>(
            `SELECT pg_backend_pid()::int AS pid`,
          );
          t2Pid = row!.pid;
          t2HasStarted();
          await changeRole(tx as unknown as PrismaClient, mTechA, 'technician');
        }, txOptions);

        // T2 must reject; capture it now so nothing is left unhandled while we wait.
        const t2Outcome = t2.then(
          () => null,
          (e: Error) => e,
        );

        await t2Started;

        const blocked = await waitFor(async () => {
          const rows = await migrator.$queryRawUnsafe<{ w: string | null }[]>(
            `SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1::int`,
            t2Pid,
          );
          return rows[0]?.w === 'Lock';
        });
        expect(
          blocked,
          'T2 never actually blocked on T1 — the interleaving was not real, so this proves nothing about the race',
        ).toBe(true);

        releaseT1();
        await t1;

        const error = await t2Outcome;
        expect(String(error), 'T2 was allowed to zero the tenant').toMatch(/MB003/);

        // The property that matters, independent of who won.
        expect(await liveAdminCount(tenantA), 'the tenant was left with no admins').toBe(1);
      } finally {
        releaseT1();
        await c1.$disconnect();
        await c2.$disconnect();
      }
    });
  });

  // -------------------------------------------------------------------------
  // POSITIVE PATHS.
  // -------------------------------------------------------------------------
  describe('the functions do what they are for', () => {
    it('invite attaches a membership to an EXISTING identity, case-insensitively', async () => {
      // The outsider is seeded as `Outsider@Acme.TEST`; the invite uses a
      // different case. This is the OPERATOR(public.=) citext path — with a bare
      // `=` the lookup binds case-sensitive text equality, misses, tries to create
      // a second identity, and is refused by the case-INSENSITIVE unique index.
      // The invite would be impossible for someone already in the system.
      const [result] = await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        invite(tx, 'outsider@acme.test', 'auditor', sentinel),
      );

      expect(result!.user_created, 'a duplicate identity was created for an existing email').toBe(
        false,
      );
      expect(result!.user_id).toBe(outsider);
      expect(await liveRole(result!.membership_id)).toBe('auditor');
    });

    it("invite does NOT overwrite an existing identity's password hash", async () => {
      // Otherwise "invite" would be a password reset for any email in the system,
      // executable by any tenant admin against a person in a tenant they have
      // nothing to do with.
      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        invite(tx, 'outsider@acme.test', 'auditor', sentinel),
      );

      const [row] = await migrator.$queryRawUnsafe<{ password_hash: string }[]>(
        `SELECT password_hash FROM public.users WHERE id = $1::uuid`,
        outsider,
      );
      expect(row!.password_hash).toBe('seeded-not-a-real-hash');
    });

    it('invite creates identity + membership together for an unknown email', async () => {
      const [result] = await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        invite(tx, 'newcomer@acme.test', 'technician', sentinel),
      );

      expect(result!.user_created).toBe(true);
      expect(await liveRole(result!.membership_id)).toBe('technician');

      const [row] = await migrator.$queryRawUnsafe<{ password_hash: string }[]>(
        `SELECT password_hash FROM public.users WHERE id = $1::uuid`,
        result!.user_id,
      );

      // The sentinel is a REAL argon2id hash at the PRODUCTION cost parameters,
      // parsed out of the stored value and compared against ARGON2_OPTIONS — the
      // same assertion shape as the step-4 timing-equalisation guard, and for the
      // same reason: a literal, or a differently-tuned hash, drifts silently.
      const params = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(row!.password_hash);
      expect(params, 'the stored sentinel is not a well-formed argon2id hash').not.toBeNull();
      expect(Number(params![1])).toBe(ARGON2_OPTIONS.memoryCost);
      expect(Number(params![2])).toBe(ARGON2_OPTIONS.timeCost);
      expect(Number(params![3])).toBe(ARGON2_OPTIONS.parallelism);

      // And it authenticates against nothing. The account exists and is
      // deliberately unusable until a set-password flow lands (recorded forward
      // marker in DECISIONS.md).
      expect(await argonVerify(row!.password_hash, 'password')).toBe(false);
      expect(await argonVerify(row!.password_hash, '')).toBe(false);
    });

    it('inviting someone who is already a live member is refused by the index', async () => {
      // No pre-check in the function: the partial unique index is the actual
      // guarantee and a SELECT-then-INSERT would be a race.
      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
          invite(tx, 'tech-a@acme.test', 'auditor', sentinel),
        ),
      ).rejects.toThrow(/23505/);
    });

    it('a revoked person can be re-invited to the same tenant', async () => {
      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        revoke(tx, mTechA),
      );

      const [result] = await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        invite(tx, 'tech-a@acme.test', 'auditor', sentinel),
      );

      expect(result!.user_created, 're-invite created a duplicate identity').toBe(false);
      expect(result!.user_id).toBe(techA);
      expect(await liveRole(result!.membership_id)).toBe('auditor');
    });

    it('change_member_role changes the role and nothing else', async () => {
      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        changeRole(tx, mTechA, 'auditor'),
      );

      const [row] = await migrator.$queryRawUnsafe<
        { role: string; user_id: string; tenant_id: string; deleted_at: Date | null }[]
      >(
        `SELECT role::text AS role, user_id::text, tenant_id::text, deleted_at
           FROM public.memberships WHERE id = $1::uuid`,
        mTechA,
      );
      expect(row!.role).toBe('auditor');
      expect(row!.user_id).toBe(techA);
      expect(row!.tenant_id).toBe(tenantA);
      expect(row!.deleted_at).toBeNull();
    });

    it('revoke_member SOFT-deletes — the row survives, which is what re-invite needs', async () => {
      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        revoke(tx, mTechA),
      );

      const [row] = await migrator.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
        `SELECT deleted_at FROM public.memberships WHERE id = $1::uuid`,
        mTechA,
      );
      expect(row, 'the membership row was hard-deleted').toBeDefined();
      expect(row!.deleted_at).not.toBeNull();
    });

    it('revoking an already-revoked membership is refused', async () => {
      await withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) =>
        revoke(tx, mTechA),
      );

      await expect(
        withExactContext(app, { userId: adminA, tenantId: tenantA }, (tx) => revoke(tx, mTechA)),
      ).rejects.toThrow(/MB002/);
    });
  });

  // -------------------------------------------------------------------------
  // The app role still cannot write the table directly. DECISION B's actual
  // guarantee, re-asserted here because these functions are the reason the
  // definer now holds UPDATE — and the grant is what keeps the broad definer
  // policy safe.
  // -------------------------------------------------------------------------
  describe('DECISION B still holds after the grant widened', () => {
    it('the app role cannot UPDATE memberships directly, function or no function', async () => {
      await expect(
        withExactContext(app, { userId: techA, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE public.memberships SET role = 'admin' WHERE id = '${mTechA}'::uuid`,
          ),
        ),
      ).rejects.toThrow(/permission denied/i);

      expect(await liveRole(mTechA)).toBe('technician');
    });

    it('the app role cannot INSERT a membership directly', async () => {
      await expect(
        withExactContext(app, { userId: techA, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.memberships (user_id, tenant_id, role)
             VALUES ('${techA}'::uuid, '${tenantA}'::uuid, 'admin')`,
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
