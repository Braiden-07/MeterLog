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
 * At scaffold there are no domain tables, so assertions 1-6 and 8 iterate empty
 * sets and only 7 has real content. That is the point — these are in CI BEFORE
 * the first tenant-scoped table exists, so step 4 cannot introduce one that is
 * unprotected (1-3), reachable by the definer path it should not be (4-6), or
 * carrying the empty-string heisenbug (8).
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

    // Subset, not equality: the allowlist is the set of definer functions that
    // are PERMITTED to exist, so it may name functions not yet written (ADR-006
    // fixes it to {login_lookup, register_tenant} before step 4 creates them).
    // The security property is one-directional — a function present in the
    // catalog but absent from the list is an unreviewed hole in the isolation
    // boundary; a listed function that does not exist yet is only a declaration.
    const unlisted = rows
      .map((r) => r.function_name)
      .filter((name) => !EXPECTED_DEFINER_FUNCTIONS.includes(name));
    expect(
      unlisted,
      `SECURITY DEFINER functions not on the reviewed allowlist: ${unlisted.join(', ')}`,
    ).toEqual([]);

    for (const fn of rows) {
      expect(fn.owner, `${fn.function_name} must be owned by meterlog_definer`).toBe(
        'meterlog_definer',
      );
      // Without a pinned search_path a SECURITY DEFINER function is itself a
      // privilege-escalation vector.
      const pin = (fn.proconfig ?? []).find((c) => c.startsWith('search_path='));
      expect(pin, `${fn.function_name} must pin search_path`).toBeDefined();

      // Presence is not the property — CONTENT is. This assertion originally
      // checked only that some `search_path=` entry existed, which a mutation
      // sweep showed accepts `search_path = public, pg_catalog, pg_temp`: the pin
      // is technically present and the hardening is gone. `public` is exactly the
      // schema that must stay out, because it is the one an attacker who can
      // create objects could use to shadow a function or operator the body
      // resolves unqualified.
      //
      // It is not hypothetical here even without an attacker: `citext` lives in
      // `public`, and whether `public` is on the path silently changes which `=`
      // operator `login_lookup` binds — case-insensitive or case-sensitive. That
      // cost a real bug in Phase 2.
      const schemas = (pin ?? '')
        .slice('search_path='.length)
        .split(',')
        .map((entry) => entry.trim().replace(/^"|"$/g, ''));
      expect(
        schemas,
        `${fn.function_name} must not resolve names in 'public' — pin is: ${pin}`,
      ).not.toContain('public');
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

  it('8. every policy reference to an app.* GUC is wrapped in NULLIF', async () => {
    // Guards a heisenbug. `current_setting(name, true)` returns NULL only while
    // the setting has never been set on that session; once SET LOCAL has set it
    // even once, it reverts at transaction end to the EMPTY STRING. So on a
    // pooled connection an unset context yields '', and ''::uuid raises 22P02
    // instead of filtering — turning "no context ⇒ zero rows" into
    // "no context ⇒ 500", but only after a connection has been reused.
    //
    // That is invisible to a behavioural test that happens to land on a fresh
    // connection, which is exactly why it is asserted structurally here instead.
    //
    // Deliberately matches ANY `app.*` GUC, not just app.current_tenant. The
    // first version of this assertion named that one setting, and would have
    // waved through every raw `app.current_user` reference in ADR-006's draft —
    // the guard had the same blind spot as the bug it exists to catch. Any new
    // request-scoped GUC is covered from the moment it is written.
    //
    // Phrased as "references a GUC ⇒ must wrap it", so `USING (true)` definer
    // policies are unaffected and tables keyed on a column other than
    // `tenant_id` (e.g. `tenants.id`) need no special case.
    const rows = await db.$queryRawUnsafe<
      { table_name: string; policy_name: string; clause: string; expression: string }[]
    >(`
      SELECT c.relname AS table_name,
             p.polname AS policy_name,
             clause.name AS clause,
             clause.expr AS expression
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL (
        VALUES ('USING', pg_get_expr(p.polqual, p.polrelid)),
               ('WITH CHECK', pg_get_expr(p.polwithcheck, p.polrelid))
      ) AS clause(name, expr)
      WHERE n.nspname = 'public'
        AND clause.expr IS NOT NULL
        AND clause.expr LIKE '%current_setting(''app.%'
      ORDER BY 1, 2, 3
    `);

    // The wrapper check runs here rather than in SQL: Postgres regex lookbehind
    // is not dependable across versions, and every occurrence must be checked,
    // not just the first.
    const NEEDLE = "current_setting('app.";
    const WRAPPER = 'NULLIF(';
    const offenders: string[] = [];

    for (const row of rows) {
      for (
        let i = row.expression.indexOf(NEEDLE);
        i !== -1;
        i = row.expression.indexOf(NEEDLE, i + 1)
      ) {
        if (row.expression.slice(i - WRAPPER.length, i) !== WRAPPER) {
          offenders.push(`${row.table_name}.${row.policy_name} [${row.clause}]: ${row.expression}`);
          break;
        }
      }
    }

    expect(
      offenders,
      `policies referencing an app.* GUC without the NULLIF(current_setting('app.<guc>', true), '') wrapper:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
  it('9. the app role holds no INSERT, UPDATE or DELETE on any identity table', async () => {
    // The structural guarantee behind DECISION B (ADR-006 §3 amendment). Membership
    // writes are denied twice over: no app-role write policy, and no write grant.
    // This asserts the second half, because it is the half a future edit can undo
    // in one line — `GRANT INSERT ON public.memberships TO meterlog_app` reopens the
    // intra-tenant self-promotion escalation with nothing else complaining.
    //
    // It also subsumes the `tenants` gap found by mutation sweep 02: that policy's
    // WITH CHECK is unreachable only because the app role cannot write `tenants`,
    // and until now nothing asserted that.
    //
    // Deliberately catalog-driven rather than a hardcoded list of three, so a new
    // identity table cannot arrive with write privileges unnoticed.
    const rows = await db.$queryRawUnsafe<{ table_name: string; privilege: string }[]>(
      `
      SELECT c.relname AS table_name, priv AS privilege
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) AS priv
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY ($1::text[])
        AND has_table_privilege('meterlog_app', c.oid, priv)
      ORDER BY 1, 2
    `,
      DEFINER_ACCESSIBLE_TABLES as string[],
    );

    expect(
      rows.map((r) => `${r.table_name}:${r.privilege}`),
      'the app role must be read-only on the identity tables — all writes go through SECURITY DEFINER functions',
    ).toEqual([]);
  });

  it('10. the app role can still READ every identity table', async () => {
    // Pairs with 9. On its own, assertion 9 is satisfied by a table the app role
    // cannot touch at all, which would be fail-closed but broken. `users` is
    // column-granted (password_hash withheld), so table-level has_table_privilege
    // reports false for it — the read check must be column-aware or it would force
    // the column grant to be widened to satisfy the test.
    const rows = await db.$queryRawUnsafe<{ table_name: string; readable: boolean }[]>(
      `
      SELECT c.relname AS table_name,
             EXISTS (
               SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                 AND has_column_privilege('meterlog_app', c.oid, a.attnum, 'SELECT')
             ) AS readable
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY ($1::text[])
      ORDER BY 1
    `,
      DEFINER_ACCESSIBLE_TABLES as string[],
    );

    expect(rows.map((r) => r.table_name)).toEqual([...DEFINER_ACCESSIBLE_TABLES].sort());
    for (const row of rows) {
      expect(row.readable, `${row.table_name} must be readable by the app role`).toBe(true);
    }
  });
  it('11. no SECURITY DEFINER function is executable by PUBLIC', async () => {
    // Postgres grants EXECUTE on a NEW function to PUBLIC by default, and a
    // function's ACL is invisible in the places people look when reviewing a
    // definer function (the body, the owner, the search_path all look right).
    // Left at the default, every role in the cluster could call a function that
    // reads password hashes with the definer's privileges.
    //
    // `proacl IS NULL` means "never touched", which IS the permissive default —
    // so it has to count as a violation, not be skipped as "no grants".
    const rows = await db.$queryRawUnsafe<{ function_name: string; reason: string }[]>(`
      SELECT p.proname AS function_name,
             CASE WHEN p.proacl IS NULL
                  THEN 'default ACL — EXECUTE is implicitly granted to PUBLIC'
                  ELSE 'EXECUTE explicitly granted to PUBLIC' END AS reason
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
        AND (
          p.proacl IS NULL
          OR EXISTS (
            SELECT 1 FROM aclexplode(p.proacl) a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
          )
        )
      ORDER BY 1
    `);

    expect(
      rows.map((r) => `${r.function_name}: ${r.reason}`),
      'a SECURITY DEFINER function is callable by PUBLIC',
    ).toEqual([]);
  });

  it('12. every SECURITY DEFINER function IS executable by the app role', async () => {
    // Pairs with 11 the way 10 pairs with 9. On its own, 11 is satisfied by a
    // function nobody can call — fail-closed, but broken: the login and register
    // paths would 500 rather than being denied, and no other assertion notices.
    const rows = await db.$queryRawUnsafe<{ function_name: string; callable: boolean }[]>(`
      SELECT p.proname AS function_name,
             has_function_privilege('meterlog_app', p.oid, 'EXECUTE') AS callable
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
      ORDER BY 1
    `);

    const uncallable = rows.filter((r) => !r.callable).map((r) => r.function_name);
    expect(
      uncallable,
      `SECURITY DEFINER functions the app role cannot call: ${uncallable.join(', ')}`,
    ).toEqual([]);
  });
});
