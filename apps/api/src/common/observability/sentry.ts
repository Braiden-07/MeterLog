import * as Sentry from '@sentry/nestjs';

import { REDACTED_BODY_FIELDS, REDACTED_HEADERS, isCredentialBodyRoute } from './redaction';

/**
 * SENTRY, API SIDE — initialised before anything else, scrubbed before anything
 * leaves.
 *
 * ================== WHY INITIALISATION IS A SEPARATE STEP ===================
 *
 * `Sentry.init` must run before the modules it instruments are imported, which
 * is why `main.ts` calls this on its first line rather than wiring it into
 * `configureApp`. It is a process concern, like `listen` and log buffering, and
 * `bootstrap.ts` already argues that those stay out of the request-pipeline
 * floor: the acceptance suite shares that floor and must keep pinning the same
 * pipeline this PR found it with.
 *
 * ===================== IT IS OFF UNLESS CONFIGURED ==========================
 *
 * No DSN, no Sentry. That is the local and CI default and it is deliberate:
 * a test run must not depend on, or talk to, an external service, and a
 * developer must not need an account to run the app. The function returns
 * whether it armed so `main.ts` can say so once at boot rather than leaving it
 * ambiguous — a reporter that is silently off is indistinguishable from one
 * that is working and has nothing to report.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',

    // ============ CONDITION (a) IS ENFORCED, NOT CONFIGURED =================
    //
    // There is deliberately no `sendDefaultPii: false` here, and its absence is
    // the finding rather than an omission: **that option does not exist in
    // @sentry/core v11** — it is gone from the options type entirely, so setting
    // it does not typecheck and would not be read if it did.
    //
    // Leaning on a flag was the weaker plan anyway, and this is the version
    // change that proves it. A boolean's meaning is a property of the SDK
    // version; `scrubEvent` below is a property of this repository, is asserted
    // by `test/api/sentry-redaction.spec.ts`, and cannot be silently changed by
    // a dependency bump. It strips the headers, the URL secrets, the client IP
    // and the host name explicitly. ADR-011's rule, again: redaction is
    // ENFORCED by the mechanism, not documented — or configured.

    // Traces off. This is an error reporter for v1.0, not an APM: performance
    // tracing samples every request and is a separate decision with a separate
    // cost, enrolled rather than switched on by omission.
    tracesSampleRate: 0,

    beforeSend: scrubEvent,
  });

  return true;
}

/**
 * CONDITIONS (a) AND (b) — the scrub every event passes through.
 *
 * Exported and pure so it can be proven without a live Sentry: the negatives in
 * `test/api/sentry-redaction.spec.ts` call this directly with synthetic events.
 * A test that needed a real DSN would be a test nobody runs.
 *
 * ADR-011's rule governs the shape of this: redaction is ENFORCED by the
 * mechanism, not documented. The route list it keys on is the exported constant
 * pino redacts from too, so the two channels cannot come apart.
 */
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  // (a) The two PII fields the SDK attaches outside `request`. Deleted here
  // rather than switched off by an option, because the option no longer exists
  // (see `initSentry`). `ip_address` identifies the caller; `server_name` names
  // the host, which is infrastructure detail an error report does not need.
  if (event.user) delete event.user.ip_address;
  delete event.server_name;

  const request = event.request;
  if (!request) return event;

  // (a) Headers, by name. `cookie` is the session itself.
  if (request.headers) {
    for (const name of Object.keys(request.headers)) {
      if ((REDACTED_HEADERS as readonly string[]).includes(name.toLowerCase())) {
        delete request.headers[name];
      }
    }
  }

  // Never report a query string or a fragment from a URL. The API does not put
  // credentials in either today — the invite token travels in a fragment the
  // server never receives — but a URL is the one field that gets copied into
  // dashboards, tickets and screenshots, and the only version of it that is
  // safe under every future route is the path.
  if (typeof request.url === 'string') {
    request.url = request.url.split('#')[0]!.split('?')[0]!;
    delete request.query_string;
  }

  // (b) The body. Four routes drop it WHOLE — picking fields out would have to
  // be right about every field name forever, and `SetPasswordDto` already
  // carries two different secrets under two different names.
  if (request.data !== undefined) {
    const path = typeof request.url === 'string' ? request.url : '';
    request.data = isCredentialBodyRoute(path)
      ? '[redacted: credential route]'
      : redactFields(request.data);
  }

  return event;
}

/**
 * The field-level fallback, for bodies that are recorded at all.
 *
 * Belt to the route list's braces: a route carrying a `password` that nobody
 * remembered to enrol still has the field itself removed. It walks nested
 * objects because a DTO is not always flat, and it does NOT try to be clever
 * about arrays of unknown shape beyond recursing into them.
 */
function redactFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFields);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = (REDACTED_BODY_FIELDS as readonly string[]).includes(key)
      ? '[redacted]'
      : redactFields(inner);
  }
  return out;
}
