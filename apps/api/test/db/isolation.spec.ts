import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APPEND_ONLY_TABLES,
  ISOLATION_BESPOKE_TABLES,
  ISOLATION_FIXTURES,
  RLS_EXEMPT_TABLES,
  appClient,
  capturePgFailure,
  execAll,
  migratorClient,
  resetDatabase,
  seedIsolationContext,
  seedIsolationUser,
  type IsolationSeedContext,
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
    // RESET FIRST, THEN SEED — the order matters and is therefore explicit here
    // rather than hidden inside a seeding helper. resetDatabase truncates `users`
    // and `tenants` as well as the domain tables, so seeding the attribution user
    // before the reset would destroy it and every child row's created_by FK would
    // fail with 23503.
    await resetDatabase(migrator);
    await seedIsolationUser(migrator, FIXTURE_USER);
    contexts = await seedIsolationContext(migrator, [TENANT_A, TENANT_B], FIXTURE_USER);
  });

  afterAll(async () => {
    // Shared catalog-derived teardown. This used to be a hand-ordered list of
    // DELETEs carrying a note that every new FK-child of `assets` had to be added
    // to it — the note was accurate and still did not work: `readings` landed and
    // the list was not updated, which broke 31 tests in a suite this file does not
    // touch. TRUNCATE ... CASCADE hands the ordering to Postgres, and
    // resetDatabase verifies zero rows afterwards.
    await resetDatabase(migrator);
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

    it('rejects a mismatched READING too — the mechanism generalises (23503)', async () => {
      // THE POINT OF PHASE 2. asset_events proved the composite FK works; this
      // proves it is a REUSABLE CONTRACT rather than something wired by hand for
      // one table. Same constraint shape, same SQLSTATE, different child, no new
      // mechanism — and if readings had needed one, the Phase 1 design was wrong.
      //
      // Constructed so ONLY the FK can fire, exactly as the asset_events negative
      // is: acting in B, writing tenant_id = B so the WITH CHECK is satisfied, but
      // pointing at an asset owned by A.
      const failure = await capturePgFailure(
        withTenant(app, TENANT_B, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.readings (tenant_id, asset_id, value, unit, read_at, created_by)
             VALUES ($1::uuid, $2::uuid, 1.0, 'kWh', now(), $3::uuid)`,
            TENANT_B,
            contexts[TENANT_A]!.assetId,
            FIXTURE_USER,
          ),
        ),
      );

      expect(failure.sqlstate).toBe('23503');
      expect(failure.message).toMatch(/readings_asset_tenant_fkey/);
      // Distinctly NOT the RLS rejection — two mechanisms, two assertions.
      expect(failure.message).not.toMatch(/row-level security/i);
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
   * `maintenance_records` — the MUTABLE child (ADR-008).
   *
   * Three properties here that none of the other domain tables needed, because it
   * is the first table with a general `UPDATE`:
   *
   *   1. **Tenant immutability under UPDATE.** The append-only children have no
   *      UPDATE path at all, so their `WITH CHECK` governs only INSERT. A general
   *      UPDATE could rewrite `tenant_id` and walk a row into another tenant.
   *   2. **Soft delete without the OPEN-5 deadlock.** The soft-delete write is an
   *      `UPDATE ... SET deleted_at`, and Postgres applies the SELECT policy to the
   *      NEW ROW of an `UPDATE ... WHERE` — so a liveness predicate in the policy
   *      would block the very statement it was meant to guard.
   *   3. **Hard DELETE refused by a missing grant**, which is how ADR-008's
   *      soft-delete-only decision is proven rather than asserted.
   */
  describe('maintenance_records — the mutable child (ADR-008)', () => {
    const seedRecord = (tenantId: string, assetId: string, description = 'annual service') =>
      withTenant(app, tenantId, (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `INSERT INTO public.maintenance_records
             (tenant_id, asset_id, description, performed_at, created_by)
           VALUES ($1::uuid, $2::uuid, $3, now(), $4::uuid)
           RETURNING id::text AS id`,
          tenantId,
          assetId,
          description,
          FIXTURE_USER,
        ),
      );

    it('rejects a record pointing at an asset in another tenant (23503, not RLS)', async () => {
      // ADR-007's composite FK on its THIRD child. Constructed so only the FK can
      // fire: acting in B with tenant_id = B, so the WITH CHECK is satisfied, but
      // pointing at an asset owned by A.
      const failure = await capturePgFailure(
        withTenant(app, TENANT_B, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO public.maintenance_records
               (tenant_id, asset_id, description, performed_at, created_by)
             VALUES ($1::uuid, $2::uuid, 'x', now(), $3::uuid)`,
            TENANT_B,
            contexts[TENANT_A]!.assetId,
            FIXTURE_USER,
          ),
        ),
      );

      expect(failure.sqlstate).toBe('23503');
      expect(failure.message).toMatch(/maintenance_records_asset_tenant_fkey/);
      expect(failure.message).not.toMatch(/row-level security/i);
    });

    it('TENANT IMMUTABILITY — an UPDATE cannot move a row to another tenant (42501)', async () => {
      // THE PROPERTY A GENERAL-UPDATE TABLE NEEDS AND THE APPEND-ONLY CHILDREN
      // NEVER DID. Their WITH CHECK only ever governs INSERT because they have no
      // UPDATE path; here it is what refuses a row walking between tenants.
      const rows = await seedRecord(TENANT_A, contexts[TENANT_A]!.assetId);
      const id = rows[0]!.id;

      const failure = await capturePgFailure(
        withTenant(app, TENANT_A, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE public.maintenance_records SET tenant_id = $1::uuid WHERE id = $2::uuid`,
            TENANT_B,
            id,
          ),
        ),
      );

      expect(failure.sqlstate).toBe('42501');
      expect(failure.message).toMatch(/row-level security/i);
      // Distinctly NOT a privilege failure: UPDATE *is* granted on this table, so a
      // "permission denied" here would mean the grant was wrong rather than the
      // policy doing its job.
      expect(failure.message).not.toMatch(/permission denied/i);

      // The row stayed in A.
      const where = await migrator.$queryRawUnsafe<{ tenant_id: string }[]>(
        `SELECT tenant_id::text AS tenant_id FROM public.maintenance_records WHERE id = $1::uuid`,
        id,
      );
      expect(where[0]!.tenant_id).toBe(TENANT_A);
    });

    it('the general field UPDATE works — the grant and policy permit real edits', async () => {
      // Pairs with the negative above the way assertion 10 pairs with 9. "Cannot
      // move tenants" is trivially satisfied by a table nobody can update at all,
      // which would be fail-closed and broken: this is the only domain table where
      // editing a field is a legitimate operation.
      const rows = await seedRecord(TENANT_A, contexts[TENANT_A]!.assetId, 'before');
      const id = rows[0]!.id;

      const affected = await withTenant(app, TENANT_A, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE public.maintenance_records SET description = 'after', updated_at = now()
            WHERE id = $1::uuid`,
          id,
        ),
      );
      expect(affected).toBe(1);

      const after = await migrator.$queryRawUnsafe<{ description: string }[]>(
        `SELECT description FROM public.maintenance_records WHERE id = $1::uuid`,
        id,
      );
      expect(after[0]!.description).toBe('after');
    });

    it('SOFT DELETE does not deadlock against its own SELECT policy (OPEN-5 reused)', async () => {
      // THE OPEN-5 TRAP, PROVEN AVOIDED RATHER THAN ASSUMED.
      //
      // Postgres applies a table's SELECT-applicable policy to the NEW ROW of an
      // `UPDATE ... WHERE`. So a policy predicate of `deleted_at IS NULL` would make
      // the revoking UPDATE — the one that sets `deleted_at` — fail to see the row
      // it just wrote, which is the deadlock recorded on `memberships`.
      //
      // This table's policy carries no `deleted_at` term, so the soft-delete write
      // succeeds and reports one row affected. If someone adds liveness to the
      // policy "to be consistent with the read path", this is what reddens.
      const rows = await seedRecord(TENANT_A, contexts[TENANT_A]!.assetId);
      const id = rows[0]!.id;

      const affected = await withTenant(app, TENANT_A, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE public.maintenance_records SET deleted_at = now() WHERE id = $1::uuid`,
          id,
        ),
      );
      expect(affected).toBe(1);

      // The row persists — soft, not hard.
      const after = await migrator.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
        `SELECT deleted_at FROM public.maintenance_records WHERE id = $1::uuid`,
        id,
      );
      expect(after).toHaveLength(1);
      expect(after[0]!.deleted_at).not.toBeNull();

      // And a soft-deleted row is still VISIBLE to the policy — liveness is an
      // application concern. If it were filtered here, the soft delete would be
      // indistinguishable from a hard one and the history would be unreachable.
      const stillVisible = await withTenant(app, TENANT_A, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM public.maintenance_records WHERE id = $1::uuid`,
          id,
        ),
      );
      expect(stillVisible[0]!.n).toBe(1);
    });

    it('HARD DELETE is refused by a missing grant — ADR-008 proven, not asserted', async () => {
      // THE CENTERPIECE OF PHASE 4. "Soft delete for v1.0" is true exactly as long
      // as the DELETE privilege is absent, and this is the demonstration.
      //
      // Asserted on SQLSTATE **and** message: 42501 alone cannot distinguish "a
      // policy refused this row" from "this role holds no such privilege", and here
      // it must be the latter — the policy would happily permit deleting an own-
      // tenant row, so a policy-shaped refusal would mean the grant was wrong.
      const rows = await seedRecord(TENANT_A, contexts[TENANT_A]!.assetId);
      const id = rows[0]!.id;

      const failure = await capturePgFailure(
        withTenant(app, TENANT_A, (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM public.maintenance_records WHERE id = $1::uuid`, id),
        ),
      );

      expect(failure.sqlstate).toBe('42501');
      expect(failure.message).toMatch(/permission denied for table maintenance_records/);
      expect(failure.message).not.toMatch(/row-level security/i);

      // The row is untouched — the refusal happened before anything was removed.
      const survived = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.maintenance_records WHERE id = $1::uuid`,
        id,
      );
      expect(survived[0]!.n).toBe(1);
    });
  });

  /**
   * `assets_tenant_serial_live_key` — serial numbers are unique PER TENANT and
   * only AMONG LIVE ROWS (decided at the Phase 1 gate).
   *
   * Directly follows the `memberships_user_tenant_live_key` precedent (ADR-006
   * §2): the partial `WHERE deleted_at IS NULL` is what stops a decommissioned
   * serial from reserving itself forever, exactly as a revoked membership must not
   * block re-invitation.
   *
   * All three properties are proven, because each one fails differently: drop the
   * uniqueness and duplicates appear; drop the `tenant_id` column from the key and
   * tenants collide with each other; drop the `WHERE` and re-registration breaks.
   * A single test could not distinguish those.
   */
  describe('serial numbers — unique per tenant, among live rows', () => {
    const insertAsset = (tenantId: string, serial: string): Promise<number> =>
      withTenant(app, tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO public.assets (tenant_id, serial_number, type, status)
           VALUES ($1::uuid, $2, 'meter', 'installed')`,
          tenantId,
          serial,
        ),
      );

    it('pins the index by name, columns and partial predicate', async () => {
      // WHY THIS EXISTS, and it is a real limitation rather than belt-and-braces.
      //
      // The other negatives in this file assert SQLSTATE **and** message, because
      // the message is what separates two mechanisms sharing a code. That is not
      // available for unique violations: PRISMA NORMALISES THEM AND DISCARDS THE
      // CONSTRAINT NAME. Measured on this database:
      //
      //   app role (Prisma engine)  23505  "Unique constraint failed: "   <- empty
      //   migration role            23505  "Key (tenant_id, serial_number)=(...)"
      //
      // So `assets_tenant_serial_live_key` cannot be asserted from the app-role
      // error at all. Rather than weaken the negative below to a bare code — which
      // ANY unique constraint on the table would satisfy, including the
      // `(id, tenant_id)` key that exists for an entirely different reason — the
      // name and shape are pinned structurally here, and the negative asserts the
      // mechanism. Together they are what the message match would have given.
      const rows = await app.$queryRawUnsafe<{ indexdef: string }[]>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'assets'
            AND indexname = 'assets_tenant_serial_live_key'`,
      );

      expect(rows, 'assets_tenant_serial_live_key is missing').toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/UNIQUE/);
      expect(rows[0]!.indexdef).toMatch(/\(tenant_id, serial_number\)/);
      // The partial predicate is the load-bearing half — without it, re-registering
      // a decommissioned serial breaks. Pinned so removing it cannot pass silently.
      expect(rows[0]!.indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/);
    });

    it('rejects a duplicate live serial in the same tenant (23505, not RLS)', async () => {
      const serial = `DUP-${randomUUID()}`;
      await insertAsset(TENANT_A, serial);

      const failure = await capturePgFailure(insertAsset(TENANT_A, serial));

      // 23505 is unique_violation, and is kept distinct from the other two
      // mechanisms this suite exercises: 23503 (the ADR-007 composite FK) and
      // 42501 (RLS policy / missing privilege). The `.not` guards are what stop
      // this passing because some unrelated layer refused the row.
      expect(failure.sqlstate).toBe('23505');
      expect(failure.message).not.toMatch(/row-level security/i);
      expect(failure.message).not.toMatch(/permission denied/i);
    });

    it('names the violated columns when raised outside the Prisma normaliser', async () => {
      // The other half of the name-pinning problem. The migration role reaches the
      // same constraint without the query engine rewriting the error, so the
      // COLUMN PAIR is recoverable there even though the index name is not
      // recoverable anywhere. This is what proves the duplicate above was refused
      // by the (tenant_id, serial_number) key specifically and not by the
      // (id, tenant_id) key or the primary key.
      const serial = `DUPRAW-${randomUUID()}`;
      await insertAsset(TENANT_A, serial);

      const failure = await capturePgFailure(
        migrator.$executeRawUnsafe(
          `INSERT INTO public.assets (tenant_id, serial_number, type, status)
           VALUES ($1::uuid, $2, 'meter', 'installed')`,
          TENANT_A,
          serial,
        ),
      );

      expect(failure.sqlstate).toBe('23505');
      expect(failure.message).toMatch(/tenant_id, serial_number/);
    });

    it('accepts the same serial in a DIFFERENT tenant', async () => {
      // The uniqueness is per tenant, not global. Without `tenant_id` in the key,
      // one tenant registering a meter would block another tenant from
      // registering its own — a cross-tenant interference channel that leaks the
      // existence of another tenant's data through an error message, which is a
      // worse failure than the inconvenience.
      const serial = `SHARED-${randomUUID()}`;
      await insertAsset(TENANT_A, serial);
      await insertAsset(TENANT_B, serial);

      const inB = await withTenant(app, TENANT_B, (tx) =>
        tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM public.assets WHERE serial_number = $1`,
          serial,
        ),
      );
      expect(inB[0]!.n).toBe(1);
    });

    it('accepts re-registering the serial of a SOFT-DELETED asset', async () => {
      // The property the partial WHERE exists for. Decommissioning an asset must
      // not permanently consume its serial number.
      const serial = `REREG-${randomUUID()}`;
      await insertAsset(TENANT_A, serial);

      const softDeleted = await withTenant(app, TENANT_A, (tx) =>
        tx.$executeRawUnsafe(
          // Decommission sets BOTH columns. Phase 3b added the
          // `assets_decommissioned_iff_deleted` CHECK, which makes
          // `deleted_at`-without-`status` unrepresentable — and this fixture used
          // to write exactly that. Corrected rather than the constraint weakened:
          // soft-deleting an asset IS decommissioning it (decision 9), so a
          // fixture that set only `deleted_at` was modelling a state the product
          // does not have.
          `UPDATE public.assets SET deleted_at = now(), status = 'decommissioned'
            WHERE tenant_id = $1::uuid AND serial_number = $2`,
          TENANT_A,
          serial,
        ),
      );
      expect(softDeleted).toBe(1);

      // The re-registration itself. With a PLAIN unique index this raises 23505.
      await insertAsset(TENANT_A, serial);

      const rows = await withTenant(app, TENANT_A, (tx) =>
        tx.$queryRawUnsafe<{ live: number; total: number }[]>(
          `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS live,
                  count(*)::int AS total
             FROM public.assets WHERE serial_number = $1`,
          serial,
        ),
      );
      // Exactly one LIVE row, and the decommissioned one still on record — the
      // history is kept, which is the entire point of soft delete here.
      expect(rows[0]!.live).toBe(1);
      expect(rows[0]!.total).toBe(2);
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
