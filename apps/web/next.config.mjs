/** @type {import('next').NextConfig} */

/**
 * The API origin the proxy forwards to. Server-side only — it is read inside
 * `rewrites()`, which runs on the Next server, so it is deliberately NOT a
 * `NEXT_PUBLIC_` variable: the browser must never learn the API origin, because
 * the browser must never talk to it directly.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3001';

const nextConfig = {
  reactStrictMode: true,
  // @meterlog/shared is published as TypeScript source, not a build artifact,
  // so Next must compile it rather than treat it as an opaque dependency.
  transpilePackages: ['@meterlog/shared'],

  /**
   * SAME-ORIGIN PROXY — the topology decided in ADR-001's amendment.
   *
   * The browser only ever talks to the web origin; Next forwards `/api/*` to the
   * API origin. The session cookie is therefore first-party, `SameSite=Lax` holds,
   * and no CSRF token is owed (on the condition, recorded in the amendment, that
   * no GET changes state).
   *
   * NO PATH TRANSLATION: the API already serves under `/api/v1` (main.ts:13), so
   * `/api/:path*` maps straight through.
   *
   * IT RUNS IN DEV TOO, AND THAT IS THE POINT RATHER THAN A CONVENIENCE. Calling
   * the API origin directly from the browser works locally and only locally:
   * `localhost:3000` and `localhost:3001` differ by port, and a port does not
   * change the site, so the cookie is same-site on a developer's machine and
   * cross-site the moment it is deployed to two hosts. A dev-only direct client
   * would hide the failure until deploy — the same shape as the superuser-migrator
   * gap `PROGRESS.md` records. Proxying in dev makes local dev behave like
   * production.
   */
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },

  /**
   * SECURITY HEADERS ON THE DOCUMENT RESPONSES — `PROJECT_BRIEF` §11 step 9.
   *
   * ================= WHY THIS FILE, AND NOT `helmet()` ========================
   *
   * `configureApp` has called `helmet()` since step 9's first PR, so the API's
   * JSON responses have carried a full header set all along. That protects
   * nothing a browser renders. Every DOCUMENT the browser actually loads comes
   * from THIS server, and until now it shipped with no CSP, no frame policy, no
   * referrer policy and no HSTS — so the app was framable and had no transport
   * or referrer posture, with a green "security headers" claim available from
   * the API half that no browser ever loads. Asserting helmet's half would have
   * proved the wrong one.
   *
   * ================= WHY `frame-ancestors` AND NOT A FULL CSP =================
   *
   * `frame-ancestors 'none'` is the directive that carries the clickjacking win,
   * and it cannot break rendering — it constrains who may EMBED the page, not
   * what the page may load.
   *
   * A full `script-src`/`style-src` CSP is deliberately NOT here. Next injects
   * inline bootstrap scripts and styled-JSX `<style>` blocks, so anything short
   * of a nonce-based policy breaks the app outright, and nonces require
   * `middleware.ts` plus per-request dynamic rendering — a change with real
   * caching consequences that deserves its own slice rather than a rushed ride
   * on a hardening PR. Enrolled as its own row in `DECISIONS.md`.
   *
   * ======================= THE HSTS VALUE IS DELIBERATE =======================
   *
   * `max-age` only. NO `includeSubDomains` and NO `preload`, on purpose: until
   * the custom domain lands at step 10 this deploys under `*.vercel.app`, whose
   * parent is not ours to make claims about, and `preload` is notoriously slow
   * to undo. Both are owed at step 10 WITH the custom domain. The header is
   * inert over plain HTTP locally, which is why it is safe to ship now.
   *
   * ==================== THE SOURCE EXCLUDES `/api` ============================
   *
   * `/api/*` is proxied to the API by `rewrites()` above, and those responses
   * already carry helmet's headers. Matching them here would set a second,
   * independent copy of the same header names on one response. The negative
   * lookahead keeps this block to what it is about: the documents.
   */
  async headers() {
    return [
      {
        source: '/:path((?!api/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
