import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appClient, execAll, migratorClient } from './helpers';

/**
 * Definer-pattern probe (ADR-004).
 *
 * Every assertion in catalog-rls.spec.ts is structural, and structure is not
 * behaviour. A definer function that is present, correctly owned, search_path-
 * pinned and covered by an allowlisted policy satisfies all seven checks while
 * returning zero rows — which is exactly the FORCE ROW LEVEL SECURITY bug this
 * design was corrected for, and exactly what a structural suite cannot see.
 *
 * So this exercises the mechanism end to end, before any auth code depends on
 * it. Crucially it asserts the NEGATIVES too: a probe that only walks the happy
 * path can rot into passing for the wrong reason. Cases B, C and E each pin down
 * a specific way the pattern breaks, and case C is the bug itself.
 *
 * Fixtures live in their own schema and are dropped afterwards, so nothing
 * persists into `public` and no catalog exemption is needed.
 */
const SCHEMA = 'rls_probe';

describe('SECURITY DEFINER + FORCE RLS mechanism', () => {
  let migrator: PrismaClient;
  let app: PrismaClient;

  beforeAll(async () => {
    migrator = migratorClient();
    app = appClient();

    await execAll(migrator, [
      `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`,
      `CREATE SCHEMA ${SCHEMA}`,
      `GRANT USAGE ON SCHEMA ${SCHEMA} TO meterlog_app`,
      `GRANT USAGE ON SCHEMA ${SCHEMA} TO meterlog_definer`,

      // --- Table 1: reachable, because a definer-scoped policy exists ---------
      // Rows are seeded BEFORE RLS is enabled; afterwards even the owner cannot
      // insert without a policy, which is the very property under test.
      `CREATE TABLE ${SCHEMA}.with_policy (id int PRIMARY KEY, label text NOT NULL)`,
      `INSERT INTO ${SCHEMA}.with_policy (id, label) VALUES (1, 'seeded')`,
      `ALTER TABLE ${SCHEMA}.with_policy ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${SCHEMA}.with_policy FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY definer_all ON ${SCHEMA}.with_policy
         FOR ALL TO meterlog_definer USING (true) WITH CHECK (true)`,
      `GRANT SELECT, INSERT ON ${SCHEMA}.with_policy TO meterlog_definer`,
      // The app role gets a real SELECT grant so that case D proves RLS is what
      // hides the row — not a missing privilege, which would fail differently.
      `GRANT SELECT ON ${SCHEMA}.with_policy TO meterlog_app`,

      // --- Table 2: identical, minus the policy ------------------------------
      `CREATE TABLE ${SCHEMA}.no_policy (id int PRIMARY KEY, label text NOT NULL)`,
      `INSERT INTO ${SCHEMA}.no_policy (id, label) VALUES (1, 'seeded')`,
      `ALTER TABLE ${SCHEMA}.no_policy ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${SCHEMA}.no_policy FORCE ROW LEVEL SECURITY`,
      `GRANT SELECT, INSERT ON ${SCHEMA}.no_policy TO meterlog_definer`,

      // --- Table 3: OWNED BY the definer role, forced, no policy -------------
      // This is the bug, encoded. Ownership must not confer a bypass under FORCE.
      // The table is owned by meterlog_definer rather than the migration role
      // deliberately: locally and in CI the migration role is a superuser (which
      // bypasses RLS unconditionally), so an owner-bypass test written against it
      // would prove nothing. meterlog_definer is never a superuser anywhere.
      `CREATE TABLE ${SCHEMA}.owner_forced (id int PRIMARY KEY, label text NOT NULL)`,
      `INSERT INTO ${SCHEMA}.owner_forced (id, label) VALUES (1, 'seeded')`,
      `ALTER TABLE ${SCHEMA}.owner_forced ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${SCHEMA}.owner_forced FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE ${SCHEMA}.owner_forced OWNER TO meterlog_definer`,

      // --- Functions ---------------------------------------------------------
      `CREATE FUNCTION ${SCHEMA}.read_with_policy() RETURNS int
         LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
         AS $fn$ SELECT count(*)::int FROM ${SCHEMA}.with_policy $fn$`,
      `ALTER FUNCTION ${SCHEMA}.read_with_policy() OWNER TO meterlog_definer`,

      `CREATE FUNCTION ${SCHEMA}.write_with_policy(new_id int) RETURNS int
         LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
         AS $fn$ INSERT INTO ${SCHEMA}.with_policy (id, label)
                 VALUES (new_id, 'written') RETURNING id $fn$`,
      `ALTER FUNCTION ${SCHEMA}.write_with_policy(int) OWNER TO meterlog_definer`,

      `CREATE FUNCTION ${SCHEMA}.read_no_policy() RETURNS int
         LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
         AS $fn$ SELECT count(*)::int FROM ${SCHEMA}.no_policy $fn$`,
      `ALTER FUNCTION ${SCHEMA}.read_no_policy() OWNER TO meterlog_definer`,

      `CREATE FUNCTION ${SCHEMA}.write_no_policy(new_id int) RETURNS int
         LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
         AS $fn$ INSERT INTO ${SCHEMA}.no_policy (id, label)
                 VALUES (new_id, 'written') RETURNING id $fn$`,
      `ALTER FUNCTION ${SCHEMA}.write_no_policy(int) OWNER TO meterlog_definer`,

      `CREATE FUNCTION ${SCHEMA}.read_owner_forced() RETURNS int
         LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
         AS $fn$ SELECT count(*)::int FROM ${SCHEMA}.owner_forced $fn$`,
      `ALTER FUNCTION ${SCHEMA}.read_owner_forced() OWNER TO meterlog_definer`,

      // plpgsql, not sql: an SQL-language body is validated at CREATE time and
      // would fail here rather than at call time, which is not what we want to
      // demonstrate.
      `CREATE FUNCTION ${SCHEMA}.read_unqualified() RETURNS int
         LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
         AS $fn$
           DECLARE n int;
           BEGIN SELECT count(*)::int INTO n FROM with_policy; RETURN n; END
         $fn$`,
      `ALTER FUNCTION ${SCHEMA}.read_unqualified() OWNER TO meterlog_definer`,

      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} TO meterlog_app`,
    ]);
  });

  afterAll(async () => {
    await execAll(migrator, [`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`]);
    await migrator.$disconnect();
    await app.$disconnect();
  });

  // --- A: the happy path ---------------------------------------------------
  it('A. a definer function reaches a forced-RLS table through its definer policy', async () => {
    const read = await app.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ${SCHEMA}.read_with_policy() AS n`,
    );
    expect(read[0]?.n).toBe(1);

    const written = await app.$queryRawUnsafe<{ id: number }[]>(
      `SELECT ${SCHEMA}.write_with_policy(2) AS id`,
    );
    expect(written[0]?.id).toBe(2);

    // The WITH CHECK half of the policy is what permits that INSERT. A policy
    // carrying only USING would have denied it — which is how registration
    // would have failed while login appeared fine.
    const after = await app.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ${SCHEMA}.read_with_policy() AS n`,
    );
    expect(after[0]?.n).toBe(2);
  });

  // --- B: the policy is load-bearing ---------------------------------------
  it('B. without a definer policy, the same pattern reads nothing and cannot write', async () => {
    const read = await app.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ${SCHEMA}.read_no_policy() AS n`,
    );
    expect(read[0]?.n).toBe(0);

    await expect(app.$queryRawUnsafe(`SELECT ${SCHEMA}.write_no_policy(2) AS id`)).rejects.toThrow(
      /row-level security/i,
    );
  });

  // --- C: the bug itself ---------------------------------------------------
  it('C. owning the table does NOT bypass FORCE ROW LEVEL SECURITY', async () => {
    // The original design assumed a definer function owned by the table owner
    // would bypass RLS. Under FORCE it does not — it fails closed, and would
    // have surfaced as login silently returning no user two build steps later.
    // If this ever returns 1, the permissive-policy mechanism has been quietly
    // replaced by an ownership assumption that does not hold.
    const read = await app.$queryRawUnsafe<{ n: number }[]>(
      `SELECT ${SCHEMA}.read_owner_forced() AS n`,
    );
    expect(read[0]?.n).toBe(0);
  });

  // --- D: the app role is still fenced out ----------------------------------
  it('D. the app role holds SELECT but sees no rows without a policy of its own', async () => {
    const rows = await app.$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM ${SCHEMA}.with_policy`,
    );
    expect(rows).toEqual([]);
  });

  // --- E: schema-qualification is load-bearing ------------------------------
  it('E. an unqualified reference under a pinned search_path fails to resolve', async () => {
    // Pinning search_path to pg_catalog, pg_temp removes `public` (and here
    // rls_probe) from resolution. So an unqualified name does not resolve to the
    // wrong table — it does not resolve at all. The pin and the qualification
    // only work as a pair, which is why the ADR treats qualification as
    // correctness rather than style.
    await expect(app.$queryRawUnsafe(`SELECT ${SCHEMA}.read_unqualified() AS n`)).rejects.toThrow(
      /does not exist/i,
    );
  });
});
