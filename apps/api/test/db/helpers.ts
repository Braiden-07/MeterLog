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
 * Tables the pre-auth SECURITY DEFINER path is permitted to reach, and the only
 * ones allowed to carry a policy scoped `TO meterlog_definer` (ADR-004).
 */
export const DEFINER_ACCESSIBLE_TABLES: readonly string[] = ['tenants', 'users', 'memberships'];

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
 * The generic matrix therefore still generates zero cases at step 4 Phase 1. It
 * activates on its own at step 6, when `assets`/`readings` land — those the app
 * role genuinely does write.
 */
export const ISOLATION_BESPOKE_TABLES: readonly string[] = ['memberships', 'users', 'tenants'];

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
 * Contract each tenant-scoped table must satisfy to be covered by the isolation
 * matrix. Factories are hand-written because foreign keys, enums and NOT NULL
 * columns make generic row construction impractical.
 */
export interface IsolationFixture {
  /** Tables whose rows must exist first, seeded in this order. */
  readonly dependsOn?: readonly string[];
  /** Column carrying the tenant key. `tenants` keys on `id`; everything else on `tenant_id`. */
  readonly tenantColumn?: string;
  /** Insert exactly one row belonging to `tenantId`. Returns its primary key. */
  seed(client: PrismaClient, tenantId: string): Promise<string>;
}

/**
 * Fixture registry. Its key set is asserted equal to the catalog's tenant-scoped
 * table set in BOTH directions, so a new table without a fixture fails the build
 * and a fixture for a dropped table does too.
 *
 * Empty at scaffold because no domain tables exist yet. Step 4 populates it as
 * tenants and users land — that is the gate, not a formality.
 */
export const ISOLATION_FIXTURES: Readonly<Record<string, IsolationFixture>> = {};

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
