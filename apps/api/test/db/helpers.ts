import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

/**
 * Minimal .env loader. Vitest does not populate `process.env` from .env files,
 * and pulling in dotenv for four lines of parsing is a dependency we do not need.
 * Values already present in the environment win, so CI (which sets them directly)
 * is unaffected.
 */
export function loadEnv(): void {
  for (const candidate of ['../../.env', '../../../../.env']) {
    try {
      const raw = readFileSync(resolve(__dirname, candidate), 'utf8');
      for (const line of raw.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (!key || key in process.env) continue;
        process.env[key] = rawValue?.trim().replace(/^["']|["']$/g, '') ?? '';
      }
    } catch {
      // No .env at this path — expected in CI.
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and start the stack with \`docker compose up\`.`,
    );
  }
  return value;
}

/** Connection as `meterlog_app` — the restricted runtime role. RLS applies in full. */
export function appClient(): PrismaClient {
  loadEnv();
  return new PrismaClient({ datasources: { db: { url: required('DATABASE_URL') } } });
}

/** Connection as the migration/owner role. Used only to set up and tear down fixtures. */
export function migratorClient(): PrismaClient {
  loadEnv();
  return new PrismaClient({
    datasources: { db: { url: required('MIGRATION_DATABASE_URL') } },
  });
}

/** Runs DDL statement-by-statement; Prisma's raw API takes one statement per call. */
export async function execAll(client: PrismaClient, statements: string[]): Promise<void> {
  for (const statement of statements) {
    const trimmed = statement.trim();
    if (trimmed) await client.$executeRawUnsafe(trimmed);
  }
}

/** Tables exempt from the RLS coverage requirement. Additions need review. */
export const RLS_EXEMPT_TABLES: readonly string[] = ['_prisma_migrations'];

/**
 * Tables a SECURITY DEFINER function is permitted to reach, and the only ones
 * allowed to carry a policy scoped `TO meterlog_definer` (ADR-004, catalog
 * assertion 5). Such a policy is a hole in the isolation boundary by
 * construction, so widening this list is a reviewed edit.
 *
 * `audit_log` JOINED AT STEP 7 PHASE 7A, and it is the first entry that is not
 * an identity table — the list's meaning was always "definer-reachable", the
 * first three just happened to be the auth tables. It needs a definer policy
 * because it is under FORCE ROW LEVEL SECURITY, which applies policies to the
 * table OWNER as well, so the `audit_capture` trigger cannot insert without one
 * (ADR-009/ADR-010).
 *
 * ADDING IT HERE DOES MORE THAN SATISFY ASSERTION 5. Assertions 9 and 10 are
 * driven off this same list, and applied to `audit_log` they assert exactly
 * ADR-010: **9** that the app role holds no INSERT/UPDATE/DELETE on it — which
 * IS immutability-by-grant, pinned at the catalog level — and **10** that it is
 * nevertheless readable, so 9 cannot be satisfied by a table nobody can touch.
 * Both assertions were already written; the trail simply became their fourth
 * subject.
 */
export const DEFINER_ACCESSIBLE_TABLES: readonly string[] = [
  'tenants',
  'users',
  'memberships',
  'audit_log',
];

/**
 * The complete set of SECURITY DEFINER functions. Each is a deliberate,
 * enumerated hole in the isolation boundary; the list is asserted so one cannot
 * be added without a reviewed edit here.
 *
 * Fixed by ADR-006 §6. `login_lookup(email)` takes email alone — ADR-004's
 * login-identity question is dissolved rather than answered, since email is now
 * globally unique. `register_tenant` performs the three-row atomic insert
 * (tenant + user + membership). Both land in build-order step 4.
 *
 * STEP 5 PHASE 1 grew this list from two to five, which ADR-006 §7 names in
 * advance as the reason it would change: DECISION B made `meterlog_app`
 * structurally incapable of writing `memberships`, so invite / change-role /
 * revoke can only exist as definer functions.
 *
 * The three additions differ from the original two in the way that matters: they
 * act ON BEHALF OF AN AUTHENTICATED CALLER, so they are bound by the §7 standing
 * rule and must enforce, in their own bodies, that the caller is an admin of the
 * active tenant and that the target row belongs to it. `register_tenant` is
 * exempt (pre-auth, no acting caller); `login_lookup` is read-only. Anything
 * added here later is subject to the rule, and to `membership-writes.spec.ts`'s
 * standard of proof: the negatives are produced by calling the function directly
 * as `meterlog_app` with the GUCs set by hand, never through an HTTP guard.
 */
export const EXPECTED_DEFINER_FUNCTIONS: readonly string[] = [
  'login_lookup',
  'register_tenant',
  'invite_member',
  'change_member_role',
  'revoke_member',
  // STEP 7 PHASE 7A. `audit_capture` is the sixth, and the first that is a
  // TRIGGER function rather than one the app calls by name. It is SECURITY
  // DEFINER for a reason ADR-010 forces rather than chooses: the app role holds
  // no INSERT on `audit_log`, so an invoker-rights trigger could not write the
  // audit row, and capture would break on the very immutability it serves.
  //
  // Being a trigger function changes what the paired assertions can ask of it.
  // Assertion 12 (every definer function is callable by the app role) is
  // narrowed to exclude it, because Postgres checks EXECUTE at CREATE TRIGGER
  // time and never at fire time — granting EXECUTE would buy nothing and would
  // make 12 satisfiable by an empty gesture. Assertion 16 replaces the cover:
  // a trigger-returning definer function must actually be ATTACHED to at least
  // one trigger, so the carve-out cannot become a way to keep an unreachable
  // definer function nobody notices.
  'audit_capture',
];

/**
 * Tables deliberately excluded from the generic tenant-only isolation matrix
 * because a bespoke test covers them instead (ADR-006 §8.2).
 *
 * `memberships` carries two permissive policies — a `FOR SELECT` self axis keyed
 * on `app.current_user` and a tenant axis keyed on `app.current_tenant`. The
 * generic matrix sets only the tenant GUC, so the self axis never fires and the
 * table quietly **passes** while half its policy surface goes untested. A green
 * generic matrix here would be evidence of nothing, which is why the exclusion is
 * declared rather than left implicit: the fixture-coverage check below accounts
 * for these tables so their absence from the matrix cannot be mistaken for an
 * oversight, and their bespoke dual-axis test is mandatory.
 *
 * `users` and `tenants` are here for a second reason, which DECISION B extended
 * to `memberships` as well: the generic matrix seeds through the app role, and
 * the app role cannot write any of these three. Tenants and users are created by
 * `register_tenant` (definer); membership writes join them behind admin-checking
 * definer functions in step 5. The app role is SELECT-only on all three, asserted
 * by catalog assertion 9. The matrix's INSERT case would therefore fail with
 * "permission denied" rather than the row-level-security rejection it asserts — a
 * failure about grants, not isolation. Their policies are covered by the bespoke
 * suite, which asserts both denial layers separately.
 *
 * The generic matrix generated ZERO cases from step 4 Phase 1 until step 6
 * Phase 1, when `assets` and `asset_events` landed — the first tables the app
 * role genuinely does write. It now generates real cases against both, and the
 * list above is what keeps that fact honest: these three are absent from the
 * matrix by declaration, not by omission.
 */
export const ISOLATION_BESPOKE_TABLES: readonly string[] = [
  'memberships',
  'users',
  'tenants',
  // STEP 7 PHASE 7A — and for the SECOND of the two reasons above, exactly.
  //
  // The generic matrix seeds through the app role, and the app role holds no
  // INSERT on `audit_log` (ADR-010). Its INSERT case asserts an RLS `WITH CHECK`
  // rejection and explicitly asserts `permission denied` ABSENT — so registering
  // a fixture here would produce a failure about GRANTS while claiming to be
  // about isolation, and the only way to make it pass would be to grant the app
  // role the INSERT the whole ADR exists to withhold.
  //
  // Its coverage is the bespoke DB-layer suite in `audit.spec.ts`, which seeds
  // the audit rows the only way anything can — by performing real mutations and
  // letting the trigger write them.
  'audit_log',
];

/**
 * Request-scoped context, as the interceptor will set it in Phase 3.
 *
 * `withTenant` sets only the tenant GUC, which is all a plain tenant-scoped table
 * needs. The identity tables need both axes, and the difference is exactly why
 * the generic matrix cannot cover `memberships` (ADR-006 §8.2).
 */
export async function withContext<T>(
  client: PrismaClient,
  ctx: { userId?: string | null; tenantId?: string | null },
  body: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    if (ctx.userId) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, ctx.userId);
    }
    if (ctx.tenantId) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, ctx.tenantId);
    }
    return body(tx as unknown as PrismaClient);
  });
}

