import type { QueryClient } from '@tanstack/react-query';

import { ApiError, type ApiClient } from './api';

/**
 * THE TENANT-KEYED CACHE AND ITS RESET — the security core of slice 1.
 *
 * RLS protects the database. The browser cache knows nothing about tenants, so
 * switching workspace A -> B without discarding the cache shows A's rows inside B
 * (ADR-006 §9). This module owns that discard, and the eviction negative in
 * `workspace-session.spec.ts` is its proof.
 *
 * TWO KEY SPACES, AND THE SPLIT IS LOAD-BEARING:
 *
 *   ME_KEY                  tenant-INDEPENDENT. Who you are and which workspaces
 *                           you hold. It survives no clear by accident — it is
 *                           re-seeded from the switch response, so it is the single
 *                           source of truth for "which tenant is active".
 *   ['tenant', id, ...]     every tenant-scoped entry. One prefix makes "cancel all
 *                           in-flight tenant work" and "nothing of A survives"
 *                           expressible as one predicate rather than a list someone
 *                           maintains.
 *
 * THE RESET IS AN INVARIANT, NOT A SEQUENCE OF CONVENIENCES:
 *
 *   1. CANCEL in-flight tenant-scoped requests. Their abort signals fire, so the
 *      old generation stops doing work that could still resolve.
 *   2. CLEAR the cache. Nothing of the old tenant remains to be read.
 *   3. SEED the new identity under ME_KEY, so the app never renders a moment with
 *      no known active workspace.
 *   4. BUMP THE GENERATION. Components remount under it (`mountKey`), and every
 *      tenant-scoped request captured its generation when it started: a response
 *      that arrives late compares generations, loses, and is DISCARDED rather than
 *      written under a live key.
 *
 * Steps 2 and 4 together are the guarantee. Clearing alone leaves a late response
 * free to repopulate a key that is live again; bumping alone leaves the old rows
 * sitting in the cache. The mutation check in the spec removes each in turn and
 * each reds a different assertion.
 */

export interface Workspace {
  tenantId: string;
  name: string;
  role: string;
}

export interface Identity {
  user: { id: string; email: string };
  activeWorkspace: Workspace | null;
  workspaces: Workspace[];
}

/** Tenant-independent: identity and the workspace list. */
export const ME_KEY = ['auth', 'me'] as const;

/** Every tenant-scoped key starts here, so one predicate reaches all of them. */
export const TENANT_KEY_PREFIX = 'tenant';

export const tenantKey = (tenantId: string, ...rest: readonly unknown[]): unknown[] => [
  TENANT_KEY_PREFIX,
  tenantId,
  ...rest,
];

/**
 * Thrown by a tenant-scoped request whose generation is no longer current.
 *
 * It is an error rather than a silent resolve because TanStack Query must not
 * write the payload anywhere: an error result leaves no `data` behind.
 */
export class StaleGenerationError extends Error {
  constructor(readonly key: readonly unknown[]) {
    super('Discarded a response from a superseded workspace generation.');
    this.name = 'StaleGenerationError';
  }
}

export type ResetReason = 'switch' | 'login' | 'logout' | 'workspace-lost' | 'remote';

export interface ResetChannel {
  post(reason: ResetReason): void;
  subscribe(handler: (reason: ResetReason) => void): () => void;
  close(): void;
}

export interface WorkspaceSessionOptions {
  queryClient: QueryClient;
  api: ApiClient;
  /** Cross-tab propagation. Optional so the spec can run without a channel. */
  channel?: ResetChannel;
}

export class WorkspaceSession {
  private readonly queryClient: QueryClient;
  private readonly api: ApiClient;
  private readonly channel?: ResetChannel;
  private readonly listeners = new Set<() => void>();
  private unsubscribeChannel?: () => void;

  /** Bumped by every reset. Also the remount key, and the late-write guard. */
  private currentGeneration = 0;

  constructor({ queryClient, api, channel }: WorkspaceSessionOptions) {
    this.queryClient = queryClient;
    this.api = api;
    this.channel = channel;
    // A switch in one tab must not leave another tab rendering the old tenant.
    this.unsubscribeChannel = channel?.subscribe((reason) => {
      if (reason === 'remote') return;
      void this.reset({ reason: 'remote', propagate: false, refetchIdentity: true });
    });
  }

