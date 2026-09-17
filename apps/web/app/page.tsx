'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AppShell } from '../components/app-shell';
import { NoWorkspaceAccess, WorkspacePicker } from '../components/workspace-picker';
import { useWorkspaceState } from '../lib/session-context';

type Phase = 'loading' | 'signed-out' | 'ready' | 'failed';

/**
 * THE COLD-LOAD BOOTSTRAP AND ITS FOUR STATES.
 *
 *   activeWorkspace set                    -> the app shell for that workspace
 *   activeWorkspace null, workspaces > 1   -> the picker
 *   activeWorkspace null, workspaces === 0 -> "no workspace access" (OPEN-2)
 *   no session                             -> /login
 *
 * The revoked two-step lives in `session.bootstrap()`: a session naming a
 * workspace the caller has been revoked from answers 403 MEMBERSHIP_REVOKED once,
 * and that same server branch clears the session's active tenant — so exactly one
 * retry returns 200 with `activeWorkspace: null` and lands on the picker or the
 * zero-state. One retry, never a loop.
 */
export default function Home() {
  const { session, identity } = useWorkspaceState();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');

  useEffect(() => {
    let cancelled = false;
    void session
      .bootstrap()
      .then((result) => {
        if (cancelled) return;
        setPhase(result ? 'ready' : 'signed-out');
      })
      .catch(() => {
        if (!cancelled) setPhase('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (phase === 'signed-out') router.replace('/login');
  }, [phase, router]);

  if (phase === 'loading') {
    return <Centered>Loading your workspaces…</Centered>;
  }
  if (phase === 'failed') {
    return <Centered>Something went wrong reaching the API. Reload to try again.</Centered>;
  }
  if (phase === 'signed-out' || !identity) {
    return <Centered>Redirecting to sign in…</Centered>;
  }

  if (identity.activeWorkspace) return <AppShell />;
  return identity.workspaces.length > 0 ? <WorkspacePicker /> : <NoWorkspaceAccess />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="text-sm text-slate-500">{children}</p>
    </main>
  );
}
