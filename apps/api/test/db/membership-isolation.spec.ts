import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appClient, execAll, migratorClient, resetDatabase, withContext } from './helpers';

/**
 * The membership-model isolation proof (ADR-006 §8.2).
 *
 * This is the bespoke dual-axis test the generic matrix cannot provide. The
 * headline property, and the reason ADR-006 exists:
 *
 *   a user who is a member of BOTH tenant A and tenant B, acting in A, sees A's
 *   membership structure and their own B-membership, and cannot see anything
 *   else in B — while being unable to grant themselves access to any tenant.
 *
 * That is strictly stronger than "different users cannot cross tenants", which is
 * all the brief's original one-tenant-per-user model could ever demonstrate.
 *
 * Seeding runs as the migration role because the app role deliberately cannot
 * write ANY of these tables. `users` and `tenants` never were app-writable;
 * `memberships` stopped being so under DECISION B (ADR-006 §3 amendment), which
 * moved invite/revoke/change-role to admin-checking SECURITY DEFINER functions in
 * step 5 rather than leaving intra-tenant role authorization to an RBAC guard.
 */
describe('membership model — dual-axis isolation', () => {
  let app: PrismaClient;
  let migrator: PrismaClient;

  // M is the multi-tenant person: member of A (admin) and B (technician).
  // N belongs only to B. P belongs only to A.
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  // A tenant NOBODY is a member of. The escalation test must target this one:
  // aiming at B would be blocked by the partial unique index on (user_id,
  // tenant_id) rather than by RLS, so the test would pass for the wrong reason.
  // Verified — with the self axis mutated to FOR ALL, an insert into B raises
  // `duplicate key` while an insert into C succeeds and escalates.
  const tenantC = randomUUID();
  // Tenant D exists only to carry M's REVOKED membership, so the liveness
  // predicate in tenants_workspace_list has something to filter. Kept separate
  // from C so C stays pristinely "nobody is a member" for the escalation cases.
  const tenantD = randomUUID();
  const userM = randomUUID();
  const userN = randomUUID();
  const userP = randomUUID();
  // R was a member of A and was revoked. Gives users_tenant_members_read's
  // liveness predicate something to filter.
  const userR = randomUUID();

  beforeAll(async () => {
    app = appClient();
    migrator = migratorClient();

    // Reset first (shared catalog-derived TRUNCATE ... CASCADE), then seed.
    await resetDatabase(migrator);
    await execAll(migrator, [
      `INSERT INTO public.tenants (id, name) VALUES
         ('${tenantA}', 'Tenant A'), ('${tenantB}', 'Tenant B'),
         ('${tenantC}', 'Tenant C'), ('${tenantD}', 'Tenant D')`,
      `INSERT INTO public.users (id, email, password_hash) VALUES
         ('${userM}', 'm@example.test', 'x'),
         ('${userN}', 'n@example.test', 'x'),
         ('${userP}', 'p@example.test', 'x'),
         ('${userR}', 'r@example.test', 'x')`,
      `INSERT INTO public.memberships (user_id, tenant_id, role) VALUES
         ('${userM}', '${tenantA}', 'admin'),
         ('${userM}', '${tenantB}', 'technician'),
         ('${userN}', '${tenantB}', 'admin'),
         ('${userP}', '${tenantA}', 'auditor')`,
      // The two REVOKED memberships. Soft delete, per ADR-006 §2 — revocation is
      // never a hard delete. Without these the liveness predicates in
      // tenants_workspace_list and users_tenant_members_read filter nothing, and
      // deleting them from the policies is a green mutation (proven: sweep 09/10).
      `INSERT INTO public.memberships (user_id, tenant_id, role, deleted_at) VALUES
         ('${userM}', '${tenantD}', 'admin',   now()),
         ('${userR}', '${tenantA}', 'auditor', now())`,
    ]);
  });

  afterAll(async () => {
    // Shared catalog-derived teardown (TRUNCATE ... CASCADE); see helpers.ts.
    await resetDatabase(migrator);
    await app.$disconnect();
    await migrator.$disconnect();
  });

  describe('memberships — tenant axis', () => {
    it('M acting in A sees every membership in A', async () => {
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ user_id: string }[]>(
          `SELECT user_id FROM public.memberships WHERE tenant_id = $1::uuid ORDER BY 1`,
          tenantA,
        ),
      );
      // R is included: memberships' own policies carry NO liveness predicate, so a
      // revoked row is still returned here. That is the OPEN-5 residual, asserted
      // deliberately rather than left to be discovered — see the liveness block below.
      expect(rows.map((r) => r.user_id).sort()).toEqual([userM, userP, userR].sort());
    });

    it("M acting in A cannot see another user's membership in B", async () => {
      // The standard isolation claim. N is unrelated to M.
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM public.memberships
           WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
          tenantB,
          userN,
        ),
      );
      expect(rows[0]?.n).toBe(0);
    });
  });

  describe('memberships — self axis', () => {
    it('M acting in A CAN see their own B-membership (correct, not a leak)', async () => {
      // This is what makes the generic matrix unusable for this table: under A's
      // context a B row is legitimately visible, because it is M's own.
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ tenant_id: string; role: string }[]>(
          `SELECT tenant_id, role::text AS role FROM public.memberships
           WHERE user_id = $1::uuid ORDER BY tenant_id`,
          userM,
        ),
      );
      // Three, not two: M's revoked D-membership comes back as well (OPEN-5
      // residual — the self axis has no liveness predicate and cannot have one).
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB, tenantD].sort());
      // Role is per-tenant, not per-person.
      expect(rows.find((r) => r.tenant_id === tenantA)?.role).toBe('admin');
      expect(rows.find((r) => r.tenant_id === tenantB)?.role).toBe('technician');
    });

    it('the self axis is scoped to self, not to "any membership"', async () => {
      // The whole visible set under A's context: A's rows plus M's own B row.
      // Nothing belonging to anyone else in B.
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ user_id: string; tenant_id: string }[]>(
          `SELECT user_id, tenant_id FROM public.memberships`,
        ),
      );
      const foreign = rows.filter((r) => r.tenant_id === tenantB && r.user_id !== userM);
      expect(foreign, `foreign-tenant rows leaked: ${JSON.stringify(foreign)}`).toEqual([]);
      // M@A, P@A, R@A (revoked, tenant axis) + M@B, M@D (revoked, self axis).
      expect(rows).toHaveLength(5);
    });
  });

  describe('memberships — the app role cannot write, at all (DECISION B)', () => {
    // ADR-006 §3 amendment. The tenant axis used to be FOR ALL, which made it the
    // app role's write path with the admin check left to an RBAC guard that does
    // not exist yet. Live proof showed a technician in A self-promoting to admin
    // in one statement. B removes the write path entirely: no app-role write
    // policy, and no write grant. The first two cases below previously SUCCEEDED.
    it('cannot INSERT a membership for its OWN active tenant (the intra-tenant escalation)', async () => {
      await expect(
        withContext(app, { userId: userP, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.memberships (user_id, tenant_id, role)
             VALUES ($1::uuid, $2::uuid, 'admin')`,
            userN,
            tenantA,
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('cannot self-promote inside its own active tenant', async () => {
      // P is an auditor in A. Before B this reported `UPDATE 1` and P became an
      // admin of A. Assert the role is unchanged afterwards, not merely that the
      // statement was refused.
      await expect(
        withContext(app, { userId: userP, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE public.memberships SET role = 'admin' WHERE user_id = $1::uuid`,
            userP,
          ),
        ),
      ).rejects.toThrow(/permission denied/i);

      const [row] = await withContext(app, { userId: userP, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ role: string }[]>(
          `SELECT role::text AS role FROM public.memberships
           WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
          userP,
          tenantA,
        ),
      );
      expect(row?.role).toBe('auditor');
    });

    it('cannot INSERT a membership for a tenant it does not belong to', async () => {
      // Regression check on the boundary that already held before B. Targets C,
      // which nobody is a member of: aiming at B would be blocked by the partial
      // unique index rather than by authorization — passing for the wrong reason.
      await expect(
        withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.memberships (user_id, tenant_id, role)
             VALUES ($1::uuid, $2::uuid, 'admin')`,
            userM,
            tenantC,
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('cannot UPDATE or DELETE across tenants', async () => {
      for (const sql of [
        `UPDATE public.memberships SET role = 'admin' WHERE tenant_id = $1::uuid`,
        `DELETE FROM public.memberships WHERE tenant_id = $1::uuid`,
      ]) {
        await expect(
          withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
            tx.$executeRawUnsafe(sql, tenantB),
          ),
        ).rejects.toThrow(/permission denied/i);
      }
    });
  });

  describe('memberships — the POLICY layer denies writes too, not just the grant', () => {
    /**
     * The block above is satisfied by the missing GRANT alone, so on its own it
     * would stay green even if a write policy were reintroduced. B's other half
     * is that no app-role policy is applicable to a write at all. This isolates
     * it: restore the write grants inside a transaction that is always rolled
     * back, leaving RLS as the only thing that can deny the statement.
     *
     * The commands then fail DIFFERENTLY, and that is the trap. A denied INSERT
     * raises. A denied UPDATE or DELETE does NOT — with no applicable policy no
     * row is visible to modify, so Postgres reports zero rows affected and no
     * error. `.rejects` on the UPDATE would fail against a correctly behaving
     * database, so those cases assert zero-rows-and-unchanged instead.
     */
    async function asAppWithWriteGrantsRestored<T>(
      ctx: { userId?: string; tenantId?: string },
      body: (tx: PrismaClient) => Promise<T>,
    ): Promise<T> {
      const ROLLBACK = '__intentional_rollback__';
      let result!: T;
      try {
        await migrator.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `GRANT INSERT, UPDATE, DELETE ON public.memberships TO meterlog_app`,
          );
          await tx.$executeRawUnsafe(`SET LOCAL ROLE meterlog_app`);
          if (ctx.userId) {
            await tx.$executeRawUnsafe(
              `SELECT set_config('app.current_user', $1, true)`,
              ctx.userId,
            );
          }
          if (ctx.tenantId) {
            await tx.$executeRawUnsafe(
              `SELECT set_config('app.current_tenant', $1, true)`,
              ctx.tenantId,
            );
          }
          result = await body(tx as unknown as PrismaClient);
          // GRANT is transactional in Postgres, so this undoes it too.
          throw new Error(ROLLBACK);
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes(ROLLBACK)) throw error;
      }
      return result;
    }

    it('the probe really does restore the grant (otherwise it proves nothing)', async () => {
      const [row] = await asAppWithWriteGrantsRestored({}, (tx) =>
        tx.$queryRawUnsafe<{ current_user: string; can_insert: boolean }[]>(
          `SELECT current_user::text AS current_user,
                  has_table_privilege('public.memberships', 'INSERT') AS can_insert`,
        ),
      );
      expect(row?.current_user).toBe('meterlog_app');
      expect(row?.can_insert).toBe(true);
    });

    it('INSERT is then rejected by row-level security, not by the missing grant', async () => {
      await expect(
        asAppWithWriteGrantsRestored({ userId: userP, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.memberships (user_id, tenant_id, role)
             VALUES ($1::uuid, $2::uuid, 'admin')`,
            userN,
            tenantA,
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('the self-promotion UPDATE silently affects zero rows and changes nothing', async () => {
      const outcome = await asAppWithWriteGrantsRestored(
        { userId: userP, tenantId: tenantA },
        async (tx) => {
          const affected = await tx.$executeRawUnsafe(
            `UPDATE public.memberships SET role = 'admin' WHERE user_id = $1::uuid`,
            userP,
          );
          const [row] = await tx.$queryRawUnsafe<{ role: string }[]>(
            `SELECT role::text AS role FROM public.memberships
             WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
            userP,
            tenantA,
          );
          return { affected, role: row?.role };
        },
      );
      // No error raised — the shape that would make a `.rejects` assertion lie.
      expect(outcome.affected).toBe(0);
      expect(outcome.role).toBe('auditor');
    });

    it('DELETE likewise affects zero rows and leaves the tenant intact', async () => {
      const outcome = await asAppWithWriteGrantsRestored(
        { userId: userP, tenantId: tenantA },
        async (tx) => {
          const affected = await tx.$executeRawUnsafe(
            `DELETE FROM public.memberships WHERE tenant_id = $1::uuid`,
            tenantA,
          );
          const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM public.memberships WHERE tenant_id = $1::uuid`,
            tenantA,
          );
          return { affected, remaining: row?.n };
        },
      );
      expect(outcome.affected).toBe(0);
      expect(outcome.remaining).toBe(3); // M@A, P@A, R@A (revoked)
    });
  });

  describe('users — identity policies', () => {
    it('M reads their own identity row', async () => {
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ email: string }[]>(
          `SELECT email FROM public.users WHERE id = $1::uuid`,
          userM,
        ),
      );
      expect(rows[0]?.email).toBe('m@example.test');
    });

    it('M acting in A reads the identities of A members, and not of B-only members', async () => {
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ email: string }[]>(`SELECT email FROM public.users ORDER BY 1`),
      );
      // M (self + A member) and P (A member). N is B-only and must not appear.
      expect(rows.map((r) => r.email)).toEqual(['m@example.test', 'p@example.test']);
    });

    it('password_hash is unreadable by the app role, even for rows it can see', async () => {
      // RLS is row-level and cannot hide a column; the column-level grant does.
      await expect(
        withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
          tx.$queryRawUnsafe(`SELECT password_hash FROM public.users WHERE id = $1::uuid`, userM),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('tenants — workspace list', () => {
    it('M active in A reads the names of BOTH their workspaces', async () => {
      // Without the workspace-list policy this returns only Tenant A, and
      // /auth/me cannot name the switcher's entries (ADR-006 §0.4).
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM public.tenants ORDER BY 1`),
      );
      expect(rows.map((r) => r.name)).toEqual(['Tenant A', 'Tenant B']);
    });

    it('a single-tenant user sees only their own workspace', async () => {
      // N belongs to B alone. Tenant A must not appear, in either policy.
      const rows = await withContext(app, { userId: userN, tenantId: tenantB }, (tx) =>
        tx.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM public.tenants ORDER BY 1`),
      );
      expect(rows.map((r) => r.name)).toEqual(['Tenant B']);
    });
  });

  describe('fail-closed on unset context', () => {
    it('no context at all yields zero rows from every table, not an error', async () => {
      const counts = await withContext(app, {}, (tx) =>
        tx.$queryRawUnsafe<{ memberships: number; users: number; tenants: number }[]>(
          `SELECT (SELECT count(*)::int FROM public.memberships) AS memberships,
                  (SELECT count(*)::int FROM public.users)       AS users,
                  (SELECT count(*)::int FROM public.tenants)     AS tenants`,
        ),
      );
      expect(counts[0]).toEqual({ memberships: 0, users: 0, tenants: 0 });
    });

    it('a user context with no active tenant sees self only, never a foreign tenant', async () => {
      // The post-login, pre-switch state for a multi-membership user.
      const rows = await withContext(app, { userId: userM }, (tx) =>
        tx.$queryRawUnsafe<{ user_id: string }[]>(`SELECT user_id FROM public.memberships`),
      );
      // A, B, and the revoked D — all M's own, none of anyone else's.
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.user_id === userM)).toBe(true);
    });
  });

  describe('liveness — revoked memberships disappear from the read paths', () => {
    /**
     * The DB-side half of OPEN-5's resolution, which ADR-006 §3, §11 and
     * DECISIONS.md all rest on: liveness cannot live in the `memberships` row
     * policies (the predicate would block the revoking UPDATE itself), so it lives
     * in the two paths that ONLY read — the tenants_workspace_list subquery and
     * users_tenant_members_read. Until these cases existed, no fixture had a
     * soft-deleted membership, and deleting either predicate was a green mutation.
     *
     * M holds a revoked membership in tenant D; R holds a revoked membership in A.
     */
    it('a revoked workspace disappears from the workspace list', async () => {
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM public.tenants ORDER BY 1`),
      );
      // Tenant D must NOT appear. Drop `AND m.deleted_at IS NULL` from
      // tenants_workspace_list and it does.
      expect(rows.map((r) => r.name)).toEqual(['Tenant A', 'Tenant B']);
    });

    it("a revoked member's identity disappears from the active tenant's member list", async () => {
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ email: string }[]>(`SELECT email FROM public.users ORDER BY 1`),
      );
      // r@example.test must NOT appear. Drop `AND m.deleted_at IS NULL` from
      // users_tenant_members_read and it does.
      expect(rows.map((r) => r.email)).toEqual(['m@example.test', 'p@example.test']);
    });

    it('the revoked rows really are still there, so the two assertions above are filtering', async () => {
      // Guards against the assertions passing because the fixture never landed.
      const rows = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.memberships WHERE deleted_at IS NOT NULL`,
      );
      expect(rows[0]?.n).toBe(2);
    });

    it('the OPEN-5 residual is real: a self-axis read still returns the revoked row', async () => {
      // Deliberate, documented, and asserted so nobody "fixes" it — the predicate
      // cannot go in this policy. `/auth/me` and every future self-axis reader must
      // filter `deleted_at IS NULL` app-side; that is the one app-side predicate in
      // the design (ADR-006 §3, OPEN-5).
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ tenant_id: string; deleted_at: Date | null }[]>(
          `SELECT tenant_id, deleted_at FROM public.memberships WHERE user_id = $1::uuid`,
          userM,
        ),
      );
      const revoked = rows.filter((r) => r.deleted_at !== null);
      expect(revoked).toHaveLength(1);
      expect(revoked[0]?.tenant_id).toBe(tenantD);
    });
  });
});
