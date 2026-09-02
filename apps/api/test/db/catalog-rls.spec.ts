import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFINER_ACCESSIBLE_TABLES,
  EXPECTED_DEFINER_FUNCTIONS,
  RLS_EXEMPT_TABLES,
  appClient,
} from './helpers';

/**
 * Catalog-level RLS coverage (ADR-004).
 *
 * The two-tenant test proves isolation works on tables it knows about. It cannot
 * catch a NEW table shipped without ENABLE ROW LEVEL SECURITY, and the failure
 * modes are asymmetric: RLS enabled with no policy denies every row (safe, loud),
 * while RLS never enabled leaves an ordinary readable table (unsafe, silent).
 *
 * These assertions read the catalog instead, inverting the default — a new table
 * must be justified as exempt rather than remembered as protected.
 *
 * Runs as `meterlog_app`, the same role the API uses at runtime. That matters for
 * assertion 7: connecting as anything else would let every other check pass while
 * isolation was gone.
 *
 * At scaffold there are no domain tables, so 1-6 pass near-vacuously. That is the
 * point — this is in CI BEFORE the first tenant-scoped table exists, so step 4
 * cannot introduce one unprotected.
 */
describe('RLS catalog coverage', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = appClient();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('1. every table in public has RLS enabled and forced', async () => {
    const rows = await db.$queryRawUnsafe<
      { table_name: string; enabled: boolean; forced: boolean }[]
    >(`
      SELECT c.relname AS table_name,
             c.relrowsecurity   AS enabled,
             c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY 1
    `);

    // Column-agnostic on purpose: `tenants` is tenant-scoped but its key is `id`,
    // not `tenant_id`, so a check keyed on that column would skip it entirely.
    const unprotected = rows
      .filter((r) => !RLS_EXEMPT_TABLES.includes(r.table_name))
      .filter((r) => !r.enabled || !r.forced);

    expect(
      unprotected,
      `tables missing ENABLE/FORCE ROW LEVEL SECURITY: ${unprotected
        .map((r) => `${r.table_name} (enabled=${r.enabled}, forced=${r.forced})`)
        .join(', ')}`,
    ).toEqual([]);
  });

  it('2. no table carrying tenant_id lacks enabled-and-forced RLS', async () => {
    // Redundant with (1) by construction. Kept because it names the actual
    // convention, so the failure message points straight at the rule that broke.
    const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND a.attname = 'tenant_id'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      ORDER BY 1
    `);

    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('3. every RLS-enabled table has at least one policy', async () => {
    // A table with RLS on and no policy denies everything. That is safe, but it
    // is a bug, and at runtime it presents as queries mysteriously returning
    // nothing. Failing here turns it into a build error instead.
    const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
      ORDER BY 1
    `);

    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('4. SECURITY DEFINER functions match the allowlist, are owned by meterlog_definer, and pin search_path', async () => {
    const rows = await db.$queryRawUnsafe<
      { function_name: string; owner: string; proconfig: string[] | null }[]
    >(`
      SELECT p.proname AS function_name,
             r.rolname AS owner,
             p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = 'public' AND p.prosecdef
      ORDER BY 1
    `);

    expect(rows.map((r) => r.function_name).sort()).toEqual([...EXPECTED_DEFINER_FUNCTIONS].sort());

    for (const fn of rows) {
      expect(fn.owner, `${fn.function_name} must be owned by meterlog_definer`).toBe(
        'meterlog_definer',
      );
      // Without a pinned search_path a SECURITY DEFINER function is itself a
      // privilege-escalation vector.
      expect(
        (fn.proconfig ?? []).some((c) => c.startsWith('search_path=')),
        `${fn.function_name} must pin search_path`,
      ).toBe(true);
    }
  });

  it('5. definer-scoped policies exist only on the auth tables', async () => {
    const rows = await db.$queryRawUnsafe<{ table_name: string; policy_name: string }[]>(`
      SELECT c.relname AS table_name, p.polname AS policy_name
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND EXISTS (
          SELECT 1 FROM pg_roles r
          WHERE r.oid = ANY (p.polroles) AND r.rolname = 'meterlog_definer'
        )
      ORDER BY 1, 2
    `);

    const offenders = rows.filter((r) => !DEFINER_ACCESSIBLE_TABLES.includes(r.table_name));
    expect(
      offenders,
      `definer-scoped policies outside the auth tables: ${offenders
        .map((r) => `${r.table_name}.${r.policy_name}`)
        .join(', ')}`,
    ).toEqual([]);
  });

  it('6. meterlog_definer holds no UPDATE, DELETE, TRUNCATE or REFERENCES on any table', async () => {
    // The definer policy is deliberately broad (FOR ALL ... USING (true) WITH
    // CHECK (true)) so registration's INSERTs are not denied. What keeps that
    // safe is the grant: table privileges are checked before policies, so a
    // broad policy cannot widen what the grants withhold. Asserted, not assumed.
    const rows = await db.$queryRawUnsafe<{ table_name: string; privilege: string }[]>(`
      SELECT c.relname AS table_name, priv AS privilege
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['UPDATE','DELETE','TRUNCATE','REFERENCES']) AS priv
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND has_table_privilege('meterlog_definer', c.oid, priv)
      ORDER BY 1, 2
    `);

    expect(rows.map((r) => `${r.table_name}:${r.privilege}`)).toEqual([]);
  });

  it('7. the runtime role is restricted and is not the migration role', async () => {
    // Load-bearing. If DATABASE_URL is ever pointed at the migration/owner role,
    // assertions 1-6 all still pass while isolation is completely gone.
    const [identity] = await db.$queryRawUnsafe<{ current_user: string }[]>(
      `SELECT current_user::text AS current_user`,
    );
    expect(identity?.current_user).toBe('meterlog_app');

    const roles = await db.$queryRawUnsafe<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >(`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname IN ('meterlog_app', 'meterlog_definer')
      ORDER BY 1
    `);

    expect(roles.map((r) => r.rolname)).toEqual(['meterlog_app', 'meterlog_definer']);
    for (const role of roles) {
      expect(role.rolsuper, `${role.rolname} must not be SUPERUSER`).toBe(false);
      expect(role.rolbypassrls, `${role.rolname} must not have BYPASSRLS`).toBe(false);
    }
  });
});
