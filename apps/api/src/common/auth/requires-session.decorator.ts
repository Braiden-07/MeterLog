import { SetMetadata } from '@nestjs/common';

export const REQUIRES_SESSION = 'meterlog:requiresSession';

/**
 * Marks a route as needing an authenticated session. The tenant-context
 * interceptor reads this and returns 401 when none resolved.
 *
 * **Why metadata rather than a `CanActivate` guard.** Nest runs guards BEFORE
 * interceptors, so a guard cannot see the request context — the interceptor has
 * not established it yet. A guard written the obvious way therefore rejects
 * *every* request, authenticated or not; that was observed, not reasoned about.
 * A guard could re-read and re-verify the session itself, but that would mean
 * doing the whole Redis lookup twice per request and having two places that
 * decide what a valid session is.
 *
 * So the declaration lives here, at the route, and the single enforcement point
 * stays inside the interceptor that already resolved the session.
 */
export const RequiresSession = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_SESSION, true);
