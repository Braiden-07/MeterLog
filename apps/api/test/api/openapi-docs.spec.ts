import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, OPENAPI_VERSION, configureApp, mountOpenApi } from '../../src/bootstrap';
import { loadEnv } from '../db/helpers';

/**
 * `/api/v1/docs` IS PUBLIC ON PURPOSE — this file is the line that says so.
 *
 * ===================== WHY A TEST AND NOT JUST A COMMENT ====================
 *
 * An unauthenticated docs UI in production is the shape a reviewer, a scanner or
 * a future contributor flags on sight, and the reflex is to gate it behind a
 * session or to drop it in production. Either would be a silent scope change:
 * `PROJECT_BRIEF` §12 lists OpenAPI docs among the essential-endpoints box, and
 * this is a public portfolio repository whose whole point is being readable.
 *
 * So the decision is pinned where a reflex-gate reds. Someone who adds a guard
 * to the docs route gets a failing test naming the decision, not a quiet
 * regression discovered when the deployed link 401s. That is the same reason
 * `route-inventory.spec.ts` exists: a deliberate surface that nothing asserts is
 * one refactor from being an accidental one.
 *
 * ==================== WHY IT CALLS `mountOpenApi` ===========================
 *
 * The mount used to live inline in `main.ts`, which no acceptance spec runs —
 * so a test of this claim could only have stood up its OWN Swagger mount and
 * asserted against that, proving that `SwaggerModule.setup` works rather than
 * that THIS API serves the page. The deploy-config PR moved the mount into
 * `bootstrap.ts` for exactly that reason, and this file calls it. The argument
 * is the one `bootstrap.ts` already makes about `configureApp`: a spec asserting
 * what production serves has to run production's code.
 *
 * ======================= WHAT THIS DOES NOT CLAIM ===========================
 *
 * It says nothing about the document's CONTENT — that every route is present,
 * summarised and tagged is `pending-split.spec.ts`'s scope, and it builds its
 * own document for it. It also does not prove the page is reachable on the
 * DEPLOYED origin through the Vercel rewrite; nothing local can, and that is the
 * deploy smoke test's job (`ARCHITECTURE.md` §16).
 *
 * NO DATABASE. It issues two GETs that touch no handler and no Postgres, so it
 * needs neither `resetDatabase` nor a migrator client — only `loadEnv`, because
 * `SessionService` and `LoginRateLimitService` are constructed during
 * `AppModule`'s DI and both refuse to exist without their configuration.
 */
describe('the OpenAPI page is deliberately public', () => {
  let app: INestApplication;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    loadEnv();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    // PRODUCTION'S MOUNT, NOT A COPY — the whole point of this file.
    mountOpenApi(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the Swagger UI to a caller with no session at all', async () => {
    // NO COOKIE, NO HEADER, NOTHING. If someone gates this route, this is the
    // assertion that turns red, and the failure names the decision rather than
    // a status code in isolation.
    const res = await http().get('/api/v1/docs').expect(200);

    // Non-vacuity: a 200 alone would also be satisfied by a route that answers
    // with an empty body or by Nest's own fallthrough. It has to be the UI.
    expect(res.text, 'the response must be the Swagger UI document').toContain('swagger');
  });

  it('serves the generated JSON document publicly too, carrying the current version', async () => {
    // `SwaggerModule.setup` mounts the JSON alongside the UI. It is the half a
    // client actually consumes, so the exposure decision covers it and it is
    // asserted rather than assumed to follow.
    const res = await http().get('/api/v1/docs-json').expect(200);

    const doc = res.body as { info?: { version?: string; title?: string } };
    expect(doc.info?.title).toBe('MeterLog API');

    // PINS THE VERSION TO ITS CONSTANT, not to a literal repeated here. A
    // hardcoded '1.0.0-rc.1' in this file would be a second place to maintain —
    // the drift this repo keeps recording — and would let the constant change
    // without anything noticing. What is asserted is that the page advertises
    // the version the source declares.
    expect(doc.info?.version).toBe(OPENAPI_VERSION);

    // AND THAT IT IS NO LONGER THE SCAFFOLD VALUE. `0.1.0` was set at step 3 and
    // was still being served, publicly, as the first thing above the route list
    // at step 10. This is the guard against it drifting back.
    expect(doc.info?.version).not.toBe('0.1.0');
  });
});
