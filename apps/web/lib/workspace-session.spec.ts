import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApiClient, type FetchLike } from './api';
import {
  ME_KEY,
  StaleGenerationError,
  createWorkspaceSession,
  tenantKey,
  type Identity,
  type WorkspaceSession,
} from './workspace-session';

/**
 * THE EVICTION NEGATIVE — slice 1's security gate.
 *
 * The claim: switching workspace discards the previous workspace's data, and no
 * response from the previous workspace can put it back.
 *
 * IT ASSERTS TENANT-A DATA IS **GONE**, NOT THAT TENANT-B ARRIVED, and the
 * distinction is the whole point. "B's rows are on screen" passes just as happily
 * when A's row is sitting next to them, which is the leak. Every Beta response is
 * therefore HELD until after the assertion: at the moment we check, the only thing
 * that could be in the cache is Acme's.
 *
 * It seeds Acme entries and ASSERTS THEM PRESENT FIRST. Without that, the whole
 * file would pass against a cache that was never populated — the vacuity trap this
 * repo has met at every layer (`readWorkspaces`, ADR-013's bootstrap rows,
 * assertion 17's attachment list).
 *
 * It drives the REAL switch (`session.switchTo`), never `queryClient.clear()`
 * directly. A test that calls clear() proves that clear() works, which nobody
 * doubted; what needs proving is that the app's switch path calls it.
 *
 * SCOPE, STATED PLAINLY: this proves the CLIENT MECHANISM against a scripted fake
 * server. It is not the real browser against the real API — that is OPEN-17
 * (Playwright, PROJECT_BRIEF §11 step 9), and `ISOLATION.md` §9 records the gap.
 */

interface Held<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  promise: Promise<T>;
}

function held<T>(): Held<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

const ACME: Identity = {
  user: { id: 'user-1', email: 'm@acme.test' },
  activeWorkspace: { tenantId: 'acme', name: 'Acme', role: 'admin' },
  workspaces: [
    { tenantId: 'acme', name: 'Acme', role: 'admin' },
    { tenantId: 'beta', name: 'Beta', role: 'technician' },
  ],
};

const BETA: Identity = {
  ...ACME,
  activeWorkspace: { tenantId: 'beta', name: 'Beta', role: 'technician' },
};

const OTHER_PERSON: Identity = {
  user: { id: 'user-2', email: 'other@globex.test' },
  activeWorkspace: { tenantId: 'globex', name: 'Globex', role: 'auditor' },
  workspaces: [{ tenantId: 'globex', name: 'Globex', role: 'auditor' }],
};

/**
 * A scripted fake server.
 *
 * Records every request, exposes per-path held responses, and RECORDS ABORTS —
 * which is how "the in-flight request was cancelled" becomes an assertion rather
 * than a hope.
 */
function fakeServer() {
  const requests: string[] = [];
  const aborted: string[] = [];
  /**
   * A shared ordering log. Aborts land here, and a test can subscribe the query
   * cache's `removed` events into it, which is how "aborted BEFORE the cache was
   * torn down" becomes an assertion. That ordering is the only thing the cancel
   * step does that `clear()` does not do by itself — v5's `clear()` destroys
   * queries and aborts their fetches too, just afterwards.
   */
  const timeline: string[] = [];
  const pending = new Map<string, Held<unknown>>();
  const canned = new Map<string, unknown>();

  const statuses = new Map<string, number>();

  const fetchImpl: FetchLike = (input, init) => {
    const path = input.replace('/api/v1', '');
    requests.push(path);

    const respond = (payload: unknown, status = 200): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
      }) as unknown as Response;

    if (canned.has(path)) {
      return Promise.resolve(respond(canned.get(path), statuses.get(path) ?? 200));
    }

    const slot = held<unknown>();
    pending.set(path, slot);
    init?.signal?.addEventListener('abort', () => {
      aborted.push(path);
      timeline.push(`abort:${path}`);
      slot.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    return slot.promise.then((payload) => respond(payload));
  };

  return {
    fetchImpl,
    requests,
    aborted,
    timeline,
    /** Answer a path immediately, for every call. */
    canned(path: string, payload: unknown, status = 200) {
      canned.set(path, payload);
      statuses.set(path, status);
    },
    /** Resolve a currently-held request. */
    release(path: string, payload: unknown) {
      const slot = pending.get(path);
      if (!slot) throw new Error(`nothing pending for ${path} (requests: ${requests.join(', ')})`);
      pending.delete(path);
      slot.resolve(payload);
    },
    isPending(path: string) {
      return pending.has(path);
    },
  };
}