  dispose(): void {
    this.unsubscribeChannel?.();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ state
  get generation(): number {
    return this.currentGeneration;
  }

  identity(): Identity | undefined {
    return this.queryClient.getQueryData<Identity>(ME_KEY);
  }

  activeTenantId(): string | null {
    return this.identity()?.activeWorkspace?.tenantId ?? null;
  }

  /**
   * The React remount key for the tenant subtree.
   *
   * Carries the generation as well as the tenant id, so two consecutive resets
   * into the SAME workspace (a logout and a login as the same person, say) still
   * remount rather than reusing components holding the previous cache's data.
   */
  mountKey(): string {
    return `${this.activeTenantId() ?? 'no-workspace'}#${this.currentGeneration}`;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------ the reset
  async reset(options: {
    reason: ResetReason;
    seed?: Identity | null;
    propagate?: boolean;
    refetchIdentity?: boolean;
  }): Promise<void> {
    const { reason, seed, propagate = true, refetchIdentity = false } = options;

    // (1) cancel in-flight tenant-scoped work
    await this.queryClient.cancelQueries({ queryKey: [TENANT_KEY_PREFIX] });

    // (2) discard everything
    this.queryClient.clear();

    // (3) seed the new identity, so no render sees an unknown active workspace
    if (seed) this.queryClient.setQueryData(ME_KEY, seed);

    // (4) new generation: remount, and every older response is now stale
    this.currentGeneration += 1;
    this.notify();

    if (propagate) this.channel?.post(reason);
    if (refetchIdentity) await this.refreshIdentity();
  }

  // -------------------------------------------------------------- bootstrap
  /**
   * Cold-load identity.
   *
   * THE REVOKED TWO-STEP, ONE RETRY AND NEVER A LOOP. A session naming a
   * workspace the caller has since been revoked from answers 403
   * MEMBERSHIP_REVOKED on its first request — and that same branch clears the
   * session's active tenant server-side. So exactly one retry is correct and
   * sufficient: the second call returns 200 with `activeWorkspace: null`. Retrying
   * a second time would be a loop with no new information, which is why the retry
   * is written once here rather than as a policy.
   */
  async bootstrap(): Promise<Identity | null> {
    try {
      return await this.loadIdentity();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'MEMBERSHIP_REVOKED') {
        await this.reset({ reason: 'workspace-lost', propagate: false });
        return await this.loadIdentity();
      }
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  }

  private async loadIdentity(): Promise<Identity> {
    const identity = await this.api.request<Identity>({ path: '/auth/me' });
    this.queryClient.setQueryData(ME_KEY, identity);
    this.notify();
    return identity;
  }

  /** Re-reads identity after a remote reset, tolerating a signed-out session. */
  private async refreshIdentity(): Promise<void> {
    try {
      await this.loadIdentity();
    } catch {
      this.queryClient.removeQueries({ queryKey: ME_KEY });
      this.notify();
    }
  }

  /**
   * Re-read identity, and NOTHING else.
   *
   * THE NARROW COUNTERPART TO `reset`, and the distinction is the whole reason
   * this is a separate method rather than a parameter on that one. A reset means
   * "you have no workspace": it cancels in-flight work, clears the cache and
   * bumps the generation so the tenant subtree remounts. This means "your ROLE is
   * not what I thought": the workspace is intact, every tenant-scoped row in the
   * cache is still readable, and the only stale thing is `activeWorkspace.role`.
   *
   * Used in two places, and they are the same event seen from both sides — the
   * server telling us (`handleApiError`'s role-correction branch, on a 403) and
   * the client already knowing (an admin changing or revoking their OWN
   * membership, where the next render must not still offer admin controls).
   *
   * Deliberately does NOT bump the generation. Doing so would remount the tenant
   * subtree and throw away component state — a half-typed invite, a scroll
   * position — for a change that invalidates no cached row.
   */
  async refresh(): Promise<void> {
    await this.refreshIdentity();
  }

  // ------------------------------------------------------- auth transitions
  async login(credentials: { email: string; password: string }): Promise<Identity> {
    const identity = await this.api.request<Identity>({
      method: 'POST',
      path: '/auth/login',
      body: credentials,
    });
    // A login is a reset: whatever the previous person's session left behind goes.
    await this.reset({ reason: 'login', seed: identity });
    return identity;
  }

  async switchTo(tenantId: string): Promise<Identity> {
    const identity = await this.api.request<Identity>({
      method: 'POST',
      path: '/auth/switch',
      body: { tenantId },
      expectedTenant: this.activeTenantId(),
    });
    await this.reset({ reason: 'switch', seed: identity });
    return identity;
  }

  async logout(): Promise<void> {
    try {
      await this.api.request<void>({ method: 'POST', path: '/auth/logout' });
    } finally {
      await this.reset({ reason: 'logout', seed: null });
    }
  }

  /**
   * The global error hook. TWO BRANCHES, AND THE SPLIT IS THE POINT.
   *
   * Returns true when it handled the error, so callers can stop.
   *
   * **Reset** — the two `RESET_CODES` mean the caller has no workspace, so every
   * tenant-scoped row in the cache is unreadable and all of it goes.
   *
   * **Role correction** — `FORBIDDEN_ROLE` / `NOT_ADMIN` mean the caller still
   * holds this workspace and may still read it; only their ROLE is not what the
   * client believed, which in practice means they were demoted mid-session. The
   * response is therefore as narrow as it can be: re-read identity, and nothing
   * else. The admin section then disappears on its own, because it renders off
   * `activeWorkspace.role`.
   *
   * IT MUST NOT BE A RESET, and the reason is a user-visible one rather than a
   * purity argument: a reset clears the cache and bumps the generation, which
   * remounts the whole tenant subtree and flickers away data the caller is still
   * entitled to see — the member list included, which every member may read by
   * decision (ADR-006 §3). See the note at `RESET_CODES` for why the code is not
   * simply added to that list.
   *
   * `invalidateQueries` rather than `setQueryData`: the refetch goes through the
   * normal query path, so a concurrently-failing `/auth/me` is handled by the
   * existing policy instead of by a second bespoke one here.
   */
  async handleApiError(error: unknown): Promise<boolean> {
    if (!(error instanceof ApiError)) return false;

    if (error.isWorkspaceReset) {
      await this.reset({ reason: 'workspace-lost', propagate: true, refetchIdentity: true });
      return true;
    }

    if (error.isRoleCorrection) {
      await this.queryClient.invalidateQueries({ queryKey: ME_KEY });
      await this.refresh();
      return true;
    }

    return false;
  }

  // --------------------------------------------------- tenant-scoped reads
  /**
   * Query options for tenant-scoped data.
   *
   * The generation is captured when the request STARTS and compared when it
   * finishes. That is what makes a late response harmless: it cannot be written
   * under a key that is live again, because it is thrown away instead.
   */
  tenantQuery<T>(
    keyTail: readonly unknown[],
    fetcher: (context: { signal?: AbortSignal; expectedTenant: string }) => Promise<T>,
  ): {
    queryKey: unknown[];
    queryFn: (context: { signal?: AbortSignal }) => Promise<T>;
    enabled: boolean;
  } {
    const tenantId = this.activeTenantId();
    const key = tenantId === null ? tenantKey('no-workspace', ...keyTail) : tenantKey(tenantId, ...keyTail);

    return {
      queryKey: key,
      enabled: tenantId !== null,
      queryFn: async ({ signal }) => {
        const startedAt = this.currentGeneration;
        const startedFor = tenantId;
        if (startedFor === null) throw new StaleGenerationError(key);

        const result = await fetcher({ signal, expectedTenant: startedFor });

        // The late-response guard. Both halves matter: the generation catches a
        // reset into the SAME workspace, the tenant id catches a reset into a
        // different one.
        if (this.currentGeneration !== startedAt || this.activeTenantId() !== startedFor) {
          throw new StaleGenerationError(key);
        }
        return result;
      },
    };
  }
}

export function createWorkspaceSession(options: WorkspaceSessionOptions): WorkspaceSession {
  return new WorkspaceSession(options);
}
