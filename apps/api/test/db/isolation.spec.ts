import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ISOLATION_BESPOKE_TABLES,
  ISOLATION_FIXTURES,
  RLS_EXEMPT_TABLES,
  appClient,
  execAll,
  migratorClient,
  withTenant,
} from './helpers';

/**
 * Catalog-driven isolation (ADR-004).
 *
 * catalog-rls.spec.ts proves RLS is PRESENT on every table. It cannot prove the
 * policy is CORRECT — `USING (true)` satisfies every one of its assertions and
 * isolates nothing. This suite closes that gap, and closes it in a way that
 * scales: the set of tables to cover is read from the catalog, so correctness
 * coverage grows automatically as tables are added rather than depending on
 * someone remembering to write a case.
 *
 * Two halves:
 *   1. Registry/catalog set equality — live now, and the thing that will fail the
 *      build in step 4 if a table arrives without a fixture.
 *   2. The isolation matrix itself — generated per registered fixture. Empty at
 *      scaffold, so it is self-tested below against a scratch table rather than
 *      shipped unexercised.
 */
const PROBE_SCHEMA = 'iso_probe';

describe('catalog-driven tenant isolation', () => {
  let app: PrismaClient;
  let migrator: PrismaClient;

  beforeAll(() => {
    app = appClient();
    migrator = migratorClient();
  });

  afterAll(async () => {
    await app.$disconnect();
    await migrator.$disconnect();
  });

  describe('fixture coverage', () => {
    it('every tenant-scoped table has an isolation fixture, and vice versa', async () => {
      const rows = await app.$queryRawUnsafe<{ table_name: string }[]>(`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY 1
      `);

      const allTables = rows.map((r) => r.table_name).filter((t) => !RLS_EXEMPT_TABLES.includes(t));

      // Tables with a bespoke dual-axis test (ADR-006 §8.2) are accounted for
      // here rather than silently missing from the matrix.
      const catalogTables = allTables.filter((t) => !ISOLATION_BESPOKE_TABLES.includes(t)).sort();
      const registered = Object.keys(ISOLATION_FIXTURES).sort();

      const missing = catalogTables.filter((t) => !registered.includes(t));
      const stale = registered.filter((t) => !catalogTables.includes(t));

      // Asserted in both directions on purpose: a new table without a fixture is
      // an isolation hole, and a fixture for a dropped table is dead weight that
      // would quietly stop covering anything.
      expect(
        missing,
        `tenant-scoped tables with no isolation fixture: ${missing.join(', ')}`,
      ).toEqual([]);
      expect(stale, `fixtures for tables that no longer exist: ${stale.join(', ')}`).toEqual([]);

      // A table cannot be both exempted for bespoke handling and registered in
      // the generic matrix — that combination means one of the two is a leftover
      // and nobody can tell which is authoritative.
      const contradictory = ISOLATION_BESPOKE_TABLES.filter((t) => registered.includes(t));
      expect(
        contradictory,
        `tables both exempted for bespoke handling and registered in the generic matrix: ${contradictory.join(', ')}`,
      ).toEqual([]);
    });
  });

  /**
   * The matrix, applied to every registered fixture. Generates nothing at
   * scaffold — which is exactly why the self-test below exists.
   */
  describe.each(Object.entries(ISOLATION_FIXTURES))('%s', (tableName, fixture) => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const column = fixture.tenantColumn ?? 'tenant_id';

    it('a tenant cannot read another tenant rows', async () => {
      await withTenant(app, tenantA, (tx) => fixture.seed(tx, tenantA));
      await withTenant(app, tenantB, (tx) => fixture.seed(tx, tenantB));

      const visible = await withTenant(app, tenantA, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM public.${tableName} WHERE ${column} = $1::uuid`,
          tenantB,
        ),
      );
      expect(visible[0]?.n).toBe(0);
    });

    it('cross-tenant UPDATE and DELETE affect zero rows', async () => {
      const updated = await withTenant(app, tenantA, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE public.${tableName} SET ${column} = ${column} WHERE ${column} = $1::uuid`,
          tenantB,
        ),
      );
      expect(updated).toBe(0);

      const deleted = await withTenant(app, tenantA, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM public.${tableName} WHERE ${column} = $1::uuid`, tenantB),
      );
      expect(deleted).toBe(0);
    });

    it('INSERT for a foreign tenant is rejected by WITH CHECK', async () => {
      // Catches a policy written with USING but no WITH CHECK — reads isolated,
      // writes not.
      await expect(withTenant(app, tenantA, (tx) => fixture.seed(tx, tenantB))).rejects.toThrow(
        /row-level security/i,
      );
    });

    it('with no tenant context set, nothing is visible', async () => {
      const visible = await withTenant(app, null, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.${tableName}`),
      );
      expect(visible[0]?.n).toBe(0);
    });
  });

  /**
   * Self-test of the matrix logic against a scratch tenant-scoped table.
   *
   * Without this the matrix would ship as unexercised code that first runs in
   * step 4, when a genuine isolation failure and a bug in the harness would look
   * identical. It also proves the per-request `SET LOCAL app.current_tenant`
   * mechanism itself — nothing else at scaffold does.
   */
  describe('matrix self-test (scratch table)', () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    beforeAll(async () => {
      await execAll(migrator, [
        `DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`,
        `CREATE SCHEMA ${PROBE_SCHEMA}`,
        `GRANT USAGE ON SCHEMA ${PROBE_SCHEMA} TO meterlog_app`,
        `CREATE TABLE ${PROBE_SCHEMA}.widgets (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           tenant_id uuid NOT NULL,
           label text NOT NULL
         )`,
        `ALTER TABLE ${PROBE_SCHEMA}.widgets ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${PROBE_SCHEMA}.widgets FORCE ROW LEVEL SECURITY`,
        // The policy shape every tenant-scoped table will carry.
        `CREATE POLICY tenant_isolation ON ${PROBE_SCHEMA}.widgets
           FOR ALL TO meterlog_app
           USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
           WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_SCHEMA}.widgets TO meterlog_app`,
      ]);
    });

    afterAll(async () => {
      await execAll(migrator, [`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`]);
    });

    const seed = (tx: PrismaClient, tenantId: string) =>
      tx.$executeRawUnsafe(
        `INSERT INTO ${PROBE_SCHEMA}.widgets (tenant_id, label) VALUES ($1::uuid, 'row')`,
        tenantId,
      );

    it('seeds each tenant a row under its own context', async () => {
      await withTenant(app, tenantA, (tx) => seed(tx, tenantA));
      await withTenant(app, tenantB, (tx) => seed(tx, tenantB));

      const mine = await withTenant(app, tenantA, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${PROBE_SCHEMA}.widgets`,
        ),
      );
      expect(mine[0]?.n).toBe(1);
    });

    it('a tenant cannot read another tenant rows', async () => {
      const visible = await withTenant(app, tenantA, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${PROBE_SCHEMA}.widgets WHERE tenant_id = $1::uuid`,
          tenantB,
        ),
      );
      expect(visible[0]?.n).toBe(0);
    });

    it('cross-tenant UPDATE and DELETE affect zero rows', async () => {
      const updated = await withTenant(app, tenantA, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE ${PROBE_SCHEMA}.widgets SET label = 'hijacked' WHERE tenant_id = $1::uuid`,
          tenantB,
        ),
      );
      expect(updated).toBe(0);

      const deleted = await withTenant(app, tenantA, (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM ${PROBE_SCHEMA}.widgets WHERE tenant_id = $1::uuid`,
          tenantB,
        ),
      );
      expect(deleted).toBe(0);

      // B's row is untouched — proving the zero counts above are RLS filtering,
      // not an accidentally empty table.
      const survived = await withTenant(app, tenantB, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${PROBE_SCHEMA}.widgets WHERE label = 'row'`,
        ),
      );
      expect(survived[0]?.n).toBe(1);
    });

    it('INSERT for a foreign tenant is rejected by WITH CHECK', async () => {
      await expect(withTenant(app, tenantA, (tx) => seed(tx, tenantB))).rejects.toThrow(
        /row-level security/i,
      );
    });

    it('with no tenant context set, nothing is visible', async () => {
      const visible = await withTenant(app, null, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${PROBE_SCHEMA}.widgets`,
        ),
      );
      expect(visible[0]?.n).toBe(0);
    });
  });
});
