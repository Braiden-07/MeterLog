import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APPEND_ONLY_TABLES,
  ISOLATION_BESPOKE_TABLES,
  ISOLATION_FIXTURES,
  type IsolationSeedContext,
  RLS_EXEMPT_TABLES,
  appClient,
  capturePgFailure,
  execAll,
  migratorClient,
  seedIsolationContext,
  seedIsolationUser,
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

// ONE tenant pair for the whole matrix, generated at module scope so the
// privileged seeding below can create real rows for them before any fixture runs.
// Sharing them across tables is safe — each fixture writes a different table.
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const FIXTURE_USER = randomUUID();

describe('catalog-driven tenant isolation', () => {
  let app: PrismaClient;
  let migrator: PrismaClient;
  let contexts: Record<string, IsolationSeedContext>;

  beforeAll(async () => {
    app = appClient();
    migrator = migratorClient();

    // WRINKLE 1, CLOSED. Until step 6 the matrix invented tenant UUIDs and never
    // created rows for them, which went unnoticed only because the sole table it
    // had ever run against was a scratch table with no foreign keys. `assets`
    // references `public.tenants`, and the app role is SELECT-only there, so the
    // parents must be seeded by the MIGRATION role before anything else happens.
    await seedIsolationUser(migrator, FIXTURE_USER);
    contexts = await seedIsolationContext(migrator, [TENANT_A, TENANT_B], FIXTURE_USER);
  });

  afterAll(async () => {
    // Domain rows first: `assets.tenant_id` is ON DELETE RESTRICT, so a leftover
    // asset would make a later suite's `DELETE FROM public.tenants` fail with
    // 23503 rather than a legible error about this suite.
    await execAll(migrator, [
      'DELETE FROM public.asset_events',
      'DELETE FROM public.assets',
      `DELETE FROM public.users WHERE id = '${FIXTURE_USER}'`,
      `DELETE FROM public.tenants WHERE id = '${TENANT_A}'`,
      `DELETE FROM public.tenants WHERE id = '${TENANT_B}'`,
    ]);
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

    it('every fixture declares write capabilities consistent with APPEND_ONLY_TABLES', async () => {
      // Binds the two DECLARATIONS to each other. Catalog assertion 13 binds
      // APPEND_ONLY_TABLES to the actual grants; this binds it to what the matrix
      // will assert. Without this pair, declaring a table append-only in one
      // place and mutable in the other produces a suite that tests the wrong
      // thing while staying green.
      //
      // The implication runs ONE WAY, deliberately: append-only means neither
      // flag may be set, but the converse does not hold — `assets` is a mutable
      // table that still declares `delete: false`, because it is soft-deleted and
      // holds no DELETE grant.
      const violations = Object.entries(ISOLATION_FIXTURES)
        .filter(([table]) => APPEND_ONLY_TABLES.includes(table))
        .filter(([, fixture]) => fixture.appWrites.update || fixture.appWrites.delete)
        .map(([table]) => table);

      expect(
        violations,
        `declared append-only but the fixture claims update/delete: ${violations.join(', ')}`,
      ).toEqual([]);
    });

    it('every append-only table actually exists in the catalog', async () => {
      // Stops APPEND_ONLY_TABLES rotting into a list of names that no longer mean
      // anything — the same both-directions discipline the fixture registry has.
      const rows = await app.$queryRawUnsafe<{ table_name: string }[]>(`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
      `);
      const present = rows.map((r) => r.table_name);
      const phantom = APPEND_ONLY_TABLES.filter((t) => !present.includes(t));

      expect(phantom, `declared append-only but no such table: ${phantom.join(', ')}`).toEqual([]);
    });
  });

  /**
   * The matrix, applied to every registered fixture.
   *
   * FROM SCAFFOLD UNTIL STEP 6 PHASE 1 THIS GENERATED NOTHING — which is what the
   * scratch-table self-test below exists to compensate for. It now generates
   * against `assets` and `asset_events`: the two different WRITE SHAPES the
   * domain contains, so the contract meets both before it is trusted.
   */
  describe.each(Object.entries(ISOLATION_FIXTURES))('%s', (tableName, fixture) => {
    const column = fixture.tenantColumn ?? 'tenant_id';
    const ctxA = (): IsolationSeedContext => contexts[TENANT_A]!;
    const ctxB = (): IsolationSeedContext => contexts[TENANT_B]!;

    it('a tenant cannot read another tenant rows', async () => {
      await withTenant(app, TENANT_A, (tx) => fixture.seed(tx, ctxA()));
      await withTenant(app, TENANT_B, (tx) => fixture.seed(tx, ctxB()));

      const visible = await withTenant(app, TENANT_A, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM public.${tableName} WHERE ${column} = $1::uuid`,
          TENANT_B,
        ),
      );
      expect(visible[0]?.n).toBe(0);
    });

    // WRINKLE 3, CLOSED. The write cases branch on the fixture's DECLARED
    // capability, never on `has_table_privilege` — reading the live grant would
    // make the assertion agree with whatever the grant happens to be, which
    // catches nothing. Where a write is declared, a cross-tenant attempt must
    // report ZERO ROWS (the policy filtered it); where it is not, the statement
    // must be REFUSED OUTRIGHT (the grant was never made).
    it(
      fixture.appWrites.update
        ? 'cross-tenant UPDATE affects zero rows'
        : 'UPDATE is refused outright — no such grant',
      async () => {
        const attempt = (): Promise<number> =>
          withTenant(app, TENANT_A, (tx) =>
            tx.$executeRawUnsafe(
              `UPDATE public.${tableName} SET ${column} = ${column} WHERE ${column} = $1::uuid`,
              TENANT_B,
            ),
          );

        if (fixture.appWrites.update) {
          expect(await attempt()).toBe(0);
        } else {
          const failure = await capturePgFailure(attempt());
          expect(failure.sqlstate).toBe('42501');
          expect(failure.message).toMatch(/permission denied/i);
        }
      },
    );

    it(
      fixture.appWrites.delete
        ? 'cross-tenant DELETE affects zero rows'
        : 'DELETE is refused outright — no such grant',
      async () => {
        const attempt = (): Promise<number> =>
          withTenant(app, TENANT_A, (tx) =>
            tx.$executeRawUnsafe(
              `DELETE FROM public.${tableName} WHERE ${column} = $1::uuid`,
              TENANT_B,
            ),
          );

        if (fixture.appWrites.delete) {
          expect(await attempt()).toBe(0);
        } else {
          const failure = await capturePgFailure(attempt());
          expect(failure.sqlstate).toBe('42501');
          expect(failure.message).toMatch(/permission denied/i);
        }
      },
    );

    it('INSERT for a foreign tenant is rejected by WITH CHECK (42501, policy)', async () => {
      // Catches a policy written with USING but no WITH CHECK — reads isolated,
      // writes not.
      //
      // ASSERTED ON SQLSTATE **AND** MESSAGE, and that is not belt-and-braces.
      // Postgres raises 42501 both for "a policy refused this row" and for "this
      // role holds no such privilege". A negative asserting the code alone would
      // stay green if the policy vanished and a missing grant did the refusing
      // instead — proving nothing about isolation. The message is what separates
      // the two mechanisms.
      const failure = await capturePgFailure(
        withTenant(app, TENANT_A, (tx) => fixture.seed(tx, ctxB())),
      );
      expect(failure.sqlstate).toBe('42501');
      expect(failure.message).toMatch(/row-level security/i);
      expect(failure.message).not.toMatch(/permission denied/i);
    });

    it('with no tenant context set, nothing is visible', async () => {
      const visible = await withTenant(app, null, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.${tableName}`),
      );
      expect(visible[0]?.n).toBe(0);
    });
  });

  /**
   * The ADR-007 composite-FK consistency proof.
   *
   * Bespoke rather than generated, because it is a property of a CHILD table and
   * the matrix has no notion of parentage — the fixture contract deliberately
   * hands children a pre-built parent instead of modelling the relationship.
   *
   * The mechanism under test: `asset_events.tenant_id` is denormalized so its RLS
   * policy can be the canonical single-column expression with no subquery. That
   * denormalization is exactly what allows the two halves to disagree, and RLS
   * CANNOT SEE THE DISAGREEMENT — the policy compares `tenant_id` to the GUC and
   * that half is correct. The row would be perfectly isolated and attached to the
   * wrong tenant's asset.
   */
  describe('composite FK (ADR-007) — a child cannot disagree with its parent', () => {
    it('rejects a child row whose tenant differs from its asset (23503, not RLS)', async () => {
      // Constructed so ONLY the FK can fire: acting in B, writing tenant_id = B,
      // so the WITH CHECK is satisfied — but pointing at an asset owned by A.
      // If this raised 42501 it would mean RLS stopped it and the FK went
      // untested, which is why the SQLSTATE is asserted rather than "it threw".
      const failure = await capturePgFailure(
        withTenant(app, TENANT_B, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.asset_events (tenant_id, asset_id, event_type, created_by)
             VALUES ($1::uuid, $2::uuid, 'created', $3::uuid)`,
            TENANT_B,
            contexts[TENANT_A]!.assetId,
            FIXTURE_USER,
          ),
        ),
      );

      expect(failure.sqlstate).toBe('23503');
      expect(failure.message).toMatch(/asset_events_asset_tenant_fkey/);
      // Distinctly NOT the RLS rejection — two mechanisms, two assertions.
      expect(failure.message).not.toMatch(/row-level security/i);
    });

    it('accepts a child row whose tenant agrees with its asset', async () => {
      // The non-vacuous half. Without it, a constraint that rejected EVERYTHING
      // would satisfy the negative above and nobody would notice.
      const before = await withTenant(app, TENANT_A, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.asset_events`),
      );

      await withTenant(app, TENANT_A, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO public.asset_events (tenant_id, asset_id, event_type, created_by)
           VALUES ($1::uuid, $2::uuid, 'created', $3::uuid)`,
          TENANT_A,
          contexts[TENANT_A]!.assetId,
          FIXTURE_USER,
        ),
      );

      const after = await withTenant(app, TENANT_A, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.asset_events`),
      );
      expect(after[0]!.n).toBe(before[0]!.n + 1);
    });

    it('the migration role cannot write a mismatched child either', async () => {
      // The property ADR-007 chose a constraint FOR. RLS protects nothing here —
      // the migration role is not subject to these policies at all — so if this
      // were enforced in a policy, or in application code, or in a trigger that
      // someone disabled, a privileged path would write the inconsistent row.
      // A constraint holds against every role and every connection.
      const failure = await capturePgFailure(
        migrator.$executeRawUnsafe(
          `INSERT INTO public.asset_events (tenant_id, asset_id, event_type, created_by)
           VALUES ($1::uuid, $2::uuid, 'created', $3::uuid)`,
          TENANT_B,
          contexts[TENANT_A]!.assetId,
          FIXTURE_USER,
        ),
      );

      expect(failure.sqlstate).toBe('23503');
      expect(failure.message).toMatch(/asset_events_asset_tenant_fkey/);
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
