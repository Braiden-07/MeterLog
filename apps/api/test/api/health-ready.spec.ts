import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import { WORKSPACE_EXEMPT_ROUTES } from '../../src/common/tenant-context/tenant-context.interceptor';
import { loadEnv } from '../db/helpers';

/**
 * `/api/v1/health/ready` — the readiness probe (step 10 observability).
 *
 * ============ WHY IT IS A SECOND ROUTE AND NOT A DEEPER `/health` ==========
 *
 * `/api/v1/health` is a DEPLOY GATE: `render.yaml` points Render's health check
 * at it, and ARCHITECTURE §16.1 makes that part of a security control — a
 * container that dies at boot fails the deploy instead of being left in
 * rotation. Making that route touch Postgres would mean a transient database
 * blip failing the deploy gate and taking down a service that was otherwise
 * healthy. Liveness and readiness are different questions with different
 * consumers, so they are two routes.
 *
 * Both halves are asserted here: the gate route still answers exactly what it
 * answered before, and the new route reports dependencies.
 */
describe('the readiness probe', () => {
  let app: INestApplication;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    loadEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an UNAUTHENTICATED caller — the exemption is live, not just declared', async () => {
    // WITHOUT THE EXEMPT-SET ENTRY THIS IS A 401, NOT A 404, and that is the
    // failure this test exists for. The tenant-context interceptor is
    // default-deny: a route absent from `WORKSPACE_EXEMPT_ROUTES` refuses an
    // anonymous caller before the handler. An uptime monitor would then report
    // the service down while it was perfectly healthy — a false alarm forever,
    // from a one-line omission.
    const res = await http().get('/api/v1/health/ready');

    expect([200, 503]).toContain(res.status);
    expect(res.status).not.toBe(401);
  });

  it('is declared in the exempt set — the declaration and the behaviour agree', () => {
    expect(WORKSPACE_EXEMPT_ROUTES.has('GET /health/ready')).toBe(true);
  });

  it('reports BOOLEANS ONLY — no driver text, no host, no timings', async () => {
    // The route is unauthenticated, so everything it returns is returned to
    // anyone. A database driver's error string routinely carries host, port,
    // database and role; this asserts the body cannot become that.
    const res = await http().get('/api/v1/health/ready');
    const body = res.body as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['db', 'ready', 'redis']);
    for (const value of Object.values(body)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('is green here, because the suite runs against a real Postgres and Redis', async () => {
    // The positive control. Without it, every assertion above is satisfied by a
    // probe that reports `false` for everything, forever.
    const res = await http().get('/api/v1/health/ready').expect(200);
    expect(res.body).toEqual({ ready: true, db: true, redis: true });
  });

  it('leaves the liveness route exactly as it was — it is the deploy gate', async () => {
    const res = await http().get('/api/v1/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    // It must NOT have grown dependency reporting. If someone "unifies" the two
    // routes, this is what reds — and the comment on the handler says why that
    // would break the deploy gate.
    expect(res.body.db).toBeUndefined();
    expect(res.body.redis).toBeUndefined();
  });
});