/**
 * APPEND-ONLY TABLES — the executable mirror of the declaration in CLAUDE.md.
 *
 * Rows are inserted and read, never updated and never deleted; a correction is a
 * new row. THE PROPERTY IS DECLARED HERE, NOT DERIVED FROM THE SCHEMA. It would
 * be perfectly possible to infer it — an append-only table is the one with no
 * `updated_at` and no `deleted_at` (PROJECT_BRIEF section 5 :146) — and that is
 * exactly what must not happen. PROJECT_BRIEF states it outright for
 * `asset_events` (:137) and `audit_log` (:140) but never for `readings` (:138),
 * where it exists only by omission, and a property held by omission is one
 * refactor away from ending: someone adds `updated_at` "for consistency" and
 * nothing objects.
 *
 * That is the shape of this repo's two worst bugs — `WITH CHECK` defaulting from
 * `USING` (ADR-006 section 0.1) and an operator resolving through an implicit
 * cast (ADR-004's operator amendment). Both were inferable, both were silent.
 *
 * Two assertions bind this list to reality, in opposite directions:
 *   * catalog assertion 13 — a table listed here holds EXACTLY `SELECT, INSERT`
 *     for `meterlog_app`, so a stray `GRANT UPDATE` turns CI red;
 *   * the fixture/declaration agreement check in isolation.spec.ts — a table
 *     listed here must have a fixture declaring no update and no delete.
 *
 * `audit_log` JOINED AT STEP 7 PHASE 7A, paying the row CLAUDE.md's declaration
 * table has carried since step 6. It is append-only in the STRONGEST sense of
 * any entry here: the other two are written by the app role and merely never
 * updated, while this one the app role cannot write AT ALL (ADR-010). See
 * `DEFINER_WRITTEN_APPEND_ONLY_TABLES` below for what that does to assertion 13.
 *
 * `readings` JOINED AT STEP 6 PHASE 2, and it is the entry this whole mechanism
 * was built for. `asset_events` and `audit_log` are marked append-only in the
 * brief in words (:137, :140); `readings` (:138) is NOT — it is append-only only
 * because :146 turns "no updated_at, no deleted_at" into that property. Inferring
 * it from absent columns is precisely what this list refuses to do. `audit_log`
 * joins at step 7.
 */
