import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertNoResidualRows, migratorClient, resetDatabase } from './helpers';

/**
 * The shared teardown, and the guard that makes it fail loudly.
 *
 * Teardown used to be hand-rolled at a dozen sites, each hard-coding an FK order
 * or assuming zero residue, and none of them failing loudly. `readings` landing at
 * step 6 phase 2 armed the trap: `isolation.spec.ts`'s teardown did not know about
 * it, threw `23503` partway, never reached its `users`/`tenants` deletes, and the
 * leftover `assets` rows broke **31 tests in `membership-writes.spec.ts`** — a file
 * with no relationship to the change, reporting a foreign-key error that named
 * neither the cause nor the culprit.
 *
 * `resetDatabase` fixes the ordering by delegating it to Postgres. This file
 * exercises the other half: that a failure to clean up is caught AT THE SITE THAT
 * CAUSED IT.
 */
describe('shared test teardown', () => {
  let migrator: PrismaClient;

  beforeAll(() => {
    migrator = migratorClient();
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await migrator.$disconnect();
  });

  it('leaves every managed table empty', async () => {
    await resetDatabase(migrator);
    // resetDatabase asserts this internally; asserting again here is what makes
    // the guard's PASSING case visible in the suite output rather than implicit.
    await expect(assertNoResidualRows(migrator)).resolves.toBeUndefined();
  });

  it('THROWS, naming the table, when a single stray row survives', async () => {
    // THE PROOF THE GUARD IS NOT DECORATIVE.
    //
    // A regression guard that has never been seen to fail is indistinguishable
    // from one that cannot fail. So the residue is planted deliberately and the
    // guard is called directly — the same method that confirmed the phase 2
    // breakage, where a single planted `assets` row reproduced the cross-suite
    // failure instead of a green re-run being taken as evidence.
    //
    // One row is the whole point: one is all it took to break 31 tests.
    await resetDatabase(migrator);

    const tenantId = randomUUID();
    await migrator.$executeRawUnsafe(
      `INSERT INTO public.tenants (id, name) VALUES ($1::uuid, 'stray')`,
      tenantId,
    );

    await expect(assertNoResidualRows(migrator)).rejects.toThrow(/tenants=1/);

    // And the message must point at the fix, not merely report dirt.
    await expect(assertNoResidualRows(migrator)).rejects.toThrow(/resetDatabase/);

    // Cleaning up through the helper under test also demonstrates it recovers the
    // database from exactly the state it just refused to accept.
    await resetDatabase(migrator);
    await expect(assertNoResidualRows(migrator)).resolves.toBeUndefined();
  });

  it('names EVERY dirty table, not just the first', async () => {
    // A guard that stops at the first offender sends whoever is debugging back for
    // a second run to discover the next one. The FK chain here also proves CASCADE
    // is doing the ordering: a tenant with an asset cannot be removed parent-first.
    await resetDatabase(migrator);

    const tenantId = randomUUID();
    await migrator.$executeRawUnsafe(
      `INSERT INTO public.tenants (id, name) VALUES ($1::uuid, 'stray')`,
      tenantId,
    );
    await migrator.$executeRawUnsafe(
      `INSERT INTO public.assets (tenant_id, serial_number, type)
       VALUES ($1::uuid, 'STRAY-1', 'meter')`,
      tenantId,
    );

    const error = await assertNoResidualRows(migrator).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/assets=1/);
    expect((error as Error).message).toMatch(/tenants=1/);

    await resetDatabase(migrator);
  });

  it('truncates a child whose parent is listed — CASCADE resolves the FK order', async () => {
    // The property that replaced the hand-ordered lists. `readings` and
    // `asset_events` reference `assets` ON DELETE RESTRICT, so any parent-first
    // DELETE raises 23503. TRUNCATE ... CASCADE does not care about order, and
    // this is the case that would have caught the phase 2 breakage before it
    // reached another suite.
    await resetDatabase(migrator);

    const tenantId = randomUUID();
    const userId = randomUUID();
    await migrator.$executeRawUnsafe(
      `INSERT INTO public.tenants (id, name) VALUES ($1::uuid, 'cascade')`,
      tenantId,
    );
    await migrator.$executeRawUnsafe(
      `INSERT INTO public.users (id, email, password_hash) VALUES ($1::uuid, $2, 'x')`,
      userId,
      `cascade-${userId.slice(0, 8)}@example.test`,
    );
    const [asset] = await migrator.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO public.assets (tenant_id, serial_number, type)
       VALUES ($1::uuid, 'CASCADE-1', 'meter') RETURNING id::text AS id`,
      tenantId,
    );
    await migrator.$executeRawUnsafe(
      `INSERT INTO public.readings (tenant_id, asset_id, value, unit, read_at, created_by)
       VALUES ($1::uuid, $2::uuid, 1.0, 'kWh', now(), $3::uuid)`,
      tenantId,
      asset!.id,
      userId,
    );
    await migrator.$executeRawUnsafe(
      `INSERT INTO public.asset_events (tenant_id, asset_id, event_type, created_by)
       VALUES ($1::uuid, $2::uuid, 'created', $3::uuid)`,
      tenantId,
      asset!.id,
      userId,
    );

    // A full parent-child-grandchild graph, removed in one statement with no
    // ordering knowledge anywhere in the test suite.
    await resetDatabase(migrator);
    await expect(assertNoResidualRows(migrator)).resolves.toBeUndefined();
  });
});
