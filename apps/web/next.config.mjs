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
};

export default nextConfig;
