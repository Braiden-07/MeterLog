'use client';

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, createApiClient } from './api';
import { createResetChannel } from './broadcast';
import {
  StaleGenerationError,
  WorkspaceSession,
  createWorkspaceSession,
  type Identity,
} from './workspace-session';

const SessionContext = createContext<WorkspaceSession | null>(null);

export function useSession(): WorkspaceSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside <SessionProvider>');
  return session;
}

/**
 * Re-renders on every reset, and returns the identity plus the remount key.
 *
 * The remount key is what the tenant subtree is keyed by, so a reset rebuilds it
 * instead of letting components keep state that was derived from the old cache.
 */
export function useWorkspaceState(): {
  session: WorkspaceSession;
  identity: Identity | undefined;
  mountKey: string;
} {
  const session = useSession();
  const [, force] = useState(0);
  useEffect(() => session.subscribe(() => force((n) => n + 1)), [session]);
  return { session, identity: session.identity(), mountKey: session.mountKey() };
}

/**
 * THE GLOBAL ERROR POLICY, and the retry rule is the load-bearing half.
 *
 * `NO_ACTIVE_WORKSPACE` is a DURABLE 403: the server returns it again on every
 * attempt and never degrades into a 200 with an empty page. TanStack Query's
 * default is three retries, which would spend three round trips learning the same
 * thing — so a 403 is never retried at all. Both reset codes then discard the
 * cache and send the app back to the picker.
 */
function createClient(sessionRef: { current: WorkspaceSession | null }): QueryClient {
  const queryCache = new QueryCache({
    onError: (error) => {
      if (error instanceof StaleGenerationError) return; // expected, not a failure
      void sessionRef.current?.handleApiError(error);
    },
  });

  return new QueryClient({
    queryCache,
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          if (error instanceof StaleGenerationError) return false;
          return failureCount < 2;
        },
        staleTime: 30_000,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const sessionRef = useRef<WorkspaceSession | null>(null);

  const { queryClient, session } = useMemo(() => {
    const client = createClient(sessionRef);
    const created = createWorkspaceSession({
      queryClient: client,
      api: createApiClient((input, init) => fetch(input, init)),
      channel: createResetChannel() ?? undefined,
    });
    sessionRef.current = created;
    return { queryClient: client, session: created };
  }, []);

  useEffect(() => () => session.dispose(), [session]);

  return (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
    </QueryClientProvider>
  );
}
