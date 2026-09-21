import { expect, test } from '@playwright/test';

import {
  chooseWorkspace,
  createAsset,
  invite,
  loginAs,
  registerOrg,
  switchWorkspaceTo,
  unique,
} from './fixtures';

/**
 * THE BROWSER EVICTION PROOF — OPEN-17, and the live-browser half of ADR-006 §9.
 *
 * =============== WHAT THIS ADDS TO THE UNIT TEST THAT EXISTS ===============
 *
 * `lib/workspace-session.spec.ts` already drives the real switch path with a real
 * `QueryClient` against a SCRIPTED FAKE SERVER. `ISOLATION.md` §9 is explicit
 * that this is a client-mechanism proof and not evidence about a browser:
 * "Nothing here exercises the router cache, `bfcache`, a second window, or a real
 * `BroadcastChannel`." This file is the second window and the real
 * `BroadcastChannel`, against the real API, through the real Next rewrite.
 *
 * ==================== GONE, NOT ARRIVED — THE ROW'S WORDING =================
 *
 * OPEN-17's acceptance is exact: "after switching from A to B, assert tenant-A
 * data is GONE from the page, not that tenant-B data arrived. A page showing B's
 * rows beside one stale A row passes an 'arrived' assertion and fails this one."
 * So the load-bearing assertion below is `toHaveCount(0)` on Acme's serial, and
 * Beta's serial is checked only to show the page is alive rather than blank.
 *
 * THE POSITIVE CONTROL IS NOT CEREMONY. An empty cache passes "Acme is gone" for
 * entirely the wrong reason, so every eviction assertion here is preceded by
 * proof that the row was on the page a moment earlier.
 */
