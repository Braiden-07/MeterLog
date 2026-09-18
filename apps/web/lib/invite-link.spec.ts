import { describe, expect, it } from 'vitest';

import { inviteLinkFor } from './invite-link';

/**
 * OPEN-14's PRODUCER-SIDE PROOF.
 *
 * The consumer end of this constraint has been enforced since slice 1: the
 * set-password page reads the token from `location.hash` and from nowhere else.
 * The producer end — the code that BUILDS the link — was unconstrained, and
 * OPEN-14 records the acceptance this file discharges: **the generated link
 * matches `#token=` and does NOT match `?token=`.**
 *
 * IT IS A PURE STRING ASSERTION, DELIBERATELY. No browser, no render, no DOM.
 * A constraint about the SHAPE of a string is provable by looking at the string,
 * and routing it through a browser would make it slower, flakier and no stronger.
 *
 * WHY A "DOES NOT MATCH `?token=`" ASSERTION IS NOT ENOUGH ON ITS OWN, and why
 * the third test exists: the failure this guards against is not somebody
 * rewriting `#token=` into `?token=` — that is a change nobody makes by accident.
 * It is somebody ADDING a query string for an unrelated reason ("prefill the
 * email", "carry a `next=` redirect", "add `utm_source`") and putting the token
 * in it too, or building the query AFTER the fragment so the token ends up inside
 * it. So the real assertion is the general one: **the token appears in no query
 * string anywhere in the link.**
 */
describe('inviteLinkFor — the fragment constraint (OPEN-14, producer side)', () => {
  const ORIGIN = 'https://meterlog.example';
  // 64 hex characters — the shape `mint_invite_token` actually returns.
  const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);

  it('puts the token in the FRAGMENT', () => {
    const link = inviteLinkFor(ORIGIN, TOKEN);
    expect(link).toContain('#token=');
    expect(link).toBe(`${ORIGIN}/set-password#token=${TOKEN}`);
  });

  it('does NOT put the token in a query string', () => {
    // The acceptance as OPEN-14 words it.
    const link = inviteLinkFor(ORIGIN, TOKEN);
    expect(link).not.toContain('?token=');
    expect(link).not.toMatch(/\?token=/);
  });

  it('puts the token in NO query string anywhere — the general form', () => {
    // THE ASSERTION THAT SURVIVES A REFACTOR. Everything before the first `#` is
    // sent to the server; everything after it is not. So the real property is
    // that the token is absent from the whole pre-fragment half of the URL,
    // however that half comes to be built.
    const link = inviteLinkFor(ORIGIN, TOKEN);

    const hashAt = link.indexOf('#');
    expect(hashAt, 'the link must have a fragment at all').toBeGreaterThan(-1);

    const serverVisible = link.slice(0, hashAt);
    expect(
      serverVisible,
      'the half of the URL that reaches the server must not contain the token',
    ).not.toContain(TOKEN);
    expect(serverVisible, 'no query string at all in this link today').not.toContain('?');

    // And the token really is on the other side — otherwise the assertion above
    // would pass for a link that dropped the token entirely.
    expect(link.slice(hashAt)).toContain(TOKEN);
  });

  it('escapes the token rather than trusting its format', () => {
    // The token is hex by construction today. This asserts the function does not
    // DEPEND on that: a value with URL-significant characters is escaped, so the
    // fragment cannot be broken out of by a future change to the token format.
    const link = inviteLinkFor(ORIGIN, 'a&b=c#d');
    expect(link).toBe('https://meterlog.example/set-password#token=a%26b%3Dc%23d');
    expect(link.slice(link.indexOf('#') + 1)).not.toContain('#');
  });

  it('is not vacuous — a query-string builder would fail these assertions', () => {
    // The mutation this file is meant to catch, written out. If the assertions
    // above were somehow satisfiable by any link at all, this would pass too.
    const wrong = `${ORIGIN}/set-password?token=${TOKEN}`;
    expect(wrong).toContain('?token=');
    expect(wrong.slice(0, wrong.indexOf('#') === -1 ? wrong.length : wrong.indexOf('#'))).toContain(
      TOKEN,
    );
  });
});
