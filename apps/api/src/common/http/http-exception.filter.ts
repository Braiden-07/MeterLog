import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import type { Response } from 'express';

/**
 * Normalises every error to the project's envelope: `{ error: { code, message, details? } }`
 * (CLAUDE.md conventions).
 *
 * Without this, `ValidationPipe` rejections and framework 404s would each ship
 * their own shape, so a client would need three parsers for one API. Handlers
 * that already throw the envelope (the tenant-context interceptor does) are
 * passed through unchanged rather than double-wrapped.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    reportIfServerFault(exception);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // Already enveloped (the interceptor's 403, and anything else that opts in).
      //
      // The check must look at the SHAPE of `error`, not merely its presence.
      // Nest's own BadRequestException body is
      // `{ statusCode, message: [...], error: 'Bad Request' }` — it has an
      // `error` key whose value is a plain string, so a presence-only check
      // waves it straight through and ValidationPipe failures ship Nest's shape
      // instead of the project envelope. Caught by the validation acceptance test.
      if (isEnveloped(body)) {
        response.status(status).json(body);
        return;
      }

      const asRecord =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const message =
        typeof body === 'string' ? body : String(asRecord.message ?? exception.message);
      response.status(status).json({
        error: {
          code: codeFor(status),
          message,
          ...(Array.isArray(asRecord.message) ? { details: asRecord.message } : {}),
        },
      });
      return;
    }

    // Never leak an internal error's shape or stack to the client.
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    });
  }
}

/** True only for `{ error: { code, message } }`, not for anything with an `error` key. */
function isEnveloped(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const inner = (body as { error: unknown }).error;
  return typeof inner === 'object' && inner !== null && 'code' in inner;
}

function codeFor(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_FAILED';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      // The login limiter (OPEN-16) writes its own envelope, because it runs in
      // Express UPSTREAM of this filter and is never seen by it. This case is
      // for the other direction: a 429 raised from INSIDE Nest — by a future
      // limiter, or by anything that throws `TooManyRequestsException` — would
      // otherwise fall through to the meaningless default and ship as `ERROR`,
      // so the same status could reach a client under two different codes.
      return 'RATE_LIMITED';
    default:
      return 'ERROR';
  }
}

/**
 * SENTRY CAPTURE — here, and 5xx ONLY.
 *
 * ================= WHY IN THIS FILTER AND NOT `SentryGlobalFilter` ==========
 *
 * `@sentry/nestjs` ships its own global exception filter, and installing it
 * would put two filters in contention for the thing this one exists to
 * guarantee: that EVERY error leaves as `{ error: { code, message } }`. That
 * envelope is not a convention here, it is asserted — the validation acceptance
 * test caught Nest's own `BadRequestException` shape slipping through a
 * presence-only check once already. So reporting is added INSIDE the filter
 * that owns the envelope rather than beside a second one that would also like
 * to own it.
 *
 * ========================= WHY 5xx ONLY =====================================
 *
 * Every 4xx this API raises is a DESIGNED refusal with a test behind it: 401
 * `UNAUTHENTICATED`, 403 `FORBIDDEN_ROLE` / `NO_ACTIVE_WORKSPACE`, 409
 * `TENANT_MISMATCH`, 429 `RATE_LIMITED`. Reporting them would fill the project
 * with events that mean "the system worked", and a dashboard where the signal
 * is 1% of the volume is a dashboard nobody reads — which is how a real 500
 * goes unnoticed.
 *
 * It also narrows the credential surface as a side effect worth naming: the
 * 4xx on `/auth/login` is the failed-login response, and a failed login is the
 * request whose body is a password. Not reporting it means the commonest
 * credential-bearing error never reaches the reporter at all, with `beforeSend`
 * as the floor underneath rather than the only line of defence.
 *
 * A no-op when Sentry was never initialised — `captureException` on an
 * unconfigured client does nothing, so this costs a function call in CI.
 */
function reportIfServerFault(exception: unknown): void {
  const status =
    exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

  if (status < HttpStatus.INTERNAL_SERVER_ERROR) return;

  Sentry.captureException(exception);
}
