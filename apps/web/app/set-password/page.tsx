'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiError, createApiClient } from '../../lib/api';
import { setPasswordSchema, type SetPasswordInput } from '../../lib/forms';

const api = createApiClient((input, init) => fetch(input, init));

/**
 * Invite redemption: `/set-password#token=…`.
 *
 * THE TOKEN COMES FROM THE FRAGMENT, NEVER A QUERY STRING, AND NEVER GOES BACK
 * INTO A URL. It is a live credential — `mint_invite_token` mints it and the
 * server stores only its SHA-256, so this page holds the one copy that exists.
 * A fragment is not sent to any server, is not written to server logs, and does
 * not travel in a `Referer` header; `?token=` fails all three, and every one of
 * those is a place a credential would be retained by something that never needed
 * it.
 *
 * **CORRECTED AT THE ADMIN USER-MANAGEMENT SLICE.** This said
 * `list_pending_invites` mints the token, which was true when written and became
 * false at the pending split (OPEN-14): that function is now a metadata-only
 * read with no `token` in its signature at all, and minting moved to
 * `mint_invite_token` behind `POST /users/pending/:membershipId/token`. The
 * correction matters beyond accuracy — a reader chasing the old name would find
 * a function that provably cannot produce what this page consumes.
 *
 * THE PRODUCER END IS NOW CONSTRAINED TOO. Until this slice, only this page —
 * the consumer — was written to the fragment rule; nothing stopped the code that
 * BUILDS the link from using `?token=`. `lib/invite-link.ts` is now the single
 * builder and `lib/invite-link.spec.ts` asserts the shape, which is the
 * producer-side acceptance OPEN-14 records as owed.
 *
 * It is read once into component state and put only in the POST body. The fragment
 * is then cleared from the address bar so the credential does not sit in history or
 * survive a copy-pasted link.
 *
 * 204 DOES NOT LOG THE USER IN, deliberately: redemption is pre-auth and returns
 * no body, so this routes to `/login` rather than inventing a session.
 */
export default function SetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const found = new URLSearchParams(hash).get('token');
    setToken(found);
    setReady(true);
    // Drop the credential from the visible URL and from the history entry. The
    // value already lives in component state; leaving it in the bar is what a
    // screenshot, a shared link or a browser sync would carry away.
    if (found) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const form = useForm<SetPasswordInput>({
    resolver: zodResolver(setPasswordSchema),
    defaultValues: { password: '' },
  });

  async function onSubmit(values: SetPasswordInput): Promise<void> {
    if (!token) return;
    setFailure(null);
    try {
      await api.request({
        method: 'POST',
        path: '/auth/set-password',
        // Body only. The token never becomes a query parameter, here or anywhere.
        body: { token, password: values.password },
      });
      router.replace('/login?password=set');
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? error.message
          : 'That did not work. Ask an admin for a fresh invitation.',
      );
    }
  }

  if (!ready) return <Centered>Checking your invitation…</Centered>;
  if (!token) {
    return (
      <Centered>
        This link is missing its invitation token. Ask an admin to send a new invitation.
      </Centered>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold tracking-tight">Set your password</h1>
      <p className="text-sm text-slate-500">
        Choose a password for your account, then sign in with it.
      </p>

      <form className="flex flex-col gap-3" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <label className="flex flex-col gap-1 text-sm">
          New password
          <input
            type="password"
            autoComplete="new-password"
            className="rounded border border-slate-300 px-2 py-1"
            {...form.register('password')}
          />
          {form.formState.errors.password && (
            <span className="text-red-600">{form.formState.errors.password.message}</span>
          )}
        </label>

        {failure && <p className="text-sm text-red-600">{failure}</p>}

        <button
          type="submit"
          className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-60"
          disabled={form.formState.isSubmitting}
        >
          Set password
        </button>
      </form>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="text-sm text-slate-600">{children}</p>
    </main>
  );
}
