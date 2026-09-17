'use client';

import { useState } from 'react';

import { useWorkspaceState } from '../lib/session-context';

/** Shown when the session holds no active workspace but the person has several. */
export function WorkspacePicker() {
  const { session, identity } = useWorkspaceState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold tracking-tight">Choose a workspace</h1>
      <p className="text-sm text-slate-500">
        You belong to more than one. Pick the one you want to work in.
      </p>
      <ul className="flex flex-col gap-2">
        {(identity?.workspaces ?? []).map((workspace) => (
          <li key={workspace.tenantId}>
            <button
              type="button"
              className="w-full rounded border border-slate-300 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-60"
              disabled={busy !== null}
              onClick={() => {
                setBusy(workspace.tenantId);
                setError(null);
                void session
                  .switchTo(workspace.tenantId)
                  .catch(() => setError('That workspace could not be opened.'))
                  .finally(() => setBusy(null));
              }}
            >
              <span className="font-medium">{workspace.name}</span>
              <span className="text-slate-500"> · {workspace.role}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        className="self-start text-sm text-slate-500 underline"
        onClick={() => void session.logout()}
      >
        Sign out
      </button>
    </main>
  );
}

/** Shown when the person has a valid session and no memberships at all (OPEN-2). */
export function NoWorkspaceAccess() {
  const { session } = useWorkspaceState();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold tracking-tight">No workspace access</h1>
      <p className="text-sm text-slate-600">
        No workspace access — ask an admin to invite you.
      </p>
      <p className="text-sm text-slate-500">
        Signing in worked; you simply hold no memberships yet. This is not an authentication
        failure.
      </p>
      <button
        type="button"
        className="self-start text-sm text-slate-500 underline"
        onClick={() => void session.logout()}
      >
        Sign out
      </button>
    </main>
  );
}
