import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import {
  LOGIN_FAILURE_AGGREGATE_PREFIX,
  LOGIN_FAILURE_BUCKET_SECONDS,
  LOGIN_FAILURE_EVENT,
  LoginRateLimitService,
} from '../../src/common/rate-limit/login-rate-limit.service';
import { loadEnv, migratorClient, resetDatabase, resetLoginRateLimit } from '../db/helpers';

/**
 * THE MASS-SPRAY SIGNAL — a counter that ships, and an alert that does NOT.
 *
 * ================= WHAT THIS IS, AND WHAT IT IS CAREFULLY NOT ==============
 *
 * `LoginRateLimitService`'s own comment refuses a global rate LIMIT and re-homes
 * the problem here: "Bounding mass spray is a DETECTION problem (step 10
 * observability — alert on the aggregate failure rate), not a limiter problem,
 * because the useful response is 'page someone', never 'refuse everyone'."
 *
 * This is the SIGNAL half, and the distinction is the point rather than a
 * caveat. The counter increments; nothing reads it to make a decision; nothing
 * alerts. **An alert RULE is a platform artifact that lives outside this
 * repository** and is owed on the author checklist in ARCHITECTURE §16.B.
 * Claiming this "detects mass spray" while only the counter exists would be the
 * green-proves-nothing shape the repo keeps recording — so the tests below
 * assert exactly what was built and nothing beyond it.
 *
 * ============ WHY THE PER-EMAIL COUNTERS CANNOT ANSWER THIS ================
 *
 * They are `sha256(email)`, one key each. Summing them means enumerating a
 * keyspace the hashing exists to keep unenumerable. The aggregate has to be
 * counted as it happens, on its own key, and the last test here is the one that
 * shows why: many addresses, each far under its own budget, all invisible to
 * the per-email view and all visible to this one.
 */
describe('the mass-spray aggregate signal', () => {
  let app: INestApplication;
  let migrator: PrismaClient;
  let redis: Redis;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';

  beforeAll(async () => {
    loadEnv();
    migrator = migratorClient();
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2, lazyConnect: false });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await resetLoginRateLimit();
    await redis.quit();
    await app.close();
    await migrator.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(migrator);
    await resetLoginRateLimit();
  });

  const bucketValue = async (): Promise<number> => {
    const raw = await redis.get(LoginRateLimitService.bucketKeyFor());
    return raw === null ? 0 : Number(raw);
  };

  async function seed(email: string): Promise<void> {
    await http()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Org ${email}`, email, password: PASSWORD })
      .expect(201);
  }

  it('starts at zero — the vacuity guard for everything below', async () => {
    expect(await bucketValue()).toBe(0);
  });

  it('counts a failed login in the aggregate bucket', async () => {
    await seed('spray-one@example.test');

    await http()
      .post('/api/v1/auth/login')
      .send({ email: 'spray-one@example.test', password: 'wrong' })
      .expect(401);

    expect(await bucketValue()).toBe(1);
  });

  it('does NOT count a SUCCESSFUL login', async () => {
    // The counter charges failures, like the per-email one it rides along with.
    // A counter that moved on success would make normal traffic look like an
    // attack, which is the fastest way to get an alert rule switched off.
    await seed('spray-ok@example.test');

    await http()
      .post('/api/v1/auth/login')
      .send({ email: 'spray-ok@example.test', password: PASSWORD })
      .expect(200);

    expect(await bucketValue()).toBe(0);
  });

  it('SEES WHAT THE PER-EMAIL COUNTERS CANNOT — many addresses, none over budget', async () => {
    // THE WHOLE REASON THIS EXISTS. Five accounts, two failures each: every
    // per-email bucket sits at 2 against a limit of 10, so not one of them is
    // close to refusing anything and no single bucket looks remarkable. The
    // aggregate is 10, and it is the only number in the system that can say a
    // spray is underway.
    const emails = Array.from({ length: 5 }, (_, i) => `spray-${i}@example.test`);
    for (const email of emails) await seed(email);

    for (const email of emails) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await http().post('/api/v1/auth/login').send({ email, password: 'wrong' }).expect(401);
      }
    }

    expect(await bucketValue()).toBe(10);

    // And the per-email view is, correctly, unalarmed: each is far under budget
    // and a sixth attempt on any of them still gets through to a 401 rather
    // than a 429.
    const stillAllowed = await http()
      .post('/api/v1/auth/login')
      .send({ email: emails[0], password: 'wrong' })
      .expect(401);
    expect(stillAllowed.status).not.toBe(429);
  });

  it('keys the bucket on TIME and carries no identity at all', () => {
    // The aggregate key must not be derivable from, or reveal, who was attacked.
    const key = LoginRateLimitService.bucketKeyFor(1_800_000_000_000);
    expect(key.startsWith(LOGIN_FAILURE_AGGREGATE_PREFIX)).toBe(true);
    expect(key).not.toContain('@');

    // Two moments in the same window share a bucket; a window apart do not.
    const base = 1_800_000_000_000;
    const withinWindow = base + (LOGIN_FAILURE_BUCKET_SECONDS - 1) * 1000;
    const nextWindow = base + LOGIN_FAILURE_BUCKET_SECONDS * 2 * 1000;
    expect(LoginRateLimitService.bucketKeyFor(base)).toBe(
      LoginRateLimitService.bucketKeyFor(withinWindow),
    );
    expect(LoginRateLimitService.bucketKeyFor(base)).not.toBe(
      LoginRateLimitService.bucketKeyFor(nextWindow),
    );
  });

  it('expires, so the keyspace is bounded without a sweeper', async () => {
    await seed('spray-ttl@example.test');
    await http()
      .post('/api/v1/auth/login')
      .send({ email: 'spray-ttl@example.test', password: 'wrong' })
      .expect(401);

    const ttl = await redis.ttl(LoginRateLimitService.bucketKeyFor());
    expect(ttl).toBeGreaterThan(0);
  });

  it('names a STABLE event, because the alert rule that reads it lives elsewhere', () => {
    // A log query, a dashboard and an alert rule will key on this string, and
    // all three are outside this repository. Renaming it silently breaks them
    // with nothing here turning red — so the name is pinned.
    expect(LOGIN_FAILURE_EVENT).toBe('login.failure');
  });
});
