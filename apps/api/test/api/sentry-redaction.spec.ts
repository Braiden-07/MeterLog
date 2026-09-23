import type { ErrorEvent } from '@sentry/nestjs';
import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_BODY_ROUTES,
  isCredentialBodyRoute,
} from '../../src/common/observability/redaction';
import { scrubEvent } from '../../src/common/observability/sentry';

/**
 * CONDITIONS (a) AND (b) — NO CREDENTIAL LEAVES IN AN ERROR REPORT.
 *
 * ===================== WHY THIS FILE EXISTS ================================
 *
 * ADR-011 already settled this question for the audit trail, and its sentence
 * transfers without modification: a mechanism that copied a withheld value into
 * a store more people can read "would become a privilege-escalation path, and
 * it would look like a feature while it did it". An error reporter shipping a
 * login body is that, through a channel that did not exist before this PR.
 *
 * ADR-011's other rule is the one that shapes this file: redaction is ENFORCED
 * by the mechanism, NOT DOCUMENTED. So the list is an exported constant, the
 * scrubber is a pure function of an event, and both are asserted here rather
 * than described in a comment somewhere and trusted.
 *
 * NO LIVE SENTRY. `scrubEvent` is `beforeSend`, called directly with synthetic
 * events. A negative that needed a DSN would never run in CI.
 */
describe('condition (b) — credential request bodies never reach Sentry', () => {
  it('drops the body of a /auth/login event — no password anywhere in it', () => {
    // THE HEADLINE NEGATIVE. A failed login is the commonest error on the
    // commonest credential-bearing route.
    const event = {
      request: {
        url: '/api/v1/auth/login',
        method: 'POST',
        data: { email: 'someone@example.test', password: 'correct horse battery staple' },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    // Asserted over the WHOLE serialised event, not just the field we removed:
    // a scrubber that moved the value somewhere else would satisfy a narrower
    // check.
    expect(JSON.stringify(scrubbed)).not.toContain('correct horse battery staple');
    expect(scrubbed.request?.data).toBe('[redacted: credential route]');
  });

  it('drops the body of /auth/register too — the route most easily missed', () => {
    // `RegisterDto` carries a password exactly as `LoginDto` does. It reads like
    // a public sign-up form rather than a credential exchange, which is why it
    // is the one a redaction list forgets.
    const event = {
      request: {
        url: '/api/v1/auth/register',
        method: 'POST',
        data: { tenantName: 'Acme', email: 'a@b.test', password: 'hunter2-and-then-some' },
      },
    } as unknown as ErrorEvent;

    expect(JSON.stringify(scrubEvent(event))).not.toContain('hunter2-and-then-some');
  });

  it('drops the body of /auth/set-password — which carries TWO secrets', () => {
    // A token AND a password. The token is a live credential the server holds
    // only as a SHA-256, so this body is the single plaintext copy in existence.
    const event = {
      request: {
        url: '/api/v1/auth/set-password',
        method: 'POST',
        data: { token: 'live-invite-token-abc123', password: 'a-brand-new-password' },
      },
    } as unknown as ErrorEvent;

    const serialised = JSON.stringify(scrubEvent(event));
    expect(serialised).not.toContain('live-invite-token-abc123');
    expect(serialised).not.toContain('a-brand-new-password');
  });

  it('covers the invite-mint route, whose credential is in the RESPONSE', () => {
    expect(isCredentialBodyRoute('/api/v1/users/pending/1e5a-b7/token')).toBe(true);
  });

  it('matches by SEGMENT, so a lookalike route is neither missed nor over-matched', () => {
    // `startsWith` would be wrong in both directions: it would match
    // `/auth/login-history` (over-redaction, harmless) and would MISS a
    // prefixed `/api/v1/auth/login` (under-redaction, a shipped password).
    expect(isCredentialBodyRoute('/auth/login')).toBe(true);
    expect(isCredentialBodyRoute('/api/v1/auth/login')).toBe(true);
    expect(isCredentialBodyRoute('/api/v1/auth/login-history')).toBe(false);
    expect(isCredentialBodyRoute('/api/v1/assets')).toBe(false);
  });

  it('redacts credential FIELDS on routes that are not on the list — the fallback', () => {
    // Belt to the route list's braces: a future route carrying a `password` that
    // nobody enrolled still has the field itself removed.
    const event = {
      request: {
        url: '/api/v1/some/future/route',
        method: 'POST',
        data: { name: 'fine', nested: { password: 'should-not-survive' } },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);
    expect(JSON.stringify(scrubbed)).not.toContain('should-not-survive');
    // Non-vacuity: the innocent field is still there.
    expect(JSON.stringify(scrubbed)).toContain('fine');
  });

  it('lists exactly four credential routes — a change here is a reviewed change', () => {
    // The list is the mechanism. Pinning its length means adding or removing a
    // route reds a test and has to be argued, rather than happening in passing.
    expect(CREDENTIAL_BODY_ROUTES).toHaveLength(4);
    expect(CREDENTIAL_BODY_ROUTES).toContain('/auth/register');
  });
});

describe('condition (a) — no session cookie, no authorization header, no URL secrets', () => {
  it('removes the Cookie header — a session cookie in a report IS the session', () => {
    const event = {
      request: {
        url: '/api/v1/assets',
        headers: {
          Cookie: 'meterlog_sid=s%3Areal-session-value.signature',
          'user-agent': 'probe/1.0',
        },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(JSON.stringify(scrubbed)).not.toContain('real-session-value');
    // Case-insensitively: Express lowercases, but an event may not have come
    // through Express.
    expect(scrubbed.request?.headers?.Cookie).toBeUndefined();
    // Non-vacuity — a scrubber that deleted all headers would pass the above.
    expect(scrubbed.request?.headers?.['user-agent']).toBe('probe/1.0');
  });

  it('removes the Authorization header', () => {
    const event = {
      request: { url: '/api/v1/assets', headers: { authorization: 'Bearer a-real-token' } },
    } as unknown as ErrorEvent;

    expect(JSON.stringify(scrubEvent(event))).not.toContain('a-real-token');
  });

  it('reduces the URL to its path, dropping query string and fragment', () => {
    const event = {
      request: { url: '/api/v1/assets?secret=leaked#also-leaked', query_string: 'secret=leaked' },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.request?.url).toBe('/api/v1/assets');
    expect(JSON.stringify(scrubbed)).not.toContain('leaked');
  });

  it('strips the caller IP and the host name — no flag exists in v11 to do it', () => {
    // `sendDefaultPii` is gone from @sentry/core v11's options type, so
    // condition (a) is met by deleting the fields rather than by asking the SDK
    // not to attach them. ADR-011's rule reaches this too: enforced by the
    // mechanism, not configured.
    const event = {
      user: { id: 'user-1', ip_address: '198.51.100.7' },
      server_name: 'api-container-3',
      request: { url: '/api/v1/assets' },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.user?.ip_address).toBeUndefined();
    expect(scrubbed.server_name).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain('198.51.100.7');
    // Non-vacuity: the user id survives, which is what makes an error triageable.
    expect(scrubbed.user?.id).toBe('user-1');
  });

  it('handles an event with no request at all', () => {
    const event = { message: 'boom' } as unknown as ErrorEvent;
    expect(() => scrubEvent(event)).not.toThrow();
  });
});
