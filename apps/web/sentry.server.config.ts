import * as Sentry from '@sentry/nextjs';

import { scrubBreadcrumb, scrubEvent } from './lib/sentry-scrub';

/**
 * SENTRY — the Next SERVER runtime (SSR, route handlers, the rewrite proxy).
 *
 * Distinct from the API's own Sentry setup: this process is the web origin, not
 * the NestJS API, and the two report different faults. The same scrubbers are
 * applied because a fragment cannot reach this process but a URL assembled here
 * can still carry a query string, and one list is easier to keep honest than
 * two that are almost the same.
 *
 * Server-side, so the DSN is the private `SENTRY_DSN`, not the public one.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
