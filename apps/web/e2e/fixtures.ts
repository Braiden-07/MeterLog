import { expect, request, type APIRequestContext, type Page } from '@playwright/test';

/**
 * E2E FIXTURE HELPERS — built entirely from HTTP calls to the WEB ORIGIN.
 *
 * ================ NO DATABASE, NO SEED SCRIPT, AND THAT IS THE POINT ========
 *
 * Every fixture below is a real request through the real Next rewrite to the
 * real API. Nothing here opens a Postgres connection, imports from `apps/api`,
 * or writes a row by hand — so the setup a journey depends on is itself exercised
 * by the journey, and a fixture cannot drift into describing a world the running
 * app does not produce. A seeded row inserted behind the API's back would be the
 * one thing in the test that had never met RLS, the interceptor or a DTO.
 *
 * It also keeps PR 3 to its contract: this slice tests the merged system and
 * changes none of it.
 *
 * ===================== EVERY RUN GETS ITS OWN IDENTIFIERS ===================
 *
 * `fullyParallel` is on and the database is shared across workers. Fixed emails
 * would collide — `POST /auth/register` answers 409 on an address that already
 * exists — so identity is suffixed per call. That also makes a local re-run
 * against a dirty database work without a teardown step, which matters because
 * these journeys have no truncate hook the way the API suites do.
 */
const PASSWORD = 'correct horse battery staple';

let counter = 0;

/** Collision-proof across workers AND across re-runs on a dirty database. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${process.pid.toString(36)}-${counter}`;
}

export interface Org {
  /** Its own cookie jar — this context IS the signed-in admin of the org. */
  ctx: APIRequestContext;
  tenantId: string;
  email: string;
  tenantName: string;
}

export { PASSWORD };

/**
 * Registers an organisation and returns a request context signed in as its
 * founding admin.
 *
 * REGISTRATION DOES NOT SIGN ANYONE IN — `POST /auth/register` answers 201 with
 * `{ tenantId, userId }` and sets NO cookie; only `POST /auth/login` does. So the
 * login below is the step that gives this context a session, not a convenience,
 * and without it every tenant-scoped call from this fixture is a 401.
 *
 * The login leaves the new tenant ACTIVE, because a session holding exactly one
 * membership auto-selects it (`SessionData`: null only for 0 memberships, or >1
 * with none picked). That is what lets the caller immediately create
 * tenant-scoped rows with no switch.
 */
export async function registerOrg(baseURL: string, label: string): Promise<Org> {
  const ctx = await request.newContext({ baseURL });
  const tenantName = unique(`${label}-org`);
  const email = `${unique(label)}@e2e.test`;

  const created = await ctx.post('/api/v1/auth/register', {
    data: { tenantName, email, password: PASSWORD },
  });
  expect(created.status(), 'fixture: register must succeed').toBe(201);
  const { tenantId } = (await created.json()) as { tenantId: string };

  const signedIn = await ctx.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  expect(signedIn.status(), 'fixture: login must succeed').toBe(200);

  return { ctx, tenantId, email, tenantName };
}

/** Creates one asset in the context's ACTIVE tenant. Returns its serial. */
export async function createAsset(org: Org, serialNumber: string): Promise<string> {
  const created = await org.ctx.post('/api/v1/assets', {
    data: { serialNumber, type: 'meter' },
  });
  expect(created.status(), `fixture: creating ${serialNumber} must succeed`).toBe(201);
  return serialNumber;
}

/**
 * Invites `email` into the context's active tenant.
 *
 * An invitee who ALREADY has a password gets a live membership immediately —
 * there is no pending state to redeem — which is what the eviction journey uses
 * to give one person two workspaces.
 */
export async function invite(org: Org, email: string, role: string): Promise<void> {
  const sent = await org.ctx.post('/api/v1/users', { data: { email, role } });
  expect(sent.status(), `fixture: inviting ${email} must succeed`).toBe(201);
}

/** Signs in through the real form and waits for the app to settle. */
export async function loginAs(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/**
 * Picks a workspace from the cold-load picker.
 *
 * A session holding more than one membership starts with NO active workspace, so
 * this is the ordinary path for a two-workspace person rather than a special
 * case — `app/page.tsx` routes them here.
 */
export async function chooseWorkspace(page: Page, tenantName: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(tenantName) }).click();
}

/** The switcher in the app shell. */
export async function switchWorkspaceTo(page: Page, tenantId: string): Promise<void> {
  await page.getByLabel('Active workspace').selectOption(tenantId);
}
