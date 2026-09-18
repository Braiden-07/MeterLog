/**
 * THE INVITE LINK BUILDER — the producer end of a two-ended constraint (OPEN-14).
 *
 * WHY THIS IS A MODULE OF ITS OWN rather than three characters of template
 * literal inside the component that shows the link. It is the only place in the
 * frontend that decides WHERE a live credential is written into a URL, and that
 * decision is a security property with a test attached. Inlined into JSX it would
 * be invisible to review, untestable without rendering, and one "add ?email= so
 * the page can prefill" away from being wrong.
 *
 * THE FRAGMENT IS THE WHOLE POINT. `#token=…` is never sent to any server: the
 * browser strips it before the request leaves. A query string fails that in three
 * distinct places, each of which retains the credential in something that never
 * needed it and usually has a different retention policy and a wider audience
 * than the database:
 *
 *   - **server access logs** — `?token=…` lands in them in plaintext;
 *   - **the `Referer` header** — carried to every third-party origin the page
 *     subsequently loads;
 *   - **proxy / CDN history** along the path.
 *
 * The token is SHA-256 at rest in `invite_tokens`, so once minted the link holds
 * the only copy of the plaintext that exists anywhere. That is precisely why
 * where the link travels is a security property and not a URL-style preference.
 *
 * THE CONSUMER END WAS ALREADY BUILT AND ENFORCED; THIS END WAS NOT. The
 * set-password page reads from `location.hash` only and clears it after reading.
 * Nothing constrained the end that BUILDS the link until this function and its
 * spec, and a constraint enforced at one end of a two-ended contract is one
 * refactor from being silently dropped at the other. `invite-link.spec.ts` is the
 * producer-side proof OPEN-14 records as owed.
 */

/** The page that redeems an invite. One definition, so the two ends cannot drift. */
export const SET_PASSWORD_PATH = '/set-password';

/**
 * Builds the redemption link for a freshly minted token.
 *
 * `origin` is passed in rather than read from `window` so this stays a pure
 * function — testable in the `node` environment the frontend suite runs in, with
 * no DOM and no mocking.
 *
 * `encodeURIComponent` is applied even though the token is 64 hex characters by
 * construction and needs no escaping today. It costs nothing, and it means the
 * function stays correct if the token format ever changes — the alternative is a
 * silent injection point guarded only by a fact about a different module.
 */
export function inviteLinkFor(origin: string, token: string): string {
  return `${origin}${SET_PASSWORD_PATH}#token=${encodeURIComponent(token)}`;
}
