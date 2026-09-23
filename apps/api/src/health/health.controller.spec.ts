import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../common/prisma/prisma.service';
import type { LoginRateLimitService } from '../common/rate-limit/login-rate-limit.service';
import type { SessionService } from '../common/session/session.service';
import { HealthController } from './health.controller';

// The trivial passing test the CI pipeline is proven against at scaffold
// (PROJECT_BRIEF §11 step 3), plus the readiness unit cases the acceptance
// spec cannot reach: `test/api/health-ready.spec.ts` runs against a real
// Postgres and Redis, so it can only ever observe the HEALTHY branch. The
// DOWN branches are what this file is for, and they are the branches that
// matter — a probe that cannot report a failure is a probe that never fires.
function controllerWith(db: boolean, sessionRedis: boolean, limiterRedis: boolean) {
  return new HealthController(
    {
      $queryRaw: () =>
        db ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('connection refused')),
    } as unknown as PrismaService,
    { ping: () => Promise.resolve(sessionRedis) } as unknown as SessionService,
    { ping: () => Promise.resolve(limiterRedis) } as unknown as LoginRateLimitService,
  );
}

/** Captures the status the handler sets, standing in for Express's response. */
function fakeResponse(): { status: (code: number) => void; code: number | null } {
  const captured = { code: null as number | null, status: (c: number) => void (captured.code = c) };
  return captured;
}

describe('HealthController', () => {
  it('reports ok', () => {
    expect(controllerWith(true, true, true).check().status).toBe('ok');
  });

  it('is READY when every dependency answers', async () => {
    const res = fakeResponse();
    const report = await controllerWith(true, true, true).ready(res as never);

    expect(report).toEqual({ ready: true, db: true, redis: true });
    expect(res.code).toBe(200);
  });

  it('answers 503 when Postgres is unreachable — a monitor alerts on the STATUS', async () => {
    // A 200 carrying `{db:false}` is a monitor that never fires and a dashboard
    // that stays green through an outage. The body is for a human reading it;
    // the status code is for the machine watching it.
    const res = fakeResponse();
    const report = await controllerWith(false, true, true).ready(res as never);

    expect(report).toEqual({ ready: false, db: false, redis: true });
    expect(res.code).toBe(503);
  });

  it('answers 503 when EITHER Redis connection is down', async () => {
    // Two independent clients: `SessionService`'s loss logs everyone out, and
    // `LoginRateLimitService`'s makes login stop being rate-limited. A probe
    // that pinged only one would report ready through the other's outage.
    for (const [session, limiter] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      const res = fakeResponse();
      const report = await controllerWith(true, session, limiter).ready(res as never);

      expect(report.redis).toBe(false);
      expect(report.ready).toBe(false);
      expect(res.code).toBe(503);
    }
  });

  it('does not throw when a dependency fails — it reports', async () => {
    // "Postgres is unreachable" is the fact this endpoint exists to report, not
    // an exception to propagate. Throwing would produce a 500 with a stack on
    // an UNAUTHENTICATED route, which is both the wrong answer and a leak.
    const res = fakeResponse();
    await expect(controllerWith(false, false, false).ready(res as never)).resolves.toEqual({
      ready: false,
      db: false,
      redis: false,
    });
  });
});
