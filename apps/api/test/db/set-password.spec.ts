import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appClient, loadEnv, migratorClient, resetDatabase } from './helpers';

/**
 * Step 8 (OPEN-7) — `set_password` and the pending read, proven against live
 * Postgres.
 *
 * MIGRATED AT THE PENDING SPLIT (OPEN-14). `list_pending_invites` no longer
 * mints: it is a metadata read, and issuing is `mint_invite_token`, one
 * membership at a time. The `mintFor` fixture below composes the two so the
 * redemption-side properties this file exists to prove — single-use consume, the
 * 72h TTL, the monotonic guard, the both-or-neither transaction — are asserted
 * exactly as before, against tokens that now arrive by an explicit mint. The new
 * function's own authorization surface is proven separately, with nothing in
 * front of it, in `test/db/mint-invite-token.spec.ts`.
 *
 * THE ENTIRE POINT OF THIS FILE IS *HOW* THE NEGATIVES ARE PRODUCED, and it is
 * the same point `membership-writes.spec.ts` makes. Every call below is made as
 * `meterlog_app`, over a plain database connection, with
 * `app.current_user` / `app.current_tenant` set BY HAND. No interceptor, no Nest,
 * no HTTP, no RBAC guard.
 *
 * That is the property under test, not a convenience. Both functions are
 * `EXECUTE`-able by `meterlog_app`, so anything holding that connection can call
 * them directly, guard or no guard. And `invite_tokens_definer` is
 * `USING (true) WITH CHECK (true)`, so — exactly as DECISION B left `memberships`
 * — there is NOTHING underneath these bodies. The tenant scoping, the admin
 * check, the single-use consume, the TTL and the monotonic guard are all the
 * bodies' sole responsibility. A negative routed through an HTTP guard would
 * prove the guard and leave the body untested.
 *
 * 42501 DISAMBIGUATION IS A RUNNING THEME HERE. `permission denied` is what
 * Postgres raises for a plain privilege denial, so a negative that merely
 * asserts "it was rejected" can pass against a misconfigured GRANT that never
 * reached the function body. Every negative below therefore names the mechanism
 * that refused it: a custom SQLSTATE the cluster cannot otherwise raise (SP001 /
 * SP002 / SP003), or — for the column-grant floor — a paired positive proving the
 * table is reachable and only the column is not.
 *
 * Seeding runs as the migration role because the app role deliberately cannot
 * write any of these tables.
 */

/** SQLSTATEs raised by the step-8 definer functions (20260915000000). */
const INVALID_TOKEN = 'SP001';
const PASSWORD_ALREADY_SET = 'SP002';
const NOT_ADMIN = 'SP003';
const INSUFFICIENT_PRIVILEGE = '42501';
const NOT_NULL_VIOLATION = '23502';

/** A real-looking argon2id hash. Never verified here — only its presence matters. */
const REAL_HASH = '$argon2id$v=19$m=19456,t=2,p=1$cmVhbHNhbHR2YWx1ZQ$0000000000000000000000000000';
const OTHER_HASH = '$argon2id$v=19$m=19456,t=2,p=1$b3RoZXJzYWx0dmFsdWU$1111111111111111111111111111';

/**
 * Prisma surfaces a raised SQLSTATE structurally, never as message text.
 * Returns undefined for a non-database error so an assertion on it fails loudly
 * rather than matching by accident.
 */
function sqlState(error: unknown): string | undefined {
  const meta = (error as { meta?: { code?: string } })?.meta;
  return meta?.code;
}

/** Runs `body` and returns the SQLSTATE it raised, or throws if it did not raise. */
async function sqlStateOf(body: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await body();
  } catch (error) {
    return sqlState(error);
  }
  throw new Error('expected the call to raise, but it succeeded');
}

async function withContext<T>(
  client: PrismaClient,
  ctx: { userId?: string; tenantId?: string },
  body: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, ctx.userId);
    }
    if (ctx.tenantId !== undefined) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, ctx.tenantId);
    }
    return body(tx as unknown as PrismaClient);
  });
}

interface PendingInvite {
  membership_id: string;
  user_id: string;
  email: string;
  role: string;
  token: string;
  expires_at: Date;
}

