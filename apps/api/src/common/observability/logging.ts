import type { Params } from 'nestjs-pino';

import { REDACTED_BODY_FIELDS, REDACTED_HEADERS } from './redaction';

/**
 * PINO — the API's structured logging, and the first logging this build has had.
 *
 * `nestjs-pino` and `pino-http` have been in `package.json` since the scaffold
 * and imported by nothing; there is no `console.*` or Nest `Logger` call in
 * `apps/api/src` either, so this replaces nothing. It is added, not swapped.
 *
 * ================ IT DOES NOT TOUCH THE REQUEST-PIPELINE FLOOR ==============
 *
 * `LoggerModule.forRoot(LOGGER_OPTIONS)` is imported by `AppModule`, so its
 * middleware is registered by Nest during `app.init()`. `configureApp` mounts
 * helmet, the JSON parser and the login rate limiter with `app.use(...)` BEFORE
 * `init()`, so all three still run first and none of them is altered. The
 * acceptance suite keeps pinning exactly the pipeline it pinned before.
 *
 * THE CONSEQUENCE OF THAT ORDERING, STATED RATHER THAN DISCOVERED: the login
 * rate limiter short-circuits a 429 upstream of Nest entirely, so `pino-http`
 * never runs for a rate-limited request and there is NO request log for one.
 * Those 429s are the most interesting events the API produces. The limiter
 * therefore writes its own structured line, in the same place and for the same
 * reason it writes its own error envelope — ARCHITECTURE §12 already records
 * that asymmetry for errors, and this is the logging half of it. The fix is
 * NOT to move `pino-http` ahead of helmet: that would put logging inside the
 * security floor the acceptance specs pin.
 */
export const LOGGER_OPTIONS: Params = {
  pinoHttp: {
    level: resolveLevel(),

    // ================= THE SAME LIST THE SCRUBBER USES =====================
    //
    // Built from the exported constants rather than retyped, so pino and
    // Sentry cannot drift apart. ADR-011's rule: redaction is enforced by the
    // mechanism, not documented.
    //
    // `censor` replaces rather than removes, so a reader can tell "this field
    // was withheld" from "this field was absent" — which is the difference
    // between a redaction working and a redaction never having run.
    redact: {
      paths: [
        ...REDACTED_HEADERS.map((h) => `req.headers["${h}"]`),
        ...REDACTED_HEADERS.map((h) => `res.headers["${h}"]`),
        // `set-cookie` is not a request header and is not in the shared list
        // for that reason, but a response carrying a fresh session cookie is
        // exactly as dangerous as a request carrying an old one.
        'res.headers["set-cookie"]',
        ...REDACTED_BODY_FIELDS.map((f) => `req.body.${f}`),
        ...REDACTED_BODY_FIELDS.map((f) => `*.${f}`),
      ],
      censor: '[redacted]',
    },

    // ==================== THE HEALTH ROUTES ARE EXCLUDED ===================
    //
    // An uptime monitor polls forever on a fixed interval. At one line per
    // probe these two routes would be the largest thing in the log and would
    // carry no information at all — and a log nobody can read is a log nobody
    // reads. Errors still surface: `autoLogging.ignore` suppresses the routine
    // request line, not a thrown exception.
    autoLogging: {
      ignore: (req) => (req.url ?? '').startsWith('/api/v1/health'),
    },

    // Pretty locally, JSON everywhere else. Production log collectors parse
    // JSON; a human at a terminal does not.
    transport:
      process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  },
};

/**
 * The level, and `LOG_LEVEL` is finally read by something.
 *
 * It has been in `.env.example` since the scaffold and read by NO code — the
 * same dead-variable shape the deploy-config PR repaired for
 * `NEXT_PUBLIC_API_URL`, left standing because this is the PR that gives it a
 * consumer.
 *
 * ============ TEST BEATS `LOG_LEVEL`, AND THE ORDER IS MEASURED ============
 *
 * The obvious order — explicit `LOG_LEVEL` first, then a per-environment
 * default — is wrong here, and only wrong locally, which is the kind that
 * survives review. Vitest pins `NODE_ENV=test` before anything runs (confirmed
 * by probe), but `loadEnv` in `test/db/helpers.ts` then reads the repo's `.env`
 * and copies in every key NOT already set — and `.env` carries
 * `LOG_LEVEL=debug`. So an explicit-wins order silences the suite in CI, where
 * no `.env` exists, and leaves it noisy on every developer machine: a request
 * log line per HTTP call across the whole acceptance suite, burying the one
 * assertion message a reader is looking for.
 *
 * `NODE_ENV === 'test'` therefore wins outright. A developer who wants logs
 * from a test run has a real need, and the honest way to serve it is a
 * deliberate edit here rather than an ambient variable that changes the suite's
 * behaviour depending on whether a file exists.
 */
function resolveLevel(): string {
  if (process.env.NODE_ENV === 'test') return 'silent';

  const explicit = process.env.LOG_LEVEL;
  if (explicit) return explicit;

  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}
