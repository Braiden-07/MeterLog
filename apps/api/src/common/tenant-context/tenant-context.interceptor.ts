import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, firstValueFrom, from } from 'rxjs';

import { REQUIRES_ROLE } from '../auth/requires-role.decorator';
import { REQUIRES_SESSION } from '../auth/requires-session.decorator';

import { PrismaService, TRANSACTION_OPTIONS } from '../prisma/prisma.service';
import { runWithRequestContext } from '../request-context/request-context';
import { SESSION_COOKIE, SessionService } from '../session/session.service';

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
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string> }>();
    const cookie = SessionService.readCookie(request?.headers?.cookie, SESSION_COOKIE);
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

    if (!session) {
      // No identity to scope by, so no transaction and no GUCs.
      //
      // Whether that is ALLOWED is the route's declaration, not this
      // interceptor's opinion: /health, /auth/register and /auth/login all
      // legitimately arrive without a session, while /auth/me and /auth/switch
      // cannot function without one. Routes say so with @RequiresSession().
      //
      // Enforced here rather than in a CanActivate guard because Nest runs guards
      // BEFORE interceptors — a guard cannot see a context this interceptor has
      // not established yet, and one written that way rejects every request.
      const required = this.reflector.getAllAndOverride<boolean>(REQUIRES_SESSION, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (required || (requiredRoles && requiredRoles.length > 0)) {
        throw new UnauthorizedException({
          error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
        });
      }
      return firstValueFrom(next.handle());
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
      // A null role means no active workspace (zero or several memberships, none
      // selected). That fails the gate: there is no tenant in which the caller
      // holds the required role, so the answer is 403, not "allow".
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