export const APPEND_ONLY_TABLES: readonly string[] = ['asset_events', 'readings', 'audit_log'];

/**
 * Append-only tables whose writer is the SECURITY DEFINER trigger, NOT the app
 * role — so their app-role grant is `SELECT` ALONE, with no `INSERT`.
 *
 * Derived, never hand-listed: it is exactly the tables that are both declared
 * append-only AND definer-reachable. Catalog assertion 13 reads this to pick the
 * expected grant string per table, so the equality stays an equality — `SELECT,
 * INSERT` where the app inserts, `SELECT` where the definer does — rather than
 * being relaxed to a subset to accommodate the new shape.
 *
 * **Widening the grant to satisfy the assertion would hand the app role the very
 * INSERT ADR-010 exists to withhold**, which is the same trap as granting
 * `TRUNCATE` to make a teardown convenient. Deriving the exception instead means
 * that if `audit_log` were ever removed from `DEFINER_ACCESSIBLE_TABLES`,
 * assertion 13 would tighten back to demanding `INSERT` and turn red — which is
 * the correct alarm, not a nuisance.
 */
export const DEFINER_WRITTEN_APPEND_ONLY_TABLES: readonly string[] = APPEND_ONLY_TABLES.filter(
  (t) => DEFINER_ACCESSIBLE_TABLES.includes(t),
);

/**
 * SOFT-DELETE-ONLY TABLES — tables the app role may UPDATE but never DELETE.
 *
 * The companion to `APPEND_ONLY_TABLES`, and a genuinely different profile: an
 * append-only table refuses UPDATE *and* DELETE, while these accept a general
 * UPDATE (field edits, and the `deleted_at` write that performs the soft delete)
 * and refuse only DELETE.
 *
 * **This is how ADR-008's decision is enforced rather than merely recorded.**
 * "Soft delete for v1.0" is true exactly as long as the `DELETE` privilege is
 * absent, so catalog assertion 14 asserts the grant set as an EQUALITY —
 * `SELECT, INSERT, UPDATE` and nothing more. A stray
 * `GRANT DELETE ON public.maintenance_records TO meterlog_app` would make v1.0
 * destructive in one line, two build steps before `audit_log` exists to record
 * what was destroyed (OPEN-9). That line turns CI red.
 *
 * `assets` is deliberately NOT here. Its `DELETE` endpoint is the decommission
 * transition — an UPDATE — and it holds no DELETE grant either, but its delete
 * semantics are governed by the lifecycle graph and the
 * `assets_decommissioned_iff_deleted` CHECK rather than by this list. Adding it
 * would conflate two different properties that happen to share a grant shape.
 */
