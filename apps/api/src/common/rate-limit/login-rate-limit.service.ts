import { createHash } from 'node:crypto';

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Redis key prefix. Namespaced like the session prefix so a shared Redis cannot
 * collide with a session or a cache key.
 *
 * EXPORTED because the test teardown clears these keys, and it must not do so
 * through a second copy of the string. This counter is durable state that
 * `resetDatabase` cannot reach — it lives in Redis, not Postgres — so the suite
 * has to clear it explicitly or a bucket filled by one spec file refuses logins
 * in the next. See `resetLoginRateLimit` in `test/db/helpers.ts`.
 */
export const LOGIN_FAILURE_KEY_PREFIX = 'meterlog:loginfail:email:';

/**
 * THE AGGREGATE FAILURE COUNTER — the mass-spray SIGNAL (step 10 observability).
 *
 * This class's own comment refuses a GLOBAL rate LIMIT and re-homes the problem
 * here: "Bounding mass spray is a DETECTION problem (step 10 observability —
 * alert on the aggregate failure rate), not a limiter problem, because the
 * useful response is 'page someone', never 'refuse everyone'." This is that
 * counter, and it REFUSES NOTHING. Nothing reads it to make a decision; it
 * exists to be read by a human or an alert rule.
 *
 * ============ WHY THE PER-EMAIL KEYS CANNOT ANSWER THIS ====================
 *
 * They are `sha256(email)` under one key each. Summing them would mean
 * enumerating a keyspace the hashing exists to keep unenumerable — a `KEYS`
 * scan over live credentials-adjacent data, which is the opposite of the
 * property `keyFor` is built for. An aggregate has to be counted as it happens,
 * on its own key, which is what this is.
 *
 * ==================== WHY THE BUCKET IS COARSE =============================
 *
 * A fixed five-minute bucket, not a per-second series. The question it answers
 * is "is something spraying right now", whose shape is visible at minutes and
 * drowns in per-second noise; and a coarse bucket is a bounded number of keys
 * per day rather than an unbounded time series in a store that is not a metrics
 * database. Redis holds sessions here, and sessions are what must not be
 * evicted to make room for telemetry.
 */
export const LOGIN_FAILURE_AGGREGATE_PREFIX = 'meterlog:loginfail:all:';

/** Bucket width. Five minutes: coarse enough to read, fine enough to alert on. */
export const LOGIN_FAILURE_BUCKET_SECONDS = 5 * 60;

/**
 * How long a bucket survives. Twelve buckets (one hour) so a reader arriving
 * after the fact can see the shape of the last hour rather than only the
 * current five minutes — and so the keyspace is bounded without a sweeper.
 */
export const LOGIN_FAILURE_AGGREGATE_TTL_SECONDS = 12 * LOGIN_FAILURE_BUCKET_SECONDS;

/**
 * The structured event name emitted alongside every charged failure.
 *
 * STABLE, AND THAT IS THE POINT: an alert rule, a log query and a dashboard all
 * key on this string, and all three live OUTSIDE this repository. Renaming it
 * silently breaks them with nothing here turning red, so it is a named export
 * with this comment attached rather than a literal inside a log call.
 */
export const LOGIN_FAILURE_EVENT = 'login.failure';

/**
 * The window, in seconds. Fixed rather than sliding: the counter is created by
 * the first failure and expires whole, so a locked-out caller is always told a
 * bounded `Retry-After` rather than being held by a tail of old attempts.
 */
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

/**
 * Failures tolerated inside the window before the next attempt is refused.
 *
 * Ten, not three. The limiter's job is to make credential-stuffing uneconomic,
 * not to punish typing — and because the axis here is the EMAIL rather than the
 * caller (see the class comment), a tight limit is also a denial-of-service
 * lever against a user whose address someone knows. Ten failures in a quarter of
 * an hour is far outside honest fat-fingering and far inside the budget an
 * attacker needs.
 */
