import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { AssetsModule } from './assets/assets.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { LOGGER_OPTIONS } from './common/observability/logging';
import { HealthModule } from './health/health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MembershipsModule } from './memberships/memberships.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Structured logging. Registered as a MODULE, so its middleware is applied
    // by Nest during `app.init()` — after everything `configureApp` mounts with
    // `app.use(...)`. The request-pipeline floor is therefore untouched and the
    // acceptance suite pins the same pipeline it always did (see logging.ts).
    LoggerModule.forRoot(LOGGER_OPTIONS),
    CommonModule,
    AuthModule,
    MembershipsModule,
    AssetsModule,
    MaintenanceModule,
    AuditModule,
    HealthModule,
  ],
})
export class AppModule {}