export const SOFT_DELETE_ONLY_TABLES: readonly string[] = ['maintenance_records'];

/**
 * What the app role may do to a table beyond `SELECT` and `INSERT`, DECLARED per
 * fixture rather than read back from `has_table_privilege`.
 *
 * Deriving it from the live grant would make the matrix assert whatever the grant
 * happens to be, which catches nothing by construction — the same tautology that
 * made a mutated definer function indistinguishable from a correct one until
 * catalog assertion 4 was tightened to assert the pin's CONTENT rather than its
 * presence.
 *
 * Note this is NOT simply "is it append-only": `assets` is mutable and still
 * declares `delete: false`, because assets are SOFT-deleted (PROJECT_BRIEF
 * section 5 :147) and the app role is deliberately granted no `DELETE`. The
 * append-only declaration implies both flags false; the converse does not hold.
 */
export interface AppWrites {
  readonly update: boolean;
  readonly delete: boolean;
}

/**
 * Parent rows a fixture may build on, seeded by the MIGRATION role before the
 * matrix runs — see `seedIsolationContext`.
 *
 * WHY THIS EXISTS (wrinkle 1). The matrix generates its tenant ids with
 * `randomUUID()` and, until step 6, never created tenant rows to match. Nothing
 * noticed, because the only table it had ever run against was a scratch table
 * with no foreign keys. A real `tenant_id uuid REFERENCES public.tenants(id)`
 * fails its very first seed with `23503`, and the fixture cannot fix that itself:
 * the app role is `SELECT`-only on `tenants` (catalog assertion 9, DECISION B).
 * So the privileged seeding happens once, up front, exactly as the bespoke
 * membership suite has always done it.
 */
export interface IsolationSeedContext {
  /** The tenant this row must belong to. */
  readonly tenantId: string;
  /** A real user, for `created_by`-style attribution FKs. Tenant-independent (ADR-006 section 2). */
  readonly userId: string;
  /** A real asset BELONGING TO `tenantId`, for child tables (ADR-007 composite FK). */
  readonly assetId: string;
}

/**
 * Contract each tenant-scoped table must satisfy to be covered by the isolation
 * matrix. Factories are hand-written because foreign keys, enums and NOT NULL
 * columns make generic row construction impractical.
 *
 * `dependsOn` WAS RETIRED AT STEP 6 PHASE 1, deliberately and with the promise it
 * came from restated rather than quietly dropped. ADR-004 said fixtures would
 * "declare their FK dependencies so the harness can seed parents first (`tenants`
 * -> `assets` -> `readings`)". Nothing ever read the field: the matrix is a
 * `describe.each` over independent tables, so there is no point at which one
 * fixture's output could be threaded into another's input. It was documentation
 * shaped like code, which is worse than either.
 *
 * PARENT-FIRST SEEDING IS STILL PROVIDED — that part of the promise was real —
 * but centrally, by `seedIsolationContext`, which creates the tenants, the user
 * and one asset per tenant before any fixture runs. A child fixture reads its
 * parent out of `IsolationSeedContext` instead of declaring a dependency it had
 * no way to satisfy.
 */
export interface IsolationFixture {
  /** Column carrying the tenant key. `tenants` keys on `id`; everything else on `tenant_id`. */
  readonly tenantColumn?: string;
  /** Declared write capability. Must agree with `APPEND_ONLY_TABLES` (asserted). */
  readonly appWrites: AppWrites;
  /** Insert exactly one row belonging to `ctx.tenantId`, using the app role. */
  seed(client: PrismaClient, ctx: IsolationSeedContext): Promise<void>;
}

