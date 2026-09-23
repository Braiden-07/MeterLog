import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { PrismaService } from '../common/prisma/prisma.service';
import { LoginRateLimitService } from '../common/rate-limit/login-rate-limit.service';
import { SessionService } from '../common/session/session.service';

/** What `/health/ready` answers with. Booleans and nothing else — see below. */
export interface ReadinessReport {
  ready: boolean;
  db: boolean;
  redis: boolean;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly limiter: LoginRateLimitService,
  ) {}

  // Target of the uptime monitor (PROJECT_BRIEF §10) and of the post-deploy
  // smoke test (§9). Unauthenticated by design, so it must never report
  // anything that isn't safe to expose publicly.
  //
  // ============== THIS ROUTE IS A DEPLOY GATE. DO NOT CHANGE IT. ============
  //
  // `render.yaml` points `healthCheckPath` here, and ARCHITECTURE §16.1 makes
  // that part of a security control rather than a monitor: `SessionService`
  // throws in its constructor without a secret, so DI fails at bootstrap and the
  // process exits — but a fail-closed guard is only worth what the moment it
  // first runs is worth, and that moment is this check. Reaching this handler
  // proves the app wired up.
  //
  // DO NOT REPOINT RENDER AT `/health/ready` BELOW. That route touches Postgres
  // and Redis, so a transient database blip would fail the DEPLOY GATE and take
  // down a service that was otherwise healthy. Liveness and readiness are
  // different questions with different consumers, which is why they are two
  // routes rather than one route with a flag.
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  check(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  /**
   * READINESS — can this process actually serve, as opposed to merely being up.
   *
   * ==================== BOOLEANS ONLY, AND THAT IS THE DESIGN ================
   *
   * This route is UNAUTHENTICATED, like its sibling, so everything it returns is
   * returned to anyone. It reports three booleans and nothing else: no driver
   * messages, no error text, no host names, no versions, no timings. Each of
   * those is a fact about the infrastructure that an attacker would otherwise
   * have to guess at, and an error string from a database driver is the
   * canonical example — they routinely carry host, port, database and role.
   *
   * It is also kept CHEAP for the same reason it is kept quiet. An
   * unauthenticated endpoint that does real work is a denial-of-service
   * amplifier: `SELECT 1` plans nothing and reads no table, and `PING` reads no
   * key. Neither can be made expensive by the caller, because the caller
   * supplies no input at all.
   *
   * =============== 503 WHEN A DEPENDENCY IS DOWN, DELIBERATELY ==============
   *
   * An uptime monitor alerts on a status code. A 200 carrying `{db:false}` is a
   * monitor that never fires and a dashboard that stays green through an
   * outage — the failure this whole PR exists to prevent. So the body is for a
   * human reading it and the STATUS is for the machine watching it.
   *
   * ================== BOTH REDIS CONNECTIONS, NOT ONE =======================
   *
   * `SessionService` and `LoginRateLimitService` each construct their own
   * client, so pinging one proves one. Losing the session connection logs
   * everyone out (ADR-001); losing the limiter's connection makes login stop
   * being rate-limited, which fails OPEN by deliberate design in the middleware.
   * Those are different failures and a probe that could only see the first would
   * report ready during the second. They are reported as one `redis` boolean
   * because the caller's question is "can it serve", and the distinction between
   * the two belongs in the logs rather than on a public endpoint.
   *
   * `SELECT 1` runs outside the interceptor's transaction — this route has no
   * session, so no tenant context is opened — and touches no table, so RLS is
   * not in its path and cannot make the answer misleading.
   */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe — reports whether Postgres and Redis are reachable.',
  })
  @ApiResponse({ status: 200, description: 'Every dependency is reachable.' })
  @ApiResponse({ status: 503, description: 'At least one dependency is unreachable.' })
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const [db, sessionRedis, limiterRedis] = await Promise.all([
      this.pingDatabase(),
      this.sessions.ping(),
      this.limiter.ping(),
    ]);

    const redis = sessionRedis && limiterRedis;
    const ready = db && redis;

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { ready, db, redis };
  }

  /**
   * Never throws, for the reason the `ping()` methods do not: "Postgres is
   * unreachable" is a fact this endpoint exists to report, not an exception to
   * propagate. Letting it throw would produce a 500 with a stack where a 503
   * with a boolean belongs.
   */
  private async pingDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
