import * as Sentry from '@sentry/nextjs';

import { scrubBreadcrumb, scrubEvent } from './lib/sentry-scrub';

/**
 * SENTRY — BROWSER. Off unless a DSN is configured, which is the local and CI
 * default: a test run must not depend on an external service.
 *
 * The DSN is `NEXT_PUBLIC_` because a browser SDK cannot work otherwise — it is
 * compiled into the bundle by necessity. The deploy-config PR deleted a
 * `NEXT_PUBLIC_` variable and argued at length against another, so the
 * distinction is recorded in ADR-020 rather than left to look like a reversal:
 * the rule is about what an exposure ENABLES. A DSN is a public write-only
 * identifier that lets anyone send events to a project; an API origin in the
 * bundle enables a direct browser-to-API call that breaks the session cookie.
 *
 * `beforeSend` and `beforeBreadcrumb` carry condition (b′) — the fragment
 * strip. They are the only reason this file is more than three lines, and
 * `lib/sentry-scrub.ts` explains why the breadcrumb half is the sharper of the
 * two.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,

  // An error reporter for v1.0, not an APM. Tracing is a separate decision with
  // a separate cost, enrolled rather than switched on by omission.
  tracesSampleRate: 0,

  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
