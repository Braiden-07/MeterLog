import type { Role } from '@meterlog/shared';

/**
 * The members view's data shapes and its merge rule.
 *
 * Kept out of the component because the merge is the one piece of logic here
 * that can be WRONG rather than merely ugly, and a pure function is provable
 * without rendering anything.
 */

/** `GET /users` — every live membership in the active tenant. */
export interface Member {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  createdAt: string;
}

/**
 * `GET /users/pending` — the not-yet-credentialled SUBSET of the above.
 *
 * NO `token` AND NO `expiresAt`, mirroring the server type exactly (OPEN-14).
 * The list endpoint is metadata-only; a live credential exists only in the mint
 * response, and only for the moment it is displayed.
 */
export interface PendingInvite {
  membershipId: string;
  userId: string;
  email: string;
  role: string;
  invitedAt: string;
}

/** `POST /users/pending/:membershipId/token` — the one secret body in the API. */
export interface MintedInviteToken extends PendingInvite {
  token: string;
  expiresAt: string;
}

/** A member as the table renders them: the member row plus derived pending-ness. */
export interface MemberRow extends Member {
  pending: boolean;
}

/**
 * MERGE BY SET-DIFFERENCE ON `membershipId`, and this is forced by the schema
 * rather than chosen for elegance.
 *
 * `GET /users` returns EVERY live membership in the tenant — credentialled and
 * not — and carries no pending flag. It cannot carry one: pending-ness is
 * `users.password_set_at`, a column withheld from `meterlog_app` by grant so the
 * login path cannot branch on it (ADR-006 §7 hazard (ii)). That withholding is
 * the entire reason `list_pending_invites` has to be a `SECURITY DEFINER`
 * function. So the flag does not exist server-side on the list endpoint, will
 * not be added, and must be derived here.
 *
 * `pending ⊆ members`, because the pending query is the member query plus
 * `password_set_at IS NULL`. Both sides key on the same `memberships.id` and
 * both `ORDER BY email`, so the member order is preserved and no re-sort is
 * needed.
 *
 * A pending id with no matching member would mean the two reads disagreed — they
 * are separate requests, so a membership revoked between them can produce it.
 * That row is simply absent from the output, which is correct: the member list
 * is the set being rendered, and an invite for someone no longer in it has
 * nothing to attach to.
 */
export function mergeMembers(
  members: readonly Member[],
  pending: readonly PendingInvite[],
): MemberRow[] {
  const pendingIds = new Set(pending.map((p) => p.membershipId));
  return members.map((m) => ({ ...m, pending: pendingIds.has(m.membershipId) }));
}

/**
 * Whether `LAST_ADMIN` is reachable for a row — which is TRUE ONLY FOR THE
 * CALLER'S OWN.
 *
 * Not a UX guess. `change_member_role` and `revoke_member` take the last-admin
 * check over a locked admin set, and the migration states the consequence
 * outright: a live membership is unique per (user, tenant), so if the target is
 * an admin membership OTHER than the caller's own, the caller's own admin row is
 * a second live admin BY CONSTRUCTION and the tenant cannot be zeroed. Demoting
 * or revoking someone else can never be the last-admin case; "last admin" and
 * "self-action on one's own admin membership" are the same condition.
 *
 * So the UI renders last-admin messaging only where it can actually fire.
 * Putting a "you may be the last admin" warning on every admin row would be
 * describing a refusal that is structurally unreachable there.
 */
export function isOwnRow(row: Member, currentUserId: string | undefined): boolean {
  return currentUserId !== undefined && row.userId === currentUserId;
}

/** The role options a `<select>` offers. One source, shared with the server's enum. */
export const ROLE_OPTIONS: readonly Role[] = ['admin', 'technician', 'auditor'];
