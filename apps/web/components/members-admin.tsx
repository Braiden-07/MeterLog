'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiError, createApiClient } from '../lib/api';
import { inviteSchema, type InviteInput } from '../lib/forms';
import { inviteLinkFor } from '../lib/invite-link';
import {
  ROLE_OPTIONS,
  isOwnRow,
  mergeMembers,
  type Member,
  type MemberRow,
  type MintedInviteToken,
  type PendingInvite,
} from '../lib/members';
import { useWorkspaceState } from '../lib/session-context';

const api = createApiClient((input, init) => fetch(input, init));

/**
 * ADMIN USER MANAGEMENT — the members table, the invite form, and the mint.
 *
 * ================== THE MINTED TOKEN NEVER ENTERS A CACHE ==================
 *
 * This is the one hard constraint in this file, and it is a structural choice
 * rather than a discipline: the token is held in ONE `useState`, and every other
 * place it could live is deliberately not used.
 *
 *   - NOT `useQuery`. That writes the payload into the TanStack cache under a
 *     `['tenant', …]` key, where it would survive until a reset and be readable
 *     by any component that knows the key. A live credential in a general-purpose
 *     cache is the client-side mirror of the `Cache-Control: no-store` the server
 *     puts on this one response, and dropping it would defeat that header.
 *   - NOT `useMutation`. Less obvious and worth stating: a mutation result is
 *     retained as `data` on the MutationCache until it is garbage-collected, so
 *     the token would outlive the interaction with no visible sign of it. Slice 1
 *     uses no `useMutation` anywhere — plain `async` handlers with local state —
 *     and that existing pattern happens to be the safer one here.
 *   - NOT `localStorage`, NOT a route param, NOT a log line.
 *
 * It is cleared on copy AND on dismiss, so its lifetime is bounded by one
 * interaction rather than by unmount.
 *
 * ========================= WHY THE FLOW IS TWO STEPS =======================
 *
 * `POST /users` answers `{ message: 'Invitation sent.' }` and nothing else — no
 * `membershipId`. That is ADR-016's uniform-response property, not an omission:
 * a body that varied in shape between "created an identity" and "attached to an
 * existing one" is an account-existence oracle over GLOBAL identity, readable by
 * any tenant admin about a person in tenants they cannot see. So the link cannot
 * be produced at invite time, and is not.
 *
 * Instead: invite → the row appears as "Invited" → the admin clicks "Copy invite
 * link" WHEN THEY ARE READY. That is the same code path as re-sending, so there
 * is one mint path rather than two, and no token is minted for an admin who was
 * not about to use one.
 */
