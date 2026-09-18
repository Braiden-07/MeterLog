import { randomUUID } from 'node:crypto';

import { hash as argonHash } from '@node-rs/argon2';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ARGON2_OPTIONS } from '../auth/auth.service';
import { requireRequestContext } from '../common/request-context/request-context';

export interface Member {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  createdAt: Date;
}

/**
 * A pending invite as the LIST sees it — metadata only (OPEN-14).
 *
 * NO `token` AND NO `expiresAt`, AND THIS IS A SEPARATE TYPE RATHER THAN A
 * WIDENED ONE. `MintedInviteToken` below is the same five fields plus the
 * credential, and the temptation is to make one interface with two optional
 * fields. That is exactly the shape the invite-response decision rejected
 * (ADR-016, and the controller's note on `invite`): a body that varies in SHAPE
 * between callers invites a client that starts depending on the difference, and
 * here the difference is whether a live credential is present. One type per
 * response, so "is there a token in this" is answered by the type and never by
 * reading the call site.
 *
 * The type is half the enforcement; the other half is a runtime assertion on the
 * exact key set of the GET body in `test/api/pending-split.spec.ts`. A future
 * widening of this interface would satisfy the type-checker and still red there.
 */
export interface PendingInvite {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  invitedAt: Date;
}

/**
 * A freshly minted plaintext redemption token for ONE pending invite
 * (OPEN-7, ADR-016; split out at OPEN-14).
 *
 * `token` is the ONLY place the plaintext ever exists outside the invitee's link
 * — the table stores a SHA-256 hash — so this response is not cacheable and must
 * not be logged. It is returned to a tenant admin acting in their own workspace,
 * and to nobody else. The route that returns it carries `Cache-Control: no-store`
 * for that reason and is the only route in the API that does.
 *
 * SINGLE OBJECT, NOT AN ARRAY. Minting is per-membership and explicit; a list of
 * credentials is what the pre-split `GET` returned, and the number of live
 * credentials crossing the boundary per call is now one by construction.
 */
export interface MintedInviteToken extends PendingInvite {
  token: string;
  expiresAt: Date;
}

/**
 * SQLSTATEs raised by the step-5 definer functions
 * (`20260909000000_membership_write_functions`).
 *
 * Matched on the CODE, never on the message — the step-4 lesson, where a 409
 * keyed on a constraint name inside an error string would have silently never
 * fired because Prisma drops the constraint name. Prisma surfaces the SQLSTATE
 * structurally as `PrismaClientKnownRequestError.meta.code` (verified: P2010
 * with `meta = { code: 'MB001', message: 'ERROR: NOT_ADMIN' }`).
 *
 * These are deliberately NOT the idiomatic standard codes. `42501
 * insufficient_privilege` is what Postgres itself raises for a plain
 * table-privilege denial, so keying on it would make a mapping fire for a
 * misconfigured GRANT that never reached the function body at all. Full
 * reasoning in the migration header and ARCHITECTURE §16.2.
 */
const NOT_ADMIN = 'MB001';
const MEMBERSHIP_NOT_FOUND = 'MB002';
const LAST_ADMIN = 'MB003';
const UNIQUE_VIOLATION = '23505';

/**
 * `list_pending_invites`'s admin refusal (`20260915000000`, ADR-016). A SEPARATE
 * code from `MB001` even though both mean "not a live admin of the active
 * tenant", because they come from different function bodies — and the step-5
 * lesson is exactly that two layers answering identically are two layers you
 * cannot tell apart when one of them breaks. Mapped to the same 403 / `NOT_ADMIN`
 * envelope, so the API contract stays uniform while the source stays legible.
 */
const PENDING_NOT_ADMIN = 'SP003';

/**
 * `mint_invite_token`'s refusals (`20260916000000`, OPEN-14). A THIRD set of
 * codes for the same three-ish conditions, and the repetition is the design
 * rather than an oversight — it is the rule `PENDING_NOT_ADMIN` above states,
 * applied to a third function body. `MB001`, `SP003` and `MT001` all mean "not a
 * live admin of the active tenant" and all become the same 403; what they buy is
 * that a log line says WHICH body refused, so a broken layer is identifiable
 * instead of merely visible.
 *
 * `MT003` has no sibling anywhere else, because no other function has had reason
 * to say it: the named member is real, live, and in the caller's own tenant, but
 * already holds a usable password. There is nothing to mint, and minting anyway
 * would make the invite path a password-reset path for a globally-unique identity
 * (ADR-016). It is the only one of the three that is a 409 rather than a
 * 403 / 404 — a conflict with the target's state, not a question of permission.
 */
