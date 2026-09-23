import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  RequestMethod,
  UnauthorizedException,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, firstValueFrom, from } from 'rxjs';

import { REQUIRES_ROLE } from '../auth/requires-role.decorator';
import { REQUIRES_SESSION } from '../auth/requires-session.decorator';

import { PrismaService, TRANSACTION_OPTIONS } from '../prisma/prisma.service';
import { runWithRequestContext } from '../request-context/request-context';
import { SESSION_COOKIE, SessionService } from '../session/session.service';

/**
 * The routes that do NOT require an active workspace — every other route does.
 *
 * DEFAULT-DENY, and the exemption is the thing written down (G2, OPEN-18). A route
 * is tenant-scoped unless it appears here, so a new controller, a new handler on
 * an exempt controller, or a renamed path all inherit the refusal rather than
 * silently reaching a handler with no tenant context. ADR-006 §5 specified this
 * 403 from the start; before this set existed, an un-gated read with no workspace
 * reached RLS with no tenant GUC and answered `200 {"items":[]}` or `404`.
 *
 * Keyed on `METHOD /path` read from Nest's own route metadata, controller-relative
 * (no `/api/v1` prefix) — the same construction `test/api/route-inventory.spec.ts`
 * uses to enumerate routes. That spec asserts this set equal to the exempt-routes
 * table in `ARCHITECTURE.md` §9, so an exemption cannot be added or dropped here
 * without the documented matrix moving with it.
 *
 * ============ THIS SET NOW CARRIES TWO MEANINGS — READ BEFORE EDITING ========
 *
 * As of OPEN-15 a listed route is exempt from BOTH:
 *
 *   1. needing an active workspace (the original meaning, G2/ADR-006 §5), and
 *   2. `X-Expected-Tenant` enforcement (`enforcesTenantExpectation` below).
 *
 * The two happen to coincide today — nothing in this set is a tenant-scoped
 * write — and (2) reuses (1) deliberately rather than minting a second list that
 * could drift out of step with the first. But they are NOT the same idea, and
 * adding a route here that IS a tenant-scoped write would silently drop
 * enforcement for it rather than merely waiving the workspace requirement.
 *
 * `route-inventory.spec.ts` guards exactly that: it asserts the enforced set is
 * non-empty and still contains all four admin writes, so the mistake reds a test
 * instead of quietly widening the hole this row was opened to close.
 */
export const WORKSPACE_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  'POST /auth/register',
  'POST /auth/login',
  'POST /auth/set-password',
  'POST /auth/switch',
  'GET /auth/me',
  'POST /auth/logout',
  'GET /health',
  // The readiness probe (step 10 observability). Exempt for the same reason
  // its sibling is: it is a pre-auth infrastructure check that reads no tenant
  // data. Without this entry the interceptor's default-deny answers an
  // anonymous probe with 401, so an uptime monitor would report the service
  // down while it was perfectly healthy. It is a GET and writes nothing, so the
  // set's SECOND meaning — waiving `X-Expected-Tenant` enforcement — costs
  // nothing here.
  'GET /health/ready',
]);

/**
 * `METHOD /path` for a handler, or null when the route carries no Nest route
 * metadata. Null is never exempt, so an unidentifiable route fails closed.
 */
export function routeKey(reflector: Reflector, handler: object, controller: object): string | null {
  const base = reflector.get<string | undefined>(PATH_METADATA, controller as never);
  const sub = reflector.get<string | undefined>(PATH_METADATA, handler as never);
  const verb = reflector.get<RequestMethod | undefined>(METHOD_METADATA, handler as never);
  if (base === undefined || sub === undefined || verb === undefined) return null;

  const path = `/${[base, sub]
    .map((p) => String(p).replace(/^\/|\/$/g, ''))
    .filter(Boolean)
    .join('/')}`;
  return `${RequestMethod[verb]} ${path}`;
}

/** The header carrying the tenant the CALLER believed was active (OPEN-15). */
export const EXPECTED_TENANT_HEADER = 'x-expected-tenant';

