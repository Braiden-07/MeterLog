import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
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
    default:
      return 'ERROR';
  }
}
