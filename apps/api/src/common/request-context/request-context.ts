import { AsyncLocalStorage } from 'node:async_hooks';

import type { Prisma } from '@prisma/client';

/**
 * What one authenticated request knows about itself, after the interceptor has
 * verified it (ADR-006 §4).
 *
 * `tx` is the interactive transaction the GUCs were set on. Every query a
 * handler makes MUST go through it: `SET LOCAL` is scoped to the transaction,
 * and therefore to the one pooled connection that transaction holds. A query
 * issued on the plain `PrismaService` instead would run on a different
 * connection with no context set, and — correctly, but confusingly — see
 * nothing. That is the whole reason ADR-004 puts the request inside a
 * transaction rather than setting the GUCs per query.
 */
export interface RequestContext {
  readonly tx: Prisma.TransactionClient;
  readonly userId: string;
  /** Null when the session has no active workspace yet (0 or >1 memberships). */
  readonly tenantId: string | null;
  /**
   * The role for the active membership, **re-read from the database this
   * request** — never the copy cached in the session. A session's role goes
   * stale the moment an admin changes it; this one cannot.
   */
  readonly role: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  body: () => Promise<T>,
): Promise<T> {
  return storage.run(context, body);
}

/** The current request's context, or `null` outside an authenticated request. */
export function peekRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/**
 * The current request's context. Throws rather than returning a partial or
 * empty context: a handler that reaches for tenant context outside a request
 * has a bug, and the failure must be loud rather than silently unscoped.
 */
export function requireRequestContext(): RequestContext {
  const store = storage.getStore();
  if (!store) {
    throw new Error(
      'No request context. Tenant-scoped work must run inside the TenantContextInterceptor.',
    );
  }
  return store;
}
