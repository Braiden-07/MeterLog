'use client';

import { useState } from 'react';

import { useWorkspaceState } from '../lib/session-context';

/**
 * The persistent workspace indicator and switcher.
 *
 * MINIMAL BY DECISION, NOT BY NEGLECT. ADR-006 §9 caps this slice at "a minimal
 * workspace switcher with a hard cache reset on switch" and explicitly defers a
 * polished picker — search, avatars, recent workspaces — so that step 8 does not
 * balloon. What it must be is correct: every selection goes through
 * `session.switchTo`, which performs the full reset invariant.
 */
export function WorkspaceSwitcher() {
  const { session, identity } = useWorkspaceState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = identity?.activeWorkspace ?? null;
  const workspaces = identity?.workspaces ?? [];

  async function select(tenantId: string): Promise<void> {
    if (busy || tenantId === active?.tenantId) return;
    setBusy(true);
    setError(null);
    try {
      await session.switchTo(tenantId);
    } catch {
      setError('That workspace could not be opened. Pick another.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 pb-3">
      <span className="text-sm text-slate-500">Workspace</span>
      <select
        aria-label="Active workspace"
        className="rounded border border-slate-300 px-2 py-1 text-sm"
        value={active?.tenantId ?? ''}
        disabled={busy}
        onChange={(event) => void select(event.target.value)}
      >
        {active === null && <option value="">Choose a workspace…</option>}
        {workspaces.map((workspace) => (
          <option key={workspace.tenantId} value={workspace.tenantId}>
            {workspace.name} ({workspace.role})
          </option>
        ))}
      </select>

      <button
        type="button"
        className="ml-auto rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-50"
        disabled={busy}
        onClick={() => void session.logout()}
      >
        Sign out
      </button>

      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </header>
  );
}
