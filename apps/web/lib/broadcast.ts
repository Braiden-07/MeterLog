import type { ResetChannel, ResetReason } from './workspace-session';

const CHANNEL_NAME = 'meterlog:workspace-reset';

/**
 * Cross-tab reset propagation.
 *
 * Two tabs share one session cookie, so a switch in tab 1 changes what tab 2 is
 * allowed to see. Without this, tab 2 keeps rendering the old workspace from its
 * own cache until something happens to refetch — and its next write would be
 * applied under the new active tenant. Broadcasting the reset makes the switch a
 * property of the SESSION rather than of one tab.
 *
 * Returns null where `BroadcastChannel` does not exist (server render, older
 * browsers). The session works without a channel; it simply stops propagating.
 */
export function createResetChannel(): ResetChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;

  const channel = new BroadcastChannel(CHANNEL_NAME);
  return {
    post(reason: ResetReason) {
      channel.postMessage({ reason });
    },
    subscribe(handler: (reason: ResetReason) => void) {
      const listener = (event: MessageEvent<{ reason?: ResetReason }>): void => {
        // The receiving tab treats every remote reset as 'remote', so it discards
        // its cache and re-reads identity rather than re-broadcasting — otherwise
        // two tabs would bounce the message between them forever.
        if (event.data?.reason) handler('remote');
      };
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    close() {
      channel.close();
    },
  };
}