/**
 * Fixture registry. Its key set is asserted equal to the catalog's tenant-scoped
 * table set in BOTH directions, so a new table without a fixture fails the build
 * and a fixture for a dropped table does too.
 *
 * EMPTY FROM SCAFFOLD UNTIL STEP 6 PHASE 1, which is when it stopped being a
 * promise. `assets` and `asset_events` are the first two entries, and they are
 * deliberately the two DIFFERENT WRITE SHAPES the domain contains — a mutable,
 * soft-deleted table and an append-only one. A contract that had only ever met
 * one shape would have been rewritten the moment the other arrived; v1.0 holds
 * two more of each (`readings`, `audit_log`; `maintenance_records`).
 */
export const ISOLATION_FIXTURES: Readonly<Record<string, IsolationFixture>> = {
  assets: {
    // Mutable, but NOT hard-deletable: soft delete is an UPDATE setting
    // deleted_at, and the app role holds no DELETE grant at all. The matrix
    // therefore proves the no-hard-delete property as a side effect.
    appWrites: { update: true, delete: false },
    async seed(client, ctx) {
      await client.$executeRawUnsafe(
        `INSERT INTO public.assets (tenant_id, serial_number, type, status)
         VALUES ($1::uuid, $2, 'meter', 'installed')`,
        ctx.tenantId,
        `SN-${randomUUID()}`,
      );
    },
  },

  readings: {
    // Append-only — declared in APPEND_ONLY_TABLES, NOT inferred from the absence
    // of updated_at/deleted_at (PROJECT_BRIEF never states it for this table).
    appWrites: { update: false, delete: false },
    async seed(client, ctx) {
      // Second FK-child of assets. Reads its parent out of the seed context, the
      // same as asset_events — no self-seeding, no dependsOn (retired at Phase 1).
      // asset_id and tenant_id come from the SAME context object, so the ADR-007
      // composite FK is satisfied; the deliberate mismatch is a dedicated negative
      // in isolation.spec.ts asserted on 23503.
      await client.$executeRawUnsafe(
        `INSERT INTO public.readings (tenant_id, asset_id, value, unit, read_at, created_by)
         VALUES ($1::uuid, $2::uuid, 42.5, 'kWh', now(), $3::uuid)`,
        ctx.tenantId,
        ctx.assetId,
        ctx.userId,
      );
    },
  },

  maintenance_records: {
    // THE ONLY DOMAIN TABLE WITH A GENERAL UPDATE (ADR-008). `delete: false` is
    // not an append-only declaration — it is the soft-delete decision: the app
    // role holds UPDATE (field edits AND the deleted_at write) and deliberately no
    // DELETE, so the matrix's DELETE case asserts `permission denied`, which is
    // how "soft delete only" is proven rather than asserted.
    appWrites: { update: true, delete: false },
    async seed(client, ctx) {
      await client.$executeRawUnsafe(
        `INSERT INTO public.maintenance_records
           (tenant_id, asset_id, description, performed_at, created_by)
         VALUES ($1::uuid, $2::uuid, 'annual service', now(), $3::uuid)`,
        ctx.tenantId,
        ctx.assetId,
        ctx.userId,
      );
    },
  },

  asset_events: {
    // Append-only (PROJECT_BRIEF section 5 :137, declared in APPEND_ONLY_TABLES).
    appWrites: { update: false, delete: false },
    async seed(client, ctx) {
      // asset_id and tenant_id are taken from the SAME context object, so this
      // pair always agrees and the ADR-007 composite FK is satisfied. The
      // deliberate MISMATCH — a valid asset from one tenant with another
      // tenant's id — is a dedicated negative in isolation.spec.ts, asserted on
      // 23503 and kept well away from the 42501 the RLS WITH CHECK raises.
      await client.$executeRawUnsafe(
        `INSERT INTO public.asset_events (tenant_id, asset_id, event_type, created_by)
         VALUES ($1::uuid, $2::uuid, 'created', $3::uuid)`,
        ctx.tenantId,
        ctx.assetId,
        ctx.userId,
      );
    },
  },
};

/**
 * Every table this suite is allowed to wipe, read from the catalog.
 *
 * Derived rather than listed, because a hand-maintained list is the thing that
 * broke: `readings` landed at step 6 phase 2 and five separate teardowns did not
 * know about it. A catalog query cannot fall behind the schema.
 *
 * `RLS_EXEMPT_TABLES` is REUSED as the exclusion rather than a second list being
 * written. It names `_prisma_migrations`, which is the correct exclusion for both
 * purposes: it is not tenant data (so it needs no RLS) and it tracks which
 * migrations have been applied (so truncating it would destroy migration state and
 * make the next `migrate deploy` try to re-run everything).
 */
