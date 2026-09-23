import type { Breadcrumb, ErrorEvent } from '@sentry/nextjs';
import { describe, expect, it } from 'vitest';

import { scrubBreadcrumb, scrubEvent, stripSensitiveUrl } from './sentry-scrub';

/**
 * CONDITION (b′) — THE INVITE TOKEN MUST NOT REACH THE ERROR REPORTER.
 *
 * ==================== WHAT THIS IS GUARDING, EXACTLY =======================
 *
 * `/set-password#token=…` carries a LIVE CREDENTIAL in the URL fragment. The
 * server stores only its SHA-256, so the link is the one place the plaintext
 * exists, and `ISOLATION.md` §9 records the fragment as a deliberate
 * containment boundary: a fragment never leaves the browser, so the token stays
 * out of server logs, out of `Referer`, and out of proxy history.
 *
 * `@sentry/nextjs` is the first thing in this build that reads
 * `window.location` and ships it to a third party — and `window.location` is
 * precisely where the fragment IS. Without the scrubbers these tests cover,
 * installing it would take the credential out of the one channel that was kept
 * clean and put it somewhere with a different audience and a longer retention.
 *
 * `minted-token-containment.spec.ts` named this before it existed: `console.*`
 * "puts a credential in the browser log, **and in whatever ships browser logs
 * onward**". This PR is the "whatever". These are its negatives.
 *
 * ===================== NO LIVE SENTRY IS NEEDED ============================
 *
 * `beforeSend` and `beforeBreadcrumb` are pure functions of an event, so they
 * are called directly with synthetic payloads. A test that needed a real DSN
 * would be a test nobody runs, and this one runs on every CI pass.
 */

/** The shape the leak actually takes: a real redemption URL. */
const TOKENED_URL = 'https://meterlog.example/set-password#token=live-credential-9f8e7d';
const TOKEN = 'live-credential-9f8e7d';

describe('condition (b′) — the URL fragment never reaches Sentry', () => {
  it('strips the fragment from a URL, keeping the path', () => {
    expect(stripSensitiveUrl(TOKENED_URL)).toBe('https://meterlog.example/set-password');
    expect(stripSensitiveUrl(TOKENED_URL)).not.toContain(TOKEN);
  });

  it('drops the fragment from event.request.url', () => {
    const event = {
      request: { url: TOKENED_URL, query_string: 'a=b' },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.request?.url).toBe('https://meterlog.example/set-password');
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
  });

  it('drops the fragment from the replaceState NAVIGATION breadcrumb — the sharper leak', () => {
    // THE ONE THAT MATTERS MOST, and the one a reviewer should read first.
    //
    // `set-password/page.tsx` clears the fragment with
    // `window.history.replaceState(null, '', window.location.pathname)`. Sentry's
    // history integration records that as a navigation breadcrumb whose `from`
    // is the PRE-CLEAR url — so the act of containing the credential is what
    // emits it. Worse, breadcrumbs are retained and attached to the NEXT event,
    // which may fire minutes later, long after the address bar looks clean. An
    // `event.request.url` leak needs an error inside a narrow window; this one
    // does not.
    const crumb = {
      category: 'navigation',
      data: { from: TOKENED_URL, to: 'https://meterlog.example/set-password' },
    } as Breadcrumb;

    const scrubbed = scrubBreadcrumb(crumb);

    expect(scrubbed.data?.from).toBe('https://meterlog.example/set-password');
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
  });

  it('drops the fragment from breadcrumbs ALREADY attached to an event', () => {
    // Both halves, because they cover different moments: `beforeBreadcrumb`
    // catches a crumb as it is recorded, and this catches one assembled onto an
    // event before either hook was installed.
    const event = {
      request: { url: 'https://meterlog.example/login' },
      breadcrumbs: [{ category: 'navigation', data: { from: TOKENED_URL, to: '/login' } }],
    } as unknown as ErrorEvent;

    expect(JSON.stringify(scrubEvent(event))).not.toContain(TOKEN);
  });

  it('strips fetch/xhr breadcrumb urls and url-bearing messages too', () => {
    const fetchCrumb = scrubBreadcrumb({
      category: 'fetch',
      data: { url: TOKENED_URL, method: 'GET' },
    } as Breadcrumb);
    expect(JSON.stringify(fetchCrumb)).not.toContain(TOKEN);

    const messageCrumb = scrubBreadcrumb({ category: 'navigation', message: TOKENED_URL });
    expect(messageCrumb.message).not.toContain(TOKEN);
  });

  it('leaves an ordinary event untouched — non-vacuity', () => {
    // Every assertion above is "the token is absent", which a scrubber that
    // deleted everything would satisfy perfectly. This is the control.
    const event = {
      request: { url: 'https://meterlog.example/assets' },
      breadcrumbs: [{ category: 'navigation', data: { from: '/login', to: '/assets' } }],
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.request?.url).toBe('https://meterlog.example/assets');
    expect(scrubbed.breadcrumbs).toHaveLength(1);
    expect(scrubbed.breadcrumbs?.[0]?.data?.to).toBe('/assets');
  });

  it('is wired into the client config as BOTH hooks, not just one', async () => {
    // A structural pin. The two functions above can be perfect and prove nothing
    // if the config only installs one of them — and `beforeBreadcrumb` is the
    // one it would be natural to forget, because it is the less obvious half.
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync(new URL('../sentry.client.config.ts', import.meta.url), 'utf8'),
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).toContain('beforeSend: scrubEvent');
    expect(code).toContain('beforeBreadcrumb: scrubBreadcrumb');
  });

  it('strips the caller IP and host name — condition (a), enforced not configured', () => {
    // `sendDefaultPii` was REMOVED from the options type in @sentry/core v11, so
    // there is no flag to set. That turns out to be the stronger position: a
    // boolean's meaning belongs to the SDK version, and this deletion belongs to
    // this repository and is asserted right here.
    const event = {
      user: { id: 'u1', ip_address: '203.0.113.9' },
      server_name: 'web-runtime-7',
      request: { url: 'https://meterlog.example/login' },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event);

    expect(scrubbed.user?.ip_address).toBeUndefined();
    expect(scrubbed.server_name).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain('203.0.113.9');
    // Non-vacuity: the user is still identified, which is the point of having one.
    expect(scrubbed.user?.id).toBe('u1');
  });
});
