import { describe, expect, it } from 'vitest';

import { isOwnRow, mergeMembers, type Member, type PendingInvite } from './members';

/**
 * The members view's merge rule.
 *
 * WHY THIS IS TESTED AT ALL, when it is six lines: it is the only place the
 * "active member vs invited" distinction exists. The server cannot send that
 * flag — pending-ness is `users.password_set_at`, withheld from `meterlog_app`
 * by column grant — so the distinction is DERIVED here or it is nowhere. Getting
 * it backwards would offer "copy invite link" on people who have already set a
 * password (a 409 the admin cannot explain) and withhold it from the people who
 * actually need one.
 */

const member = (over: Partial<Member> & { membershipId: string }): Member => ({
  userId: `u-${over.membershipId}`,
  email: `${over.membershipId}@acme.test`,
  role: 'technician',
  createdAt: '2026-09-18T00:00:00.000Z',
  ...over,
});

const invite = (membershipId: string): PendingInvite => ({
  membershipId,
  userId: `u-${membershipId}`,
  email: `${membershipId}@acme.test`,
  role: 'technician',
  invitedAt: '2026-09-18T00:00:00.000Z',
});

describe('mergeMembers — set-difference on membershipId', () => {
  it('flags exactly the members whose membershipId is in the pending set', () => {
    const rows = mergeMembers(
      [
        member({ membershipId: 'm1' }),
        member({ membershipId: 'm2' }),
        member({ membershipId: 'm3' }),
      ],
      [invite('m2')],
    );

    expect(rows.map((r) => [r.membershipId, r.pending])).toEqual([
      ['m1', false],
      ['m2', true],
      ['m3', false],
    ]);
  });

  it('keeps every member — pending is an ANNOTATION, never a filter', () => {
    // The merged view is the MEMBER list with a badge, not the union of two
    // lists. A member must never disappear because they are not pending.
    const members = [member({ membershipId: 'm1' }), member({ membershipId: 'm2' })];
    expect(mergeMembers(members, [])).toHaveLength(2);
    expect(mergeMembers(members, []).every((r) => r.pending === false)).toBe(true);
  });

  it('preserves the order the server sent (both endpoints ORDER BY email)', () => {
    const rows = mergeMembers(
      [member({ membershipId: 'b' }), member({ membershipId: 'a' })],
      [invite('a')],
    );
    expect(rows.map((r) => r.membershipId)).toEqual(['b', 'a']);
  });

  it('ignores a pending row with no matching member — the two reads can disagree', () => {
    // Separate requests: a membership revoked between them lands here. The row
    // is absent rather than synthesised, because the member list is the set
    // being rendered and an invite with nothing to attach to is not a row.
    const rows = mergeMembers([member({ membershipId: 'm1' })], [invite('m1'), invite('ghost')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pending).toBe(true);
  });

  it('matches on membershipId, NOT on email or userId', () => {
    // The join key matters: both endpoints take it from `memberships.id`. Keying
    // on email would look identical in every ordinary fixture and break the
    // moment a person holds memberships in two workspaces — which is the exact
    // multi-workspace case G1 exists for.
    const rows = mergeMembers(
      [member({ membershipId: 'm1', email: 'same@acme.test', userId: 'shared' })],
      [{ ...invite('other'), email: 'same@acme.test', userId: 'shared' }],
    );
    expect(rows[0]!.pending, 'a different membershipId must not flag this row').toBe(false);
  });
});

describe('isOwnRow — where LAST_ADMIN can actually fire', () => {
  it('is true only for the caller', () => {
    const row = member({ membershipId: 'm1', userId: 'me' });
    expect(isOwnRow(row, 'me')).toBe(true);
    expect(isOwnRow(row, 'someone-else')).toBe(false);
  });

  it('is false when identity is not loaded — never guesses', () => {
    // Undefined identity must not resolve to "this is you": a wrong true would
    // show last-admin messaging on a stranger's row.
    expect(isOwnRow(member({ membershipId: 'm1', userId: 'me' }), undefined)).toBe(false);
  });
});
