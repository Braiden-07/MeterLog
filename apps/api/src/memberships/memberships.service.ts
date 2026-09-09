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
   * active tenant. There is no `tenant_id` in the WHERE clause and there must not
   * be one: app-layer filtering is not what isolates this, and adding it would
   * hide a policy regression behind a redundant predicate.
   */
  async list(): Promise<Member[]> {
    const { tx } = requireRequestContext();

    const rows = await tx.$queryRawUnsafe<
      { membership_id: string; user_id: string; email: string; role: string; created_at: Date }[]
    >(
      `SELECT m.id   AS membership_id,
              u.id   AS user_id,
              u.email::text AS email,
              m.role::text  AS role,
              m.created_at
         FROM public.memberships m
         JOIN public.users u ON u.id = m.user_id
        WHERE m.deleted_at IS NULL
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
  async invite(input: { email: string; role: string }): Promise<{
    membershipId: string;
    userId: string;
    userCreated: boolean;
  }> {
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
      return {
        membershipId: row.membership_id,
        userId: row.user_id,
        userCreated: row.user_created,
      };
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
 * function's — and if it ever stops being reachable, that is a signal the two
 * checks have been collapsed into one.
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
      return new ForbiddenException({
        error: {
          code: 'FORBIDDEN_ROLE',
          message: 'You do not have permission to perform this action in this workspace.',
        },
      });
    case MEMBERSHIP_NOT_FOUND:
      return new NotFoundException({
        error: { code: 'MEMBERSHIP_NOT_FOUND', message: 'No such member in this workspace.' },
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
