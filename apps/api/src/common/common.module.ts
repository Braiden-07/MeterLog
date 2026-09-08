import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service';
import { SessionService } from './session/session.service';
import { TenantContextInterceptor } from './tenant-context/tenant-context.interceptor';

/**
 * Request-scoping machinery (step 4, Phase 3).
 *
 * The interceptor is provided but deliberately NOT registered with APP_INTERCEPTOR
 * yet: there are no authenticated routes to apply it to until Phase 4, and binding
 * it globally now would wrap /health — and every future public route — in an
 * interactive transaction for no reason. Phase 4 binds it where it belongs.
 */
@Global()
@Module({
  providers: [PrismaService, SessionService, TenantContextInterceptor],
  exports: [PrismaService, SessionService, TenantContextInterceptor],
})
export class CommonModule {}