const MINT_NOT_ADMIN = 'MT001';
const MINT_MEMBERSHIP_NOT_FOUND = 'MT002';
const MINT_NOT_PENDING = 'MT003';

@Injectable()
export class MembershipsService {
  /**
   * The member list for the active workspace.
   *
   * **Deliberately not role-gated** (ADR-006 §3): every member of a tenant reads
   * every co-member's identity and role. That is the recorded team-SaaS default,
   * and gating it would mean a role term in a read policy — the option-C shape
   * that produced OPEN-5. What is genuinely sensitive (`password_hash`) is
   * withheld by column grant, not by this query being careful.
   *
   * Runs on the request transaction, so `memberships_tenant` scopes it to the
   * active tenant — and the `tenant_id` predicate below NARROWS that result
   * rather than replacing it.
   *
   * ===== THE PREDICATE, AND WHY IT IS NOT THE ANTI-PATTERN THIS COMMENT USED TO
   * FORBID (G1, OPEN-13) ======================================================
   *
   * This comment previously said there must be no `tenant_id` in the WHERE
   * clause, because "app-layer filtering is not what isolates this, and adding it
   * would hide a policy regression behind a redundant predicate". THE CONCERN WAS
   * RIGHT AND IS KEPT. What was wrong was the conclusion, because the predicate
   * that is actually needed here is not redundant with any policy.
   *
   * `memberships` carries TWO permissive `FOR SELECT` policies, and permissive
   * policies OR: a self axis keyed on `app.current_user` and a tenant axis keyed
   * on `app.current_tenant`. So a caller who belongs to several workspaces sees,
   * under any one tenant's context, every one of THEIR OWN membership rows from
   * every workspace they belong to. That is not a policy regression — both
   * policies are behaving exactly as designed, and the self axis is load-bearing
   * for `/auth/me`, whose whole job is to list workspaces the caller is NOT
   * currently active in. It is simply a wider result than one endpoint wants.
   *
   * SO THE DISTINCTION THE OLD COMMENT WAS REACHING FOR IS BETWEEN TWO DIFFERENT
   * THINGS, and only one of them is the anti-pattern:
   *
   *   - An app-side filter that MASKS an RLS result — dropping rows RLS should
   *     never have returned — is the hazard. It makes a broken policy invisible,
   *     because the query looks correct no matter what the policy does.
   *   - An app-side filter that NARROWS a CORRECT RLS result for one endpoint is
   *     this. Every row it drops is a row RLS returns correctly and deliberately,
   *     for a different caller's legitimate use.
   *
   * AND THE REGRESSION CONCERN IS ANSWERED RATHER THAN WAIVED. The reason a mask
   * would be dangerous is that it would leave a policy failure untested. That
   * cannot happen here: `test/db/membership-isolation.spec.ts` tests both axes
   * DIRECTLY as `meterlog_app` through `appClient()`, with the GUCs set by hand
   * and no service code anywhere in the path. If `memberships_tenant` ever
   * stopped scoping, that file reds — this predicate cannot quiet it, because
   * this predicate is not in its path at all. A regression is still caught; what
   * changed is only which rows ONE endpoint chooses to show.
   *
   * IT IS SERVICE-LAYER AND NOT AN RLS TIGHTENING, and that is forced rather than
   * preferred. Putting a tenant term into `memberships_self_read` would scope
   * this list correctly and collapse `readWorkspaces` in the same stroke — the
   * workspace switcher would show only the active workspace, which is the one
   * thing a switcher must not do. The two readers want different row sets from
   * the same policy, so the narrowing belongs in the reader that wants less.
   *
   * Listed as an app-side predicate, with its purpose, in ADR-006 OPEN-5.
   */
  async list(): Promise<Member[]> {
    const { tx } = requireRequestContext();

    const rows = await tx.$queryRawUnsafe<
      { membership_id: string; user_id: string; email: string; role: string; created_at: Date }[]
    >(
      // NULLIF(..., '') for the reason every other reader of this GUC carries it:
      // on a pooled connection a GUC set once reverts to the EMPTY STRING, not
      // NULL, at transaction end, and ''::uuid raises 22P02 rather than failing
      // closed (ADR-004 assertion 8). With no active tenant this yields NULL,
      // which matches no row — the list is empty rather than erroring. In
      // practice the interceptor refuses such a request before the handler runs
      // (G2, NO_ACTIVE_WORKSPACE); this is the floor under that, not a substitute.
      `SELECT m.id   AS membership_id,
              u.id   AS user_id,
              u.email::text AS email,
              m.role::text  AS role,
              m.created_at
         FROM public.memberships m
         JOIN public.users u ON u.id = m.user_id
        WHERE m.tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
          AND m.deleted_at IS NULL
        ORDER BY u.email`,
    );

    return rows.map((r) => ({
      membershipId: r.membership_id,
      userId: r.user_id,
      email: r.email,
      role: r.role,
      createdAt: r.created_at,
    }));
  }

