import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { MembershipsModule } from './memberships/memberships.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,
    AuthModule,
    MembershipsModule,
    HealthModule,
  ],
})
export class AppModule {}