test.describe('workspace eviction in a real browser (OPEN-17)', () => {
  test('a switch evicts tenant A from the page — gone, not arrived (OPEN-17)', async ({
    browser,
    baseURL,
  }) => {
    const SN_ACME = unique('SN-ACME').toUpperCase();
    const SN_BETA = unique('SN-BETA').toUpperCase();

    // ---- fixture: one person, two workspaces, one visible row in each --------
    const acme = await registerOrg(baseURL!, 'acme');
    const beta = await registerOrg(baseURL!, 'beta');
    await createAsset(acme, SN_ACME);
    await createAsset(beta, SN_BETA);
    // Acme's admin already has a password, so this is a LIVE membership rather
    // than a pending invite — which is what gives one person two workspaces.
    await invite(beta, acme.email, 'admin');

    const context = await browser.newContext();

    // ---- tab 1: sign in, pick Acme, and SEE Acme's row ----------------------
    const tab1 = await context.newPage();
    await loginAs(tab1, acme.email);
    // Two memberships means no active workspace on a cold session, so the picker
    // is the ordinary path here rather than a special case (app/page.tsx).
    await chooseWorkspace(tab1, acme.tenantName);
    await expect(tab1.getByText(SN_ACME), 'positive control: tab 1 shows Acme').toBeVisible();

    // ---- OPEN-17's OWN ACCEPTANCE, in the switching tab ---------------------
    // "after switching from A to B, assert tenant-A data is GONE from the page".
    // Asserted here, in the tab that switched, because this is the claim the row
    // makes and it must not depend on the cross-tab machinery below.
    await switchWorkspaceTo(tab1, beta.tenantId);
    await expect(
      tab1.getByText(SN_ACME),
      'the switching tab still shows tenant A — the reset did not evict',
    ).toHaveCount(0);
    await expect(tab1.getByText(SN_BETA), 'and it is alive, not blank').toBeVisible();

    await context.close();
  });

  test('SECOND TAB: a real BroadcastChannel propagates the reset', async ({ browser, baseURL }) => {
    // ===================== KNOWN DEFECT — OPEN-22 ============================
    //
    // MARKED `test.fail()`: this test is CORRECT and the APP IS BROKEN. It runs
    // on every CI pass, and the moment someone fixes the app it reports
    // "expected to fail but passed" — which is a RED build that names this line.
    // That is the point of marking it rather than skipping it: a skip would go
    // quiet forever, and a deletion would lose the only executable statement of
    // what cross-tab propagation is supposed to do.
    //
    // WHAT IS BROKEN, established by probe rather than inference:
    //
    //   - the message IS delivered to the second tab's page
    //     (an independent listener on the same channel received
    //     `{"reason":"switch"}`);
    //   - the second tab issues ZERO `/auth/me` refetches afterwards, so its
    //     session never reset;
    //   - `broadcast.ts` normalises EVERY message to `handler('remote')`, and
    //     `workspace-session.ts`'s subscriber opens with
    //     `if (reason === 'remote') return;` — so `reset()` is unreachable on
    //     every message, and has been since the channel was written.
    //
    // The two comments contradict each other: broadcast.ts says the receiver
    // "discards its cache and re-reads identity", and the session's guard treats
    // exactly that signal as "ignore". The loop-prevention the guard was aiming
    // at is already handled by `propagate: false` in the reset call it guards.
    //
    // WHY IT WAS NEVER CAUGHT: no unit spec constructs a session WITH a channel
    // (`WorkspaceSessionOptions.channel` is optional "so the spec can run without
    // a channel"), so the subscriber has never been executed by a test. This is
    // precisely the gap `ISOLATION.md` §9 named — "Nothing here exercises … a
    // real `BroadcastChannel`" — found by the first test that did.
    //
    // NOT FIXED HERE, DELIBERATELY: the fix is one line of app feature code, and
    // PR 3 writes none. Enrolled as OPEN-22 with this test as its ready-made
    // live negative; un-mark this line in the PR that fixes it.
    //
    // SCOPE OF THE DEFECT, so nobody over- or under-reacts: a background tab
    // keeps DISPLAYING a workspace the session has switched away from, until
    // something else refetches. The rows are ones the caller is entitled to see,
    // RLS is untouched, and a stale WRITE from that tab is already refused by the
    // server's 409 TENANT_MISMATCH (OPEN-15) — which the backstop test below
    // proves. It is a stale-display defect, not a cross-tenant leak.
    test.fail();

    const SN_ACME = unique('SN-ACME').toUpperCase();
    const SN_BETA = unique('SN-BETA').toUpperCase();

    const acme = await registerOrg(baseURL!, 'acme');
    const beta = await registerOrg(baseURL!, 'beta');
    await createAsset(acme, SN_ACME);
    await createAsset(beta, SN_BETA);
    await invite(beta, acme.email, 'admin');

    const context = await browser.newContext();
    const tab1 = await context.newPage();
    await loginAs(tab1, acme.email);
    await chooseWorkspace(tab1, acme.tenantName);
    await expect(tab1.getByText(SN_ACME), 'positive control: tab 1 shows Acme').toBeVisible();

    // ---- tab 2: a SECOND WINDOW on the same session -------------------------
    // Cookies are per-context, so this tab shares the session — and, being
    // same-origin in the same context, it also shares the BroadcastChannel.
    const tab2 = await context.newPage();
    await tab2.goto('/');
    await expect(tab2.getByText(SN_ACME), 'positive control: tab 2 shows Acme too').toBeVisible();

    // ---- the switch, in tab 1 only ------------------------------------------
    await switchWorkspaceTo(tab1, beta.tenantId);
    await expect(tab1.getByText(SN_BETA), 'tab 1 followed the switch').toBeVisible();

    // ---- THE ASSERTION — tab 2 evicted Acme without being touched -----------
    // Nothing navigated tab 2 and nothing clicked in it. The only thing that
    // reached it is the reset broadcast `switchTo` posts, which is precisely the
    // mechanism §9 records as unexercised.
    await expect(
      tab2.getByText(SN_ACME),
      'tab 2 still shows tenant A after a switch — the broadcast did not evict',
    ).toHaveCount(0);

    // Alive, not blank. Secondary to the assertion above, and deliberately so.
    await expect(tab2.getByText(SN_BETA), 'tab 2 re-homed to Beta').toBeVisible();

    await context.close();
  });

  test('TENANT_MISMATCH backstop: a stale tab the broadcast cannot reach is refused and re-homed', async ({
    browser,
    baseURL,
  }) => {
    // ============ WHY THIS IS A SECOND TEST WITH A SECOND SETUP =============
    //
    // The broadcast is the FAST PATH; the 409 is the BACKSTOP for when the
    // broadcast cannot reach. Testing the backstop through the fast path would
    // prove only the fast path — so these cannot be one test, and the setups are
    // deliberately different.
    //
    // A SECOND BROWSER CONTEXT WITH THE SESSION COOKIE COPIED IN IS THE
    // CONDITION, NOT A CONVENIENCE. `TENANT_MISMATCH` is a disagreement between
    // the header a tab sends and the SHARED session's verified active tenant. An
    // independent login in context 2 would create its OWN session, whose active
    // tenant always agrees with its own header — so the 409 could never fire and
    // this test would pass while proving nothing. `addCookies` with context 1's
    // cookie is what makes one session visible from two places.
    //
    // Separate contexts also mean separate browser profiles, so no
    // BroadcastChannel reaches across — which is exactly the condition the
    // backstop exists for (another browser, another device, a channel that is
    // unavailable). It is also, incidentally, why this test is unaffected by the
    // OPEN-22 defect above: it never relies on the broadcast working.
    const acme = await registerOrg(baseURL!, 'acme');
    const beta = await registerOrg(baseURL!, 'beta');
    await invite(beta, acme.email, 'admin');

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await loginAs(page1, acme.email);
    await chooseWorkspace(page1, acme.tenantName);
    await expect(page1.getByLabel('Active workspace')).toHaveValue(acme.tenantId);

    // ---- context 2: the same session, seen from a place the channel can't reach
    const sessionCookie = (await context1.cookies()).find((c) => c.name === 'meterlog_sid');
    expect(sessionCookie, 'fixture: no session cookie to share').toBeDefined();

    const context2 = await browser.newContext();
    await context2.addCookies([sessionCookie!]);
    const page2 = await context2.newPage();
    await page2.goto('/');
    await expect(page2.getByLabel('Active workspace')).toHaveValue(acme.tenantId);

    // ---- the switch happens in context 1 ------------------------------------
    await switchWorkspaceTo(page1, beta.tenantId);
    await expect(page1.getByLabel('Active workspace')).toHaveValue(beta.tenantId);

    // ---- SHOW ME THE POSITIVE: the scenario is actually set up --------------
    // Asserted immediately before the write, because a stale tab can cure itself
    // — a window-focus refetch is the obvious way — and a cured tab sends a
    // header that AGREES, gets no 409, and fails the recovery assertions below
    // for a reason that has nothing to do with the recovery. Proving the
    // precondition here means a failure distinguishes "the scenario collapsed"
    // from "the recovery broke".
    await expect(
      page2.getByLabel('Active workspace'),
      'context 2 is no longer stale — the precondition collapsed, so the 409 cannot fire',
    ).toHaveValue(acme.tenantId);

    // ---- the stale write ----------------------------------------------------
    // Sent with `x-expected-tenant: <acme>` because that is what this tab still
    // believes. The server verified Beta. That disagreement is the 409.
    await page2.getByLabel('Email to invite').fill(`${unique('invitee')}@e2e.test`);
    await page2.getByRole('button', { name: 'Invite' }).click();

    // ---- THE RECOVERY (PR 2) — the only browser-level proof of it -----------
    await expect(
      page2.getByText(/did not apply/i),
      'no dropped-write notice — the 409 was swallowed instead of surfaced',
    ).toBeVisible();

    await expect(
      page2.getByLabel('Active workspace'),
      'the stale tab did not re-home to the verified workspace',
    ).toHaveValue(beta.tenantId);

    await context1.close();
    await context2.close();
  });

  test('back-navigation does not resurrect tenant A', async ({ browser, baseURL }) => {
    // TWO THINGS AT ONCE, AND ONLY ONE OF THEM IS A RISK.
    //
    // (1) BACK-NAVIGATION is a real path a user takes after switching, and a
    //     history entry rendered from a stale cache would put tenant A back on
    //     screen. Worth asserting on its own terms.
    //
    // (2) THE NEXT ROUTER CACHE is PINNED here, not exercised. The App Router
    //     caches RSC payloads per route, which would be a second cache
    //     `queryClient.clear()` cannot reach — except that `app-shell.tsx`
    //     renders every tenant row in CLIENT components precisely so no tenant
    //     data can enter it. So this asserts the constraint still holds; it is
    //     not evidence against a router-cache bug, because by construction there
    //     is not one to find. Labelled rather than left to imply more.
    //
    // NOT ATTEMPTED: a true `bfcache` restore. Chromium disables the back/forward
    // cache while the DevTools protocol is attached, so this navigation is an
    // ordinary re-render — a test claiming bfcache here would assert a reload and
    // report it as something else. Enrolled in DECISIONS instead.
    const SN_ACME = unique('SN-ACME').toUpperCase();
    const SN_BETA = unique('SN-BETA').toUpperCase();

    const acme = await registerOrg(baseURL!, 'acme');
    const beta = await registerOrg(baseURL!, 'beta');
    await createAsset(acme, SN_ACME);
    await createAsset(beta, SN_BETA);
    await invite(beta, acme.email, 'admin');

    const context = await browser.newContext();
    const page = await context.newPage();

    await loginAs(page, acme.email);
    await chooseWorkspace(page, acme.tenantName);
    await expect(page.getByText(SN_ACME), 'positive control').toBeVisible();

    await switchWorkspaceTo(page, beta.tenantId);
    await expect(page.getByText(SN_BETA)).toBeVisible();

    // Leave the app and come back through history.
    await page.goto('/login');
    await page.goBack();

    await expect(
      page.getByText(SN_ACME),
      'tenant A reappeared after a back-navigation',
    ).toHaveCount(0);
    await expect(page.getByText(SN_BETA), 'and the live workspace still renders').toBeVisible();

    await context.close();
  });
});