export const LOGIN_FAILURE_LIMIT = 10;

/**
 * PER-EMAIL LOGIN FAILURE COUNTER (OPEN-16).
 *
 * ===================== WHY THE AXIS IS THE EMAIL =============================
 *
 * OPEN-16 was written expecting an IP-based limiter: "login rate-limiting trusts
 * `X-Forwarded-For` with a FIXED trusted-hop count, so a client-supplied header
 * cannot choose its own bucket." That remedy CANNOT work in this topology, and
 * the orientation probe for this PR is what established it rather than any
 * reasoning from the docs.
 *
 * The probe stood the real `apps/web/next.config.mjs` rewrite in front of an
 * echo origin and inspected what arrived, in `next dev` AND in a production
 * `next build` + `next start`:
 *
 *   - client sends no XFF        -> the API sees NO `x-forwarded-for` at all
 *   - client forges `1.2.3.4`    -> the API sees exactly `1.2.3.4`
 *   - client forges a two-hop chain -> it arrives verbatim, nothing appended
 *
 * **Next's rewrite is a verbatim header relay.** It does not originate
 * `X-Forwarded-For` and it does not append the peer to an existing chain. So the
 * hop arithmetic OPEN-16 specifies has nothing to count: the only XFF that ever
 * reaches the API is one the caller typed. Implemented as written, the limiter
 * would bucket on an attacker-controlled string and hand out a fresh bucket per
 * request — strictly WORSE than no limiter, because it would look like it worked.
 *
 * So the axis is the email, which the caller must supply truthfully for the
 * attempt to be worth making at all. This satisfies OPEN-16's stated INTENT — "a
 * client-supplied header cannot choose its own bucket" — more completely than
 * the mechanism it named, by reading nothing client-supplied.
 *
 * ================ AND WHY THERE IS NO GLOBAL COUNTER =========================
 *
 * A site-wide ceiling was considered and is REFUSED, not deferred. A global
 * bucket has no client-identity axis, so anyone at all can fill it and every
 * other user is locked out of logging in: an anonymous, unauthenticated
 * site-outage lever, handed over in the name of hardening. Bounding mass spray
 * is a DETECTION problem (step 10 observability — alert on the aggregate failure
 * rate), not a limiter problem, because the useful response is "page someone",
 * never "refuse everyone".
 *
 * ===================== WHAT IT DELIBERATELY DOES NOT DO ======================
 *
 * It counts FAILURES, so the check necessarily runs before the outcome is known.
 * A burst of genuinely concurrent attempts can therefore all pass the check
 * before any of them records its failure. That is inherent to failure-counting,
 * not an artefact of this implementation: the only way to close it is to count
 * ATTEMPTS up front and refund on success, which trades the race for a different
 * one. It is bounded — a burst buys the attacker one window's worth of
 * concurrency, not an unbounded budget — and the failures still land, so the
 * window still closes. Recorded here rather than left for someone to rediscover.
 *
 * The email is HASHED into the key so a credential never enters a Redis key, a
 * `KEYS` dump, or a slow-log line.
 */
@Injectable()
export class LoginRateLimitService implements OnModuleDestroy {
  private readonly redis: Redis;

  /**
   * Takes no constructor arguments, for the same reason `SessionService` does
   * not: defaulted parameters still count as injectable dependencies to Nest's
   * DI, so `constructor(url = process.env.REDIS_URL)` fails at bootstrap with
   * "can't resolve dependencies ... at index [0]". Configuration is read here.
   *
   * Throws on a missing `REDIS_URL` rather than degrading to an in-memory
   * counter. A rate limiter that silently stops limiting is the failure mode
   * this whole row exists to avoid.
   */
  constructor() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL is not set.');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  }