  /**
   * Invite someone to the active workspace (ADR-006 §7).
   *
   * The tenant is NOT passed: `invite_member` reads it from `app.current_tenant`,
   * which the interceptor only sets after re-verifying the caller's membership.
   * A tenant argument here would be a value the caller could choose.
   *
   * The sentinel hash is minted per invite from a fresh random secret at the
   * production `ARGON2_OPTIONS` cost. It is used by the function ONLY when a new
   * identity is created, and can never overwrite an existing person's credential
   * — that scoping is a security boundary, not an implementation detail
   * (ADR-006 §7): honoured on the attach branch it would make "invite an existing
   * email" an arbitrary password reset for any address in the system.
   *
   * The invited account is therefore deliberately unusable until a set-password
   * flow lands in a later step — the known, recorded dead-end in DECISIONS.
   */
  async invite(input: { email: string; role: string }): Promise<void> {
    const { tx } = requireRequestContext();
    const sentinel = await argonHash(randomUUID(), ARGON2_OPTIONS);

    try {
      const [row] = await tx.$queryRawUnsafe<
        { membership_id: string; user_id: string; user_created: boolean }[]
      >(
        `SELECT * FROM public.invite_member($1::citext, $2::public.membership_role, $3::text)`,
        input.email,
        input.role,
        sentinel,
      );
      if (!row) throw new Error('invite_member returned no row');

      // `user_created` IS READ AND THEN DROPPED ON THE FLOOR, DELIBERATELY.
      //
      // The function still returns it and its signature is deliberately
      // untouched — the flag is what distinguishes "created a pending identity,
      // which needs a token" from "attached a membership to someone who already
      // has a usable password, which must NOT get one". That branch is real and
      // it lives here, in the server.
      //
      // WHAT IT MUST NEVER DO IS REACH THE RESPONSE. `userCreated` was on the
      // wire until step 8, and it is an account-existence oracle for any tenant
      // admin: invite an address, read the flag, learn whether that person holds
      // an account ANYWHERE in the system — across every tenant, including ones
      // the caller cannot see. The invite response is now uniform for both
      // branches (see the controller), and this is the line where the flag stops.
      //
      // Token issuance is NOT done here. It happens on the pending-invites read,
      // because the token is hashed at rest and therefore cannot be re-displayed
      // later — so it is minted when it is about to be shown, and never returned
      // from this endpoint. An existing credentialled user is pending-false, so
      // they never appear in that read and never get a token; that is the same
      // predicate this flag describes, enforced where it matters rather than
      // trusted from here.
      void row.user_created;
    } catch (error) {
      throw translate(error, {
        [UNIQUE_VIOLATION]: () =>
          new ConflictException({
            error: {
              code: 'ALREADY_A_MEMBER',
              message: 'That person is already a member of this workspace.',
            },
          }),
      });
    }
  }