describe('set_password / the pending read — step 8 (OPEN-7), split at OPEN-14', () => {
  let app: PrismaClient;
  let migrator: PrismaClient;

  beforeAll(async () => {
    loadEnv();
    app = appClient();
    migrator = migratorClient();
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await app.$disconnect();
    await migrator.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(migrator);
  });

  /**
   * An admin and a pending invitee, built the way production builds them:
   * `register_tenant` for the founder, `invite_member` for the invitee. Nothing
   * here hand-writes a `users` row, so the pending state under test is the real
   * one rather than a fixture's imitation of it.
   */
  async function seedTenant(
    name: string,
    adminEmail: string,
    inviteeEmail: string,
  ): Promise<{ tenantId: string; adminId: string; inviteeId: string }> {
    const [org] = await migrator.$queryRawUnsafe<{ tenant_id: string; user_id: string }[]>(
      `SELECT tenant_id, user_id FROM public.register_tenant($1, $2::citext, $3)`,
      name,
      adminEmail,
      REAL_HASH,
    );

    const invited = await withContext(
      migrator,
      { userId: org!.user_id, tenantId: org!.tenant_id },
      (tx) =>
        tx.$queryRawUnsafe<{ user_id: string }[]>(
          `SELECT user_id FROM public.invite_member($1::citext, 'technician', $2::text)`,
          inviteeEmail,
          OTHER_HASH,
        ),
    );

    return {
      tenantId: org!.tenant_id,
      adminId: org!.user_id,
      inviteeId: invited[0]!.user_id,
    };
  }

  /**
   * MIGRATED AT THE PENDING SPLIT (OPEN-14), and its shape is deliberately
   * unchanged so every call site below still reads as "the tokens for this
   * tenant's pending invites".
   *
   * WHAT CHANGED IS THAT IT IS NOW TWO CALLS, which is the split itself: the read
   * lists, and a mint per row issues. Before, one read did both. Both calls are
   * still made DIRECTLY as `meterlog_app` with the GUCs set by hand, so this file
   * keeps its standard of proof — nothing is routed through a guard.
   *
   * The admin negatives below still fire on the FIRST call, because
   * `list_pending_invites` checks the same live-admin condition and raises the
   * same SP003. That is why those tests needed no change: the refusal they assert
   * is the read's, and the read still refuses.
   */
  const mintFor = async (tenantId: string, adminId: string): Promise<PendingInvite[]> => {
    const pending = await withContext(app, { userId: adminId, tenantId }, (tx) =>
      tx.$queryRawUnsafe<{ membership_id: string }[]>(
        `SELECT * FROM public.list_pending_invites()`,
      ),
    );

    const minted: PendingInvite[] = [];
    for (const row of pending) {
      const [token] = await withContext(app, { userId: adminId, tenantId }, (tx) =>
        tx.$queryRawUnsafe<PendingInvite[]>(
          `SELECT * FROM public.mint_invite_token($1::uuid)`,
          row.membership_id,
        ),
      );
      minted.push(token!);
    }
    return minted;
  };

  const redeem = (token: string, hash: string | null) =>
    app.$queryRawUnsafe(`SELECT public.set_password($1::text, $2::text)`, token, hash);

  const userState = async (userId: string) => {
    const [row] = await migrator.$queryRawUnsafe<
      { password_hash: string; pending: boolean }[]
    >(
      `SELECT password_hash, (password_set_at IS NULL) AS pending
         FROM public.users WHERE id = $1::uuid`,
      userId,
    );
    return row!;
  };

  const tokenState = async (userId: string) => {
    return migrator.$queryRawUnsafe<{ consumed_at: Date | null; expires_at: Date }[]>(
      `SELECT consumed_at, expires_at FROM public.invite_tokens
        WHERE user_id = $1::uuid ORDER BY created_at`,
      userId,
    );
  };

  // =========================================================================
  describe('the pending predicate', () => {
    it('invite_member creates a PENDING identity; register_tenant does NOT', async () => {
      // The two write paths into `users` disagree deliberately, and that
      // disagreement IS the pending predicate. If this ever stops being true,
      // every negative below is testing nothing.
      const { adminId, inviteeId } = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');

      expect((await userState(adminId)).pending, 'a registered founder must NOT be pending').toBe(
        false,
      );
      expect((await userState(inviteeId)).pending, 'an invited user MUST be pending').toBe(true);
    });

    it('the app role CANNOT read password_set_at — 42501, and it is the GRANT', async () => {
      // THE LOGIN-INVISIBILITY FLOOR, behaviourally. Catalog assertion 18 pins the
      // grant; this proves what the grant does to a real query.
      //
      // DISAMBIGUATION IS THE WHOLE JOB HERE. Postgres reports a column-grant
      // denial as `permission denied for TABLE users` — the message is
      // indistinguishable from a whole-table denial, so catching 42501 alone
      // would also pass if the app role had lost access to `users` entirely, or
      // if the table had been renamed out from under the test. Three paired
      // assertions separate the mechanisms:
      await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');

      // (1) the table IS reachable — so the refusal below is not about the table.
      await expect(
        app.$queryRawUnsafe(`SELECT id, email FROM public.users`),
        'the app role must still be able to read users, or the negative below is vacuous',
      ).resolves.toBeDefined();

      // (2) the withheld column is refused, with the privilege SQLSTATE.
      const state = await sqlStateOf(() =>
        app.$queryRawUnsafe(`SELECT password_set_at FROM public.users`),
      );
      expect(state, 'reading password_set_at as the app role must fail 42501').toBe(
        INSUFFICIENT_PRIVILEGE,
      );

      // (3) and the OTHER withheld column fails identically — so the mechanism is
      // "columns not on the grant", not something specific to the new column.
      expect(
        await sqlStateOf(() => app.$queryRawUnsafe(`SELECT password_hash FROM public.users`)),
        'password_hash must be refused by the same mechanism',
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  // =========================================================================
  describe('the positive path, under FORCE ROW LEVEL SECURITY', () => {
    it('mint → redeem sets a real password and consumes the token', async () => {
      // PROVEN LIVE RATHER THAN ASSUMED, because `users` is FORCE RLS and the
      // UPDATE path had been unreachable since step 4 — no role held the
      // privilege, so no statement had ever tested whether the definer policy
      // actually permits the write. FORCE applies policies to the table owner
      // too, so "the definer owns it" is not an answer.
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );

      const pending = await mintFor(tenantId, adminId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.email).toBe('new@acme.test');
      expect(pending[0]!.token, 'a plaintext token must be returned on read').toMatch(
        /^[0-9a-f]{64}$/,
      );

      await redeem(pending[0]!.token, REAL_HASH);

      const after = await userState(inviteeId);
      expect(after.password_hash, 'the new hash must be written').toBe(REAL_HASH);
      expect(after.pending, 'the account must no longer be pending').toBe(false);

      const tokens = await tokenState(inviteeId);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.consumed_at, 'the token must be consumed').not.toBeNull();
    });

    it('stores ONLY the hash — the plaintext token is not in the table', async () => {
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      const [invite] = await mintFor(tenantId, adminId);

      // The stored value must be the SHA-256 of the plaintext and nothing else.
      // Asserted as an equality against a hash computed in SQL, so "it is not the
      // plaintext" is proven by showing what it IS.
      const [row] = await migrator.$queryRawUnsafe<{ matches: boolean; is_plaintext: boolean }[]>(
        `SELECT token_hash = sha256(convert_to($2::text, 'UTF8')) AS matches,
                token_hash = convert_to($2::text, 'UTF8')        AS is_plaintext
           FROM public.invite_tokens WHERE user_id = $1::uuid`,
        inviteeId,
        invite!.token,
      );
      expect(row!.matches, 'stored value must be the SHA-256 of the token').toBe(true);
      expect(row!.is_plaintext, 'the plaintext must never be stored').toBe(false);
    });
  });

  // =========================================================================
  describe('token negatives — one external code, three distinct internal paths', () => {
    /*
     * SP001 covers unknown, expired and replayed alike, deliberately: telling a
     * caller a token is "expired" rather than "unknown" confirms it was once
     * real, which is an oracle over the token space (the MB002 reasoning).
     *
     * So each negative asserts SP001 **and** the database state that path leaves
     * behind. Asserting only the code would let all three collapse into one test
     * that cannot tell whether the other two paths still work.
     *
     * WHAT ACTUALLY DISTINGUISHES THEM IS THE TABLE, NOT THE FUNCTION, and this
     * was corrected after a mutation test rather than reasoned out in advance.
     * Because the RAISE unwinds the consume in every failing path, expiry and
     * forgery leave IDENTICAL state in `invite_tokens` — a mutant that folded the
     * expiry check into the consume predicate passed the expiry test unchanged.
     * The real discriminators are: forgery matches NO ROW for the hash; expiry
     * matches a row whose `expires_at` is past; replay matches a row whose
     * `consumed_at` was already set and must stay at its FIRST value. Each test
     * below asserts its own discriminator.
     */

    it('FORGERY — an unknown token is rejected, and touches nothing', async () => {
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      await mintFor(tenantId, adminId);

      const forged = 'f'.repeat(64);
      expect(await sqlStateOf(() => redeem(forged, REAL_HASH))).toBe(INVALID_TOKEN);

      // The forgery DISCRIMINATOR: NO ROW exists for the forged hash. That is
      // what separates this case from expiry, where a row does exist.
      const [match] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.invite_tokens
          WHERE token_hash = sha256(convert_to($1::text, 'UTF8'))`,
        forged,
      );
      expect(match!.n, 'a forged token must match no stored hash').toBe(0);

      // And the legitimate invite is untouched — a forgery must not burn it.
      const tokens = await tokenState(inviteeId);
      expect(tokens[0]!.consumed_at, 'a forged token must not consume the real one').toBeNull();
      expect((await userState(inviteeId)).pending).toBe(true);
    });

    it('REPLAY — a second redemption is rejected, via the zero-rows path', async () => {
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      const [invite] = await mintFor(tenantId, adminId);

      await redeem(invite!.token, REAL_HASH);
      const firstConsume = (await tokenState(inviteeId))[0]!.consumed_at;
      expect(firstConsume).not.toBeNull();

      expect(
        await sqlStateOf(() => redeem(invite!.token, OTHER_HASH)),
        'replaying a consumed token must be rejected',
      ).toBe(INVALID_TOKEN);

      // The distinguishing state, and the security property: the FIRST consume's
      // timestamp is intact (so the guarded UPDATE matched zero rows rather than
      // re-consuming), and the password is still the one the first redemption
      // set — the replay did not overwrite it.
      const tokens = await tokenState(inviteeId);
      expect(tokens[0]!.consumed_at).toEqual(firstConsume);
      expect((await userState(inviteeId)).password_hash).toBe(REAL_HASH);
    });

    it('EXPIRY — a token past its TTL is rejected, and is NOT burned by the attempt', async () => {
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      const [invite] = await mintFor(tenantId, adminId);

      // Age the token past its 72h TTL. Done by moving `expires_at` rather than
      // by waiting, and as the migration role — the app role cannot write this
      // table at all, which assertion 20 pins.
      await migrator.$executeRawUnsafe(
        `UPDATE public.invite_tokens SET expires_at = now() - interval '1 second'
          WHERE user_id = $1::uuid`,
        inviteeId,
      );

      expect(await sqlStateOf(() => redeem(invite!.token, REAL_HASH))).toBe(INVALID_TOKEN);

      // The expiry DISCRIMINATOR: a row for this token exists, and its expires_at
      // is in the past. That is what separates this case from forgery — NOT the
      // consumed_at state, which is identical in both (the RAISE rolls the
      // consume back either way; a mutant folding expiry into the consume
      // predicate passes an assertion on consumed_at alone).
      const tokens = await tokenState(inviteeId);
      expect(tokens, 'the expired token must still EXIST — that is the discriminator').toHaveLength(
        1,
      );
      expect(tokens[0]!.expires_at.getTime()).toBeLessThan(Date.now());

      // And the attempt did not burn it: a token that is merely expired stays
      // unconsumed, so re-reading the pending list supersedes it cleanly rather
      // than leaving a consumed row behind.
      expect(
        tokens[0]!.consumed_at,
        'the failed redemption must have rolled its own consume back',
      ).toBeNull();
      expect((await userState(inviteeId)).pending).toBe(true);

      // AND THE RECOVERY PATH WORKS — re-invite is just re-reading the list.
      // This is the assertion that makes the TTL survivable rather than a
      // permanent lockout, which was OPEN-7's original complaint.
      const [fresh] = await mintFor(tenantId, adminId);
      await redeem(fresh!.token, REAL_HASH);
      expect((await userState(inviteeId)).pending).toBe(false);
    });

    it('the TTL is 72 hours', async () => {
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      await mintFor(tenantId, adminId);

      const [row] = await migrator.$queryRawUnsafe<{ hours: number }[]>(
        `SELECT round(extract(epoch FROM (expires_at - created_at)) / 3600)::int AS hours
           FROM public.invite_tokens WHERE user_id = $1::uuid`,
        inviteeId,
      );
      expect(row!.hours).toBe(72);
    });
  });

  // =========================================================================
  describe('the monotonic guard', () => {
    it('a valid token against an ALREADY-SET account is rejected — never a reset', async () => {
      // The property that makes "invite" safe to point at any address: possessing
      // a valid token for a credentialled account is not a password reset.
      //
      // Reached here by minting a token and then setting the password by another
      // route, which is the narrow race the guard exists for. Everything else
      // about the flow supersedes prior tokens, so this state is hard to reach on
      // purpose — and the guard is what makes it safe rather than lucky.
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      const [invite] = await mintFor(tenantId, adminId);

      // Credential the account out of band, as the migration role.
      await migrator.$executeRawUnsafe(
        `UPDATE public.users SET password_hash = $2, password_set_at = now() WHERE id = $1::uuid`,
        inviteeId,
        REAL_HASH,
      );

      expect(
        await sqlStateOf(() => redeem(invite!.token, OTHER_HASH)),
        'a token must never overwrite a usable password',
      ).toBe(PASSWORD_ALREADY_SET);

      // And the password is UNCHANGED — the distinguishing assertion. A test that
      // only checked the SQLSTATE would pass even if the UPDATE had landed and
      // something else had raised afterwards.
      expect((await userState(inviteeId)).password_hash).toBe(REAL_HASH);
    });
  });

  // =========================================================================
  describe('both-or-neither: one transaction across consume and set', () => {
    it('a failure injected BETWEEN the consume and the set rolls BOTH back', async () => {
      // THE INJECTION IS A REAL FAILURE AT THE RIGHT POINT, not a simulation.
      // `set_password(token, NULL)` consumes the token successfully and then
      // attempts `SET password_hash = NULL`, which violates the column's NOT NULL
      // — a 23502 raised from inside the function body, after the consume and
      // before the set completes. Exactly the window under test.
      //
      // Atomicity here is STRUCTURAL: the body carries no EXCEPTION handler, so
      // plpgsql opens no subtransaction and the raise unwinds the consume with
      // it. Adding a handler around a subset of those statements is what would
      // break this, which is why the migration says not to.
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      const [invite] = await mintFor(tenantId, adminId);

      expect(
        await sqlStateOf(() => redeem(invite!.token, null)),
        'the injected failure must be the NOT NULL violation, not something earlier',
      ).toBe(NOT_NULL_VIOLATION);

      // NEITHER of the two bad end-states may exist.
      const tokens = await tokenState(inviteeId);
      const user = await userState(inviteeId);

      // (1) NOT "token consumed but password unset" — that is a NEW dead-end,
      //     the exact defect OPEN-7 exists to remove, recreated by its own fix.
      expect(
        tokens[0]!.consumed_at,
        'token was consumed while the password stayed unset — a new dead-end',
      ).toBeNull();

      // (2) NOT "password set but token still live" — a replayable credential
      //     against an account that now has a real password.
      expect(
        user.pending,
        'the password was set while the token stayed live — a replayable credential',
      ).toBe(true);

      // And the token still WORKS afterwards, which is what makes the rollback a
      // recovery rather than merely a non-write.
      await redeem(invite!.token, REAL_HASH);
      expect((await userState(inviteeId)).password_hash).toBe(REAL_HASH);
    });
  });

  // =========================================================================
  describe('supersession, seen from the REDEMPTION side', () => {
    it('minting again kills the previous token', async () => {
      // RETITLED AT OPEN-14: "mint-on-read" is gone — reading mints nothing now.
      // The property under test survives the split unchanged and is if anything
      // more important, because minting is a button an admin can press twice: the
      // old token must be dead the moment a new one is issued, or "single live
      // token per invite" is a description rather than a property.
      //
      // `mint_invite_token`'s own supersede is asserted structurally (live-row
      // counts) in `test/db/mint-invite-token.spec.ts`. THIS assertion is the
      // consequence — the superseded token actually fails to redeem — which is
      // the only form of the claim that matters to an invitee holding a stale
      // link.
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );

      const [first] = await mintFor(tenantId, adminId);
      const [second] = await mintFor(tenantId, adminId);
      expect(second!.token).not.toBe(first!.token);

      // The superseded token is refused, by the ordinary replay path.
      expect(
        await sqlStateOf(() => redeem(first!.token, REAL_HASH)),
        'a superseded token must not redeem',
      ).toBe(INVALID_TOKEN);

      // The new one works.
      await redeem(second!.token, REAL_HASH);
      expect((await userState(inviteeId)).pending).toBe(false);

      // At most one live token ever existed; both rows are now consumed.
      const tokens = await tokenState(inviteeId);
      expect(tokens).toHaveLength(2);
      expect(tokens.every((t) => t.consumed_at !== null)).toBe(true);
    });

    it('a credentialled member never appears in the pending list, so never gets a token', async () => {
      // The invite path is not a password-reset path (ADR-006 §7). Inviting an
      // address that already has a usable password attaches a membership and
      // issues NOTHING.
      //
      // AFTER OPEN-14 THIS IS THE FIRST OF TWO INDEPENDENT REFUSALS, and both are
      // kept. Here the person is absent from the LIST, so no mint is ever
      // attempted. `mint_invite_token` refuses them again on its own account
      // (MT003) if an id is named directly — proven in
      // `test/db/mint-invite-token.spec.ts`. The list is not a security boundary;
      // the function body is.
      const { tenantId: acme, adminId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      const [beta] = await migrator.$queryRawUnsafe<{ user_id: string }[]>(
        `SELECT user_id FROM public.register_tenant('Beta', 'multi@beta.test'::citext, $1)`,
        REAL_HASH,
      );

      // Invite the already-credentialled person into Acme.
      await withContext(migrator, { userId: adminId, tenantId: acme }, (tx) =>
        tx.$queryRawUnsafe(
          `SELECT * FROM public.invite_member('multi@beta.test'::citext, 'auditor', $1::text)`,
          OTHER_HASH,
        ),
      );

      const pending = await mintFor(acme, adminId);
      expect(
        pending.map((p) => p.email),
        'a credentialled user must not be offered a set-password token',
      ).toEqual(['new@acme.test']);

      const tokens = await tokenState(beta!.user_id);
      expect(tokens, 'no token may be minted for a credentialled account').toHaveLength(0);
    });
  });

  // =========================================================================
  describe('RLS tenant-scoping — ADR-006 §7 clauses (a) and (b)', () => {
    it("an admin of A cannot read B's pending invites", async () => {
      // (b) is STRUCTURAL: the tenant comes from `app.current_tenant`, never from
      // a parameter, so there is no cross-tenant target to pass. The negative
      // therefore lands on (a) — an admin of A asserting B is not a live admin of
      // B — and that is the real shape of the attack, not a weaker version of it.
      const acme = await seedTenant('Acme', 'admin@acme.test', 'acme-invitee@acme.test');
      const beta = await seedTenant('Beta', 'admin@beta.test', 'beta-invitee@beta.test');

      // Non-vacuity first: B genuinely HAS a pending invite to leak.
      const bReal = await mintFor(beta.tenantId, beta.adminId);
      expect(bReal.map((p) => p.email)).toEqual(['beta-invitee@beta.test']);

      // A's admin, acting in A, sees only A.
      const asA = await mintFor(acme.tenantId, acme.adminId);
      expect(asA.map((p) => p.email)).toEqual(['acme-invitee@acme.test']);

      // A's admin ASSERTING B is refused by the admin check, with the custom code
      // — not by a privilege error that would also fire on a broken grant.
      expect(
        await sqlStateOf(() => mintFor(beta.tenantId, acme.adminId)),
        "an admin of A must not read B's pending invites",
      ).toBe(NOT_ADMIN);
    });

    it('a NON-ADMIN member of the active tenant is refused', async () => {
      const { tenantId, inviteeId } = await seedTenant('Acme', 'admin@acme.test', 'tech@acme.test');

      // The invitee is a live technician of this tenant — a real member, wrong
      // role. That is the case the role check exists for.
      expect(await sqlStateOf(() => mintFor(tenantId, inviteeId))).toBe(NOT_ADMIN);
    });

    it('fails CLOSED with absent or blank context', async () => {
      // The pooled-connection case: a GUC set once reverts to the EMPTY STRING,
      // not NULL, so `''::uuid` would raise 22P02 without the NULLIF guard — a
      // 500 rather than a clean refusal, reproducible only after connection
      // reuse. Both the absent and the blank forms must reach SP003.
      await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');

      expect(
        await sqlStateOf(() =>
          app.$queryRawUnsafe(`SELECT * FROM public.list_pending_invites()`),
        ),
        'no context at all must fail closed',
      ).toBe(NOT_ADMIN);

      expect(
        await sqlStateOf(() =>
          app.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', '', true)`);
            await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', '', true)`);
            return tx.$queryRawUnsafe(`SELECT * FROM public.list_pending_invites()`);
          }),
        ),
        'BLANK context must fail closed with SP003, not 22P02',
      ).toBe(NOT_ADMIN);
    });

    it('a revoked admin loses the pending read', async () => {
      // Liveness, not just membership. `deleted_at IS NULL` is in the admin check
      // for the same reason it is in every other §7 body.
      const { tenantId, adminId } = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      expect(await mintFor(tenantId, adminId)).toHaveLength(1);

      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now()
          WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
        adminId,
        tenantId,
      );

      expect(await sqlStateOf(() => mintFor(tenantId, adminId))).toBe(NOT_ADMIN);
    });
  });

  // =========================================================================
  describe('the audit row', () => {
    it('a password set is logged as user.password_set, not user.created', async () => {
      // The `users` UPDATE path became reachable for the first time at step 8,
      // and the pre-existing branch would have labelled it `user.created` with an
      // empty diff — an audit trail discrediting itself on its first real event.
      const { tenantId, adminId, inviteeId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      const [invite] = await mintFor(tenantId, adminId);
      await redeem(invite!.token, REAL_HASH);

      const rows = await migrator.$queryRawUnsafe<
        { action: string; row_id: string; payload: unknown; tenant_id: string | null }[]
      >(
        `SELECT action::text AS action, row_id::text AS row_id, payload, tenant_id
           FROM public.audit_log
          WHERE table_name = 'users' AND action = 'user.password_set'`,
      );

      expect(rows, 'the password set must be captured').toHaveLength(1);
      // WHO is carried by row_id — the one fact the event must identify.
      expect(rows[0]!.row_id).toBe(inviteeId);
      // The diff is empty and that is correct: neither written column is on the
      // allowlist (password_hash never may be; password_set_at is excluded by
      // ADR-011's fail-closed default). jsonb NOT NULL means '{}', never null.
      expect(rows[0]!.payload).toEqual({ before: {}, after: {} });
      // NULL tenant: set_password is pre-session, so this is ADR-013's bootstrap
      // class — permanently invisible to every application read, BY DESIGN.
      expect(rows[0]!.tenant_id).toBeNull();
    });

    it('the hash never reaches the audit payload', async () => {
      // ADR-011's redaction, at the one table that carries a secret. Asserted
      // over the whole trail rather than one row, so a future branch cannot leak
      // it somewhere this test was not looking.
      const { tenantId, adminId } = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      const [invite] = await mintFor(tenantId, adminId);
      await redeem(invite!.token, REAL_HASH);

      const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.audit_log
          WHERE payload::text LIKE '%argon2%' OR payload::text LIKE '%password_hash%'`,
      );
      expect(row!.n, 'a password hash reached the audit trail').toBe(0);
    });

    it('the plaintext token never reaches the audit trail either', async () => {
      const { tenantId, adminId } = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      const [invite] = await mintFor(tenantId, adminId);
      await redeem(invite!.token, REAL_HASH);

      const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.audit_log WHERE payload::text LIKE $1`,
        `%${invite!.token}%`,
      );
      expect(row!.n).toBe(0);
    });
  });

  // =========================================================================
  describe('the app role cannot reach invite_tokens directly', () => {
    it('every statement against invite_tokens is refused — 42501, disambiguated', async () => {
      // Catalog assertion 20 pins the grants; this proves what they do. The
      // disambiguation problem is the same as for the withheld column: 42501
      // alone would also pass if the table did not exist. So the paired positive
      // establishes that it DOES, as the migration role, first.
      const { tenantId, adminId } = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      await mintFor(tenantId, adminId);

      const [live] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.invite_tokens`,
      );
      expect(live!.n, 'the negative is vacuous unless a row actually exists').toBe(1);

      for (const statement of [
        `SELECT * FROM public.invite_tokens`,
        `SELECT token_hash FROM public.invite_tokens`,
        `INSERT INTO public.invite_tokens (user_id, tenant_id, token_hash, expires_at)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'x'::bytea, now())`,
        `UPDATE public.invite_tokens SET consumed_at = NULL`,
        `DELETE FROM public.invite_tokens`,
      ]) {
        expect(
          await sqlStateOf(() => app.$queryRawUnsafe(statement)),
          `the app role must be refused: ${statement.split('\n')[0]}`,
        ).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });
});