  /**
   * PING — purely additive, for the readiness probe (`/api/v1/health/ready`).
   *
   * `PING` and nothing else: it reads no key, writes no key, and touches no
   * session. It answers one question — is this connection usable — which is
   * the only question a readiness probe is entitled to ask of a store holding
   * live credentials. Anything richer would make an UNAUTHENTICATED endpoint
   * into a way to measure the store's contents.
   *
   * Never throws. A readiness probe that throws turns a dependency being down
   * into a 500 with a stack, which is both an information leak and the wrong
   * answer: "Redis is unreachable" is a fact to report, not an exception to
   * propagate.
   */
  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  /** Test/teardown hook — the module lifecycle does not run in the DB suites. */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * The bucket key for an email address.
   *
   * Normalised then hashed. Normalisation is what stops `Admin@x.test` and
   * `admin@x.test ` from being two free buckets for one account; the hash is
   * what keeps the address itself out of Redis.
   */
  static keyFor(email: string): string {
    const normalised = email.trim().toLowerCase();
    return LOGIN_FAILURE_KEY_PREFIX + createHash('sha256').update(normalised).digest('hex');
  }

  /**
   * The aggregate bucket key for a moment in time. No identity in it at all —
   * that is the difference between this and `keyFor`, and the reason it can be
   * read freely without touching anything about who was attacked.
   */
  static bucketKeyFor(atMs: number = Date.now()): string {
    const bucket = Math.floor(atMs / 1000 / LOGIN_FAILURE_BUCKET_SECONDS);
    return LOGIN_FAILURE_AGGREGATE_PREFIX + String(bucket);
  }

  /**
   * Is this email over budget right now? Reads only — the attempt has not
   * happened yet, and an attempt that is about to succeed must not be charged.
   */
  async check(key: string): Promise<{ limited: boolean; retryAfterSeconds: number }> {
    const [raw, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
    const count = raw === null ? 0 : Number(raw);
    if (!Number.isFinite(count) || count < LOGIN_FAILURE_LIMIT) {
      return { limited: false, retryAfterSeconds: 0 };
    }
    // A positive TTL is the real remaining window; anything else (-1 no expiry,
    // -2 vanished between the two reads) falls back to the full window rather
    // than promising a retry time that has already passed.
    return {
      limited: true,
      retryAfterSeconds: ttl > 0 ? ttl : LOGIN_FAILURE_WINDOW_SECONDS,
    };
  }

  /**
   * Charge one failure. The expiry is attached on the FIRST failure only, so the
   * window is anchored to the first bad attempt and does not slide forward with
   * each subsequent one — a sliding expiry would let a patient attacker hold a
   * victim locked out indefinitely.
   */
  async recordFailure(key: string): Promise<{ emailFailures: number; windowFailures: number }> {
    const bucketKey = LoginRateLimitService.bucketKeyFor();

    // ONE ROUND TRIP FOR BOTH COUNTERS, and that is not micro-optimisation.
    // This runs inside `chargeFailureBeforeResponding`, which holds the response
    // open until it resolves — so a second sequential round trip would add its
    // full latency to every failed login. Pipelined, the aggregate costs the
    // signal nothing measurable.
    const [emailFailures, windowFailures] = (await this.redis
      .multi()
      .incr(key)
      .incr(bucketKey)
      .exec()
      .then((replies) => (replies ?? []).map(([, value]) => Number(value)))) as [number, number];

    // Expiries are attached on the FIRST increment of each key only. For the
    // per-email key that is load-bearing: a sliding expiry would let a patient
    // attacker hold a victim locked out indefinitely. For the aggregate it
    // simply bounds the keyspace.
    const expiries = [];
    if (emailFailures === 1) expiries.push(this.redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS));
    if (windowFailures === 1) {
      expiries.push(this.redis.expire(bucketKey, LOGIN_FAILURE_AGGREGATE_TTL_SECONDS));
    }
    if (expiries.length > 0) await Promise.all(expiries);

    return { emailFailures, windowFailures };
  }
}