/**
 * Does `X-Expected-Tenant` get ENFORCED on this route? (OPEN-15.)
 *
 * **Writes only, and never an exempt route.** Both halves are load-bearing.
 *
 * WRITES ONLY, because the race OPEN-15 closes is a late WRITE: a request issued
 * while workspace A was active landing after a switch to B and being applied
 * under B. Late READS are already handled client-side — `tenantQuery` cancels
 * and discards them by cache generation — and reads DO send the header today, so
 * this predicate is what makes the server ignore it there rather than act on it.
 * Enforcing on reads is scope the row does not ask for.
 *
 * NEVER AN EXEMPT ROUTE, and this is the half that is easy to get wrong. A naive
 * "any non-GET" rule also catches `POST /auth/switch`, which is the one request
 * that must never be refused for a stale claim: `switchTo` sends
 * `expectedTenant: activeTenantId()` — the OLD tenant — so a client whose view
 * has gone stale (a second tab switched underneath it) would send A while the
 * session verified B, get a 409, and be PINNED: the UI says one thing, the
 * server another, and the single request that reconciles them is refused.
 *
 * It would be easy to assume the exempt list already prevents this because the
 * re-verify "does not run" for exempt routes. IT DOES RUN. `exempt` gates only
 * the 401 and the NO_ACTIVE_WORKSPACE 403; the tenant re-verify runs on the sole
 * condition that the session HAS an active tenant, exempt or not — which is why
 * `revocation.spec.ts` sees `GET /auth/me`, an exempt route, answer 403
 * MEMBERSHIP_REVOKED. The exclusion here is therefore explicit and deliberate,
 * not inherited.
 *
 * A null route key is never exempt, so an unidentifiable route is ENFORCED
 * rather than waved through — the same fail-closed direction `routeKey` takes.
 */
export function enforcesTenantExpectation(method: string, key: string | null): boolean {
  if (method.toUpperCase() === 'GET') return false;
  return !WORKSPACE_EXEMPT_ROUTES.has(key ?? '');
}