export function MembersAdmin() {
  const { session, identity } = useWorkspaceState();
  const queryClient = useQueryClient();

  const membersQuery = useQuery(
    session.tenantQuery<Member[]>(['members', 'list'], async ({ signal, expectedTenant }) =>
      api.request<Member[]>({ path: '/users', signal, expectedTenant }),
    ),
  );

  const pendingQuery = useQuery(
    session.tenantQuery<PendingInvite[]>(
      ['members', 'pending'],
      async ({ signal, expectedTenant }) =>
        api.request<PendingInvite[]>({ path: '/users/pending', signal, expectedTenant }),
    ),
  );

  // THE ONE PLACE A LIVE CREDENTIAL LIVES IN THIS CLIENT.
  const [minted, setMinted] = useState<MintedInviteToken | null>(null);
  const [rowFailure, setRowFailure] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** Both member reads, after any write. They are one view and refresh together. */
  const refreshMembers = async (): Promise<void> => {
    await queryClient.invalidateQueries({
      predicate: (query) => Array.isArray(query.queryKey) && query.queryKey.includes('members'),
    });
  };

  /**
   * Every write funnels its failure through here.
   *
   * `session.handleApiError` is what turns a mid-session demotion into a
   * corrected UI: `FORBIDDEN_ROLE` re-reads identity ONLY — no cache clear, no
   * remount — so this whole section unmounts on the next render because it is
   * gated on `activeWorkspace.role`. The two reset codes still take the full
   * reset path. Anything else is shown to the admin as text.
   */
  const reportFailure = async (error: unknown, fallback: string): Promise<void> => {
    const handled = await session.handleApiError(error);
    if (handled) return;
    setRowFailure(error instanceof ApiError ? error.message : fallback);
  };

  // ------------------------------------------------------------------ invite
  const form = useForm<InviteInput>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: 'technician' },
  });
  const [inviteFailure, setInviteFailure] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  async function onInvite(values: InviteInput): Promise<void> {
    setInviteFailure(null);
    setInviteNotice(null);
    try {
      await api.request<{ message: string }>({
        method: 'POST',
        path: '/users',
        body: values,
        expectedTenant: session.activeTenantId(),
      });
      // The response carries no id by design, so the new row is found by
      // refetching rather than by reading it back out of the response.
      await refreshMembers();
      form.reset({ email: '', role: values.role });
      setInviteNotice(
        `Invitation sent to ${values.email}. Use “Copy invite link” to send them in.`,
      );
    } catch (error) {
      const handled = await session.handleApiError(error);
      if (handled) return;
      setInviteFailure(
        error instanceof ApiError ? error.message : 'The invitation could not be sent.',
      );
    }
  }

  // -------------------------------------------------------------------- mint
  /**
   * Mints a fresh token for one pending membership, superseding any prior one.
   *
   * Called from the pending rows only — a non-pending member answers
   * `409 NOT_PENDING`, which is handled below anyway rather than assumed
   * unreachable.
   */
  async function onCopyLink(row: MemberRow): Promise<void> {
    setRowFailure(null);
    setCopied(false);
    setBusyRow(row.membershipId);
    try {
      const result = await api.request<MintedInviteToken>({
        method: 'POST',
        path: `/users/pending/${row.membershipId}/token`,
        expectedTenant: session.activeTenantId(),
      });
      setMinted(result);
      // A fresh mint invalidates the previous link, which is why re-issuing is
      // safe to offer as a button — but the pending SET is unchanged by minting,
      // so there is nothing to refetch here.
    } catch (error) {
      await reportFailure(error, 'The invite link could not be created.');
    } finally {
      setBusyRow(null);
    }
  }

  async function copyToClipboard(): Promise<void> {
    if (!minted) return;
    const link = inviteLinkFor(window.location.origin, minted.token);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the link is on screen to copy by hand,
      // so this is not a failure worth interrupting the flow for.
      setCopied(false);
    }
  }

  /** Clears the credential from component state. Called on copy and on dismiss. */
  function dismissLink(): void {
    setMinted(null);
    setCopied(false);
  }

  // ------------------------------------------------------------- row actions
  async function onChangeRole(row: MemberRow, role: string): Promise<void> {
    setRowFailure(null);
    setBusyRow(row.membershipId);
    try {
      await api.request<void>({
        method: 'PATCH',
        path: `/users/${row.membershipId}`,
        body: { role },
        expectedTenant: session.activeTenantId(),
      });
      await refreshMembers();
      // Changing your OWN role changes what you may do next, so identity has to
      // catch up or the admin section would linger for a self-demoted admin.
      if (isOwnRow(row, identity?.user.id)) await session.refresh();
    } catch (error) {
      await reportFailure(error, 'The role could not be changed.');
    } finally {
      setBusyRow(null);
    }
  }

  async function onRevoke(row: MemberRow): Promise<void> {
    setRowFailure(null);
    setBusyRow(row.membershipId);
    try {
      await api.request<void>({
        method: 'DELETE',
        path: `/users/${row.membershipId}`,
        expectedTenant: session.activeTenantId(),
      });
      await refreshMembers();
      if (isOwnRow(row, identity?.user.id)) await session.refresh();
    } catch (error) {
      await reportFailure(error, 'Access could not be revoked.');
    } finally {
      setBusyRow(null);
    }
  }

  // ------------------------------------------------------------------ render
  if (membersQuery.isPending || pendingQuery.isPending) {
    return <p className="text-sm text-slate-500">Loading members…</p>;
  }
  if (membersQuery.isError || pendingQuery.isError) {
    return <p className="text-sm text-red-600">Members could not be loaded. Try again shortly.</p>;
  }

  const rows = mergeMembers(membersQuery.data ?? [], pendingQuery.data ?? []);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-tight">People</h2>

      {/* ---------------------------------------------------------- invite */}
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={form.handleSubmit(onInvite)}
        noValidate
      >
        <div className="flex flex-col">
          <input
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="name@example.com"
            aria-label="Email to invite"
            autoComplete="off"
            {...form.register('email')}
          />
          {form.formState.errors.email && (
            <span className="text-xs text-red-600">{form.formState.errors.email.message}</span>
          )}
        </div>

        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          aria-label="Role for the invitee"
          {...form.register('role')}
        >
          {ROLE_OPTIONS.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>

        <button
          type="submit"
          className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
          disabled={form.formState.isSubmitting}
        >
          Invite
        </button>
      </form>

      {inviteFailure && <p className="text-sm text-red-600">{inviteFailure}</p>}
      {inviteNotice && <p className="text-sm text-emerald-700">{inviteNotice}</p>}

      {/* ------------------------------------------------ the minted link */}
      {minted && (
        <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium">Invite link for {minted.email}</p>
          <p className="text-xs text-slate-600">
            Shown once. Send it to them now — it is not stored anywhere and cannot be shown again.
            Creating a new link invalidates this one.
          </p>
          <code className="overflow-x-auto rounded bg-white px-2 py-1 text-xs">
            {inviteLinkFor(window.location.origin, minted.token)}
          </code>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded bg-slate-900 px-3 py-1 text-sm text-white"
              onClick={() => void copyToClipboard()}
            >
              Copy
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 px-3 py-1 text-sm"
              onClick={dismissLink}
            >
              Done
            </button>
            {copied && <span className="text-xs text-emerald-700">Copied.</span>}
          </div>
        </div>
      )}

      {rowFailure && <p className="text-sm text-red-600">{rowFailure}</p>}

      {/* ----------------------------------------------------------- table */}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="py-2">Email</th>
            <th className="py-2">Role</th>
            <th className="py-2">Status</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const own = isOwnRow(row, identity?.user.id);
            const busy = busyRow === row.membershipId;
            return (
              <tr key={row.membershipId} className="border-b border-slate-100">
                <td className="py-2 font-medium">
                  {row.email}
                  {own && <span className="ml-1 text-xs text-slate-500">(you)</span>}
                </td>
                <td className="py-2">
                  <select
                    className="rounded border border-slate-300 px-1 py-0.5 text-sm"
                    aria-label={`Role for ${row.email}`}
                    value={row.role}
                    disabled={busy}
                    onChange={(event) => void onChangeRole(row, event.target.value)}
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2">
                  {row.pending ? (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                      Invited
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500">Active</span>
                  )}
                </td>
                <td className="flex flex-wrap gap-2 py-2">
                  {/*
                    ONLY ON PENDING ROWS. A credentialled member answers
                    409 NOT_PENDING, so gating the action by the same set that
                    drives the badge keeps ordinary use away from an error the
                    admin could not act on. The handler still renders that 409 if
                    it arrives — the two reads are separate requests, so a member
                    can activate between them.
                  */}
                  {row.pending && (
                    <button
                      type="button"
                      className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void onCopyLink(row)}
                    >
                      Copy invite link
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void onRevoke(row)}
                  >
                    Revoke
                  </button>
                  {/*
                    LAST-ADMIN MESSAGING, ON THE OWN ROW ONLY.
                    `409 LAST_ADMIN` is structurally unreachable on anyone else's
                    row: a live membership is unique per (user, tenant), so if the
                    target is an admin other than the caller, the caller's own
                    admin row is a second live admin by construction. Warning on
                    every admin row would describe a refusal that cannot happen
                    there.
                  */}
                  {own && row.role === 'admin' && (
                    <span className="text-xs text-slate-500">
                      Leaving the workspace without an admin is refused.
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
