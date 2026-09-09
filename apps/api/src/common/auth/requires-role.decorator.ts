import { SetMetadata } from '@nestjs/common';

export const REQUIRES_ROLE = 'meterlog:requiresRole';

/**
 * Marks a route as needing one of the given roles in the ACTIVE workspace. The
 * tenant-context interceptor reads this and returns 403 when the caller's
 * re-verified role is not among them.
 *
 * **Why metadata rather than a `CanActivate` guard — this is the same defect,
 * one layer up, and it has already been paid for once.** Nest runs guards
 * BEFORE interceptors. A role guard therefore executes before the interceptor
 * has opened the transaction, set the GUCs, or re-read the membership — so the
 * role it wants to check does not exist yet. The guard written the obvious way
 * does not fail open; it fails *wrong*: `RequestContext` throws for a request
 * that has no context, which the exception filter turns into a **500 on every
 * gated route**. That is exactly the Phase 4 shape, where a session guard 401'd
 * every request including authenticated ones, and it was observed rather than
 * reasoned about.
 *
 * **Measured, not reasoned about.** A `CanActivate` guard reading
 * `requireRequestContext().role` was written and wired to `POST /users` at the
 * Phase 2 gate, and the acceptance suite went red on the **admin's** invite —
 * `expected 201, got 500` — before any non-admin case was even reached. That is
 * the sharper version of the point: the guard does not merely mis-handle
 * non-admins, it 500s **every** request, because at guard time no request has a
 * context yet, whoever is calling. The probe was reverted; this comment is what
 * it left behind.
 *
 * The alternative — have the guard resolve the session and membership itself —
 * means a second Redis round-trip and a second database read per request, and
 * two places that decide what an admin is. Two answers to that question is one
 * too many when the whole point of ADR-006 §4 is that the role comes from a
 * single per-request re-verification.
 *
 * So the declaration lives here, at the route, and the single enforcement point
 * stays inside the interceptor that already resolved the role — after step (4),
 * where `RequestContext.role` is populated from the live database read rather
 * than from the session, which can be stale.
 *
 * **This decorator implies `@RequiresSession()`.** A route that requires a role
 * cannot be served without identity, and the interceptor treats the two the same
 * way for the no-session case, so forgetting to write both cannot silently leave
 * a gated route reachable anonymously.
 *
 * The role checked is the one for the ACTIVE workspace, so the same person is an
 * admin here and a technician there — role follows the membership, not the human
 * (ADR-006 §7).
 */
export const RequiresRole = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_ROLE, roles);
