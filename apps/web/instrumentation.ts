/**
 * Next's server-side instrumentation hook. Loads the Sentry server config once
 * per runtime, before anything else in the process.
 *
 * `NEXT_RUNTIME` is checked because Next builds a separate edge bundle and the
 * Node SDK cannot load there; this app has no edge runtime today, so the check
 * is what keeps that true rather than something to maintain.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
}
