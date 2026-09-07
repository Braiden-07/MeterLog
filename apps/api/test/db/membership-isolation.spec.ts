import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appClient, execAll, migratorClient, withContext } from './helpers';

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
 * write `users` or `tenants` — those are created by `register_tenant` in Phase 2.
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
  const userM = randomUUID();
  const userN = randomUUID();
  const userP = randomUUID();

  beforeAll(async () => {
    app = appClient();
    migrator = migratorClient();

    await execAll(migrator, [
      `DELETE FROM public.memberships`,
      `DELETE FROM public.users`,
      `DELETE FROM public.tenants`,
      `INSERT INTO public.tenants (id, name) VALUES
         ('${tenantA}', 'Tenant A'), ('${tenantB}', 'Tenant B'), ('${tenantC}', 'Tenant C')`,
      `INSERT INTO public.users (id, email, password_hash) VALUES
         ('${userM}', 'm@example.test', 'x'),
         ('${userN}', 'n@example.test', 'x'),
         ('${userP}', 'p@example.test', 'x')`,
      `INSERT INTO public.memberships (user_id, tenant_id, role) VALUES
         ('${userM}', '${tenantA}', 'admin'),
         ('${userM}', '${tenantB}', 'technician'),
         ('${userN}', '${tenantB}', 'admin'),
         ('${userP}', '${tenantA}', 'auditor')`,
    ]);
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

  describe('memberships — tenant axis', () => {
    it('M acting in A sees every membership in A', async () => {
      const rows = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$queryRawUnsafe<{ user_id: string }[]>(
          `SELECT user_id FROM public.memberships WHERE tenant_id = $1::uuid ORDER BY 1`,
          tenantA,
        ),
      );
      expect(rows.map((r) => r.user_id).sort()).toEqual([userM, userP].sort());
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
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
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
      expect(rows).toHaveLength(3); // M@A, P@A, M@B
    });
  });

  describe('memberships — escalation is impossible', () => {
    it('a member cannot grant themselves a membership in a tenant they do not belong to', async () => {
      // The ADR-006 §0.1 bug, asserted against the real migration rather than a
      // scratch table. If the self axis is ever changed to FOR ALL, this fails.
      await expect(
        withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.memberships (user_id, tenant_id, role)
             VALUES ($1::uuid, $2::uuid, 'admin')`,
            userM,
            tenantC,
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('a member cannot grant an unrelated user access to their tenant... in another tenant', async () => {
      await expect(
        withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.memberships (user_id, tenant_id, role)
             VALUES ($1::uuid, $2::uuid, 'admin')`,
            userP,
            tenantB,
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('cross-tenant UPDATE and DELETE affect zero rows', async () => {
      const updated = await withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE public.memberships SET role = 'admin' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
          tenantB,
          userN,
        ),
      );
      expect(updated).toBe(0);

      // No DELETE grant at all — revocation is a soft delete. Proven by the
      // privilege layer rather than the policy layer, which is the intent.
      await expect(
        withContext(app, { userId: userM, tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM public.memberships WHERE tenant_id = $1::uuid`,
            tenantB,
          ),
        ),
      ).rejects.toThrow(/permission denied/i);
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
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.user_id === userM)).toBe(true);
    });
  });
});