async function listManagedTables(migrator: PrismaClient): Promise<string[]> {
  const rows = await migrator.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename).filter((t) => !RLS_EXEMPT_TABLES.includes(t));
}

/**
 * Asserts the database holds no rows in any managed table. Throws naming the
 * offenders.
 *
 * THIS IS THE HALF THE ORIGINAL COMPLAINT NEVER FIXED. Teardown was wrong in two
 * ways — wrong ORDER and SILENT. `resetDatabase` fixes the order by delegating it
 * to Postgres; this fixes the silence. Today it passes by construction, which is
 * the point: it is a regression guard, not a check for a known bug.
 *
 * What it buys: if teardown ever stops fully cleaning — someone reverts to
 * hand-rolled DELETEs that miss a table, or a future table escapes the catalog
 * derivation — the suite that failed to clean up fails **at its own site, naming
 * the table**, instead of surfacing three suites later as a `23503` foreign-key
 * violation that names neither the cause nor the culprit. That is exactly how the
 * step 6 phase 2 breakage presented: 31 failures in `membership-writes.spec.ts`,
 * caused by `isolation.spec.ts`.
 *
 * COUNTS ON THE MIGRATOR, AND THAT IS LOAD-BEARING. An app-client count is
 * RLS-filtered: with no `app.current_tenant` set it returns zero rows whatever the
 * table actually holds, so the guard would pass vacuously and forever. No role
 * holds `BYPASSRLS` (ADR-004), so the migration role's cross-tenant visibility is
 * the only way to see residue — the same reason the teardown itself runs as the
 * migrator.
 */
export async function assertNoResidualRows(migrator: PrismaClient): Promise<void> {
  const tables = await listManagedTables(migrator);
  if (tables.length === 0) return;

  // One statement, per-table counts, so the failure message names the offender
  // rather than merely reporting that something somewhere is dirty.
  const union = tables
    .map((t) => `SELECT '${t}' AS table_name, count(*)::int AS n FROM public."${t}"`)
    .join(' UNION ALL ');

  const rows = await migrator.$queryRawUnsafe<{ table_name: string; n: number }[]>(union);
  const dirty = rows.filter((r) => r.n > 0);

  if (dirty.length > 0) {
    const detail = dirty.map((r) => `${r.table_name}=${r.n}`).join(', ');
    throw new Error(
      `teardown left rows behind: ${detail}. ` +
        `A later suite's cleanup will fail with an opaque foreign-key error instead of naming this. ` +
        `Call resetDatabase(migrator) rather than hand-rolling DELETEs.`,
    );
  }
}

/**
 * THE shared teardown. Empties every managed table, then proves it.
 *
 * `TRUNCATE ... CASCADE` is the mechanism deliberately, in place of an ordered
 * list of DELETEs. **Postgres resolves the foreign-key graph itself**, so the
 * ordering knowledge does not move into this helper — it ceases to exist. That is
 * the difference between fixing the bug and relocating it: when
 * `maintenance_records` and `audit_log` land, this function needs no edit, and
 * nobody has to remember that children go before parents.
 *
 * Three things a reader will trip over, so they are written down:
 *
 * 1. **It runs as the MIGRATOR, never the app client.** Catalog assertion 6
 *    asserts `meterlog_app` holds no `TRUNCATE` on any table, on purpose. So when
 *    a teardown here raises `permission denied`, the obvious fix —
 *    `GRANT TRUNCATE ... TO meterlog_app` — silently defeats a real assertion and
 *    widens the runtime role's privileges to make a test convenient. **Never do
 *    that.** Pass a `migratorClient()`.
 * 2. **`CASCADE` is broader than the tables named.** It also truncates any table
 *    referencing them, even one absent from the argument list. That is what makes
 *    the ordering problem disappear, and it is surprising to anyone reading a
 *    delete list as exhaustive. Today the derived list already IS every non-exempt
 *    table in `public`, so nothing lies outside it — the note is for the schemas
 *    that come later.
 * 3. **`_prisma_migrations` is excluded** via `RLS_EXEMPT_TABLES`; see
 *    `listManagedTables`.
 */
export async function resetDatabase(migrator: PrismaClient): Promise<void> {
  const tables = await listManagedTables(migrator);
  if (tables.length === 0) return;

  const quoted = tables.map((t) => `public."${t}"`).join(', ');
  await migrator.$executeRawUnsafe(`TRUNCATE ${quoted} CASCADE`);

  await assertNoResidualRows(migrator);
}

