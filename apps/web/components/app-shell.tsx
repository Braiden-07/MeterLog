'use client';

import { AssetsList } from './assets-list';
import { MembersAdmin } from './members-admin';
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

        {/*
          ADMIN SECTION — DISPLAY-GATED ONLY, and that distinction is the point.
          `role === 'admin'` decides whether these controls are RENDERED; it
          decides nothing about whether they work. The real gate is the server's
          `@RequiresRole('admin')`, backed by an independent live-admin check
          inside each `SECURITY DEFINER` body, and neither may be relaxed on the
          strength of this line.
          A role that goes stale mid-session — a demotion in another tab, or by
          another admin — is corrected rather than trusted: a 403 from any write
          re-reads identity (`handleApiError`'s role-correction branch), and this
          section then unmounts on the next render because `role` has changed.
        */}
        {active.role === 'admin' && <MembersAdmin />}
      </main>
    </div>
  );
}
