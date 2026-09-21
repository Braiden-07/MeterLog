import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config.mjs';

/**
 * SECURITY HEADERS ON THE DOCUMENT RESPONSES — `PROJECT_BRIEF` §11 step 9.
 *
 * ================== WHY THIS FILE EXISTS AT ALL ==============================
 *
 * `configureApp` has called `helmet()` since the cross-site posture PR, so the
 * API's JSON responses have carried a full header set for a slice. **That is the
 * half no browser loads.** Every DOCUMENT comes from the Next server, and until
 * this PR `next.config.mjs` had no `headers()` block at all — so the app was
 * framable, with no referrer policy and no HSTS, while a "security headers"
 * claim was available from the API side that proved none of it.
 *
 * So the assertion here is deliberately about the DOCUMENT route, and the
 * exclusion of `/api/*` is asserted as explicitly as the inclusion. A test that
 * checked an `/api/*` response would be re-proving helmet.
 *
 * ================== WHAT THIS PROVES, AND WHAT IT DOES NOT ==================
 *
 * It proves the CONFIGURATION: the exact header set, and — using **Next's own
 * bundled `path-to-regexp`**, not a hand-rolled approximation of it — that the
 * `source` pattern matches documents and does not match the proxied API. Using
 * Next's copy is the point: a test that re-implemented the matching would assert
 * my understanding of the pattern rather than the framework's.
 *
 * It does NOT prove the headers arrive on a live response, because that needs a
 * running server and a real request. **That proof is owed to the Playwright
 * slice**, which is the tool that loads a document, and is named here so the gap
 * is recorded rather than assumed closed. The pattern behaviour — the part most
 * likely to be silently wrong — is what this file pins.
 */
const require_ = createRequire(import.meta.url);
const { pathToRegexp } = require_('next/dist/compiled/path-to-regexp') as {
  pathToRegexp: (source: string) => RegExp;
};

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

async function rules(): Promise<HeaderRule[]> {
  const headers = nextConfig.headers;
  if (typeof headers !== 'function') throw new Error('next.config.mjs defines no headers()');
  return (await headers()) as HeaderRule[];
}

describe('security headers (PROJECT_BRIEF §11 step 9 — the document half)', () => {
  it('next.config.mjs defines a headers() block at all', async () => {
    // Non-vacuity. Before this PR the answer was "no", and every assertion below
    // would have had nothing to inspect.
    expect((await rules()).length).toBeGreaterThan(0);
  });

  it('sets the frame, referrer, transport and sniffing headers', async () => {
    const [rule] = await rules();
    const set = new Map(rule!.headers.map((h) => [h.key, h.value]));

    // `frame-ancestors` is the clickjacking win and cannot break rendering. The
    // X-Frame-Options line is the belt to its braces for older agents.
    expect(set.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(set.get('X-Frame-Options')).toBe('DENY');
    expect(set.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(set.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('ships NO script-src/style-src CSP — a nonce-less one would break the app', async () => {
    // Pins the deliberate limit of this slice rather than leaving it to a
    // comment. Next injects inline bootstrap scripts and styled-JSX blocks, so a
    // policy without nonces breaks rendering outright, and nonces need
    // middleware.ts plus per-request dynamic rendering. Enrolled as its own row
    // in DECISIONS.md; if someone adds one here, they must come and delete this
    // test, which is the reviewed moment the change deserves.
    const [rule] = await rules();
    const csp = rule!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
    expect(csp).not.toMatch(/script-src|style-src|default-src/);
  });

  it('HSTS carries max-age only — includeSubDomains and preload are owed at step 10', async () => {
    // NOT an oversight, and asserted so it cannot be "tidied up" into one.
    // Until the custom domain lands this deploys under *.vercel.app, whose parent
    // is not ours to make claims about, and preload is slow to undo.
    const [rule] = await rules();
    const hsts = rule!.headers.find((h) => h.key === 'Strict-Transport-Security')!.value;
    expect(hsts).toBe('max-age=31536000');
    expect(hsts).not.toMatch(/includeSubDomains|preload/);
  });

  it('applies to DOCUMENT routes and NOT to the proxied /api/*', async () => {
    // THE ASSERTION THAT MATTERS MOST, because the source pattern is the part
    // that can be silently wrong. Evaluated with Next's own matcher.
    const [rule] = await rules();
    const match = pathToRegexp(rule!.source);

    for (const documentPath of ['/', '/login', '/dashboard', '/assets/123']) {
      expect(match.test(documentPath), `${documentPath} should carry the headers`).toBe(true);
    }

    for (const apiPath of ['/api/v1/auth/login', '/api/v1/users', '/api/health']) {
      expect(match.test(apiPath), `${apiPath} is helmet's, not ours`).toBe(false);
    }

    // The exclusion is the `/api/` PREFIX, not the substring — a document route
    // that merely begins with those letters must still be covered.
    expect(match.test('/apiary'), 'over-broad exclusion: /apiary lost its headers').toBe(true);
  });
});
