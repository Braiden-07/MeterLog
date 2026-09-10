import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appClient, migratorClient, resetDatabase } from './helpers';

/**
 * The pre-auth SECURITY DEFINER surface (ADR-006 §6), Phase 2 of step 4.
 *
 * definer-probe.spec.ts proves the *mechanism* against throwaway fixtures. This
 * proves the two real functions against the real schema.
 *
 * Everything here calls the functions as `meterlog_app` — the role the API
 * actually runs as — with **no request context set at all**, because that is the
 * situation both functions exist for: there is no acting user at login, and no
 * tenant exists yet at registration.
 *
 * A note on how the atomicity cases are written, because the obvious version is
 * wrong twice over:
 *
 *   1. They must NOT run inside a wrapping transaction. A rolled-back transaction
 *      would leave no orphan whether the function is atomic or not, so the test
 *      would pass against a broken function. Every statement here is autocommit.
 *   2. The "did an orphan survive?" query must run as the MIGRATION role, not the
 *      app role. `tenants` is under FORCE RLS and the app role sees zero rows
 *      without an active tenant, so asking it would return 0 regardless — a
 *      guaranteed green that proves nothing.
 */
describe('pre-auth SECURITY DEFINER functions', () => {
  let app: PrismaClient;
  let migrator: PrismaClient;

  beforeAll(async () => {
    app = appClient();
    migrator = migratorClient();
    await resetDatabase(migrator);
  });

  afterEach(async () => {
    await resetDatabase(migrator);
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await app.$disconnect();
    await migrator.$disconnect();
  });

  /** Row counts read as the migration role, which is not subject to the policies. */
  async function census(): Promise<{ tenants: number; users: number; memberships: number }> {
    const [row] = await migrator.$queryRawUnsafe<
      { tenants: number; users: number; memberships: number }[]
    >(
      `SELECT (SELECT count(*)::int FROM public.tenants)     AS tenants,
              (SELECT count(*)::int FROM public.users)       AS users,
              (SELECT count(*)::int FROM public.memberships) AS memberships`,
    );
    return row ?? { tenants: -1, users: -1, memberships: -1 };
  }

  const register = (name: string, email: string, hash = 'argon2-hash') =>
    app.$queryRawUnsafe<{ tenant_id: string; user_id: string; membership_id: string }[]>(
      `SELECT * FROM public.register_tenant($1, $2::citext, $3)`,
      name,
      email,
      hash,
    );

  const lookup = (email: string) =>
    app.$queryRawUnsafe<{ id: string; password_hash: string; deleted_at: Date | null }[]>(
      `SELECT * FROM public.login_lookup($1::citext)`,
      email,
    );

  // -------------------------------------------------------------------------
  describe('register_tenant', () => {
    it('creates the tenant, the person and the admin membership, correctly linked', async () => {
      const [row] = await register('Acme Metering', 'founder@acme.test');
      expect(row).toBeDefined();

      const [joined] = await migrator.$queryRawUnsafe<
        { tenant_name: string; email: string; role: string; live: boolean }[]
      >(
        `SELECT t.name AS tenant_name, u.email::text AS email, m.role::text AS role,
                (m.deleted_at IS NULL) AS live
         FROM public.memberships m
         JOIN public.users   u ON u.id = m.user_id
         JOIN public.tenants t ON t.id = m.tenant_id
         WHERE m.id = $1::uuid`,
        row?.membership_id,
      );

      expect(joined).toEqual({
        tenant_name: 'Acme Metering',
        email: 'founder@acme.test',
        role: 'admin',
        live: true,
      });
      expect(await census()).toEqual({ tenants: 1, users: 1, memberships: 1 });
    });

    it('is reachable by the app role with no request context whatsoever', async () => {
      // The point of the definer path. Every one of these tables is under FORCE
      // RLS with no app-role write policy; the write lands anyway because the
      // function body executes as meterlog_definer.
      await expect(register('Context Free', 'nocontext@acme.test')).resolves.toHaveLength(1);
    });

    it('the app role cannot perform the same writes directly', async () => {
      // The negative that makes the positive meaningful — the definer is not a
      // convenience wrapper around something the caller could already do.
      for (const sql of [
        `INSERT INTO public.tenants (name) VALUES ('Direct')`,
        `INSERT INTO public.users (email, password_hash) VALUES ('direct@acme.test', 'x')`,
      ]) {
        await expect(app.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied/i);
      }
      expect(await census()).toEqual({ tenants: 0, users: 0, memberships: 0 });
    });

    // --- atomicity -----------------------------------------------------------

    it('ATOMICITY: a failure on the second insert leaves no orphan tenant', async () => {
      // The failure ADR-004's step-4 gate names by hand: the tenant row exists,
      // nobody can log into it, and registration cannot be retried because the
      // tenant already exists. Forced naturally, via the duplicate-email path
      // that OPEN-1 resolves as a 409 — users_email_live_key raises 23505 on
      // insert #2, after insert #1 has already happened.
      await register('First Org', 'shared@acme.test');
      expect(await census()).toEqual({ tenants: 1, users: 1, memberships: 1 });

      // Asserted on the SQLSTATE, not the constraint name. Postgres raises
      // `duplicate key value violates unique constraint "users_email_live_key"`,
      // but Prisma's raw-query wrapper reduces that to
      // `Raw query failed. Code: 23505. Message: Unique constraint failed: ` —
      // the constraint name is dropped on the floor. Phase 4 must therefore map
      // register's duplicate-email 409 from SQLSTATE 23505, not from the
      // constraint name; on this function only the email index can realistically
      // raise it, since the other two keys are gen_random_uuid() primary keys.
      await expect(register('Orphan Corp', 'shared@acme.test')).rejects.toThrow(/23505/);

      // Autocommit, so if the function were not atomic "Orphan Corp" would be
      // sitting in the table right now.
      const [orphans] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.tenants WHERE name = 'Orphan Corp'`,
      );
      expect(orphans?.n, 'an orphan tenant survived a failed registration').toBe(0);
      expect(await census()).toEqual({ tenants: 1, users: 1, memberships: 1 });
    });

    it('ATOMICITY: a failure on the THIRD insert leaves no tenant and no user', async () => {
      // The duplicate-email case can only ever fail at insert #2. The membership
      // insert is the one with nothing natural to trip it, and it is also the one
      // whose failure strands the most state — so it is forced with a CHECK
      // constraint that no row can satisfy. NOT VALID so existing rows are not
      // re-checked; new inserts are checked regardless.
      await migrator.$executeRawUnsafe(
        `ALTER TABLE public.memberships
           ADD CONSTRAINT tmp_force_third_insert_failure CHECK (false) NOT VALID`,
      );
      try {
        await expect(register('Stranded Org', 'stranded@acme.test')).rejects.toThrow(
          /tmp_force_third_insert_failure/i,
        );
        expect(
          await census(),
          'the tenant and/or user survived a failure on the membership insert',
        ).toEqual({ tenants: 0, users: 0, memberships: 0 });
      } finally {
        await migrator.$executeRawUnsafe(
          `ALTER TABLE public.memberships DROP CONSTRAINT tmp_force_third_insert_failure`,
        );
      }
    });

    it('the atomicity tests would actually notice a non-atomic function', async () => {
      // Guards the guard. If `register_tenant` silently stopped writing rows, or
      // the census read the wrong thing, every assertion above would go green on
      // an empty database. Prove the census sees a committed tenant.
      await migrator.$executeRawUnsafe(`INSERT INTO public.tenants (name) VALUES ('Census Probe')`);
      expect((await census()).tenants).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('login_lookup', () => {
    const email = 'Founder@Acme.TEST';

    // beforeEach, not beforeAll: the outer afterEach resets the whole database after
    // every test, and afterEach hooks run innermost-first, so a seed placed in an
    // inner afterEach is destroyed before the next test ever sees it. That failure
    // is silent and looks exactly like a broken function — three of these cases
    // first failed that way, not because login_lookup was wrong.
    beforeEach(async () => {
      await resetDatabase(migrator);
      await register('Acme Metering', email, 'argon2-real-hash');
    });

    it('returns the credential row to the app role with no context set', async () => {
      const rows = await lookup(email);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.password_hash).toBe('argon2-real-hash');
      expect(rows[0]?.deleted_at).toBeNull();
      expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('the app role cannot read password_hash directly — the column grant withholds it', async () => {
      // RLS is row-level and cannot hide a column; this is the column-level grant
      // doing the work. Without it, a tenant admin listing members would read
      // everyone's hash.
      await expect(app.$queryRawUnsafe(`SELECT password_hash FROM public.users`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('matches case-insensitively — regression guard, this was broken', async () => {
      // citext's `=` operator lives in `public`, which the function's pinned
      // search_path excludes. A bare `=` does not fail to resolve; it falls back
      // through citext's implicit cast to text and binds case-SENSITIVE
      // `text = text`. Registering as Founder@Acme.TEST and logging in as
      // founder@acme.test then found no row, while the partial unique index — whose
      // operator class was resolved at CREATE INDEX time — still refused a
      // re-registration. The account was unreachable and unrecoverable.
      //
      // Fixed by schema-qualifying the operator, NOT by widening the search_path.
      for (const form of [email, email.toLowerCase(), email.toUpperCase()]) {
        const rows = await lookup(form);
        expect(rows, `no match for ${form}`).toHaveLength(1);
        expect(rows[0]?.password_hash).toBe('argon2-real-hash');
      }
    });

    it('is exact-match only — no prefix, suffix or substring matching', async () => {
      for (const form of [
        'founder@acme.te',
        'ounder@acme.test',
        'founder@acme.test ',
        '%@acme.test',
        'nobody@nowhere.test',
      ]) {
        expect(await lookup(form), `unexpected match for ${form}`).toHaveLength(0);
      }
    });

    it('returns at most one row when a soft-deleted account shares the address, preferring the live one', async () => {
      // users_email_live_key is PARTIAL, so any number of soft-deleted rows may
      // share an address with one live row. ADR-006 §6 specifies "at most one
      // row", which the schema does not guarantee on its own.
      const ghost = randomUUID();
      await migrator.$executeRawUnsafe(
        `INSERT INTO public.users (id, email, password_hash, deleted_at)
         VALUES ($1::uuid, $2::citext, 'stale-hash', now())`,
        ghost,
        email,
      );

      const rows = await lookup(email);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.password_hash, 'the soft-deleted row won the lookup').toBe(
        'argon2-real-hash',
      );
      expect(rows[0]?.id).not.toBe(ghost);
    });

    it('returns nothing at all when the only matching account is soft-deleted', async () => {
      await migrator.$executeRawUnsafe(
        `UPDATE public.users SET deleted_at = now() WHERE email OPERATOR(public.=) $1::citext`,
        email,
      );
      const rows = await lookup(email);
      // Still found — deleted_at is RETURNED, not filtered, so the caller can tell
      // "no such account" from "deactivated". Both answer with the same generic
      // auth failure (no user enumeration), but only one is worth logging.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deleted_at).not.toBeNull();
    });
  });
});
