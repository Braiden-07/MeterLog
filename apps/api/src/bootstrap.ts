import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import helmet from 'helmet';

/**
 * Creation-time options for the Nest app, shared by production and the tests.
 *
 * `bodyParser: false` TURNS OFF NEST'S DEFAULTS SO THE PARSERS CAN BE CHOSEN
 * RATHER THAN INHERITED, and it is half of the login-CSRF floor — the other half
 * is the `json()` registered in `configureApp`. It has to be here, at creation,
 * because Nest installs its default parsers during `create()`: by the time
 * `configureApp` runs there would already be a `urlencoded()` in the stack, and
 * adding `json()` afterwards would not remove it.
 *
 * The two halves are deliberately kept adjacent in this file, and a caller that
 * uses one without the other is wrong in a way `login-csrf.spec.ts` catches:
 * omit this and the form-encoded attack is parsed again; omit the `json()` and
 * every legitimate request 400s.
 */
export const NEST_APP_OPTIONS = { bodyParser: false } as const;

/**
 * THE REQUEST-PIPELINE FLOOR — one definition, applied by production and by every
 * acceptance test.
 *
 * ===================== WHY THIS EXISTS ======================================
 *
 * Until step 9 this configuration lived in `main.ts` and was HAND-MIRRORED by
 * twelve acceptance specs, three of which said so in a comment: "Mirrors
 * main.ts, so the acceptance tests exercise the real request pipeline." The
 * mirroring was accurate for the two things it copied — the global prefix and
 * the `ValidationPipe` — and silently WRONG about everything it did not know to
 * copy, because a test app built by `createNestApplication()` inherits Nest's
 * own defaults rather than `main.ts`'s choices.
 *
 * That gap is not hypothetical and it is not cosmetic. The cross-site posture PR
 * adds a security floor at the body-parser layer, and a floor that production
 * has while the test pipeline does not is the worst of both worlds: the suite
 * would assert the mitigation works against an app that never received it — a
 * green test proving nothing, which is the failure mode this repo keeps meeting
 * and keeps writing down.
 *
 * So the floor gets ONE definition and both callers use it. A future change to
 * the pipeline cannot now be applied to production and forgotten in the tests,
 * because there is no second place to forget it in.
 *
 * ================== WHAT BELONGS HERE, AND WHAT DOES NOT ====================
 *
 * IN: everything that shapes how a REQUEST is parsed, validated or refused
 * before it reaches a handler — the prefix, the parsers, the pipes, the security
 * headers. These are the things a test must share with production for its result
 * to mean anything.
 *
 * OUT: process-level concerns that no test exercises and that would cost the
 * suite time or noise — `listen`, log buffering, and the Swagger document. They
 * stay in `main.ts`. A spec that needs the OpenAPI document builds its own
 * (`pending-split.spec.ts` does), which is the correct scope for it.
 *
 * ALSO OUT, DELIBERATELY: `test/api/route-inventory.spec.ts` does not call this
 * and must not. It issues no HTTP request at all — it reads the router and
 * compares it to `ARCHITECTURE.md` §9 — and it omits the global prefix ON
 * PURPOSE, because §9's rows are controller-relative. Applying the prefix there
 * would prefix every registered path and break the matrix comparison. It is not
 * a hand-mirror that drifted; it is a spec that needs none of this.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api/v1');
  app.use(helmet());

  // ===================== THE ANTI-LOGIN-CSRF FLOOR ==========================
  //
  // JSON AND NOTHING ELSE. Paired with `NEST_APP_OPTIONS`' `bodyParser: false`,
  // this leaves exactly one parser in the stack, and the absence of
  // `urlencoded()` is the security property — not an optimisation, and not a
  // tidy-up.
  //
  // WHAT IT CLOSES, demonstrated against this codebase before it was written
  // (`test/api/login-csrf.spec.ts`): a cross-site auto-submitting HTML form
  // POSTing `email` + `password` to `/auth/login` returned **200** and a
  // `Set-Cookie: meterlog_sid=…; Max-Age=28800`, logging the victim's browser
  // into the ATTACKER's account. Everything the victim then recorded would land
  // in the attacker's workspace. `SameSite=Lax` does not reach it: Lax governs
  // whether an EXISTING cookie is sent, and this attack sends none — it
  // establishes one.
  //
  // WHY THE PARSER IS THE RIGHT PLACE TO STOP IT. An HTML form can only send
  // `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`,
  // none of which preflight. A cross-site `fetch` carrying `application/json`
  // is NOT a simple request: it preflights, and the attacker's origin has
  // nothing allowing it. So refusing to parse form encodings removes the entire
  // no-preflight path, and what remains must pass CORS — which, after OPEN-20,
  // allows nothing cross-origin at all. One boundary, no per-route checks, and
  // no CSRF token (ADR-001 deliberately avoided one).
  //
  // A form-encoded body therefore arrives UNPARSED: `email` and `password` are
  // absent, the DTO refuses, and the caller gets the ordinary 400 that any
  // malformed request gets. The refusal is the existing `forbidNonWhitelisted`
  // shape rather than a bespoke CSRF branch, which is why it needs no new error
  // code and cannot be forgotten on a new route.
  //
  // NOTHING LEGITIMATE SENDS FORM ENCODING: the frontend's only client is
  // `apps/web/lib/api.ts`, which sets `content-type: application/json` on every
  // request with a body, and Swagger UI posts JSON. Verified, not assumed.
  app.use(json());

  // ============ NO CORS AT ALL — OPEN-20, and it is the second half ==========
  //
  // There was an `enableCors({ origin: [...], credentials: true })` here, with a
  // comment explaining that credentials are sent on every request so the origin
  // must be an allow-list. That was true when written and stopped being true at
  // slice 1 of the frontend slice: the Next rewrite made the browser talk ONLY
  // to the web origin, so nothing in the system makes a cross-origin
  // credentialed request any more. The allow-list stopped being a boundary and
  // became a leftover — one that quietly announced an origin as trusted.
  //
  // REMOVING IT IS NOT MERELY TIDYING, because of how it composes with the JSON
  // floor above. That floor removes the no-preflight path (an HTML form cannot
  // send JSON). What remains for an attacker is a cross-site `fetch` with
  // `content-type: application/json` — which MUST preflight. With no CORS
  // configuration at all, the preflight gets no `Access-Control-Allow-Origin`,
  // the browser refuses, and the request never reaches a handler.
  //
  // So the two changes in this PR close the same threat from opposite ends, and
  // neither is sufficient alone: CORS never stopped the form POST (forms are not
  // subject to it), and the JSON floor never stopped a preflighted fetch from an
  // allow-listed origin. Together there is no cross-origin path to a
  // state-changing route at all.
  //
  // `CORS_ORIGIN` remains in `.env.example` and is now read by nothing.

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // PROJECT_BRIEF §6: reject unknown fields rather than silently dropping them.
      forbidNonWhitelisted: true,
    }),
  );

  return app;
}