type Server = ReturnType<typeof fakeServer>;

/** Every cache key currently holding data, as strings. */
function keysWithData(queryClient: QueryClient): string[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.data !== undefined)
    .map((query) => JSON.stringify(query.queryKey));
}

function cacheJson(queryClient: QueryClient): string {
  return JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, data: query.state.data })),
  );
}

/**
 * Only the TENANT-SCOPED half of the cache.
 *
 * `ME_KEY` legitimately names Acme after a switch to Beta — the person is still a
 * member of both, and the switcher renders that list. So "nothing of Acme remains"
 * is a claim about tenant-scoped entries and about Acme's DATA, never about the
 * string "acme" appearing nowhere at all. Asserting the latter would have demanded
 * the app forget which workspaces the user holds.
 */
function tenantCacheJson(queryClient: QueryClient): string {
  return JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === 'tenant')
      .map((query) => ({ key: query.queryKey, data: query.state.data })),
  );
}

describe('workspace switch evicts the previous tenant (slice 1 security gate)', () => {
  let queryClient: QueryClient;
  let server: Server;
  let session: WorkspaceSession;

  beforeEach(async () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    server = fakeServer();
    session = createWorkspaceSession({ queryClient, api: createApiClient(server.fetchImpl) });

    server.canned('/auth/me', ACME);
    await session.bootstrap();
  });

  /** Seeds three tenant-scoped Acme entries: a list, a detail, and a role-gated one. */
  async function seedAcme(): Promise<void> {
    queryClient.setQueryData(tenantKey('acme', 'assets', 'list'), {
      items: [{ id: 'asset-a', serialNumber: 'SN-ACME-1' }],
      nextCursor: null,
    });
    queryClient.setQueryData(tenantKey('acme', 'assets', 'asset-a'), {
      id: 'asset-a',
      serialNumber: 'SN-ACME-1',
    });
    queryClient.setQueryData(tenantKey('acme', 'audit', 'list'), {
      items: [{ id: 'audit-a', action: 'asset.created' }],
      nextCursor: null,
    });
  }

  it('the fixture is real — Acme data is in the cache before the switch', async () => {
    await seedAcme();
    const keys = keysWithData(queryClient);
    expect(keys).toContain(JSON.stringify(tenantKey('acme', 'assets', 'list')));
    expect(keys).toContain(JSON.stringify(tenantKey('acme', 'assets', 'asset-a')));
    expect(keys).toContain(JSON.stringify(tenantKey('acme', 'audit', 'list')));
    expect(cacheJson(queryClient)).toContain('SN-ACME-1');
  });

  it('after the REAL switch, nothing of Acme remains — asserted before any Beta response arrives', async () => {
    await seedAcme();
    expect(cacheJson(queryClient)).toContain('SN-ACME-1');

    server.canned('/auth/switch', BETA);
    await session.switchTo('beta');

    // Beta's read is started and deliberately LEFT HELD. At the moment of the
    // assertion below, Beta has delivered NOTHING — so a clean cache cannot be
    // explained by B's rows having replaced A's.
    const betaRead = queryClient.fetchQuery(
      session.tenantQuery(['assets', 'list'], async ({ signal }) =>
        createApiClient(server.fetchImpl).request({ path: '/assets', signal }),
      ),
    );
    void betaRead.catch(() => undefined);
    await Promise.resolve();
    expect(server.isPending('/assets'), 'Beta must still be in flight').toBe(true);

    // THE ASSERTION: Acme is GONE, not replaced.
    const tenantCache = tenantCacheJson(queryClient);
    expect(tenantCache).not.toContain('acme');
    expect(tenantCache).not.toContain('SN-ACME-1');
    expect(tenantCache).not.toContain('audit-a');
    expect(keysWithData(queryClient).filter((k) => k.includes('acme'))).toEqual([]);
    // Nor anywhere else in the cache: no Acme PAYLOAD survives.
    expect(cacheJson(queryClient)).not.toContain('SN-ACME-1');
    expect(cacheJson(queryClient)).not.toContain('audit-a');

    // Identity was re-seeded under the TENANT-INDEPENDENT key, so no render sees
    // an unknown workspace. It still names Acme as a MEMBERSHIP, which is correct
    // and is not tenant data.
    expect(keysWithData(queryClient)).toContain(JSON.stringify(ME_KEY));
    expect(session.identity()?.activeWorkspace?.tenantId).toBe('beta');
    expect(session.activeTenantId()).toBe('beta');
    expect(session.identity()?.workspaces.map((w) => w.tenantId)).toEqual(['acme', 'beta']);
  });

  it('the in-flight Acme request is CANCELLED by the switch', async () => {
    const inFlight = queryClient.fetchQuery(
      session.tenantQuery(['assets', 'list'], async ({ signal }) =>
        createApiClient(server.fetchImpl).request({ path: '/assets', signal }),
      ),
    );
    void inFlight.catch(() => undefined);
    await Promise.resolve();
    expect(server.isPending('/assets'), 'the Acme read should be in flight').toBe(true);

    // Log cache teardown into the same timeline as the aborts.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed') server.timeline.push('cache-removed');
    });

    server.canned('/auth/switch', BETA);
    await session.switchTo('beta');
    unsubscribe();

    expect(server.aborted, 'the in-flight Acme request was not aborted by the switch').toContain(
      '/assets',
    );

    // AND IT WAS ABORTED FIRST. This is what the explicit cancel step buys: the old
    // generation stops before the cache is torn down. Without it, `clear()` still
    // aborts — afterwards — so the ordering is the only observable difference, and
    // the invariant is stated as cancel-then-clear for a reason.
    const abortAt = server.timeline.indexOf('abort:/assets');
    const removedAt = server.timeline.indexOf('cache-removed');
    expect(abortAt, 'no abort was recorded').toBeGreaterThanOrEqual(0);
    expect(removedAt, 'the cache was never torn down').toBeGreaterThanOrEqual(0);
    expect(abortAt, 'the cache was cleared before in-flight work was cancelled').toBeLessThan(
      removedAt,
    );
  });

  it('a LATE Acme response resolving after the switch never lands under any key', async () => {
    // THE SECOND LINE, BEHIND CANCEL. Cancellation handles the requests the client
    // controls; this covers the one it does not — a server that has already sent
    // its bytes and ignores the abort. The request is therefore driven through the
    // query function DIRECTLY, so the cancel cannot mask the generation guard: what
    // is under test is what happens when a superseded response really does arrive.
    const acmeRead = session.tenantQuery(['assets', 'list'], async () =>
      createApiClient(server.fetchImpl).request({ path: '/assets' }),
    );
    const inFlight = acmeRead.queryFn({}).catch((error: unknown) => error);
    await Promise.resolve();

    server.canned('/auth/switch', BETA);
    await session.switchTo('beta');

    server.release('/assets', { items: [{ id: 'asset-a', serialNumber: 'SN-ACME-1' }] });
    const outcome = await inFlight;

    expect(outcome, 'a superseded response was not discarded').toBeInstanceOf(StaleGenerationError);
    // And it wrote nothing on its way past.
    expect(cacheJson(queryClient)).not.toContain('SN-ACME-1');
    expect(keysWithData(queryClient).filter((k) => k.includes('acme'))).toEqual([]);
  });

  it('through the query cache, the same late response is CANCELLED rather than stored', async () => {
    // The ordinary path: a tracked query is aborted by the switch, so it never even
    // reaches the generation check. Recorded separately so the two mechanisms are
    // not confused for one.
    const acmeRead = session.tenantQuery(['assets', 'list'], async ({ signal }) =>
      createApiClient(server.fetchImpl).request({ path: '/assets', signal }),
    );
    const settled = queryClient.fetchQuery(acmeRead).catch((error: unknown) => error);
    await Promise.resolve();

    server.canned('/auth/switch', BETA);
    await session.switchTo('beta');
    const outcome = await settled;

    // Rejected rather than stored, and the abort reached the server. The error
    // CLASS is deliberately not pinned — TanStack's cancellation wrapper is an
    // implementation detail; that nothing was written is the claim.
    expect(outcome).toBeInstanceOf(Error);
    expect(server.aborted).toContain('/assets');
    expect(cacheJson(queryClient)).not.toContain('SN-ACME-1');
  });

  it('an observer still mounted on an Acme key cannot recreate an Acme entry', async () => {
    await seedAcme();
    const acmeRead = session.tenantQuery(['assets', 'list'], async () =>
      createApiClient(server.fetchImpl).request({ path: '/assets' }),
    );
    const observer = new QueryObserver(queryClient, { ...acmeRead, staleTime: 0 });
    const unsubscribe = observer.subscribe(() => undefined);

    server.canned('/auth/switch', BETA);
    await session.switchTo('beta');

    // The app remounts the tenant subtree, which unmounts observers like this one.
    // Even when one is left behind, its refetch must not repopulate Acme: the
    // query function refuses before it issues a request, because the generation it
    // captured is gone.
    const refetch = observer.refetch().catch(() => undefined);
    if (server.isPending('/assets')) {
      server.release('/assets', { items: [{ id: 'asset-a', serialNumber: 'SN-ACME-1' }] });
    }
    await refetch;

    const cache = cacheJson(queryClient);
    expect(cache).not.toContain('SN-ACME-1');
    expect(keysWithData(queryClient).filter((k) => k.includes('acme'))).toEqual([]);
    unsubscribe();
  });

  it('a late response from before a reset into the SAME workspace is discarded too', async () => {
    // THE CASE THE GENERATION EXISTS FOR, and the tenant id cannot cover it: the
    // active workspace is Acme before and after. Only the generation counter
    // distinguishes "this response belongs to the cache we threw away" from "this
    // response belongs to the cache we have now".
    const acmeRead = session.tenantQuery(['assets', 'list'], async () =>
      createApiClient(server.fetchImpl).request({ path: '/assets' }),
    );
    const inFlight = acmeRead.queryFn({}).catch((error: unknown) => error);
    await Promise.resolve();

    const mountBefore = session.mountKey();
    server.canned('/auth/logout', undefined);
    await session.logout();
    server.canned('/auth/login', ACME);
    await session.login({ email: 'm@acme.test', password: 'x'.repeat(12) });
    expect(session.activeTenantId(), 'the fixture must land back in Acme').toBe('acme');

    server.release('/assets', { items: [{ id: 'asset-a', serialNumber: 'SN-ACME-1' }] });

    expect(await inFlight, 'a response from the discarded generation was accepted').toBeInstanceOf(
      StaleGenerationError,
    );
    expect(cacheJson(queryClient)).not.toContain('SN-ACME-1');
    // The subtree remounts even though the tenant id is unchanged.
    expect(session.mountKey()).not.toBe(mountBefore);
  });

  it('the remount key changes, so the tenant subtree is rebuilt rather than reused', async () => {
    const before = session.mountKey();
    server.canned('/auth/switch', BETA);
    await session.switchTo('beta');
    expect(session.mountKey()).not.toBe(before);
    expect(session.mountKey().startsWith('beta#')).toBe(true);
  });

  it('LOGOUT then a different person logging in leaves nothing of the first', async () => {
    await seedAcme();
    expect(cacheJson(queryClient)).toContain('SN-ACME-1');

    server.canned('/auth/logout', undefined);
    await session.logout();
    expect(cacheJson(queryClient)).not.toContain('SN-ACME-1');
    expect(session.identity()).toBeUndefined();

    server.canned('/auth/login', OTHER_PERSON);
    await session.login({ email: 'other@globex.test', password: 'x'.repeat(12) });

    const cache = cacheJson(queryClient);
    expect(cache).not.toContain('acme');
    expect(cache).not.toContain('m@acme.test');
    expect(session.activeTenantId()).toBe('globex');
  });

  /**
   * Both reset codes arrive the same way: a 403 envelope on a tenant-scoped read.
   *
   * `staleTime: 0` is required, not cosmetic: the seeded Acme list lives under this
   * exact key, and with the suite's default `staleTime: Infinity` the fetch would
   * be served from cache and never reach the fake server — the refusal under test
   * would never happen, and the test would assert against seeded data.
   */
  async function refusedRead(code: string, message: string): Promise<unknown> {
    server.canned('/assets', { error: { code, message } }, 403);
    return queryClient
      .fetchQuery({
        ...session.tenantQuery(['assets', 'list'], async () =>
          createApiClient(server.fetchImpl).request({ path: '/assets' }),
        ),
        staleTime: 0,
      })
      .catch((error: unknown) => error);
  }

  it('a MEMBERSHIP_REVOKED response resets the cache the same way', async () => {
    await seedAcme();
    const revoked = await refusedRead('MEMBERSHIP_REVOKED', 'You no longer have access.');
    expect((revoked as { code?: string }).code).toBe('MEMBERSHIP_REVOKED');

    // The server clears the session's active tenant on that branch, so the
    // identity re-read is the no-workspace state.
    server.canned('/auth/me', { ...ACME, activeWorkspace: null });
    expect(await session.handleApiError(revoked)).toBe(true);

    const cache = cacheJson(queryClient);
    expect(cache).not.toContain('SN-ACME-1');
    expect(cache).not.toContain('audit-a');
    expect(session.activeTenantId()).toBeNull();
  });

  it('NO_ACTIVE_WORKSPACE resets too, and the durable 403 is never retried into a success', async () => {
    await seedAcme();
    const refused = await refusedRead('NO_ACTIVE_WORKSPACE', 'Choose a workspace to continue.');
    expect((refused as { code?: string }).code).toBe('NO_ACTIVE_WORKSPACE');

    // The 403 is DURABLE server-side: retrying returns it again, never a 200 with
    // an empty page. The client must not retry it at all — `retry: false` here
    // mirrors the QueryCache policy the providers install.
    const requestsBefore = server.requests.filter((p) => p === '/assets').length;
    expect(requestsBefore, 'one attempt, no retries').toBe(1);

    server.canned('/auth/me', { ...ACME, activeWorkspace: null });
    expect(await session.handleApiError(refused)).toBe(true);
    expect(session.activeTenantId()).toBeNull();
    expect(cacheJson(queryClient)).not.toContain('SN-ACME-1');
  });

  /**
   * ================= ROLE CORRECTION IS NOT A RESET =======================
   *
   * Added at the admin user-management slice. `FORBIDDEN_ROLE` is a 403 like the
   * two reset codes above and sits one line away from them in the same handler,
   * which is exactly why it needs a test that pins the DIFFERENCE rather than a
   * comment saying there is one.
   *
   * The two reset codes mean "you have no workspace": every tenant-scoped row is
   * now unreadable, so all of it goes. `FORBIDDEN_ROLE` means "your ROLE is not
   * what you thought" — the workspace is intact, the member list is still
   * readable by every member by decision (ADR-006 §3), and the only stale value
   * is `activeWorkspace.role`. Resetting would clear rows the caller is still
   * entitled to see and remount the shell around them.
   *
   * THE ASSERTION THAT MATTERS IS THE SURVIVAL ONE. "Identity was re-read" would
   * pass just as happily for a full reset, since a reset re-reads identity too.
   * What separates the two is whether the tenant cache is STILL THERE
   * afterwards — and whether the generation moved, because that is what remounts
   * the subtree.
   */
  it('FORBIDDEN_ROLE re-reads identity and leaves the tenant cache INTACT', async () => {
    await seedAcme();
    const before = tenantCacheJson(queryClient);
    expect(before, 'the fixture must be real, or the survival assertion is vacuous').toContain(
      'SN-ACME-1',
    );
    const generationBefore = session.generation;

    const refused = await refusedRead('FORBIDDEN_ROLE', 'You may not perform this action.');
    expect((refused as { code?: string }).code).toBe('FORBIDDEN_ROLE');

    // The demotion the 403 is reporting: admin -> technician, SAME workspace.
    const demoted: Identity = {
      ...ACME,
      activeWorkspace: { tenantId: 'acme', name: 'Acme', role: 'technician' },
    };
    server.canned('/auth/me', demoted);

    expect(await session.handleApiError(refused), 'the handler must claim this error').toBe(true);

    // (1) identity corrected — the admin section unmounts off the back of this.
    expect(session.identity()?.activeWorkspace?.role).toBe('technician');

    // (2) THE WORKSPACE IS STILL THERE. A reset would have nulled it.
    expect(session.activeTenantId()).toBe('acme');

    // (3) the tenant cache SURVIVED, byte for byte.
    expect(
      tenantCacheJson(queryClient),
      'a role correction must not discard rows the caller may still read',
    ).toBe(before);

    // (4) and the subtree is NOT remounted — no generation bump, so a half-typed
    // invite or a scroll position is not thrown away for a role change.
    expect(session.generation, 'role correction must not bump the generation').toBe(
      generationBefore,
    );
  });

  it("NOT_ADMIN — the definer body's own 403 — is treated the same way", async () => {
    // The two layers answer with DIFFERENT codes on purpose (the step-5 lesson:
    // two layers answering identically are two you cannot tell apart when one
    // breaks). From the client's side they mean the same thing, so both take the
    // role-correction path — but only because that is written down, not assumed.
    await seedAcme();
    const before = tenantCacheJson(queryClient);

    const refused = await refusedRead('NOT_ADMIN', 'You do not have permission.');
    server.canned('/auth/me', {
      ...ACME,
      activeWorkspace: { tenantId: 'acme', name: 'Acme', role: 'technician' },
    });

    expect(await session.handleApiError(refused)).toBe(true);
    expect(session.activeTenantId()).toBe('acme');
    expect(tenantCacheJson(queryClient)).toBe(before);
  });

  it('the CONTRAST — a reset code on the same fixture wipes what FORBIDDEN_ROLE kept', async () => {
    // The discriminating test. Without this, the three assertions above could be
    // satisfied by a handler that never resets for anything, and the reset path
    // would be silently dead. Same seed, same handler, opposite outcome.
    await seedAcme();
    expect(tenantCacheJson(queryClient)).toContain('SN-ACME-1');

    const refused = await refusedRead('NO_ACTIVE_WORKSPACE', 'Choose a workspace.');
    server.canned('/auth/me', { ...ACME, activeWorkspace: null });
    expect(await session.handleApiError(refused)).toBe(true);

    expect(tenantCacheJson(queryClient)).not.toContain('SN-ACME-1');
    expect(session.activeTenantId()).toBeNull();
  });

  it('an unrelated error is claimed by neither branch', async () => {
    // The handler must return false for anything it does not own, or a plain
    // 500 would silently trigger cache surgery.
    await seedAcme();
    const before = tenantCacheJson(queryClient);
    const refused = await refusedRead('INTERNAL_ERROR', 'Something went wrong.');

    expect(await session.handleApiError(refused)).toBe(false);
    expect(tenantCacheJson(queryClient)).toBe(before);
    expect(session.activeTenantId()).toBe('acme');
  });

  it('the revoked two-step on bootstrap retries exactly once and does not loop', async () => {
    const fresh = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const freshServer = fakeServer();
    const freshSession = createWorkspaceSession({
      queryClient: fresh,
      api: createApiClient(freshServer.fetchImpl),
    });

    let call = 0;
    freshServer.canned('/auth/me', undefined);
    const api = createApiClient((input, init) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({
              error: { code: 'MEMBERSHIP_REVOKED', message: 'You no longer have access.' },
            }),
        } as unknown as Response);
      }
      return freshServer.fetchImpl(input, init);
    });
    const twoStep = createWorkspaceSession({ queryClient: fresh, api });
    freshServer.canned('/auth/me', { ...ACME, activeWorkspace: null });

    const identity = await twoStep.bootstrap();
    expect(call, 'bootstrap must call /auth/me exactly twice — one retry, no loop').toBe(2);
    expect(identity?.activeWorkspace).toBeNull();
    expect(identity?.workspaces.length).toBeGreaterThan(0);
    void freshSession;
  });
});
