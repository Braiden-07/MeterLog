/**
 * THE REDACTION LIST — ONE DEFINITION, TWO CHANNELS.
 *
 * ===================== WHY ONE DEFINITION ===================================
 *
 * The observability PR opens two places a credential could leave this process
 * that did not exist before it: pino's structured logs and Sentry's error
 * reports. Both need to know the same thing — which request bodies are
 * credentials — and a list maintained twice is a list that drifts. When it
 * drifts, the failure is silent in the worst direction: the channel with the
 * stale copy keeps shipping the field nobody meant to ship, and looks healthy
 * while it does it.
 *
 * So the list is defined once and both consumers import it. There is no second
 * place to forget a route in.
 *
 * ============ WHY HERE AND NOT IN `packages/shared` — MEASURED =============
 *
 * `packages/shared` was the intended home and CANNOT be one today, for a reason
 * a typecheck does not show. It is published as TypeScript SOURCE rather than a
 * build artifact — a deliberate decision, recorded at `next.config.mjs`, which
 * works because the web app compiles it via `transpilePackages`. The API has
 * never imported it: `@meterlog/shared` is in `apps/api/package.json` and in
 * zero source files.
 *
 * Probed before relying on it, and the result is the reason this file sits here:
 * an API file importing `@meterlog/shared` PASSES `tsc --noEmit` and PASSES
 * `nest build`, and the emitted `dist` then crashes at runtime with
 * `Unexpected token 'export'` — `require('@meterlog/shared')` resolves to
 * `packages/shared/src/index.ts`, which Node cannot execute. **Green build,
 * dead container**, discovered on the deploy rather than in CI: the same shape
 * as the superuser-migrator gap and the cross-site cookie, and it would have
 * been shipped by this PR of all PRs.
 *
 * Making `packages/shared` runtime-consumable means giving it a build step,
 * which reverses that recorded decision and changes how the web app resolves it
 * too. That is a reviewed refactor, not a line on an observability PR. **Both
 * consumers of this list are in `apps/api`** — pino's `redact` and the API's
 * `beforeSend` — so nothing is lost by defining it beside them: there is still
 * exactly one definition. The web's Sentry config needs none of it, because a
 * browser event carries no API request body; what it needs is the fragment
 * strip, which is browser-only.
 *
 * ================== THE PRECEDENT THIS IS BUILT ON ==========================
 *
 * ADR-011 settled this question once already, for the audit trail: a
 * `SECURITY DEFINER` trigger reading `to_jsonb(NEW)` would have written
 * `users.password_hash` into a table more roles can read than can read the
 * source — "the audit trail would become a privilege-escalation path, and it
 * would look like a feature while it did it". Its answer was an explicit
 * per-table column ALLOWLIST carried in the mechanism, with the governing rule
 * stated as REDACTION IS ENFORCED BY THE TRIGGER, NOT DOCUMENTED.
 *
 * An error report carrying a login body is that same escalation through a second
 * channel, so it gets the same treatment: a list in the mechanism, not a note in
 * a README, and a negative test per channel proving the field is gone.
 */

/**
 * Routes whose REQUEST BODY is, in whole or in part, a credential. A log line or
 * an error report for one of these must carry no body at all.
 *
 * Dropping the whole body rather than picking fields out of it is deliberate:
 * a field-level filter has to be right about every field name, forever, and
 * `SetPasswordDto` already carries two different secrets under two different
 * names. The body of these four routes is worth nothing to a debugger and is
 * worth a great deal to whoever reads the log, so the whole thing goes.
 *
 * WHY EACH ONE IS HERE — no route is on this list by resemblance:
 *
 *   - `/auth/login`        `LoginDto` — `email`, `password`.
 *   - `/auth/register`     `RegisterDto` — `tenantName`, `email`, `password`.
 *                          **The one most easily missed.** It is a sign-up
 *                          rather than a sign-in, so it reads as a public form;
 *                          it carries a password exactly like login does.
 *   - `/auth/set-password` `SetPasswordDto` — `token` AND `password`. TWO
 *                          secrets, and the `token` is a live credential the
 *                          server stores only as a SHA-256, so the request body
 *                          holds the single plaintext copy in existence.
 *   - the invite mint      `POST /users/pending/:membershipId/token` — the
 *                          credential is in the RESPONSE, not the request. It is
 *                          listed because a channel that ever starts recording
 *                          response bodies must already know about this route;
 *                          it is the only response body in the API that is a
 *                          live credential, which is why it alone carries
 *                          `Cache-Control: no-store`.
 *
 * Paths are GLOBAL-PREFIX-RELATIVE (no `/api/v1`), matched by the helper below.
 */
export const CREDENTIAL_BODY_ROUTES = [
  '/auth/login',
  '/auth/register',
  '/auth/set-password',
  '/users/pending/:membershipId/token',
] as const;

/**
 * Header names that must never reach a log or an error report.
 *
 * `cookie` is the whole point: the session cookie IS the session. It is
 * `httpOnly` precisely so that script cannot reach it, and an error report
 * carrying it hands a live session to everyone with access to the error
 * project — a longer-lived and more widely-read store than the browser it was
 * kept out of.
 *
 * `authorization` carries nothing in this build today (the API is
 * cookie-authenticated). It is listed anyway, because the cost is one array
 * entry and the failure mode of omitting it is discovering later that a header
 * introduced after this list was written was never covered by it.
 */
export const REDACTED_HEADERS = ['cookie', 'authorization'] as const;

/**
 * Body field names redacted wherever a body IS recorded — the fallback for
 * everything not on `CREDENTIAL_BODY_ROUTES`.
 *
 * Belt to the route list's braces. The route list is exact and this is
 * defensive: a new route carrying a `password` that nobody remembered to enrol
 * above still has the field itself redacted. Neither replaces the other — this
 * one cannot save a body whose secret is under a name not listed here, which is
 * exactly why the four routes drop their bodies whole.
 */
export const REDACTED_BODY_FIELDS = ['password', 'token', 'passwordHash', 'password_hash'] as const;

/**
 * Does this path name one of the credential-body routes?
 *
 * Compared SEGMENT BY SEGMENT with `:param` matching any single segment, rather
 * than by `startsWith` or a substring test. `startsWith` would be wrong in both
 * directions: `/auth/login-history` would match `/auth/login` and be silently
 * over-redacted, while a global prefix on the incoming path would stop
 * `/auth/login` matching at all — and over-redaction hides nothing dangerous
 * while under-redaction ships a password.
 *
 * The global prefix is tolerated rather than required, so a caller may pass
 * either `/auth/login` or `/api/v1/auth/login`; a query string or fragment is
 * dropped before matching.
 */
export function isCredentialBodyRoute(path: string): boolean {
  const incoming = segments(path);
  return CREDENTIAL_BODY_ROUTES.some((route) => {
    const want = segments(route);
    // Allow the incoming path to carry a leading global prefix (`api`, `v1`).
    const start = incoming.length - want.length;
    if (start < 0) return false;
    return want.every((segment, i) => segment.startsWith(':') || segment === incoming[start + i]);
  });
}

function segments(path: string): string[] {
  const clean = path.split('#')[0]!.split('?')[0]!;
  return clean.split('/').filter((s) => s.length > 0);
}