  /**
   * Pending invites for the ACTIVE workspace — METADATA ONLY (OPEN-14).
   *
   * THIS READ NO LONGER MINTS, AND THAT IS THE SLICE. Until the pending split it
   * called a `list_pending_invites` that superseded every live token and issued a
   * replacement on each call, which made it a state-changing GET: it broke the
   * condition the ADR-001 amendment attaches to `SameSite=Lax` (Lax is CSRF
   * protection only while every GET is safe), and it made a window-focus refetch
   * a denial of service against a link the admin had already sent. Minting is now
   * `mintInviteToken` below, one membership at a time, over POST.
   *
   * THE PREVIOUS REASONING IS SUPERSEDED, NOT MERELY DROPPED. The old comment
   * argued mint-on-read was "forced by the storage decision" because tokens are
   * hashed at rest and the server holds no plaintext to re-display. The premise
   * is still true; the conclusion was not. Hash-at-rest forces only that a token
   * cannot be part of a READ at all — it never forced the read to create one.
   *
   * IT IS STILL A DEFINER CALL EVEN THOUGH IT NOW ONLY READS, and the reason is
   * the one that always mattered: the pending predicate is
   * `users.password_set_at`, withheld from `meterlog_app` by column grant so the
   * login path cannot branch on it (ADR-006 §7 hazard (ii)); an app-role query
   * naming that column fails `permission denied`. The admin check is enforced in
   * the function body as well as at the gate, because nothing underneath it
   * constrains anything.
   *
   * ANTI-ENUMERATION IS DONE BY ISOLATION. The caller sees only their own
   * tenant's pending invites, so there is no cross-tenant address space to walk
   * and nothing to sign — the same reason the audit cursor is unsigned.
   */
  async pendingInvites(): Promise<PendingInvite[]> {
    const { tx } = requireRequestContext();

    try {
      const rows = await tx.$queryRawUnsafe<
        {
          membership_id: string;
          user_id: string;
          email: string;
          role: string;
          invited_at: Date;
        }[]
      >(`SELECT * FROM public.list_pending_invites()`);

      return rows.map((r) => ({
        membershipId: r.membership_id,
        userId: r.user_id,
        email: r.email,
        role: r.role,
        invitedAt: r.invited_at,
      }));
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Mint ONE redemption token for ONE pending membership (OPEN-14).
   *
   * THE ONLY PLACE A LIVE CREDENTIAL CROSSES THE ISOLATION BOUNDARY. The
   * plaintext exists in exactly two places and neither is the database: this
   * return value, and the invitee's link. The table stores a SHA-256 hash, so
   * this token can never be re-displayed — losing it means minting another, which
   * is a button rather than a dead end because the function supersedes.
   *
   * EXPLICIT, ONE MEMBERSHIP AT A TIME. The pre-split read handed out a token for
   * every pending invite in the tenant on every call; this hands out exactly one,
   * for a row the caller named, when the caller asked. The number of live
   * credentials crossing the boundary per request went from "as many as there are
   * pending invites" to one, by construction.
   *
   * `membershipId` IS THE TARGET, and it is the row being written in the §7 (b)
   * sense — the step-5 decision that `:id` is a membership id rather than a user
   * id, for exactly this reason. It is the first definer function on this path for
   * which (b) is a real predicate rather than a structural consequence:
   * `list_pending_invites` takes no parameter, so it has no target to validate.
   *
   * THE THREE REFUSALS COME FROM THE FUNCTION BODY, WITH ITS OWN SQLSTATES, and
   * they are mapped below onto the same envelope the rest of the module uses.
   * `MT003` / `NOT_PENDING` is the one with no sibling elsewhere: a member who
   * already holds a usable password is not pending, so there is nothing to mint —
   * the invite path is not a password-reset path (ADR-016).
   */
  async mintInviteToken(membershipId: string): Promise<MintedInviteToken> {
    const { tx } = requireRequestContext();

    try {
      const [row] = await tx.$queryRawUnsafe<
        {
          membership_id: string;
          user_id: string;
          email: string;
          role: string;
          invited_at: Date;
          token: string;
          expires_at: Date;
        }[]
      >(`SELECT * FROM public.mint_invite_token($1::uuid)`, membershipId);

      // The function RAISEs on every refusal path, so a missing row is not a
      // "not found" — it is the function having returned nothing while claiming
      // success, which is a bug rather than a client error. Fail loudly.
      if (!row) throw new Error('mint_invite_token returned no row');

      return {
        membershipId: row.membership_id,
        userId: row.user_id,
        email: row.email,
        role: row.role,
        invitedAt: row.invited_at,
        token: row.token,
        expiresAt: row.expires_at,
      };
    } catch (error) {
      throw translate(error);
    }
  }

  /** Change a membership's role. `membershipId` is the row being written (§7 (b)). */
  async changeRole(membershipId: string, role: string): Promise<void> {
    const { tx } = requireRequestContext();
    try {
      await tx.$executeRawUnsafe(
        `SELECT public.change_member_role($1::uuid, $2::public.membership_role)`,
        membershipId,
        role,
      );
    } catch (error) {
      throw translate(error);
    }
  }

  /** Revoke a membership — a SOFT delete, so the person can be re-invited later. */
  async revoke(membershipId: string): Promise<void> {
    const { tx } = requireRequestContext();
    try {
      await tx.$executeRawUnsafe(`SELECT public.revoke_member($1::uuid)`, membershipId);
    } catch (error) {
      throw translate(error);
    }
  }
}

/**
 * Maps a definer function's SQLSTATE onto the HTTP envelope.
 *
 * `MB001` becomes a 403 even though the RBAC gate should already have produced
 * one, and that overlap is the point rather than dead code: the gate and the
 * function body are two independent checks, and this mapping is what the body's
 * refusal looks like if it ever fires without the gate having. It fires for real
 * whenever the caller's role changes between the interceptor's read and the
 * function's.
 *
 * **It carries a DIFFERENT error code from the gate's 403, and that distinction
 * is load-bearing — it was added at the Phase 3 sweep, because without it the
 * gate could be deleted with every test still green.** Both layers refuse a
 * non-admin, so when both produced `FORBIDDEN_ROLE` the two responses were
 * byte-identical and nothing could tell which layer had acted. Removing
 * `@RequiresRole('admin')` from all three routes left the entire acceptance suite
 * passing: the body caught every case and answered identically. That is
 * defence-in-depth doing its job, and it is also an untestable claim — "the RBAC
 * gate works" had no negative behind it.
 *
 * So: the gate answers `FORBIDDEN_ROLE`, the function body answers `NOT_ADMIN`.
 * Both are 403. A test asserting `FORBIDDEN_ROLE` now fails if the gate is
 * removed, because the body's code arrives instead.
 *
 * The operational payoff is real too: `NOT_ADMIN` reaching a client means the
 * request got past the gate and was stopped by the database — either the caller's
 * role changed between the interceptor's read and the function's, or the gate is
 * missing from a route that needs it. That is worth being able to see in a log.
 *
 * `MB002` is a 404: "belongs to another tenant" and "does not exist" are one
 * code by design, so the endpoint cannot be used to probe for membership ids in
 * tenants the caller cannot see.
 */
function translate(error: unknown, extra: Record<string, () => Error> = {}): Error {
  const code = sqlState(error);
  if (!code) return error instanceof Error ? error : new Error(String(error));

  const handler = extra[code];
  if (handler) return handler();

  switch (code) {
    case NOT_ADMIN:
    case PENDING_NOT_ADMIN:
    case MINT_NOT_ADMIN:
      return new ForbiddenException({
        error: {
          // NOT the gate's `FORBIDDEN_ROLE` — see the note above. Same status,
          // different code, so the two layers are distinguishable.
          code: 'NOT_ADMIN',
          message: 'You do not have permission to perform this action in this workspace.',
        },
      });
    case MEMBERSHIP_NOT_FOUND:
    case MINT_MEMBERSHIP_NOT_FOUND:
      return new NotFoundException({
        error: { code: 'MEMBERSHIP_NOT_FOUND', message: 'No such member in this workspace.' },
      });
    case MINT_NOT_PENDING:
      // 409, not 404. The member exists, is live, and is in the caller's own
      // tenant — the caller can see them in `GET /users` — so a 404 would be a
      // lie that also loses the one piece of information that makes the admin UI
      // usable. There is no oracle here: co-member visibility (ADR-006 §3)
      // already shows this admin that person and, through `GET /users/pending`,
      // their pending state.
      return new ConflictException({
        error: {
          code: 'NOT_PENDING',
          message: 'That member has already set a password, so there is no invitation to re-send.',
        },
      });
    case LAST_ADMIN:
      return new ConflictException({
        error: {
          code: 'LAST_ADMIN',
          message:
            'This workspace would be left without an admin. Promote another admin first, then retry.',
        },
      });
    default:
      return error instanceof Error ? error : new Error(String(error));
  }
}

function sqlState(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return (error.meta as { code?: string } | undefined)?.code;
  }
  return undefined;
}
