import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { HttpExceptionFilter } from './http/http-exception.filter';
import { PrismaService } from './prisma/prisma.service';
import { SessionService } from './session/session.service';
import { TenantContextInterceptor } from './tenant-context/tenant-context.interceptor';

/**
 * Request-scoping machinery (step 4).
 *
 * The interceptor is bound GLOBALLY via APP_INTERCEPTOR as of Phase 4. Binding
 * was deferred through Phase 3 because there were no authenticated routes to
 * apply it to, and deferred wiring is exactly the kind that gets forgotten — so
 * `test/api/auth.spec.ts` proves over real HTTP that it is live, in both
 * directions: an authenticated request has context set, and a request with no
 * valid session gets none. If it were silently unbound, every endpoint would run
 * with no tenant context: a wall of empty results at best, and fail-OPEN on any
 * query path that does not depend on the GUC.
 *
 * Global is correct rather than per-route: it opens a transaction only when a
 * session is actually present, so /health and the pre-auth endpoints
 * (register, login) pass straight through untouched.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    SessionService,
    TenantContextInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: TenantContextInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
  exports: [PrismaService, SessionService, TenantContextInterceptor],
})
export class CommonModule {}
