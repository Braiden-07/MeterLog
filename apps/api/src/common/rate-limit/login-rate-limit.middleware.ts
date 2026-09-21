import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { LoginRateLimitService } from './login-rate-limit.service';

/**
 * The status a failed credential check answers with. The login route is exempt
 * from the workspace gate and carries no `@RequiresSession()`, so the ONLY 401
 * `POST /auth/login` can produce is `INVALID_CREDENTIALS` from `AuthService`.
 * That makes the status a sufficient signal and keeps this middleware from
 * having to parse a response body it did not write.
 */
const FAILED_LOGIN_STATUS = 401;

/**
 * Pulls the email out of an already-parsed JSON body, or null when there is
 * nothing trustworthy to key on.
 *
 * ================= THE ABSENT-BODY CASE, MEASURED NOT ASSUMED ===============
 *
 * This is where the cross-site posture PR (1a) and this one meet. 1a's floor is
 * `bodyParser: false` + `json()` and nothing else, so a form-encoded POST to
 * `/auth/login` is deliberately left UNPARSED: the DTO refuses it and the caller
 * gets an ordinary 400 (see bootstrap.ts). That is the whole login-CSRF
 * mitigation, and this middleware — which derives its key from the body — must
 * not turn that deliberate 400 into a 500.
 *
 * THE OBVIOUS FEAR IS NOT WHAT HAPPENS, and it was worth checking rather than
 * writing a guard against a hazard that does not exist. `req.body` is NOT
 * undefined on that request: body-parser sets `req.body = req.body || {}` at
 * `lib/types/json.js:108`, BEFORE the `hasBody` and `shouldParse` skip branches.
 * So a form-encoded POST arrives with `req.body === {}`, and a naive
 * `req.body.email` reads `undefined` rather than throwing. Verified by removing
 * the object check below and re-running the cross-PR test: it still passed.
 *
 * SO WHY KEEP THE CHECK. Because that line is a body-parser INTERNAL, not a
 * contract of Express, Nest, or anything this repo controls — body-parser 2.x
 * and Express 5 restructure exactly this path. One `typeof` keeps the
 * middleware's correctness from resting on a dependency's implementation detail,
 * and the cost is a line. It is defence in depth, and is described as that
 * rather than as a live fix, because a comment claiming to prevent a 500 that
 * cannot currently happen is the kind of thing a later reader deletes — or
 * worse, trusts.
 *
 * The half that IS doing the work today is the `typeof email !== 'string'`
 * check: `{}` has no email, so the request is skipped and falls through to
 * validation. Not charging an unparseable request is correct on its own terms —
 * no account is being guessed at, so there is nothing to bill.
 */
function emailFromBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const email = (body as Record<string, unknown>).email;
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * PER-EMAIL LOGIN RATE LIMITING (OPEN-16) — the Express half.
 *
 * Mounted in `configureApp` AFTER `app.use(json())`, because the key is derived
 * from the parsed body. That ordering is a requirement, not a preference, and it
 * is why this is middleware rather than a Nest guard: it must sit downstream of
 * the parser and upstream of everything else.
 *
 * `resolve` is called PER REQUEST rather than once at mount time. The acceptance
 * specs call `configureApp(app)` BEFORE `await app.init()`, so a provider looked
 * up while wiring would be resolved against a container that has not
 * instantiated anything yet. Deferring the lookup into the request path means it
 * happens long after init, in production and in every spec alike.
 *
 * ================== IT OWNS ITS OWN ERROR ENVELOPE ==========================
 *
 * This runs in Express, UPSTREAM of Nest — so `HttpExceptionFilter`, which
 * normalises every other error to `{ error: { code, message } }`, never sees the
 * 429. Throwing here would produce Express's default HTML error page, not the
 * project envelope. The refusal is therefore written out by hand, in the shape
 * the filter would have produced, so a client needs exactly one parser for every
 * error this API can return. (`codeFor()` gained a `TOO_MANY_REQUESTS` case in
 * the same change, so a future 429 raised from INSIDE Nest lands on
 * `RATE_LIMITED` too instead of the default `ERROR`.)
 */
export function loginRateLimitMiddleware(resolve: () => LoginRateLimitService): RequestHandler {
  return function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'POST') {
      next();
      return;
    }

    const email = emailFromBody(req.body);
    if (email === null) {
      next();
      return;
    }

    const key = LoginRateLimitService.keyFor(email);
    const limiter = resolve();

    limiter
      .check(key)
      .then(({ limited, retryAfterSeconds }) => {
        if (limited) {
          res
            .status(429)
            .setHeader('Retry-After', String(retryAfterSeconds))
            .json({
              error: {
                code: 'RATE_LIMITED',
                message: 'Too many attempts. Try again shortly.',
              },
            });
          return;
        }

        chargeFailureBeforeResponding(res, limiter, key);
        next();
      })
      .catch(next);
  };
}

/**
 * Records the failure BEFORE the caller is told the attempt failed, by holding
 * the response open for the one Redis round trip.
 *
 * The obvious implementation is `res.on('finish')`, and it is subtly wrong: the
 * counter would then be written AFTER the client already has the answer, so a
 * caller that pipelines its next attempt can race ahead of its own charge. The
 * budget would drift under exactly the load it exists to refuse. Deferring the
 * real `end` until the `INCR` resolves makes the charge durable before the
 * attempt is acknowledged, which is also what lets the acceptance specs count
 * attempts deterministically instead of sleeping.
 *
 * A Redis failure must not strand the response, so the original `end` runs on
 * the rejection path too — the attempt goes uncharged, which is the right way to
 * fail: a broken limiter must not break logging in.
 */
function chargeFailureBeforeResponding(
  res: Response,
  limiter: LoginRateLimitService,
  key: string,
): void {
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;

  res.end = function patchedEnd(this: Response, ...args: unknown[]): Response {
    // Restore first: `end` must never be patched twice, and the deferred call
    // below goes through the original rather than back through this wrapper.
    res.end = originalEnd as Response['end'];

    if (res.statusCode !== FAILED_LOGIN_STATUS) return originalEnd(...args);

    void limiter.recordFailure(key).then(
      () => void originalEnd(...args),
      () => void originalEnd(...args),
    );
    return res;
  } as Response['end'];
}
