import { randomUUID } from 'node:crypto';

import { ForbiddenException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient as PrismaClientCtor } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { Observable, firstValueFrom } from 'rxjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  peekRequestContext,
  requireRequestContext,
} from '../../src/common/request-context/request-context';
import { SESSION_COOKIE, SessionService } from '../../src/common/session/session.service';
import { TenantContextInterceptor } from '../../src/common/tenant-context/tenant-context.interceptor';
import { execAll, loadEnv, migratorClient } from './helpers';

/**
 * Step 4, Phase 3 — the two-GUC interceptor, verify-before-set, and per-request
 * re-verification, exercised through the REAL interceptor rather than against
 * the policies in isolation.
 *
 * ── Why every request here shares one pooled connection ──────────────────────
 *
 * The guarantee this phase exists to establish is "a membership revoked between
 * two requests fails closed on the next request". The failure surface that makes
 * that hard is not the policy — Phase 1 proved the policy — it is **pooled
 * connection statefulness**, one layer up from the ADR-004 empty-string
 * heisenbug. A GUC set on a connection outlives the request that set it unless
 * the scoping is right.
 *
 * A test that lets request 2 land on a *fresh* connection proves nothing about
 * any of that, and would pass whether or not re-verification works — the same
 * shape as Phase 2's rolled-back-wrapper trap in new clothes. So the app client
 * here is pinned to `connection_limit=1`, and every case that depends on reuse
 * **asserts `pg_backend_pid()` is identical across the two requests** rather than
 * assuming the pool obliged.
 */
const APP_URL_SUFFIX = 'connection_limit=1&pool_timeout=10';

