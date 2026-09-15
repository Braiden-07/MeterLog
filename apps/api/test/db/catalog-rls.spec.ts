import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APPEND_ONLY_TABLES,
  APP_UNREADABLE_DEFINER_TABLES,
  DEFINER_WRITTEN_APPEND_ONLY_TABLES,
  SOFT_DELETE_ONLY_TABLES,
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

  it('6. meterlog_definer holds table-level UPDATE on exactly memberships and invite_tokens', async () => {
    // The definer policy is deliberately broad (FOR ALL ... USING (true) WITH
    // CHECK (true)) so registration's INSERTs are not denied. What keeps that
    // safe is the grant: table privileges are checked before policies, so a
    // broad policy cannot widen what the grants withhold. Asserted, not assumed.
    //
    // NARROWED AT STEP 5 PHASE 1, deliberately and with sign-off. This assertion
    // previously read "no UPDATE, DELETE, TRUNCATE or REFERENCES on ANY table"
    // and expected the empty set. change-role writes `role` and revoke writes
    // `deleted_at` (a soft delete IS an UPDATE), so the definer role now needs
    // UPDATE on `memberships` and the old shape cannot hold.
    //
    // This is the moment DECISION B's grant-level backstop weakens on purpose,
    // and it is worth being plain about what is lost: until now, a bug in a
    // definer function body that tried to UPDATE anything was unreachable because
    // the privilege did not exist. That is no longer true for `memberships`. What
    // replaces it is the §7 body-level checks and the direct-call negatives in
    // `membership-writes.spec.ts` — which is exactly why those negatives are
    // produced without an HTTP guard in front of them.
    //
    // So the assertion is narrowed to an EQUALITY on the exact new shape, never
    // relaxed to "has some grants". Still no DELETE, TRUNCATE or REFERENCES
    // anywhere at all.
    //
    // WIDENED AGAIN AT STEP 8 (OPEN-7) to admit `invite_tokens:UPDATE`. The
    // consume (`SET consumed_at = now() WHERE ... AND consumed_at IS NULL`) and
    // the supersession on mint are both UPDATEs. Still an equality.
    //
    // ===== READ THIS BEFORE TRUSTING THIS ASSERTION =========================
    // THIS ASSERTION IS BLIND TO COLUMN-LEVEL GRANTS, and step 8 is where that
    // stopped being academic. `has_table_privilege` reports only TABLE-wide
    // privileges. Verified live: with
    //   GRANT UPDATE (password_hash, password_set_at) ON public.users TO meterlog_definer
    // in place — which is exactly what step 8 grants — this assertion still
    // returns ['invite_tokens:UPDATE', 'memberships:UPDATE'] and PASSES.
    //
    // So the sentence this comment used to carry, "the next grant that widens
    // this by one privilege fails here", was only ever true of table-level
    // grants. The definer's UPDATE on `users` is real, is column-limited, and is
    // invisible here. The same blindness applies to assertion 9 on the app-role
    // side, which is why the `password_hash` withholding went unasserted from
    // step 4 until step 8.
    //
    // **Assertion 18 is what actually pins the column grants**, as an equality
    // over `information_schema.column_privileges`. This assertion covers the
    // table-level axis and says so; 18 covers the column axis. Neither subsumes
    // the other, and a reader who takes this one for total coverage is reading
    // the guarantee this project shipped without for four steps.
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

    expect(rows.map((r) => `${r.table_name}:${r.privilege}`)).toEqual([
      'invite_tokens:UPDATE',
      'memberships:UPDATE',
    ]);
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

  it('10. the app role can still READ every identity table (except the declared-unreadable ones)', async () => {
    // Pairs with 9. On its own, assertion 9 is satisfied by a table the app role
    // cannot touch at all, which would be fail-closed but broken. `users` is
    // column-granted (password_hash withheld), so table-level has_table_privilege
    // reports false for it — the read check must be column-aware or it would force
    // the column grant to be widened to satisfy the test.
    //
    // NARROWED AT STEP 8 (OPEN-7), deliberately and with a replacement. The
    // premise above — definer-reachable implies app-readable — held for the first
    // four entries and does not hold for `invite_tokens`, which holds credentials
    // and grants the app role NOTHING. Forcing it to satisfy this assertion would
    // mean granting an app role SELECT on a token table to make a test pass, the
    // same trap as granting TRUNCATE to fix a teardown.
    //
    // The exclusion is DECLARED (`APP_UNREADABLE_DEFINER_TABLES`), not derived
    // from the live grants — deriving it would make this assert whatever the
    // grants happen to be. And it is paired with assertion 18, which asserts the
    // app role holds ZERO privileges on those tables, so the carve-out cannot
    // become a way to keep a quietly-readable credential table nobody checks.
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
      if (APP_UNREADABLE_DEFINER_TABLES.includes(row.table_name)) {
        // The carve-out asserts the OPPOSITE rather than skipping: a declared
        // unreadable table that becomes readable fails here, not silently.
        expect(
          row.readable,
          `${row.table_name} is declared app-unreadable but the app role can read a column of it`,
        ).toBe(false);
        continue;
      }
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

  it('12. every CALLABLE SECURITY DEFINER function IS executable by the app role', async () => {
    // Pairs with 11 the way 10 pairs with 9. On its own, 11 is satisfied by a
    // function nobody can call — fail-closed, but broken: the login and register
    // paths would 500 rather than being denied, and no other assertion notices.
    //
    // NARROWED AT STEP 7 PHASE 7A to exclude TRIGGER functions, and the carve-out
    // is narrow on purpose. `audit_capture` returns `trigger` and is never called
    // by name: Postgres checks EXECUTE at CREATE TRIGGER time, not at fire time,
    // so the app role needs no privilege on it and a direct call is refused by
    // the server regardless ("trigger functions can only be called as triggers").
    //
    // The alternative — granting EXECUTE anyway to keep the query unchanged —
    // would be a privilege that buys nothing, and worse, it would make this
    // assertion satisfiable by an empty gesture: the thing it checks (that a
    // definer function is actually REACHABLE) would no longer be what it asserts.
    //
    // The cover it would have lost is replaced by assertion 16, which requires a
    // trigger-returning definer function to be ATTACHED to at least one trigger.
    // So reachability is still asserted for every definer function — by the right
    // question for each kind.
    const rows = await db.$queryRawUnsafe<{ function_name: string; callable: boolean }[]>(`
      SELECT p.proname AS function_name,
             has_function_privilege('meterlog_app', p.oid, 'EXECUTE') AS callable
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND p.prorettype <> 'pg_catalog.trigger'::regtype
      ORDER BY 1
    `);

    const uncallable = rows.filter((r) => !r.callable).map((r) => r.function_name);
    expect(
      uncallable,
      `SECURITY DEFINER functions the app role cannot call: ${uncallable.join(', ')}`,
    ).toEqual([]);
  });

  it('13. every append-only table grants the app role exactly SELECT, INSERT', async () => {
    // BINDS THE DECLARATION TO THE GRANT (step 6 Phase 1).
    //
    // Append-only is a DECLARED property — CLAUDE.md states it, APPEND_ONLY_TABLES
    // is its executable mirror. A declaration nothing enforces is a comment, and
    // this repo has already paid for two properties that were true by convention
    // until they silently were not (WITH CHECK defaulting from USING; an operator
    // resolving through an implicit cast).
    //
    // The failure this closes is one line long and completely silent:
    //
    //     GRANT UPDATE ON public.asset_events TO meterlog_app;
    //
    // Nothing else in the suite would notice. Assertion 9 does not cover it —
    // that one is scoped to DEFINER_ACCESSIBLE_TABLES, the three identity tables,
    // deliberately, so it has nothing to say about domain tables. The isolation
    // matrix would not notice either: its write cases branch on the fixture's
    // DECLARED capability, so it would keep asserting "refused outright" and keep
    // passing — because the missing POLICY, not the missing grant, would still
    // refuse the cross-tenant statement it happens to attempt.
    //
    // Asserted as an EQUALITY, not a subset. "Holds no UPDATE" would be satisfied
    // by a table the app role cannot read or insert into at all — fail-closed but
    // broken, the same trap assertion 10 exists to close for assertion 9.
    const rows = await db.$queryRawUnsafe<{ table_name: string; privileges: string }[]>(
      `
      SELECT c.relname AS table_name,
             coalesce(string_agg(priv, ', ' ORDER BY priv), '') AS privileges
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES']) AS priv
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY ($1::text[])
        AND has_table_privilege('meterlog_app', c.oid, priv)
      GROUP BY 1
      ORDER BY 1
    `,
      APPEND_ONLY_TABLES as string[],
    );

    // EXTENDED AT STEP 7 PHASE 7A, and extended rather than relaxed.
    //
    // `audit_log` is append-only too, but its writer is the `audit_capture`
    // SECURITY DEFINER trigger, not the app role — so its app-role grant is
    // `SELECT` ALONE (ADR-010). Widening the grant to `SELECT, INSERT` to keep
    // one expected string would hand the app role the very INSERT that ADR its
    // entire immutability claim rests on withholding, to make an assertion
    // convenient. That is the same trap as granting TRUNCATE to fix a teardown.
    //
    // So the expected value is chosen PER TABLE, from a DERIVED list — an
    // append-only table that is also definer-reachable expects `SELECT`, every
    // other expects `INSERT, SELECT`. Still an equality in both cases, never a
    // subset: "holds no UPDATE" would be satisfied by a table the app role cannot
    // read or insert into at all, which is the trap assertion 10 closes for 9.
    const actual = Object.fromEntries(rows.map((r) => [r.table_name, r.privileges]));
    const expected = Object.fromEntries(
      APPEND_ONLY_TABLES.map((t) => [
        t,
        DEFINER_WRITTEN_APPEND_ONLY_TABLES.includes(t) ? 'SELECT' : 'INSERT, SELECT',
      ]),
    );

    expect(
      actual,
      'an append-only table must hold exactly SELECT, INSERT for the app role — or SELECT alone where the definer trigger is the writer. A stray GRANT reopens it to mutation',
    ).toEqual(expected);
  });

  it('14. every soft-delete-only table grants exactly SELECT, INSERT, UPDATE — never DELETE', async () => {
    // BINDS ADR-008's DECISION TO THE GRANT (step 6 phase 4).
    //
    // `maintenance_records` is soft-delete for v1.0. That is true exactly as long
    // as the DELETE privilege is absent, so this asserts the grant set rather than
    // trusting the service to only ever issue an UPDATE.
    //
    // The failure this closes is one line and completely silent:
    //
    //     GRANT DELETE ON public.maintenance_records TO meterlog_app;
    //
    // v1.0 would become destructive **two build steps before `audit_log` exists**,
    // so a purged maintenance record would leave no trace of itself, of who removed
    // it, or of what it said (OPEN-9). Nothing else in the suite would notice:
    // assertion 13 covers only append-only tables, and the isolation matrix's
    // DELETE case branches on the fixture's DECLARED capability, so it would keep
    // asserting "refused" and keep passing — because the missing POLICY, not the
    // missing grant, would still refuse a cross-tenant statement.
    //
    // Asserted as an EQUALITY, not a subset. "Holds no DELETE" is satisfied by a
    // table the app role cannot read or write at all — fail-closed but broken, the
    // same trap assertion 10 exists to close for assertion 9.
    const rows = await db.$queryRawUnsafe<{ table_name: string; privileges: string }[]>(
      `
      SELECT c.relname AS table_name,
             coalesce(string_agg(priv, ', ' ORDER BY priv), '') AS privileges
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES']) AS priv
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY ($1::text[])
        AND has_table_privilege('meterlog_app', c.oid, priv)
      GROUP BY 1
      ORDER BY 1
    `,
      SOFT_DELETE_ONLY_TABLES as string[],
    );

    const actual = Object.fromEntries(rows.map((r) => [r.table_name, r.privileges]));
    const expected = Object.fromEntries(
      SOFT_DELETE_ONLY_TABLES.map((t) => [t, 'INSERT, SELECT, UPDATE']),
    );

    expect(
      actual,
      'a soft-delete-only table must hold exactly SELECT, INSERT, UPDATE — a DELETE grant makes v1.0 destructive before anything can audit it (ADR-008, OPEN-9)',
    ).toEqual(expected);
  });

  it('15. no domain table is declared both append-only and soft-delete-only', async () => {
    // The two profiles are mutually exclusive: append-only refuses UPDATE, and
    // soft-delete-only requires it. A table in both lists would make assertions 13
    // and 14 demand contradictory grant sets, and whichever ran second would be the
    // one that "failed" — obscuring that the declaration itself was incoherent.
    const overlap = APPEND_ONLY_TABLES.filter((t) => SOFT_DELETE_ONLY_TABLES.includes(t));
    expect(
      overlap,
      `declared both append-only and soft-delete-only: ${overlap.join(', ')}`,
    ).toEqual([]);
  });

  it('16. every trigger-returning SECURITY DEFINER function is actually ATTACHED', async () => {
    // THE REPLACEMENT COVER FOR ASSERTION 12's CARVE-OUT (step 7 phase 7a).
    //
    // 12 asks "can the app role call it?", which is the right reachability
    // question for a function called by name and a meaningless one for a trigger
    // function. Excluding trigger functions from 12 without asking a different
    // reachability question would open a gap the allowlist cannot see: a SECURITY
    // DEFINER function could sit in `EXPECTED_DEFINER_FUNCTIONS`, owned by the
    // definer role, pinned and correct in every structural respect, and be
    // attached to NOTHING — so every audited mutation would go uncaptured while
    // assertions 4, 11 and 12 all stayed green.
    //
    // That is the exact failure shape this repo keeps meeting: not a wrong
    // answer, an unreachable guard (the RBAC gate in ISOLATION §7d, the readings
    // tiebreaker in §7e). So the question is asked in the form that fits: an
    // unattached trigger function is a definer function with no caller.
    const rows = await db.$queryRawUnsafe<{ function_name: string; attachments: number }[]>(`
      SELECT p.proname AS function_name,
             (SELECT count(*)::int FROM pg_trigger t
               WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS attachments
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
        AND p.prorettype = 'pg_catalog.trigger'::regtype
      ORDER BY 1
    `);

    // Non-vacuity: if this query ever returns nothing, the assertion below passes
    // trivially. `audit_capture` is the only such function today and must be here.
    expect(
      rows.map((r) => r.function_name),
      'no trigger-returning SECURITY DEFINER function found — this assertion would be vacuous',
    ).toContain('audit_capture');

    const orphans = rows.filter((r) => r.attachments === 0).map((r) => r.function_name);
    expect(
      orphans,
      `SECURITY DEFINER trigger functions attached to no trigger — capture is silently dead: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('17. no audit trigger allowlist admits password_hash, and every audited table has one', async () => {
    // ADR-011's REDACTION, ASSERTED STRUCTURALLY (step 7 phase 7a).
    //
    // The per-table column allowlist is passed as the TRIGGER'S ARGUMENT rather
    // than hard-coded in the function body, precisely so it lands in
    // `pg_trigger.tgargs` and a single catalog query can read every one of them.
    //
    // WHY A STRUCTURAL CHECK WHEN A BEHAVIOURAL ONE EXISTS. The behavioural proof
    // in `audit.spec.ts` is the stronger evidence — it writes a real hash and
    // reads the audit row back — but it can only cover the paths a fixture
    // exercises. This covers ALL of them, including a table that no test happens
    // to mutate, and it fails at the moment a migration adds the column to an
    // allowlist rather than at the moment someone writes a row through it.
    //
    // `tgargs` is a null-separated byte string; `pg_get_triggerdef` is easier to
    // read and is what a reviewer would look at, so the check is done on that.
    const rows = await db.$queryRawUnsafe<{ table_name: string; definition: string }[]>(`
      SELECT c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
        AND p.proname = 'audit_capture'
      ORDER BY 1
    `);

    // Non-vacuity, and this one is load-bearing: an empty result set makes the
    // leak check below pass while NOTHING IS AUDITED AT ALL. The six audited
    // tables are named (ADR-012) so a dropped attachment fails here.
    expect(
      rows.map((r) => r.table_name),
      'the audit trigger is not attached where ADR-012 says it is',
    ).toEqual([
      'asset_events',
      'assets',
      'maintenance_records',
      'memberships',
      'readings',
      'users',
    ]);

    const leaking = rows
      .filter((r) => r.definition.includes('password_hash'))
      .map((r) => r.table_name);
    expect(
      leaking,
      `an audit allowlist admits password_hash — the trail would become a privilege-escalation path (ADR-011): ${leaking.join(', ')}`,
    ).toEqual([]);

    // And every attachment must carry an allowlist at all. A trigger created with
    // NO argument would make `TG_ARGV[0]` NULL, `string_to_array` return NULL, and
    // every diff come out empty — capture that looks alive and records nothing.
    const argless = rows
      // `pg_get_triggerdef` renders the function name search_path-relative, so
      // the schema prefix is optional here rather than assumed.
      .filter((r) => !/EXECUTE FUNCTION (public\.)?audit_capture\('[^']+'\)/.test(r.definition))
      .map((r) => r.table_name);
    expect(
      argless,
      `audit trigger attached with no column allowlist: ${argless.join(', ')}`,
    ).toEqual([]);
  });

  it('18. the users COLUMN-grant set is exactly pinned, for both roles', async () => {
    // STEP 8 (OPEN-7). THE LOGIN-INVISIBILITY FLOOR — and the first assertion in
    // this suite that looks at column-level privileges at all.
    //
    // WHY IT HAD TO BE WRITTEN, stated plainly because the gap it closes was
    // believed to be already closed. `password_hash` has been withheld from
    // `meterlog_app` by column grant since step 4, and 20260907000000 describes
    // that withholding as "asserted in CI". IT WAS NOT. Assertions 6 and 9 are
    // both built on `has_table_privilege`, which reports only TABLE-wide
    // privileges and is blind to column grants. Verified live against this
    // database before this assertion existed:
    //
    //   GRANT SELECT (password_hash) ON public.users TO meterlog_app;
    //     -> assertion 9 passes, assertion 10 passes, whole suite green,
    //        and the app role can read every password hash in the system.
    //
    //   GRANT UPDATE (password_hash, password_set_at) ON public.users TO meterlog_definer;
    //     -> assertion 6 still returns exactly its expected list and passes.
    //
    // So from step 4 until now, the single most sensitive column grant in the
    // schema could have been widened in one line with nothing turning red. Step 8
    // adds `password_set_at` to that same withheld set — the login path must fail
    // `permission denied` if it ever names the column, which is the DB floor under
    // ADR-006 §7's hazard (ii) — so the floor had to become real.
    //
    // EQUALITY, NOT SUBSET, in both directions. A subset check ("password_hash is
    // absent from the app grant") would pass while some other column was quietly
    // added, and would say nothing about the definer side. The sets below are the
    // complete, reviewed answer to "who may touch which column of `users`".
    // READ FROM pg_catalog, NOT information_schema, AND THE DIFFERENCE IS A TRAP
    // THIS ASSERTION FELL INTO ON ITS FIRST RUN. The `information_schema` views
    // are PRIVILEGE-FILTERED: they show only rows the CONNECTING role has some
    // privilege on. This suite connects as `meterlog_app`, so
    // `information_schema.column_privileges` showed only the app role's own
    // grants and `information_schema.columns` could not see `password_set_at` at
    // all — the very column being pinned was invisible to the pin. The assertion
    // would have "passed" over a set it could not observe.
    //
    // `has_column_privilege(role, ...)` answers about ANY role from any
    // connection, and it reports EFFECTIVE access — column-level grants and
    // table-level grants that reach the column alike. Effective access is the
    // property worth pinning; an ACL read would miss a table-level grant covering
    // a column.
    const rows = await db.$queryRawUnsafe<
      { grantee: string; privilege_type: string; cols: string }[]
    >(`
      SELECT g.grantee, p.priv AS privilege_type,
             string_agg(a.attname, ',' ORDER BY a.attname) AS cols
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN unnest(ARRAY['meterlog_app','meterlog_definer']) AS g(grantee)
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p(priv)
      WHERE n.nspname = 'public' AND c.relname = 'users'
        AND has_column_privilege(g.grantee, c.oid, a.attnum, p.priv)
      GROUP BY g.grantee, p.priv
      ORDER BY 1, 2
    `);

    const actual = Object.fromEntries(
      rows.map((r) => [`${r.grantee}:${r.privilege_type}`, r.cols]),
    );

    expect(
      actual,
      'the users column-grant set has changed — see ADR-016 before widening it',
    ).toEqual({
      // THE APP ROLE READS IDENTITY, NEVER CREDENTIALS. `password_hash` and
      // `password_set_at` are both absent, and both absences are load-bearing:
      // the first keeps hashes out of reach of every authenticated request, the
      // second keeps the login path structurally unable to branch on pending
      // status (ADR-006 §7 hazard (ii)). Login runs as `meterlog_app`; a
      // reference to either column fails 42501, loudly, rather than working.
      'meterlog_app:SELECT': 'created_at,deleted_at,email,id,updated_at',

      // The definer reads everything — it must, to verify a password hash at
      // login and to evaluate the pending predicate. Table-level, so a new column
      // joins it automatically; that is why step 8 needed no new SELECT grant.
      'meterlog_definer:SELECT':
        'created_at,deleted_at,email,id,password_hash,password_set_at,updated_at',
      'meterlog_definer:INSERT':
        'created_at,deleted_at,email,id,password_hash,password_set_at,updated_at',

      // AND THE NARROW ONE. `set_password` writes exactly these two columns, so
      // the grant says exactly these two. `email` and `deleted_at` stay unwritable
      // by every role in the system, which is what stops a future edit to
      // set_password's body from becoming an identity-takeover or account-deletion
      // primitive. It is also what makes `user.password_set` an exhaustive label
      // for any `users` UPDATE rather than a guess — see 20260915000000 §7.
      'meterlog_definer:UPDATE': 'password_hash,password_set_at',
    });
  });

  it('19. users.password_set_at has NO column default', async () => {
    // STEP 8 (OPEN-7). Floors an invariant that is invisible in the schema as a
    // presence and only visible as an ABSENCE — the shape CLAUDE.md's append-only
    // declaration exists to refuse leaving implicit.
    //
    // NULL means "pending". A new `users` row written by `invite_member` gets NULL
    // and is therefore pending BY DEFAULT, with no change to `invite_member` at
    // all. `register_tenant` is the branch that says otherwise, explicitly.
    //
    // `DEFAULT now()` is the obvious tidy, and it would be a SILENT re-entry into
    // OPEN-7's dead-end: every invited user would look credentialled the moment
    // they were created, `list_pending_invites` would return nothing, no token
    // would ever be minted, and the invited person would be unreachable again —
    // with every existing test still green, because nothing else in the suite
    // looks at this column's default. That is the whole reason this assertion is
    // a test and not a comment in the migration.
    // pg_catalog, not information_schema.columns — see assertion 18's note. The
    // app role holds no privilege on this column, so information_schema cannot
    // see it from this connection and the assertion would have been vacuous.
    const [row] = await db.$queryRawUnsafe<{ has_default: boolean; default_expr: string | null }[]>(`
      SELECT a.atthasdef AS has_default,
             pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relname = 'users' AND a.attname = 'password_set_at'
    `);

    expect(row, 'users.password_set_at is missing entirely').toBeDefined();
    expect(
      row?.has_default,
      `users.password_set_at must have NO default — NULL is the pending predicate (ADR-016). Found: ${row?.default_expr}`,
    ).toBe(false);
  });

  it('20. the app role holds ZERO privileges on every declared-unreadable table', async () => {
    // STEP 8 (OPEN-7). The replacement cover for assertion 10's carve-out, and the
    // reason that carve-out is not a hiding place.
    //
    // Assertion 10 stops demanding that `invite_tokens` be app-readable. On its
    // own that is a hole: a table could be dropped into
    // `APP_UNREADABLE_DEFINER_TABLES` and quietly granted whatever it liked. This
    // asserts the strong property instead — the app role holds NOTHING on it. Not
    // SELECT, not INSERT, not UPDATE, not DELETE, not TRUNCATE, not REFERENCES,
    // and not on any single column.
    //
    // `invite_tokens` holds redemption credentials. Combined with the absence of
    // any app-role policy, the app role is refused twice over — the DECISION B
    // shape applied to a credential table — so a stolen app-role connection cannot
    // enumerate live tokens, read a hash, or mint one.
    const rows = await db.$queryRawUnsafe<{ table_name: string; privilege: string }[]>(
      `
      SELECT c.relname AS table_name, priv AS privilege
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES']) AS priv
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY ($1::text[])
        AND (
          has_table_privilege('meterlog_app', c.oid, priv)
          -- Column-aware too. Assertion 18's whole lesson is that a table-level
          -- check alone would miss a column grant, and missing one here would mean
          -- a readable token table reported as unreadable.
          OR EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
              AND priv IN ('SELECT','INSERT','UPDATE','REFERENCES')
              AND has_column_privilege('meterlog_app', c.oid, a.attnum, priv)
          )
        )
      ORDER BY 1, 2
    `,
      APP_UNREADABLE_DEFINER_TABLES as string[],
    );

    expect(
      rows.map((r) => `${r.table_name}:${r.privilege}`),
      'the app role holds a privilege on a table declared unreadable to it',
    ).toEqual([]);

    // Non-vacuity: an empty declaration list would make the check above pass while
    // asserting nothing, the `readWorkspaces` lesson. The list must be non-empty
    // and every entry must actually exist as a table.
    expect(APP_UNREADABLE_DEFINER_TABLES.length).toBeGreaterThan(0);
    const present = await db.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY ($1::text[])
        ORDER BY 1`,
      APP_UNREADABLE_DEFINER_TABLES as string[],
    );
    expect(present.map((r) => r.relname)).toEqual([...APP_UNREADABLE_DEFINER_TABLES].sort());
  });
});
