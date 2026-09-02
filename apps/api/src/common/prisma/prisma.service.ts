import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Transaction settings from ADR-004.
 *
 * Every authenticated request runs inside an interactive transaction so that
 * `SET LOCAL app.current_tenant` and the request's queries share one connection.
 * That makes Prisma's transaction defaults the API's request deadline, so they
 * are set explicitly rather than inherited.
 *
 * `timeout` sits ABOVE the app role's `statement_timeout` (4s, set in migration
 * SQL) so a runaway query is killed by Postgres with an error naming the
 * statement, instead of surfacing as an opaque transaction abort.
 */
export const TRANSACTION_OPTIONS = {
  /** Wait for a pooled connection. Exceeded means pool exhaustion, not a slow query. */
  maxWait: 2_000,
  /** Ceiling on one request's transaction. */
  timeout: 5_000,
} as const;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      // Bound explicitly to DATABASE_URL — the restricted app role.
      //
      // schema.prisma points at MIGRATION_DATABASE_URL because the CLI only runs
      // migrations. Naming the runtime URL here, rather than sharing one env var,
      // is what makes it impossible to connect the running app as the migration
      // role by accident. That mistake would disable tenant isolation entirely
      // while every structural test still passed, so the catalog suite asserts
      // against it too (test/db/catalog-rls.spec.ts).
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
