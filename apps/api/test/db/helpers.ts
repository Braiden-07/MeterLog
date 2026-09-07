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
 * (tenant + user + membership). Both land in build-order step 4; until then this
 * list is asserted against an empty catalog.
 */
export const EXPECTED_DEFINER_FUNCTIONS: readonly string[] = ['login_lookup', 'register_tenant'];

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
 */
export const ISOLATION_BESPOKE_TABLES: readonly string[] = ['memberships'];

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
