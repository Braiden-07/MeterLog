import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appClient, loadEnv, migratorClient, resetDatabase } from './helpers';

/**
 * `mint_invite_token` — the NINTH definer function, added by the pending split
 * (OPEN-14, `20260916000000_mint_invite_token`).
 *
 * WHY THIS FILE EXISTS AT ALL, rather than the HTTP negatives being enough.
 * ADR-006 §7's standing rule binds every definer function that acts on behalf of
 * an authenticated caller, and `EXPECTED_DEFINER_FUNCTIONS` states the standard
 * of proof in so many words: **the negatives are produced by calling the function
 * directly as `meterlog_app` with the GUCs set by hand, never through an HTTP
 * guard.** Every call below does exactly that — no Nest, no interceptor, no RBAC
 * gate. The function is `EXECUTE`-able by `meterlog_app`, so anything holding
 * that connection can call it with nothing in front of it, and
 * `invite_tokens_definer` is `USING (true) WITH CHECK (true)`, so there is
 * nothing underneath it either. The admin check, the tenant scoping, the pending
 * predicate and the supersede are this body's sole responsibility.
 *
 * WHAT IS NEW HERE RELATIVE TO `list_pending_invites`, and it is the reason the
 * function could not simply be reused: this one takes a CALLER-SUPPLIED
 * PARAMETER. `list_pending_invites` satisfies ADR-006 §7 clause (b) structurally
 * — there is no target to validate, because the tenant comes from
 * `app.current_tenant` and the rows follow from it. A membership id in the
 * signature makes (b) a REAL CHECK for the first time on this path: the row
 * named by the caller must be proven to belong to the active tenant before it is
 * touched. The cross-tenant negative below is that check, exercised with the
 * GUCs set by hand to a tenant the target does not belong to.
 *
 * THE THREE REFUSAL CODES ARE THIS FUNCTION'S OWN, and that is the step-5 lesson
 * applied rather than restated. `list_pending_invites` already took `SP003` for
 * "not a live admin" even though `MB001` meant the same thing, precisely because
 * they come from different bodies and two layers answering identically are two
 * layers you cannot tell apart when one breaks. A third body gets a third set:
 * `MT001` / `MT002` / `MT003`. They map onto the same HTTP envelope as their
 * siblings, so the API contract is uniform while the source stays legible.
 */

/** SQLSTATEs raised by `mint_invite_token` (20260916000000). */
const NOT_ADMIN = 'MT001';
const MEMBERSHIP_NOT_FOUND = 'MT002';
const NOT_PENDING = 'MT003';

const REAL_HASH = '$argon2id$v=19$m=19456,t=2,p=1$cmVhbHNhbHR2YWx1ZQ$0000000000000000000000000000';
const OTHER_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$b3RoZXJzYWx0dmFsdWU$1111111111111111111111111111';

function sqlState(error: unknown): string | undefined {
  const meta = (error as { meta?: { code?: string } })?.meta;
  return meta?.code;
}

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

interface MintedToken {
  membership_id: string;
  user_id: string;
  email: string;
  role: string;
  invited_at: Date;
  token: string;
  expires_at: Date;
}

