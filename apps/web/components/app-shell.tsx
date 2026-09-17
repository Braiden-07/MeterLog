'use client';

import { AssetsList } from './assets-list';
import { WorkspaceSwitcher } from './workspace-switcher';
import { useWorkspaceState } from '../lib/session-context';

/**
 * The app shell for a chosen workspace.
 *
 * TENANT DATA RENDERS IN CLIENT COMPONENTS ONLY, and that is a constraint with a
 * reason rather than a convention. A server-rendered list would be cached by the
 * Next router keyed by ROUTE, not by tenant — a second cache that
 * `queryClient.clear()` cannot reach, holding the previous workspace's rows and
 * replaying them on a back navigation. A future "let's SSR the list for speed"
 * would reintroduce exactly the cross-tenant leak this slice exists to close.
 */
export function AppShell() {
  const { identity, mountKey } = useWorkspaceState();
  const active = identity?.activeWorkspace;
  if (!active) return null;

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-8">
      <WorkspaceSwitcher />

      {/*
        KEYED BY THE REMOUNT KEY, not by the tenant id alone. The key carries the
        cache generation too, so a reset back into the SAME workspace still rebuilds
        this subtree instead of reusing components whose state came from the cache
        that was just discarded.
      */}
      <main key={mountKey} className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{active.name}</h1>
          <p className="text-sm text-slate-500">
            Signed in as {identity.user.email} · {active.role}
          </p>
        </div>
        <AssetsList />
      </main>
    </div>
  );
}
