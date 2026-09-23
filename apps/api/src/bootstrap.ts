import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import helmet from 'helmet';

import { loginRateLimitMiddleware } from './common/rate-limit/login-rate-limit.middleware';
import { LoginRateLimitService } from './common/rate-limit/login-rate-limit.service';

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
 * The URL prefix every route is served under. Named rather than repeated because
 * the login rate limiter below mounts on a RAW EXPRESS path, which
 * `setGlobalPrefix` does not apply to — so the two must be kept in step by
 * construction instead of by memory.
 */
const GLOBAL_PREFIX = 'api/v1';

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
 * suite time or noise — `listen`, log buffering, and the Swagger document.
 * Generating the OpenAPI document scans every controller, and paying that on
 * every acceptance spec's app init would buy the suite nothing.
 *
 * THE SWAGGER DOCUMENT IS STILL OUT OF THIS FUNCTION, BUT IT IS NO LONGER INSIDE
 * `main.ts` EITHER — it is `mountOpenApi` below, which `main.ts` calls and so
 * does the one spec that asserts `/api/v1/docs` is PUBLICLY reachable
 * (`test/api/openapi-docs.spec.ts`). Moved there at the deploy-config PR for the
 * reason this whole file exists: that spec's claim is about what production
 * serves to an anonymous visitor, so it has to call production's mount rather
 * than stand up a copy and assert against that. A spec that needs the document's
 * CONTENT still builds its own (`pending-split.spec.ts` does), which is the
 * correct scope for that and costs the rest of the suite nothing.
 *
 * ALSO OUT, DELIBERATELY: `test/api/route-inventory.spec.ts` does not call this
 * and must not. It issues no HTTP request at all — it reads the router and
 * compares it to `ARCHITECTURE.md` §9 — and it omits the global prefix ON
 * PURPOSE, because §9's rows are controller-relative. Applying the prefix there
 * would prefix every registered path and break the matrix comparison. It is not
 * a hand-mirror that drifted; it is a spec that needs none of this.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(GLOBAL_PREFIX);
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
  // `CORS_ORIGIN` was removed from `.env.example` by the tenant/abuse hardening
  // PR, once nothing had read it for a whole slice.

  // =============== LOGIN RATE LIMITING — OPEN-16, PER EMAIL ==================
  //
  // AFTER `json()` AND THAT IS A REQUIREMENT: the bucket is keyed on the email in
  // the parsed body, so this cannot sit above the parser. It is also why the
  // limiter is Express middleware rather than a Nest guard — it belongs between
  // the parser and everything else.
  //
  // THE AXIS IS THE EMAIL, NOT THE IP, and the reason is empirical. OPEN-16 was
  // written expecting `X-Forwarded-For` trusted at a fixed hop count; the
  // orientation probe for this PR put the real `next.config.mjs` rewrite in front
  // of an echo origin and found Next to be a VERBATIM HEADER RELAY — it neither
  // originates XFF nor appends the peer to a chain, in dev or in a production
  // build. The only `x-forwarded-for` that ever reaches this API is one the
  // caller typed. A hop count has nothing to count, and keying on it would hand
  // every attacker a fresh bucket per request. See login-rate-limit.service.ts
  // for the probe output and for why a GLOBAL ceiling is refused rather than
  // deferred.
  //
  // Mounted on the RAW path (no `setGlobalPrefix` here), hence GLOBAL_PREFIX.
  // The service is resolved per request, not at mount time, because every
  // acceptance spec calls this function BEFORE `app.init()`.
  app.use(
    `/${GLOBAL_PREFIX}/auth/login`,
    loginRateLimitMiddleware(() => app.get(LoginRateLimitService)),
  );

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

/**
 * The version advertised on the public OpenAPI page.
 *
 * A HAND-KEPT LITERAL, and the reason it is not imported from `package.json` is
 * worth one line: `apps/api/package.json` sits outside `src`, and pulling it in
 * as a module would put a second entry under the build's root and move
 * `dist/main.js`, which `render.yaml`'s `startCommand` names by path. Not worth
 * it for a string.
 *
 * `1.0.0-rc.1` RATHER THAN `1.0.0`, DELIBERATELY. The backend is feature-complete
 * and this is the deploy-prep slice, but `PROJECT_BRIEF` §11 step 10 is NOT v1.0
 * — §12 still has open boxes that no deploy ticks (the essential frontend
 * journeys, and coverage). Advertising `1.0.0` on the first page a visitor reads
 * would be the milestone claim the repo has not earned. It replaces a `0.1.0`
 * that had been the scaffold value since step 3.
 *
 * `apps/api/package.json` and the root manifest still say `0.1.0`. Reconciling
 * the three is a RELEASE decision for step 11, not a docs decision for this PR,
 * and is recorded rather than quietly done here.
 */
export const OPENAPI_VERSION = '1.0.0-rc.1';

/**
 * Mounts the OpenAPI document and its Swagger UI at `/api/v1/docs`.
 *
 * ================ THE PAGE IS PUBLIC, AND THAT IS THE DECISION ==============
 *
 * `/api/v1/docs` is served to anyone, unauthenticated, in production. That is a
 * choice rather than an oversight, and this comment exists because the shape of
 * it — a docs UI reachable without a session — is the shape a reviewer or a
 * scanner flags on sight. WHAT MAKES IT SAFE, rather than merely intended:
 *
 *   - **The repository is public.** The document is generated from decorators in
 *     source anyone can already read. It discloses no route, DTO or status code
 *     that `apps/api/src` does not, so there is no information here that hiding
 *     the page would withhold from anyone who can use a browser.
 *   - **Every endpoint behind it is authn-gated.** The document describes the
 *     surface; it opens none of it. The exempt routes are enumerated and
 *     asserted (`WORKSPACE_EXEMPT_ROUTES`, and `test/api/route-inventory.spec.ts`
 *     holds the whole route/role matrix to `ARCHITECTURE.md` §9), so "public
 *     docs" cannot quietly come to mean "public data".
 *   - **It is a read of a generated document.** The page mutates nothing, and
 *     `SwaggerModule.setup` adds no route that writes.
 *
 * ACCEPTED, AND STATED RATHER THAN DISCOVERED: Swagger UI's "Try it out" posts
 * real requests at the live API from the visitor's browser. An anonymous visitor
 * pressing it collects 401s — they hold no session, and the same-origin proxy is
 * not in their path — so what they can actually exercise is the unauthenticated
 * surface, which is `/health`, `/auth/register`, `/auth/login` (rate-limited per
 * email) and the set-password flow. Someone who IS logged in as an admin can
 * mutate their OWN tenant from this page, which is a thing that admin could do
 * from the app regardless. The cost is that registration is reachable from a
 * button; it was already reachable from `curl`.
 *
 * NOT IN `configureApp`, and the boundary is argued there — this costs a
 * controller scan per call, and the acceptance suite has no use for it.
 */
export function mountOpenApi(app: INestApplication): void {
  const openApi = new DocumentBuilder()
    .setTitle('MeterLog API')
    .setDescription('Multi-tenant asset & utility-meter traceability')
    .setVersion(OPENAPI_VERSION)
    .build();
  SwaggerModule.setup(`${GLOBAL_PREFIX}/docs`, app, SwaggerModule.createDocument(app, openApi));
}
