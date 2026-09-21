import { expect, test } from '@playwright/test';

import { PASSWORD, loginAs, registerOrg, unique } from './fixtures';

/**
 * THE ADMIN INVITE JOURNEY — the second of the two e2e journeys `PROJECT_BRIEF`
 * §12 names, end to end in a real browser.
 *
 * invite -> mint -> fragment link -> set password -> sign in -> ONE workspace.
 *
 * ============ THE TOKEN IS READ FROM THE RENDERED LINK, NOT FETCHED =========
 *
 * The minted token is never introspected out of an API response, read from the
 * database, or lifted from the clipboard. It is taken from the LINK THE ADMIN UI
 * PUT ON SCREEN, and the journey then navigates to exactly that string.
 *
 * That choice is what turns the fragment rule from an assertion into an
 * exercise. `lib/invite-link.spec.ts` asserts the builder emits `#token=`; this
 * navigates to whatever the builder actually produced and redeems it. Switch the
 * builder to `?token=` and this journey fails at the redemption step, because the
 * set-password page reads `location.hash` and would find nothing — the two ends
 * of OPEN-14's two-ended contract, checked against each other by use.
 *
 * It also needs no clipboard permission, which would otherwise be a browser-grant
 * dependency in the middle of a security journey.
 */
test('admin invites a person who sets a password and signs in to exactly one workspace', async ({
  browser,
  baseURL,
}) => {
  const acme = await registerOrg(baseURL!, 'acme');
  const inviteeEmail = `${unique('invitee')}@e2e.test`;

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();

  // A founding admin holds exactly one membership, which auto-activates, so the
  // app shell renders straight away with no picker in between.
  await loginAs(admin, acme.email);
  await expect(admin.getByRole('heading', { name: 'People' })).toBeVisible();

  // ---- invite --------------------------------------------------------------
  await admin.getByLabel('Email to invite').fill(inviteeEmail);
  await admin.getByLabel('Role for the invitee').selectOption('technician');
  await admin.getByRole('button', { name: 'Invite' }).click();
  await expect(admin.getByText(/Invitation sent to/)).toBeVisible();

  // ---- mint ----------------------------------------------------------------
  // "Copy invite link" is offered on PENDING rows only — the invitee has no
  // password yet, so the row is pending and the button is there.
  await admin.getByRole('button', { name: 'Copy invite link' }).click();

  const link = (await admin.locator('code').first().innerText()).trim();

  // The fragment discipline, asserted on the real rendered value before it is
  // used. Both directions: a query string is not merely absent by luck.
  expect(link, 'the invite link must carry the token in the FRAGMENT').toContain('#token=');
  expect(link, 'the token must never reach a query string').not.toContain('?token=');

  // ---- redeem, in the invitee's own browser --------------------------------
  const inviteeContext = await browser.newContext();
  const invitee = await inviteeContext.newPage();
  await invitee.goto(link);

  await expect(invitee.getByRole('heading', { name: 'Set your password' })).toBeVisible();

  // THE ADDRESS BAR IS CLEARED BEFORE ANYTHING IS TYPED. The page reads the
  // fragment once into component state and drops it with `history.replaceState`,
  // so the live credential does not sit in the URL, in history, or in a
  // screenshot taken mid-form.
  expect(
    new URL(invitee.url()).hash,
    'the token is still in the address bar after the page read it',
  ).toBe('');

  await invitee.getByLabel('New password').fill(PASSWORD);
  await invitee.getByRole('button', { name: 'Set password' }).click();

  // Redemption is PRE-AUTH and returns 204, so it does not log anyone in — it
  // routes to the sign-in form with a notice instead of inventing a session.
  await invitee.waitForURL(/\/login/);
  await expect(invitee.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // ---- sign in, and land in EXACTLY ONE workspace --------------------------
  await loginAs(invitee, inviteeEmail);

  const switcher = invitee.getByLabel('Active workspace');
  await expect(switcher).toHaveValue(acme.tenantId);
  await expect(
    switcher.locator('option'),
    'the invitee must hold exactly one workspace, and see only it',
  ).toHaveCount(1);
  await expect(invitee.getByRole('heading', { name: acme.tenantName })).toBeVisible();

  // The technician role is display-gated out of the admin section — the invitee
  // was invited as one, so the people section must not be on their page.
  await expect(
    invitee.getByRole('heading', { name: 'People' }),
    'a technician must not see the admin section',
  ).toHaveCount(0);

  await adminContext.close();
  await inviteeContext.close();
});