describe('mint_invite_token — the explicit mint (OPEN-14)', () => {
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
   * hand-writes a `users` row, so the pending state under test is the real one.
   */
  async function seedTenant(
    name: string,
    adminEmail: string,
    inviteeEmail: string,
  ): Promise<{
    tenantId: string;
    adminId: string;
    inviteeId: string;
    inviteeMembershipId: string;
    adminMembershipId: string;
  }> {
    const [org] = await migrator.$queryRawUnsafe<
      { tenant_id: string; user_id: string; membership_id: string }[]
    >(
      `SELECT tenant_id, user_id, membership_id FROM public.register_tenant($1, $2::citext, $3)`,
      name,
      adminEmail,
      REAL_HASH,
    );

    const invited = await withContext(
      migrator,
      { userId: org!.user_id, tenantId: org!.tenant_id },
      (tx) =>
        tx.$queryRawUnsafe<{ user_id: string; membership_id: string }[]>(
          `SELECT user_id, membership_id FROM public.invite_member($1::citext, 'technician', $2::text)`,
          inviteeEmail,
          OTHER_HASH,
        ),
    );

    return {
      tenantId: org!.tenant_id,
      adminId: org!.user_id,
      adminMembershipId: org!.membership_id,
      inviteeId: invited[0]!.user_id,
      inviteeMembershipId: invited[0]!.membership_id,
    };
  }

  /** The call under test, as `meterlog_app`, GUCs set by hand. */
  const mint = (ctx: { userId: string; tenantId: string }, membershipId: string) =>
    withContext(app, ctx, (tx) =>
      tx.$queryRawUnsafe<MintedToken[]>(
        `SELECT * FROM public.mint_invite_token($1::uuid)`,
        membershipId,
      ),
    );

  const tokensFor = (userId: string) =>
    migrator.$queryRawUnsafe<{ id: string; consumed_at: Date | null; expires_at: Date }[]>(
      `SELECT id::text, consumed_at, expires_at FROM public.invite_tokens
        WHERE user_id = $1::uuid ORDER BY created_at`,
      userId,
    );

  // =========================================================================
  describe('the positive path', () => {
    it('mints one token for a pending membership and returns the plaintext', async () => {
      const { tenantId, adminId, inviteeId, inviteeMembershipId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );

      const rows = await mint({ userId: adminId, tenantId }, inviteeMembershipId);

      expect(rows, 'exactly one row — this is a single-resource mint, not a list').toHaveLength(1);
      expect(rows[0]!.email).toBe('new@acme.test');
      expect(rows[0]!.membership_id).toBe(inviteeMembershipId);
      expect(rows[0]!.user_id).toBe(inviteeId);
      expect(rows[0]!.token, '244 bits, hex').toMatch(/^[0-9a-f]{64}$/);

      const tokens = await tokensFor(inviteeId);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.consumed_at).toBeNull();
      // 72h TTL, computed at mint and stored — a property of the issued token.
      const ttlHours = (tokens[0]!.expires_at.getTime() - Date.now()) / 3_600_000;
      expect(ttlHours).toBeGreaterThan(71);
      expect(ttlHours).toBeLessThan(73);
    });

    it('stores ONLY the hash — the plaintext is not in the table', async () => {
      const { tenantId, adminId, inviteeId, inviteeMembershipId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      const [minted] = await mint({ userId: adminId, tenantId }, inviteeMembershipId);

      const [row] = await migrator.$queryRawUnsafe<{ hex: string }[]>(
        `SELECT encode(token_hash, 'hex') AS hex FROM public.invite_tokens
          WHERE user_id = $1::uuid`,
        inviteeId,
      );
      expect(row!.hex).not.toBe(minted!.token);
      // It is the SHA-256 of the plaintext, not some unrelated value.
      const [expected] = await migrator.$queryRawUnsafe<{ hex: string }[]>(
        `SELECT encode(sha256(convert_to($1::text, 'UTF8')), 'hex') AS hex`,
        minted!.token,
      );
      expect(row!.hex).toBe(expected!.hex);
    });

    it('SUPERSEDES the prior live token rather than accumulating', async () => {
      const { tenantId, adminId, inviteeId, inviteeMembershipId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );

      await mint({ userId: adminId, tenantId }, inviteeMembershipId);
      await mint({ userId: adminId, tenantId }, inviteeMembershipId);
      await mint({ userId: adminId, tenantId }, inviteeMembershipId);

      const tokens = await tokensFor(inviteeId);
      expect(tokens, 'the superseded rows are KEPT — consumed, not deleted').toHaveLength(3);
      const live = tokens.filter((t) => t.consumed_at === null);
      expect(live, 'at most one redeemable token per pending invite, by construction').toHaveLength(
        1,
      );
      expect(live[0]!.id, 'the survivor must be the most recent').toBe(tokens[2]!.id);
    });
  });

  // =========================================================================
  describe('ADR-006 §7 (a) — the caller is a live admin of the active tenant', () => {
    it('a TECHNICIAN of the same tenant is refused — MT001', async () => {
      const { tenantId, inviteeId, inviteeMembershipId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'tech@acme.test',
      );
      // The invitee is a technician of this very tenant. Calling as them, with
      // the GUCs set by hand and no gate anywhere.
      expect(
        await sqlStateOf(() => mint({ userId: inviteeId, tenantId }, inviteeMembershipId)),
      ).toBe(NOT_ADMIN);
      expect(await tokensFor(inviteeId), 'a refused mint writes nothing').toHaveLength(0);
    });

    it('a REVOKED admin is refused — liveness is part of (a), not an afterthought', async () => {
      const { tenantId, adminId, adminMembershipId, inviteeId, inviteeMembershipId } =
        await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      // A second admin, so revoking the first is not a last-admin violation.
      await withContext(migrator, { userId: adminId, tenantId }, (tx) =>
        tx.$executeRawUnsafe(
          `SELECT public.invite_member('admin2@acme.test'::citext, 'admin', $1::text)`,
          OTHER_HASH,
        ),
      );
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE id = $1::uuid`,
        adminMembershipId,
      );

      expect(await sqlStateOf(() => mint({ userId: adminId, tenantId }, inviteeMembershipId))).toBe(
        NOT_ADMIN,
      );
      expect(await tokensFor(inviteeId)).toHaveLength(0);
    });

    it('ABSENT context fails closed — MT001, not a crash and not a mint', async () => {
      // On a POOLED connection a GUC set once reverts to the EMPTY STRING, not
      // NULL, at transaction end, and `''::uuid` raises 22P02 rather than failing
      // closed (ADR-004 assertion 8). The NULLIF wrapper is what makes the
      // refusal below a deliberate MT001 instead of a cast error.
      const { inviteeMembershipId } = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');

      expect(
        await sqlStateOf(() =>
          withContext(app, { userId: '', tenantId: '' }, (tx) =>
            tx.$queryRawUnsafe(
              `SELECT * FROM public.mint_invite_token($1::uuid)`,
              inviteeMembershipId,
            ),
          ),
        ),
        'empty-string GUCs must refuse as MT001, never raise 22P02',
      ).toBe(NOT_ADMIN);
    });

    it('an ADMIN OF ANOTHER TENANT asserting this tenant is refused by (a), not by (b)', async () => {
      // The tenant comes from `app.current_tenant`, which the interceptor only
      // sets after re-verifying membership — but this call sets it by hand to a
      // tenant the caller has no membership in, which is precisely the attack the
      // interceptor is not present to stop here. (a) catches it: they are not a
      // live admin of the tenant they asserted.
      const acme = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      const beta = await seedTenant('Beta', 'admin@beta.test', 'b-new@beta.test');

      expect(
        await sqlStateOf(() =>
          mint({ userId: beta.adminId, tenantId: acme.tenantId }, acme.inviteeMembershipId),
        ),
      ).toBe(NOT_ADMIN);
      expect(await tokensFor(acme.inviteeId)).toHaveLength(0);
    });
  });

  // =========================================================================
  describe('ADR-006 §7 (b) — the target row belongs to the active tenant', () => {
    it("an admin of A naming B's membership gets MT002 — the first REAL (b) check on this path", async () => {
      // `list_pending_invites` satisfies (b) structurally: no parameter, no
      // target to validate. A membership id in the signature makes (b) a genuine
      // check, and this is it — a legitimate admin of their own tenant, naming a
      // row in a tenant they cannot see.
      const acme = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      const beta = await seedTenant('Beta', 'admin@beta.test', 'b-new@beta.test');

      expect(
        await sqlStateOf(() =>
          mint({ userId: acme.adminId, tenantId: acme.tenantId }, beta.inviteeMembershipId),
        ),
      ).toBe(MEMBERSHIP_NOT_FOUND);
      expect(
        await tokensFor(beta.inviteeId),
        "B's invitee must not be minted for by A's admin",
      ).toHaveLength(0);
    });

    it("a nonexistent membership id is INDISTINGUISHABLE from another tenant's", async () => {
      // One code for "does not exist" and "belongs to a tenant you cannot see",
      // so the function cannot be used to probe for membership ids. The MB002
      // reasoning, restated for a new body.
      const acme = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      const beta = await seedTenant('Beta', 'admin@beta.test', 'b-new@beta.test');

      const [absent] = await migrator.$queryRawUnsafe<{ id: string }[]>(
        `SELECT gen_random_uuid()::text AS id`,
      );
      const forNonexistent = await sqlStateOf(() =>
        mint({ userId: acme.adminId, tenantId: acme.tenantId }, absent!.id),
      );
      const forForeign = await sqlStateOf(() =>
        mint({ userId: acme.adminId, tenantId: acme.tenantId }, beta.inviteeMembershipId),
      );
      expect(forNonexistent).toBe(forForeign);
      expect(forNonexistent).toBe(MEMBERSHIP_NOT_FOUND);
    });

    it("a REVOKED membership in the caller's own tenant is MT002 — it is not a live target", async () => {
      const { tenantId, adminId, inviteeId, inviteeMembershipId } = await seedTenant(
        'Acme',
        'admin@acme.test',
        'new@acme.test',
      );
      await migrator.$executeRawUnsafe(
        `UPDATE public.memberships SET deleted_at = now() WHERE id = $1::uuid`,
        inviteeMembershipId,
      );

      expect(await sqlStateOf(() => mint({ userId: adminId, tenantId }, inviteeMembershipId))).toBe(
        MEMBERSHIP_NOT_FOUND,
      );
      expect(
        await tokensFor(inviteeId),
        'a revoked person must not be handed a way back in',
      ).toHaveLength(0);
    });
  });

  // =========================================================================
  describe('the pending predicate — the reason this must be a definer function', () => {
    it('an ALREADY-CREDENTIALLED member is refused — MT003, and no token is written', async () => {
      // The invite path is not a password-reset path (ADR-016). A member who
      // holds a usable password is not pending; minting for them would hand a
      // tenant admin a redemption credential for an account that exists across
      // the whole system, in tenants they cannot see.
      const acme = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');
      // A person who already has a real password, attached to Acme as a second
      // workspace — the multi-org mechanism (OPEN-1).
      const beta = await seedTenant('Beta', 'multi@beta.test', 'b-new@beta.test');
      const [attached] = await withContext(
        migrator,
        { userId: acme.adminId, tenantId: acme.tenantId },
        (tx) =>
          tx.$queryRawUnsafe<{ membership_id: string }[]>(
            `SELECT membership_id FROM public.invite_member('multi@beta.test'::citext, 'auditor', $1::text)`,
            OTHER_HASH,
          ),
      );

      expect(
        await sqlStateOf(() =>
          mint({ userId: acme.adminId, tenantId: acme.tenantId }, attached!.membership_id),
        ),
      ).toBe(NOT_PENDING);
      expect(await tokensFor(beta.adminId), 'no token for a credentialled account').toHaveLength(0);

      // And their credential is untouched — the refusal changed nothing.
      const [person] = await migrator.$queryRawUnsafe<{ hash: string; pending: boolean }[]>(
        `SELECT password_hash AS hash, (password_set_at IS NULL) AS pending
           FROM public.users WHERE id = $1::uuid`,
        beta.adminId,
      );
      expect(person!.hash).toBe(REAL_HASH);
      expect(person!.pending).toBe(false);
    });

    it('the app role cannot read the predicate column it depends on — 42501', async () => {
      // WHY A DEFINER FUNCTION AT ALL, proven rather than asserted. The pending
      // predicate is `users.password_set_at`, withheld from `meterlog_app` by
      // column grant so the login path cannot branch on it (ADR-006 §7 hazard
      // (ii)). An app-role query naming it fails, which is exactly why this
      // endpoint cannot be an ordinary RLS-scoped statement.
      await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');

      // Paired, so the refusal is about the COLUMN and not the table: the table
      // is reachable...
      await expect(
        app.$queryRawUnsafe(`SELECT id, email FROM public.users`),
      ).resolves.toBeDefined();
      // ...and the column is not.
      expect(
        await sqlStateOf(() => app.$queryRawUnsafe(`SELECT password_set_at FROM public.users`)),
      ).toBe('42501');
    });

    it('the app role cannot write invite_tokens directly — the mint has no bypass', async () => {
      // The other half of "why a definer function": `invite_tokens` grants the
      // app role NOTHING (catalog assertion 18). A caller cannot skip the
      // function and insert a token of their own choosing.
      const { tenantId, inviteeId } = await seedTenant('Acme', 'admin@acme.test', 'new@acme.test');

      const state = await sqlStateOf(() =>
        app.$executeRawUnsafe(
          `INSERT INTO public.invite_tokens (user_id, tenant_id, token_hash, expires_at)
           VALUES ($1::uuid, $2::uuid, sha256(convert_to('forged', 'UTF8')), now() + interval '72 hours')`,
          inviteeId,
          tenantId,
        ),
      );
      expect(state).toBe('42501');
    });
  });
});
