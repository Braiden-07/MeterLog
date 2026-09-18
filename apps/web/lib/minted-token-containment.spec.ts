import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE MINTED TOKEN IS CONTAINED — a STRUCTURAL PIN over the admin component.
 *
 * ================== WHAT THIS IS, AND WHAT IT IS NOT =======================
 *
 * This is a pin on the SOURCE, not a measurement of the running component. It
 * cannot observe the cache at runtime; it asserts that the component is written
 * so that the cases below cannot arise. Stated plainly because the distinction
 * decides what a green result here is worth: it would catch somebody
 * REINTRODUCING one of these mechanisms, and it would not catch a runtime leak
 * by some route nobody has thought of.
 *
 * A behavioural counterpart would have to render the component and inspect the
 * QueryClient afterwards, which needs a DOM testing library this repo does not
 * depend on. That is a deliberate omission rather than an oversight — adding a
 * dependency is a reviewed decision — and the gap is the same one `ISOLATION.md`
 * §9 already records for the eviction proof: the client mechanism is proven, the
 * real browser is OPEN-17.
 *
 * ===================== WHY EACH RULE IS HERE ===============================
 *
 * `POST /users/pending/:membershipId/token` is the only response body in the
 * entire API that is a live credential, and the server marks it `Cache-Control:
 * no-store`. These rules are that header's client-side counterpart: the places a
 * React app would ordinarily put a fetched value are all places that RETAIN it.
 *
 *   - `useQuery` writes the payload into the TanStack cache under its key, where
 *     it survives until a reset and is readable by anything that knows the key.
 *   - `useMutation` is the subtler one: the result is retained as `data` on the
 *     MutationCache until garbage collection, so the token would outlive the
 *     interaction with nothing on screen to suggest it.
 *   - `localStorage` / `sessionStorage` persist it across reloads, on disk.
 *   - `console.*` puts a credential in the browser log, and in whatever ships
 *     browser logs onward.
 *
 * The token therefore lives in exactly one `useState`, and is cleared from it on
 * copy and on dismiss.
 */

const SOURCE = readFileSync(resolve(__dirname, '../components/members-admin.tsx'), 'utf8');

/** Strips block and line comments, so the prose above the code cannot satisfy a rule. */
function code(): string {
  return SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the minted token is contained (structural pin)', () => {
  it('reads a real component — not passing because the file moved', () => {
    // Vacuity guard. Every assertion below is "X is absent", which an empty
    // string satisfies perfectly.
    expect(SOURCE.length).toBeGreaterThan(2000);
    expect(SOURCE).toContain('MintedInviteToken');
    expect(SOURCE).toContain('/token');
  });

  it('uses no useMutation — the MutationCache would retain the token as data', () => {
    expect(code()).not.toContain('useMutation');
  });

  it('never persists anything to browser storage', () => {
    const body = code();
    expect(body).not.toContain('localStorage');
    expect(body).not.toContain('sessionStorage');
    expect(body).not.toContain('document.cookie');
  });

  it('never logs — a credential must not reach the browser console', () => {
    expect(code()).not.toMatch(/\bconsole\s*\./);
  });

  it('routes the mint through api.request as a POST, never through a query', () => {
    const body = code();
    // The mint path appears exactly once, and the call around it is a POST.
    const mintCalls = body.match(/path: `\/users\/pending\/\$\{[^}]+\}\/token`/g) ?? [];
    expect(mintCalls, 'exactly one mint call site').toHaveLength(1);

    const at = body.indexOf('/users/pending/${');
    const surrounding = body.slice(Math.max(0, at - 300), at);
    expect(surrounding, 'the mint must be an explicit POST').toContain("method: 'POST'");
  });

  it('has exactly two cached reads, and neither is the mint', () => {
    const body = code();
    // The members table's two reads — and only those — go through the tenant
    // cache. A third `useQuery` in this component is the thing to look at.
    const queries = body.match(/useQuery\(/g) ?? [];
    expect(queries, 'two tenant-scoped reads: members and pending').toHaveLength(2);

    const tenantQueries = body.match(/session\.tenantQuery</g) ?? [];
    expect(tenantQueries, 'both reads go through tenantQuery, never a hand-built key').toHaveLength(
      2,
    );

    // Neither cached read mentions the token type or the mint path.
    for (const match of body.matchAll(/session\.tenantQuery<([^>]+)>/g)) {
      expect(match[1], 'a cached read must not be typed as the minted token').not.toContain(
        'Minted',
      );
    }
  });

  it('clears the token from state on copy AND on dismiss', () => {
    const body = code();
    // The single holder, and the two places it is emptied.
    expect(body).toContain('useState<MintedInviteToken | null>(null)');
    expect(body).toContain('setMinted(null)');
    // Dismiss is wired to a control, so the clear is reachable by the user
    // rather than only on unmount.
    expect(body).toContain('dismissLink');
  });
});
