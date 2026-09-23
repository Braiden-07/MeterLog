import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';

/**
 * CONDITION (b′) — STRIP THE URL FRAGMENT FROM EVERYTHING THE BROWSER REPORTS.
 *
 * ================ THIS IS A CREDENTIAL LEAK, NOT A HARDENING GAP ===========
 *
 * The invite token travels in a URL FRAGMENT — `/set-password#token=…` — and
 * that is a deliberate containment boundary, not a URL-style preference.
 * `ISOLATION.md` §9 states what it buys: a fragment is stripped by the browser
 * before the request leaves, so the credential stays out of server access logs,
 * out of the `Referer` header, and out of proxy and CDN history. The server
 * stores only a SHA-256 of the token, so the link is the one place the
 * plaintext exists at all.
 *
 * **A browser error reporter is the first thing in this build that reads
 * `window.location` and ships it somewhere.** Sentry's browser SDK puts the
 * current URL on `event.request.url` and records navigation breadcrumbs — and
 * `window.location` is the one place the fragment IS present. Installing
 * `@sentry/nextjs` without this would take a live credential out of the one
 * channel that was carefully kept clean and put it into a third-party store
 * with a different audience and a different retention policy. That is the exact
 * escalation ADR-011 refused for the audit trail, through a new door.
 *
 * ============== THE BREADCRUMB IS THE SHARPER LEAK OF THE TWO ==============
 *
 * `set-password/page.tsx` clears the fragment in a `useEffect` —
 * `window.history.replaceState(null, '', window.location.pathname)` — so the
 * credential is only in the address bar for the moment between hydration and
 * that effect, and an `event.request.url` leak needs an error inside that
 * window.
 *
 * **The `replaceState` call itself generates a navigation breadcrumb whose
 * `from` is the pre-clear URL.** Sentry's history integration records it, and
 * breadcrumbs are retained and attached to the NEXT event — any event, minutes
 * later, long after the address bar looks clean. So the containment mechanism
 * becomes the leak vector, and the leak outlives the window it was supposed to
 * close. `beforeBreadcrumb` is therefore not the lesser half of this pair.
 *
 * ================== WHY STRIP RATHER THAN ALLOW-LIST ROUTES ================
 *
 * This drops the fragment from EVERY url, not just `/set-password`. A rule that
 * names the one route known to carry a credential has to be updated by whoever
 * next puts something in a fragment, and they will not know this file exists.
 * Nothing in this application needs a fragment in an error report, so the safe
 * default costs nothing and cannot be forgotten.
 *
 * Both functions are pure and exported so the negatives in
 * `sentry-scrub.spec.ts` can prove them with no live Sentry: a test that needed
 * a real DSN is a test nobody runs.
 */

/** Everything from the first `#` onward, gone. Also drops the query string. */
export function stripSensitiveUrl(url: string): string {
  return url.split('#')[0]!.split('?')[0]!;
}

/** Recognises a value as a URL-ish string worth stripping. */
function isUrlString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `beforeSend` — the event itself.
 *
 * Covers `request.url` and the breadcrumbs already attached to the event, so an
 * event assembled before this ran cannot carry one through.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  // Condition (a), enforced rather than configured: `sendDefaultPii` was
  // REMOVED from the options type in v11, so the only durable way to keep the
  // caller's IP and the host name out of an event is to delete them on the way
  // past. A dependency bump cannot undo this; it could have undone a flag.
  if (event.user) delete event.user.ip_address;
  delete event.server_name;

  if (event.request && isUrlString(event.request.url)) {
    event.request.url = stripSensitiveUrl(event.request.url);
  }
  delete event.request?.query_string;

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb).filter((b): b is Breadcrumb => !!b);
  }

  return event;
}

/**
 * `beforeBreadcrumb` — every crumb, as it is recorded.
 *
 * The navigation crumb carries `data.from` and `data.to`; fetch and xhr crumbs
 * carry `data.url`. All three are stripped, and the crumb's `message` is too,
 * because the SDK writes the URL into it for some categories.
 */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const data = crumb.data;
  if (data) {
    for (const key of ['from', 'to', 'url'] as const) {
      const value = data[key];
      if (isUrlString(value)) data[key] = stripSensitiveUrl(value);
    }
  }

  if (isUrlString(crumb.message) && crumb.message.includes('#')) {
    crumb.message = stripSensitiveUrl(crumb.message);
  }

  return crumb;
}
