import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/** Cookie carrying the signed session id. */
export const SESSION_COOKIE = 'meterlog_sid';

/** Redis key prefix. Namespaced so a shared Redis cannot collide with a cache key. */
const KEY_PREFIX = 'meterlog:sess:';

/** Eight hours. Refreshed on every read, so an active session does not expire under a user. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * What the server remembers about a logged-in person (ADR-001, ADR-006 §4).
 *
 * This lives in Redis, not in a token, and that is the point: the client cannot
 * forge an active tenant, because it never holds one — only an opaque id. The
 * "belt" half of ADR-006 §4's belt-and-braces.
 */
export interface SessionData {
  readonly userId: string;
  /** Null until a workspace is chosen — 0 memberships, or >1 and none picked yet. */
  readonly activeTenantId: string | null;
  /**
   * The role at the time the tenant was selected.
   *
   * **Never authoritative.** ADR-006 §4 stores it, but the per-request re-verify
   * re-reads the role from the database and that value is what RBAC uses. This
   * copy is stale the instant an admin changes the role, and reading it for an
   * authorization decision is a bug — `RequestContext.role` is the one to use.
   */
  readonly role: string | null;
}

@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly secret: string;

  constructor(redisUrl = process.env.REDIS_URL, secret = process.env.SESSION_SECRET) {
    if (!redisUrl) throw new Error('REDIS_URL is not set.');
    if (!secret) throw new Error('SESSION_SECRET is not set.');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    this.secret = secret;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  /** Test/teardown hook — the module lifecycle does not run in the DB suites. */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  // -- signing --------------------------------------------------------------

  /**
   * `<id>.<hmac>`. The id alone is unguessable (128 bits), so the signature is
   * not what makes the session secret — it is what stops a forged or truncated
   * cookie from reaching Redis at all, and keeps session ids from being probed
   * by a client that only controls the cookie value.
   */
  private sign(id: string): string {
    const mac = createHmac('sha256', this.secret).update(id).digest('base64url');
    return `${id}.${mac}`;
  }

  private unsign(signed: string): string | null {
    const dot = signed.lastIndexOf('.');
    if (dot <= 0) return null;
    const id = signed.slice(0, dot);
    const given = Buffer.from(signed.slice(dot + 1));
    const expected = Buffer.from(createHmac('sha256', this.secret).update(id).digest('base64url'));
    // Length check first: timingSafeEqual throws on a length mismatch.
    if (given.length !== expected.length) return null;
    return timingSafeEqual(given, expected) ? id : null;
  }

  // -- lifecycle ------------------------------------------------------------

  /** Creates a session and returns the **signed** value to put in the cookie. */
  async create(data: SessionData): Promise<string> {
    const id = randomBytes(16).toString('base64url');
    await this.redis.set(KEY_PREFIX + id, JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
    return this.sign(id);
  }

  /** Reads a session by its signed cookie value, sliding the TTL forward. */
  async read(signed: string | undefined): Promise<SessionData | null> {
    if (!signed) return null;
    const id = this.unsign(signed);
    if (!id) return null;
    const raw = await this.redis.get(KEY_PREFIX + id);
    if (raw === null) return null;
    await this.redis.expire(KEY_PREFIX + id, SESSION_TTL_SECONDS);
    return JSON.parse(raw) as SessionData;
  }

  async update(signed: string, patch: Partial<SessionData>): Promise<void> {
    const id = this.unsign(signed);
    if (!id) return;
    const raw = await this.redis.get(KEY_PREFIX + id);
    if (raw === null) return;
    const next = { ...(JSON.parse(raw) as SessionData), ...patch };
    await this.redis.set(KEY_PREFIX + id, JSON.stringify(next), 'EX', SESSION_TTL_SECONDS);
  }

  /**
   * Drops the active workspace, leaving the person logged in.
   *
   * Called when the per-request re-verify finds the membership gone (ADR-006
   * §4): the session must not keep re-asserting a tenant the user no longer
   * holds, or every subsequent request repeats the same rejected claim.
   */
  async clearActiveTenant(signed: string): Promise<void> {
    await this.update(signed, { activeTenantId: null, role: null });
  }

  async destroy(signed: string): Promise<void> {
    const id = this.unsign(signed);
    if (id) await this.redis.del(KEY_PREFIX + id);
  }

  // -- request plumbing -----------------------------------------------------

  /**
   * Minimal cookie-header parse. `cookie-parser` would do this, but it is four
   * lines and the API has no other use for the dependency.
   */
  static readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() !== name) continue;
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
  }
}