/**
 * The two-GUC request interceptor (ADR-004 + ADR-006 §4).
 *
 * Everything an authenticated request does happens inside one interactive
 * transaction, because `SET LOCAL` is scoped to a transaction and therefore to
 * the single pooled connection that transaction holds. Per-query context
 * setting would be a different connection each time and would not work.
 *
 * The ordering below is the load-bearing part, and it is **verify, then set**:
 *
 *   1. `app.current_user` — always, for every authenticated request.
 *   2. Re-verify the claimed tenant, **passing it as a bound parameter, never
 *      reading it from a GUC**. Only the self axis can read this row, so no
 *      tenant context is needed yet — which is exactly why the verification can
 *      happen before any tenant context exists.
 *   3. Zero rows ⇒ the membership was revoked since the session was minted ⇒
 *      403, the session's active tenant is cleared, and `app.current_tenant` is
 *      **never set at any instant**.
 *   4. One row ⇒ set `app.current_tenant`, and use the freshly-read role.
 *
 * Written the other way round — set, then check — there would be a window,
 * however brief, in which the tenant axis was live for a tenant the user may not
 * hold. The guarantee here is structural rather than sequential: the value is
 * never assigned unless it has already been proven.
 *
 * This also makes revocation take effect on the **next request** rather than at
 * next login, and a role *change* likewise.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return from(this.handle(context, next));
  }

  private async handle(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      method?: string;
    }>();
    const cookie = SessionService.readCookie(
      typeof request?.headers?.cookie === 'string' ? request.headers.cookie : undefined,
      SESSION_COOKIE,
    );
    const session = await this.sessions.read(cookie);

    // Both route declarations are read up front. `@RequiresRole()` IMPLIES a
    // session: a role-gated route cannot be served without identity, so it is
    // treated as session-required below even if `@RequiresSession()` was not
    // written alongside it. Forgetting one of the two decorators must not leave a
    // gated route anonymously reachable.
    const requiredRoles = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRES_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Default-deny: only a listed route may be served without an active workspace.
    const key = routeKey(this.reflector, context.getHandler(), context.getClass());
    const exempt = WORKSPACE_EXEMPT_ROUTES.has(key ?? '');

    // OPEN-15. Computed here, from the same route key, so the two meanings the
    // exempt set now carries are derived in one place rather than re-decided
    // further down.
    const enforceExpectedTenant = enforcesTenantExpectation(request?.method ?? '', key);

    if (!session) {
      // No identity to scope by, so no transaction and no GUCs.
      //
      // Whether that is ALLOWED is the route's declaration, not this
      // interceptor's opinion: /health, /auth/register and /auth/login all
      // legitimately arrive without a session, while /auth/me and /auth/switch
      // cannot function without one. Routes say so with @RequiresSession().
      //
      // A route that is NOT exempt is tenant-scoped, and a tenant-scoped route
      // cannot be served without identity whatever its decorators say. Every
      // such controller carries @RequiresSession() today; this makes forgetting
      // it a 401 rather than an anonymous call into a handler that has no
      // request context and 500s.
      //
      // Enforced here rather than in a CanActivate guard because Nest runs guards
      // BEFORE interceptors — a guard cannot see a context this interceptor has
      // not established yet, and one written that way rejects every request.
      const required = this.reflector.getAllAndOverride<boolean>(REQUIRES_SESSION, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!exempt || required || (requiredRoles && requiredRoles.length > 0)) {
        throw new UnauthorizedException({
          error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
        });
      }
      return firstValueFrom(next.handle());
    }

    if (!session.activeTenantId && !exempt) {
      // NO ACTIVE WORKSPACE on a tenant-scoped route (G2, ADR-006 §5).
      //
      // Refused here, before the transaction, the pipes, the role gate and the
      // handler, so nothing in the answer can depend on the request: the same
      // bytes for any id, well-formed or not. Letting it through would reach RLS
      // with no tenant GUC and answer an empty page or a 404 — a false success a
      // client caches, and the one a retry after MEMBERSHIP_REVOKED lands on.
      //
      // DISTINCT from FORBIDDEN_ROLE on purpose: "choose a workspace" and "you
      // may not do this here" need different client responses. It reveals only
      // the caller's own session state, which GET /auth/me already returns; the
      // request names no workspace, so there is nothing to probe.
      throw new ForbiddenException({
        error: {
          code: 'NO_ACTIVE_WORKSPACE',
          message: 'Choose a workspace to continue.',
        },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // (1) The user axis. Set unconditionally: the self-axis policies key on it,
      // and they are what let a user read their own memberships at login, before
      // any workspace has been chosen.
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, session.userId);

      let tenantId: string | null = null;
      let role: string | null = null;

      if (session.activeTenantId) {
        // (2) Re-verify. The candidate tenant is a BOUND PARAMETER, deliberately:
        // reading it from a GUC would mean setting the GUC first, which is the
        // ordering this design exists to avoid.
        //
        // `NULLIF(current_setting(..., true), '')` is not decoration. Without the
        // `, true` this raises `unrecognized configuration parameter` on a
        // connection where the GUC was never set; without the `NULLIF` it raises
        // `invalid input syntax for type uuid: ""` on a POOLED connection, where
        // a previously-set GUC reverts to the empty string rather than to NULL at
        // transaction end. Either way the re-verify would 500 non-deterministically
        // instead of failing closed. With both, an unset context yields NULL, the
        // comparison matches nothing, and the request 403s cleanly.
        //
        // `deleted_at IS NULL` is enforced HERE, in the policy-free query, and this
        // is where OPEN-5's liveness lives: it cannot go in the memberships row
        // policies without blocking the revoking UPDATE itself. This read is the
        // security gate; the self-axis read is not.
        const rows = await tx.$queryRawUnsafe<{ role: string }[]>(
          `SELECT role::text AS role
             FROM public.memberships
            WHERE user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
              AND tenant_id = $1::uuid
              AND deleted_at IS NULL`,
          session.activeTenantId,
        );

        // (3) Fail closed. app.current_tenant has not been touched and will not be.
        if (rows.length === 0 || !rows[0]) {
          if (cookie) await this.sessions.clearActiveTenant(cookie);
          throw new ForbiddenException({
            error: {
              code: 'MEMBERSHIP_REVOKED',
              message: 'You no longer have access to this workspace.',
            },
          });
        }

        // (4) Verified — only now does the tenant axis go live.
        role = rows[0].role;
        await tx.$executeRawUnsafe(
          `SELECT set_config('app.current_tenant', $1, true)`,
          session.activeTenantId,
        );
        tenantId = session.activeTenantId;

        // (4b) THE TENANT THE CALLER EXPECTED — G3, OPEN-15.
        //
        // Checked HERE, immediately after (4), because this is the first instant
        // in the request at which the active tenant is PROVEN. Comparing against
        // the session's stored copy earlier would be comparing a claim to
        // another claim; `session.activeTenantId` is only trustworthy once the
        // membership re-verify above has returned a row for it.
        //
        // WHAT IT CLOSES. Responses do not echo the tenant that scoped them, so
        // a write issued while workspace A was active could land after a switch
        // to B and be applied under B — the cross-tab and late-response write
        // races. The client states the tenant it believed was active; if that
        // disagrees with the verified one, the request is refused rather than
        // silently re-homed.
        //
        // ABSENT MEANS NO CLAIM, AND NO CLAIM IS ALLOWED. A missing header is
        // never a mismatch: Swagger, curl and any non-browser caller send
        // nothing, and refusing them would break every client that never made a
        // claim to begin with. The web client cannot send an EMPTY claim either
        // — `api.ts` only sets the header when the value is truthy — so there is
        // no third state to consider.
        //
        // 409 rather than 403, and a distinct code rather than a shared one, for
        // the same reason NO_ACTIVE_WORKSPACE is not FORBIDDEN_ROLE: "your view
        // of the workspace is stale, re-read and retry" needs a different client
        // response from "you may not do this". The 409 handler is PR 2.
        //
        // Nothing has been written at this point — the handler has not run — and
        // throwing here rolls the transaction back regardless, which is what
        // makes the acceptance test's second half (the target row is UNCHANGED)
        // hold rather than merely the status code.
        const expected = request?.headers?.[EXPECTED_TENANT_HEADER];
        if (
          enforceExpectedTenant &&
          typeof expected === 'string' &&
          expected !== session.activeTenantId
        ) {
          throw new ConflictException({
            error: {
              code: 'TENANT_MISMATCH',
              message: 'Your active workspace changed. Reload and try again.',
            },
          });
        }
      }

      // (5) The role gate — @RequiresRole(), enforced HERE and nowhere else.
      //
      // This is the only point in the request where the answer exists. It is
      // after (4), so `role` is the value just re-read from the database for the
      // active membership — never the copy in the session, which goes stale the
      // moment an admin changes it. And it is inside the interceptor rather than
      // in a CanActivate guard because Nest runs guards BEFORE interceptors: a
      // guard would be asking for a role that has not been resolved yet, and
      // would 500 on every gated route. See requires-role.decorator.ts — this is
      // the Phase 4 ordering defect one layer up, and it is not being repeated.
      //
      // A null role means no active workspace. On a tenant-scoped route that is
      // refused above with NO_ACTIVE_WORKSPACE before this point is reached, so
      // the `!role` arm now matters only for a role-gated route that is also
      // exempt — none exists. It stays: a null role must never read as "allow".
      //
      // This is the OUTER of two checks. The definer function bodies re-check the
      // caller is a live admin of the active tenant, and that check is the one
      // that cannot be bypassed — anything holding the app connection can call
      // the function directly, guard or no guard (ADR-006 §7). Removing this gate
      // must never be justified by the body check, nor the body check by this
      // gate; test/db/membership-writes.spec.ts proves the inner one with nothing
      // in front of it, and is marked load-bearing for exactly that reason.
      if (requiredRoles && requiredRoles.length > 0 && (!role || !requiredRoles.includes(role))) {
        throw new ForbiddenException({
          error: {
            code: 'FORBIDDEN_ROLE',
            message: 'You do not have permission to perform this action in this workspace.',
          },
        });
      }

      return runWithRequestContext({ tx, userId: session.userId, tenantId, role }, () =>
        firstValueFrom(next.handle()),
      );
    }, TRANSACTION_OPTIONS);
  }
}