describe('tenant-context interceptor (Phase 3)', () => {
  let prisma: PrismaService;
  let sessions: SessionService;
  let interceptor: TenantContextInterceptor;
  let migrator: PrismaClient;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userM = randomUUID(); // member of A (admin) and B (technician)
  const userN = randomUUID(); // member of B only

  beforeAll(async () => {
    loadEnv();

    // Pin the pool to a single connection BEFORE PrismaService is constructed —
    // it reads DATABASE_URL in its constructor.
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is not set.');
    process.env.DATABASE_URL = `${base}${base.includes('?') ? '&' : '?'}${APP_URL_SUFFIX}`;

    prisma = new PrismaService();
    await prisma.$connect();
    sessions = new SessionService();
    interceptor = new TenantContextInterceptor(prisma, sessions, new Reflector());
    migrator = migratorClient();
    process.env.DATABASE_URL = base;
  });

  afterAll(async () => {
    await execAll(migrator, [
      `DELETE FROM public.memberships`,
      `DELETE FROM public.users`,
      `DELETE FROM public.tenants`,
    ]);
    await prisma.$disconnect();
    await migrator.$disconnect();
    await sessions.disconnect();
  });

  beforeEach(async () => {
    await execAll(migrator, [
      `DELETE FROM public.memberships`,
      `DELETE FROM public.users`,
      `DELETE FROM public.tenants`,
      `INSERT INTO public.tenants (id, name) VALUES
         ('${tenantA}', 'Tenant A'), ('${tenantB}', 'Tenant B')`,
      `INSERT INTO public.users (id, email, password_hash) VALUES
         ('${userM}', 'm@example.test', 'x'), ('${userN}', 'n@example.test', 'x')`,
      `INSERT INTO public.memberships (user_id, tenant_id, role) VALUES
         ('${userM}', '${tenantA}', 'admin'),
         ('${userM}', '${tenantB}', 'technician'),
         ('${userN}', '${tenantB}', 'auditor')`,
    ]);
  });

  // -- harness ---------------------------------------------------------------

  function contextWithCookie(cookie: string | undefined): ExecutionContext {
    const headers = cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {};
    // getHandler/getClass are required because the interceptor now consults the
    // Reflector for @RequiresSession on the session-less path. These stand in for
    // an unannotated route, which is the correct default for this suite: it tests
    // the context machinery, not route-level auth policy (that is test/api).
    const noop = (): void => undefined;
    return {
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
      getHandler: () => noop,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  /** Runs `body` as the route handler would — inside the interceptor's context. */
  function handler<T>(body: () => Promise<T>): CallHandler {
    return {
      handle: () =>
        new Observable<T>((sub) => {
          body().then(
            (value) => {
              sub.next(value);
              sub.complete();
            },
            (error) => sub.error(error),
          );
        }),
    };
  }

  /** One simulated request. */
  function request<T>(cookie: string | undefined, body: () => Promise<T>): Promise<T> {
    return firstValueFrom(
      interceptor.intercept(contextWithCookie(cookie), handler(body)),
    ) as Promise<T>;
  }

  /** What the handler can see about the connection and the live GUCs. */
  async function probe(): Promise<{
    pid: number;
    user_guc: string;
    tenant_guc: string;
    visible_memberships: number;
  }> {
    const { tx } = requireRequestContext();
    const [row] = await tx.$queryRawUnsafe<
      { pid: number; user_guc: string; tenant_guc: string; visible_memberships: number }[]
    >(
      `SELECT pg_backend_pid()                                    AS pid,
              coalesce(current_setting('app.current_user',   true), '<never-set>') AS user_guc,
              coalesce(current_setting('app.current_tenant', true), '<never-set>') AS tenant_guc,
              (SELECT count(*)::int FROM public.memberships)       AS visible_memberships`,
    );
    if (!row) throw new Error('probe returned no row');
    return row;
  }

  /** Reads the GUCs on the pooled connection OUTSIDE any transaction. */
  async function residueOnConnection(): Promise<{ pid: number; user: string; tenant: string }> {
    const [row] = await prisma.$queryRawUnsafe<{ pid: number; user: string; tenant: string }[]>(
      `SELECT pg_backend_pid() AS pid,
              coalesce(current_setting('app.current_user',   true), '<never-set>') AS "user",
              coalesce(current_setting('app.current_tenant', true), '<never-set>') AS tenant`,
    );
    if (!row) throw new Error('residue probe returned no row');
    return row;
  }

  const login = (userId: string, activeTenantId: string | null, role: string | null = null) =>
    sessions.create({ userId, activeTenantId, role });

  // =========================================================================
  describe('the happy path', () => {
    it('sets both GUCs and exposes the re-verified role', async () => {
      const cookie = await login(userM, tenantA, 'admin');
      const seen = await request(cookie, async () => {
        const ctx = requireRequestContext();
        return { ...(await probe()), role: ctx.role, tenantId: ctx.tenantId, userId: ctx.userId };
      });

      expect(seen.user_guc).toBe(userM);
      expect(seen.tenant_guc).toBe(tenantA);
      expect(seen.role).toBe('admin');
      expect(seen.tenantId).toBe(tenantA);
      expect(seen.userId).toBe(userM);
      // A's two rows (M, and nobody else in A) plus M's own B row via the self axis.
      expect(seen.visible_memberships).toBe(2);
    });

    it('a session with no active tenant gets the user axis only', async () => {
      // The post-login, pre-switch state for a multi-membership user.
      const cookie = await login(userM, null);
      const seen = await request(cookie, probe);
      expect(seen.user_guc).toBe(userM);
      expect(seen.tenant_guc).toBe('');
      expect(seen.visible_memberships).toBe(2); // M's own A and B memberships
    });

    it('an unauthenticated request opens no transaction and gets no context', async () => {
      const ctx = await request(undefined, async () => peekRequestContext());
      expect(ctx).toBeNull();
    });

    it('a forged or tampered cookie is treated as no session', async () => {
      const cookie = await login(userM, tenantA, 'admin');
      const tampered = `${cookie.slice(0, cookie.lastIndexOf('.'))}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
      expect(await request(tampered, async () => peekRequestContext())).toBeNull();
      // And a valid signature over an unknown id is still nothing.
      await sessions.destroy(cookie);
      expect(await request(cookie, async () => peekRequestContext())).toBeNull();
    });
  });

  // =========================================================================
  describe('THE HARD ONE — revocation between two requests on a REUSED connection', () => {
    it('request 2 fails closed, on the same backend, with no tenant residue', async () => {
      const cookie = await login(userM, tenantA, 'admin');

      // ---- request 1: succeeds, and pins which backend we are on -------------
      const first = await request(cookie, probe);
      expect(first.tenant_guc).toBe(tenantA);

      // ---- revoke between the requests ---------------------------------------
      const revoked = await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now()
          WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        userM,
        tenantA,
      );
      expect(revoked, 'the revocation itself must affect exactly one row').toBe(1);

      // ---- request 2: same session, same cookie, same connection --------------
      let reached = false;
      await expect(
        request(cookie, async () => {
          reached = true;
          return probe();
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // The handler must never have run — a 403 that still executed the route
      // would be a fail-open wearing a 403's clothes.
      expect(reached, 'the route handler ran despite the failed re-verify').toBe(false);

      const after = await residueOnConnection();

      // THE VACUITY GUARD. If request 2 had landed on a different backend, none
      // of this would say anything about pooled statefulness.
      expect(after.pid, 'requests did not share a pooled connection').toBe(first.pid);

      // No stale tenant left behind. With `SET` instead of `SET LOCAL` this holds
      // tenant A's uuid, and any query on this connection still sees A's rows —
      // the fail-open this whole ordering exists to prevent.
      expect(after.tenant, `stale tenant GUC survived on the pooled connection`).toBe('');
      expect(after.user).toBe('');

      // And prove the consequence, not just the symptom: nothing of A is reachable
      // on this connection now.
      const [leak] = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.memberships WHERE tenant_id = $1::uuid`,
        tenantA,
      );
      expect(leak?.n, "tenant A's rows are still reachable on the reused connection").toBe(0);
    });

    it('the session s active tenant is cleared, so the next request stops re-asserting it', async () => {
      const cookie = await login(userM, tenantA, 'admin');
      await request(cookie, probe);
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now()
          WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        userM,
        tenantA,
      );

      await expect(request(cookie, probe)).rejects.toBeInstanceOf(ForbiddenException);

      // Third request: no longer 403, because the session no longer claims A.
      const third = await request(cookie, probe);
      expect(third.tenant_guc).toBe('');
      expect((await sessions.read(cookie))?.activeTenantId).toBeNull();
    });

    it('a role CHANGE between requests is picked up on the next request', async () => {
      // The session still says 'admin'; the database says otherwise. The
      // re-verified value must win — the cached one is never authoritative.
      const cookie = await login(userM, tenantA, 'admin');
      expect(await request(cookie, async () => requireRequestContext().role)).toBe('admin');

      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET role = 'auditor'
          WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        userM,
        tenantA,
      );

      expect(await request(cookie, async () => requireRequestContext().role)).toBe('auditor');
      expect((await sessions.read(cookie))?.role, 'the stale session copy is still there').toBe(
        'admin',
      );
    });
  });

  // =========================================================================
  describe('GUC hygiene across pooled requests', () => {
    it('context from request 1 does not bleed into request 2 on the SAME connection', async () => {
      const mCookie = await login(userM, tenantA, 'admin');
      const nCookie = await login(userN, tenantB, 'auditor');

      const first = await request(mCookie, probe);
      const second = await request(nCookie, probe);

      expect(second.pid, 'the two requests did not share a connection').toBe(first.pid);
      expect(second.user_guc).toBe(userN);
      expect(second.tenant_guc).toBe(tenantB);
      // N is an auditor in B alongside M — two rows, and none of A's.
      expect(second.visible_memberships).toBe(2);

      const third = await request(undefined, async () => peekRequestContext());
      expect(third).toBeNull();

      const residue = await residueOnConnection();
      expect(residue.pid).toBe(first.pid);
      expect(residue.user).toBe('');
      expect(residue.tenant).toBe('');
    });

    it('holds on a FRESH connection as well as a reused one', async () => {
      // The ADR-004 heisenbug is asymmetric: on a connection that has never had
      // the GUC set, current_setting returns NULL; once SET LOCAL has touched it,
      // it reverts to the EMPTY STRING. Both must fail closed, and only checking
      // one of them is how the bug survived review the first time.
      const fresh = new PrismaService();
      await fresh.$connect();
      try {
        const [row] = await fresh.$queryRawUnsafe<{ user: string; tenant: string; n: number }[]>(
          `SELECT coalesce(current_setting('app.current_user',   true), '<never-set>') AS "user",
                  coalesce(current_setting('app.current_tenant', true), '<never-set>') AS tenant,
                  (SELECT count(*)::int FROM public.memberships) AS n`,
        );
        expect(row?.user, 'fresh connection should never have seen this GUC').toBe('<never-set>');
        expect(row?.tenant).toBe('<never-set>');
        expect(row?.n, 'a fresh connection with no context must see nothing').toBe(0);
      } finally {
        await fresh.$disconnect();
      }

      // And the reused one, where the value is '' rather than NULL.
      const cookie = await login(userM, tenantA, 'admin');
      await request(cookie, probe);
      const residue = await residueOnConnection();
      expect(residue.user).toBe('');
      expect(residue.tenant).toBe('');
      const [leak] = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.memberships`,
      );
      expect(leak?.n, 'a reused connection with reverted GUCs must see nothing').toBe(0);
    });
  });

  // =========================================================================
  describe('verify-before-set ordering', () => {
    it('an unauthorized tenant claim is rejected and never sets the tenant GUC', async () => {
      // N belongs to B only. A forged/stale session claiming A must not get context.
      const cookie = await login(userN, tenantA, 'admin');
      let reached = false;

      await expect(
        request(cookie, async () => {
          reached = true;
          return probe();
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(reached).toBe(false);
      const residue = await residueOnConnection();
      expect(residue.tenant).toBe('');
    });

    it('the SQL is emitted in the order verify-then-set, not set-then-verify', async () => {
      // The behavioural cases above cannot separate the two orderings: both end in
      // a 403 with a rolled-back transaction and no residue. The difference is
      // whether app.current_tenant was ever assigned an unverified value at any
      // instant, which is only observable in the statement order itself.
      // A raw PrismaClient rather than PrismaService, purely so query logging can
      // be switched on — PrismaService deliberately takes no constructor options,
      // and loosening that for a test would be the wrong trade. The interceptor
      // only ever calls $transaction, so this is structurally identical.
      const traced = new PrismaClientCtor({
        datasources: { db: { url: process.env.DATABASE_URL } },
        log: [{ emit: 'event', level: 'query' }],
      });
      await traced.$connect();
      const statements: string[] = [];
      (traced as unknown as { $on: (e: string, cb: (p: { query: string }) => void) => void }).$on(
        'query',
        (event) => statements.push(event.query),
      );

      try {
        const tracing = new TenantContextInterceptor(
          traced as unknown as PrismaService,
          sessions,
          new Reflector(),
        );
        const cookie = await login(userM, tenantA, 'admin');
        await firstValueFrom(
          tracing.intercept(
            contextWithCookie(cookie),
            handler(async () => 'ok'),
          ),
        );

        const setUser = statements.findIndex((q) => q.includes(`set_config('app.current_user'`));
        const verify = statements.findIndex((q) => q.includes('FROM public.memberships'));
        const setTenant = statements.findIndex((q) =>
          q.includes(`set_config('app.current_tenant'`),
        );

        expect(setUser, 'no app.current_user assignment was emitted').toBeGreaterThanOrEqual(0);
        expect(verify, 'no re-verify query was emitted').toBeGreaterThanOrEqual(0);
        expect(setTenant, 'no app.current_tenant assignment was emitted').toBeGreaterThanOrEqual(0);

        expect(setUser).toBeLessThan(verify);
        expect(verify, 'the tenant GUC was set BEFORE the membership was verified').toBeLessThan(
          setTenant,
        );
      } finally {
        await traced.$disconnect();
      }
    });

    it('the re-verify reads liveness itself — a revoked membership yields zero rows in-policy', async () => {
      // OPEN-5's DB-side claim, exercised through the interceptor rather than
      // against the policy in isolation as Phase 1 tested it. Liveness cannot live
      // in the memberships row policies; it lives HERE.
      const cookie = await login(userM, tenantB, 'technician');
      expect((await request(cookie, probe)).tenant_guc).toBe(tenantB);

      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now()
          WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        userM,
        tenantB,
      );

      await expect(request(cookie, probe)).rejects.toBeInstanceOf(ForbiddenException);

      // The row is still there — soft delete, not removal. The re-verify filtered it.
      const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.memberships
          WHERE user_id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NOT NULL`,
        userM,
        tenantB,
      );
      expect(row?.n, 'the fixture did not actually revoke anything').toBe(1);
    });
  });

  // =========================================================================
  describe('the interceptor fails closed on a poisoned context', () => {
    it('a session naming a user that does not exist gets no tenant and sees nothing', async () => {
      const ghost = randomUUID();
      const cookie = await login(ghost, tenantA, 'admin');
      await expect(request(cookie, probe)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a session with a BLANK user id fails closed with 403, not 500', async () => {
      // This is what makes the `NULLIF(..., '')` in the re-verify reachable, and
      // therefore testable. A blank userId is a poisoned-session state (corrupted
      // Redis value, a future code path that forgets to populate it) — not an
      // attack, but the fail-closed behaviour has to hold anyway.
      //
      // set_config writes '' into the GUC, so the re-verify reads '' rather than a
      // uuid. WITH the NULLIF that becomes NULL, matches nothing, and 403s cleanly.
      // WITHOUT it, ''::uuid raises 22P02 and the request 500s — the ADR-004
      // empty-string heisenbug, one layer up in the interceptor.
      //
      // Verified: dropping the NULLIF turns this into a PrismaClientKnownRequestError.
      const cookie = await sessions.create({
        userId: '',
        activeTenantId: tenantA,
        role: 'admin',
      });
      await expect(request(cookie, probe)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a session with no active tenant can still read its own memberships and nothing else', async () => {
      const cookie = await login(userN, null);
      const seen = await request(cookie, async () => {
        const { tx } = requireRequestContext();
        return tx.$queryRawUnsafe<{ user_id: string }[]>(`SELECT user_id FROM public.memberships`);
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.user_id).toBe(userN);
    });
  });
});
