import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AssetsModule } from './assets/assets.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MembershipsModule } from './memberships/memberships.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,
    AuthModule,
    MembershipsModule,
    AssetsModule,
    MaintenanceModule,
    HealthModule,
  ],
})
export class AppModule {}