/**
 * Seeds the parent rows every FK-carrying fixture needs, AS THE MIGRATION ROLE,
 * and returns a context per tenant. Closes wrinkle 1.
 *
 * DOES NOT reset the database — the caller must call `resetDatabase` BEFORE seeding
 * the attribution user, not after. This function used to clear the domain tables
 * itself, which was safe only while it deleted domain tables alone; `resetDatabase`
 * truncates `users` and `tenants` too, so a self-reset here would silently destroy
 * the user seeded moments earlier and every `created_by` FK would fail. Reset,
 * then seed, in that order, at the call site where the order is visible.
 */
export async function seedIsolationContext(
  migrator: PrismaClient,
  tenantIds: readonly string[],
  userId: string,
): Promise<Record<string, IsolationSeedContext>> {
  const contexts: Record<string, IsolationSeedContext> = {};

  for (const tenantId of tenantIds) {
    await migrator.$executeRawUnsafe(
      `INSERT INTO public.tenants (id, name) VALUES ($1::uuid, $2)
       ON CONFLICT (id) DO NOTHING`,
      tenantId,
      `isolation-fixture-${tenantId.slice(0, 8)}`,
    );

    const rows = await migrator.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO public.assets (tenant_id, serial_number, type, status)
       VALUES ($1::uuid, $2, 'meter', 'installed')
       RETURNING id::text AS id`,
      tenantId,
      `PARENT-${tenantId.slice(0, 8)}`,
    );
    const assetId = rows[0]?.id;
    if (!assetId) throw new Error(`failed to seed a parent asset for tenant ${tenantId}`);

    contexts[tenantId] = { tenantId, userId, assetId };
  }

  return contexts;
}

/** Creates the attribution user the fixtures reference. Migration role: `users` is not app-writable. */
export async function seedIsolationUser(migrator: PrismaClient, userId: string): Promise<void> {
  await migrator.$executeRawUnsafe(
    `INSERT INTO public.users (id, email, password_hash) VALUES ($1::uuid, $2, 'x')
     ON CONFLICT (id) DO NOTHING`,
    userId,
    `isolation-${userId.slice(0, 8)}@example.test`,
  );
}

/** Runs `body` with the request-scoped tenant context set, as the API does at runtime. */
export async function withTenant<T>(
  client: PrismaClient,
  tenantId: string | null,
  body: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    // set_config(..., is_local => true) is SET LOCAL: scoped to this transaction,
    // and therefore to this connection, which is why the whole request must run
    // inside it (ADR-002/ADR-004).
    if (tenantId !== null) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantId);
    }
    return body(tx as unknown as PrismaClient);
  });
}

/**
 * The SQLSTATE and message Postgres actually raised, pulled out of the Prisma
 * wrapper so a negative can assert the MECHANISM rather than a phrase.
 *
 * WHY BOTH HALVES ARE RETURNED, AND WHY ASSERTING ONE IS NOT ENOUGH. Measured
 * against the live database at step 6 Phase 1:
 *
 *   RLS WITH CHECK rejection   -> 42501  "new row violates row-level security policy"
 *   missing table privilege    -> 42501  "permission denied for table ..."
 *   composite-FK mismatch      -> 23503  "violates foreign key constraint ..."
 *
 * THE FIRST TWO SHARE A SQLSTATE. `42501` is insufficient_privilege, and Postgres
 * uses it for both "a policy refused this row" and "the role was never granted
 * this command" — two entirely different mechanisms, one code. A negative
 * asserting only `42501` therefore passes when the OTHER layer did the refusing,
 * which is precisely the failure that made the step-5 RBAC gate untestable until
 * the guard and the function body were given distinct error codes.
 *
 * So callers assert the pair. The SQLSTATE separates FK violations from
 * privilege failures; the message separates policy from grant.
 *
 * Prisma surfaces raw-query failures as P2010 with the driver's code and message
 * in `meta`, which is where both halves come from.
 */
export interface PgFailure {
  readonly sqlstate: string;
  readonly message: string;
}

export async function capturePgFailure(promise: Promise<unknown>): Promise<PgFailure> {
  try {
    await promise;
  } catch (error) {
    const meta = (error as { meta?: { code?: unknown; message?: unknown } }).meta;
    return {
      sqlstate: String(meta?.code ?? ''),
      message: String(meta?.message ?? (error as { message?: unknown }).message ?? ''),
    };
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}
