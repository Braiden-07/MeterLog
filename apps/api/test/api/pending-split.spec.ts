import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * THE PENDING SPLIT (OPEN-14) — `GET /users/pending` stops changing state, and
 * minting moves to an explicit `POST /users/pending/:membershipId/token`.
 *
 * WHAT WAS WRONG, STATED AS A PROPERTY RATHER THAN A STYLE COMPLAINT. The old
 * `GET` called `list_pending_invites`, which marks every live token consumed and
 * mints a replacement on every read. Two consequences, both real:
 *
 *   (i)  It breaks the condition the ADR-001 amendment attaches to
 *        `SameSite=Lax` — the cookie is withheld from cross-site POST but still
 *        sent on a top-level cross-site GET, so Lax is CSRF protection only
 *        while every GET is safe in the RFC 9110 §9.2.1 sense. A GET whose
 *        RESPONSE IS the state change fails that test outright.
 *   (ii) A window-focus refetch is a denial of service against a token the
 *        admin has already copied into an email. The frontend slice makes that
 *        refetch routine rather than hypothetical, which is why the split is
 *        owed BEFORE the admin UI, not with it.
 *
 * THE TWO GET NEGATIVES BELOW ARE DELIBERATELY SEPARATE ASSERTIONS, and the
 * separation is the point rather than thoroughness. "Writes nothing" and "returns
 * no token" are different regressions with different blast radii: a GET that
 * stopped minting but still returned a token would be a stale-credential leak,
 * and a GET that dropped the token from its body but kept minting would still be
 * the (i)/(ii) DoS with the damage invisible in the response. Either one alone
 * passes while the other fails, so neither is allowed to stand in for the other.
 *
 * These are the OUTER checks — HTTP, real session cookies, the real interceptor.
 * The new definer function's own body is proven with nothing in front of it, by
 * direct call as `meterlog_app` with the GUCs set by hand, in
 * `test/db/mint-invite-token.spec.ts`. Neither file may be relaxed on the
 * strength of the other (the step-5 two-layer rule, ADR-006 §7).
 */
describe('the pending split (OPEN-14) — a safe GET and an explicit mint', () => {
  let app: INestApplication;
  let migrator: PrismaClient;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';

  beforeAll(async () => {
    loadEnv();
    migrator = migratorClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await resetDatabase(migrator);
    await app.close();
    await migrator.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(migrator);
  });

  async function login(email: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = setCookie?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    if (!cookie) throw new Error(`no session cookie issued for ${email}`);
    return cookie;
  }

  async function newOrg(
    tenantName: string,
    email: string,
  ): Promise<{ cookie: string; tenantId: string }> {
    const created = await http()
      .post('/api/v1/auth/register')
      .send({ tenantName, email, password: PASSWORD })
      .expect(201);
    return { cookie: await login(email), tenantId: created.body.tenantId };
  }

  async function invite(cookie: string, email: string, role = 'technician'): Promise<void> {
    await http().post('/api/v1/users').set('Cookie', cookie).send({ email, role }).expect(201);
  }

  /** The metadata read. Deliberately typed WITHOUT a token — see the shape assertion. */
  async function pendingList(
    cookie: string,
  ): Promise<{ membershipId: string; userId: string; email: string; role: string }[]> {
    const res = await http().get('/api/v1/users/pending').set('Cookie', cookie).expect(200);
    return res.body;
  }

  /**
   * Mints for one membership. The ONE secret response body in the API.
   *
   * Returns supertest's chainable request rather than a promise, so call sites
   * read `await mint(...).expect(201)` and a wrong status names itself.
   */
  function mint(cookie: string, membershipId: string): request.Test {
    return http().post(`/api/v1/users/pending/${membershipId}/token`).set('Cookie', cookie).send();
  }

  async function membershipIdOf(email: string, cookie: string): Promise<string> {
    const list = await http().get('/api/v1/users').set('Cookie', cookie).expect(200);
    const row = (list.body as { email: string; membershipId: string }[]).find(
      (m) => m.email === email,
    );
    if (!row) throw new Error(`${email} is not in the member list`);
    return row.membershipId;
  }

  /**
   * EVERY column of EVERY `invite_tokens` row, ordered deterministically.
   *
   * The whole table rather than a count, and every column rather than the ones
   * the mint touches. A count alone cannot see the supersede — marking a live
   * token consumed and inserting a replacement leaves the count changed by
   * exactly one either way, and marking one consumed with no insert leaves it
   * unchanged entirely. `token_hash` is included so that a re-mint that
   * coincidentally preserved every timestamp would still be visible.
   */
  async function tokenTableSnapshot(): Promise<string> {
    const rows = await migrator.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id::text, user_id::text, tenant_id::text, encode(token_hash, 'hex') AS token_hash,
              expires_at, consumed_at, created_at
         FROM public.invite_tokens
        ORDER BY id`,
    );
    return JSON.stringify(rows);
  }

  /** Live (unconsumed, unexpired) tokens for a person in a tenant. */
  async function liveTokenCount(email: string, tenantId: string): Promise<number> {
    const [row] = await migrator.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n
         FROM public.invite_tokens t
         JOIN public.users u ON u.id = t.user_id
        WHERE u.email = $1::citext
          AND t.tenant_id = $2::uuid
          AND t.consumed_at IS NULL
          AND t.expires_at > now()`,
      email,
      tenantId,
    );
    return row!.n;
  }

  // =========================================================================
  describe('GET /users/pending is a safe GET', () => {
    it('two consecutive GETs leave invite_tokens BYTE-IDENTICAL', async () => {
      // THE OPEN-14 NEGATIVE. Against the pre-split endpoint this fails on the
      // second call: `list_pending_invites` supersedes the live token and inserts
      // a replacement every time it is read, so the table differs after a read
      // that asked for nothing but a list of names.
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(cookie, 'newcomer@acme.test');

      const before = await tokenTableSnapshot();
      await pendingList(cookie);
      const afterFirst = await tokenTableSnapshot();
      await pendingList(cookie);
      const afterSecond = await tokenTableSnapshot();

      expect(afterFirst, 'the first GET wrote to invite_tokens').toBe(before);
      expect(afterSecond, 'the second GET wrote to invite_tokens').toBe(afterFirst);
    });

    it('the response body carries NO token and NO expiresAt — only metadata', async () => {
      // SEPARATE FROM THE ASSERTION ABOVE, deliberately. A token-less endpoint
      // that still writes and a writing endpoint that still returns a token are
      // different regressions; each of these two tests passes while the other
      // fails, so neither covers the other.
      //
      // Asserted as an EXACT key set, not as "token is undefined": a field added
      // back under any other name — `inviteToken`, `secret`, a nested object — is
      // the same leak, and `toEqual` on the key list is what sees it.
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(cookie, 'newcomer@acme.test');

      const body = await pendingList(cookie);
      expect(body).toHaveLength(1);
      expect(Object.keys(body[0]!).sort()).toEqual([
        'email',
        'invitedAt',
        'membershipId',
        'role',
        'userId',
      ]);
      expect(
        JSON.stringify(body),
        'no value anywhere in the body may look like a token',
      ).not.toMatch(/[0-9a-f]{64}/);
    });

    it('still lists the right people — the safe GET is not safe by being empty', async () => {
      // Non-vacuity for both assertions above: they would pass trivially against
      // an endpoint that returned nothing at all.
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      await newOrg('Beta Water', 'multi@beta.test');
      await invite(cookie, 'newcomer@acme.test');
      await invite(cookie, 'multi@beta.test', 'auditor');

      const body = await pendingList(cookie);
      expect(
        body.map((p) => p.email),
        'only the PENDING invitee is listed — the credentialled one is not pending',
      ).toEqual(['newcomer@acme.test']);
      expect(body[0]).toMatchObject({ role: 'technician' });
    });

    it('is still admin-only, and it is the GATE that refuses', async () => {
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(cookie, 'tech@acme.test');
      const membershipId = await membershipIdOf('tech@acme.test', cookie);
      const minted = await mint(cookie, membershipId).expect(201);
      await http()
        .post('/api/v1/auth/set-password')
        .send({ token: minted.body.token, password: PASSWORD })
        .expect(204);

      const techCookie = await login('tech@acme.test');
      const res = await http().get('/api/v1/users/pending').set('Cookie', techCookie).expect(403);
      expect(res.body.error.code, 'the RBAC gate must be what refuses here').toBe('FORBIDDEN_ROLE');
    });
  });

  // =========================================================================
  describe('POST /users/pending/:membershipId/token mints exactly one', () => {
    it('leaves EXACTLY ONE live token for that (user, tenant), however many times it is called', async () => {
      const { cookie, tenantId } = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(cookie, 'newcomer@acme.test');
      const membershipId = await membershipIdOf('newcomer@acme.test', cookie);

      const first = await mint(cookie, membershipId).expect(201);
      expect(await liveTokenCount('newcomer@acme.test', tenantId)).toBe(1);

      const second = await mint(cookie, membershipId).expect(201);
      expect(
        await liveTokenCount('newcomer@acme.test', tenantId),
        'a second mint must supersede the first, not accumulate',
      ).toBe(1);

      // Non-vacuity: the two mints really did issue DIFFERENT tokens. Without
      // this, a function that returned the same token twice would pass.
      expect(second.body.token).not.toBe(first.body.token);
      expect(second.body.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('the response is 201 and carries Cache-Control: no-store', async () => {
      // THE ONE SECRET RESPONSE BODY IN THE API. `no-store` is on THIS route
      // specifically, because this is the only response whose body is a live
      // credential — an intermediary or the browser's disk cache holding it is a
      // credential at rest outside the two places the design permits (the mint
      // transaction's return value and the invitee's link).
      //
      // 201 rather than 200: the call CREATES a token resource. The brief permits
      // either; 201 is the named choice, asserted so it cannot drift silently.
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(cookie, 'newcomer@acme.test');
      const membershipId = await membershipIdOf('newcomer@acme.test', cookie);

      const res = await mint(cookie, membershipId).expect(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.body).sort()).toEqual([
        'email',
        'expiresAt',
        'invitedAt',
        'membershipId',
        'role',
        'token',
        'userId',
      ]);
    });

    it('the PREVIOUSLY issued token is refused on redemption — 400 INVALID_TOKEN', async () => {
      // The supersede, proven by its consequence rather than by reading the
      // table. "At most one redeemable token per pending invite" is only a real
      // property if the superseded one actually stops working.
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(cookie, 'newcomer@acme.test');
      const membershipId = await membershipIdOf('newcomer@acme.test', cookie);

      const first = await mint(cookie, membershipId).expect(201);
      const second = await mint(cookie, membershipId).expect(201);

      const replay = await http()
        .post('/api/v1/auth/set-password')
        .send({ token: first.body.token, password: PASSWORD })
        .expect(400);
      expect(replay.body.error.code).toBe('INVALID_TOKEN');

      // And the SURVIVING token still works — otherwise "supersede" could be
      // satisfied by breaking both.
      await http()
        .post('/api/v1/auth/set-password')
        .send({ token: second.body.token, password: PASSWORD })
        .expect(204);
      await login('newcomer@acme.test');
    });

    it('a membership in ANOTHER tenant → 404, indistinguishable from one that does not exist', async () => {
      // `MEMBERSHIP_NOT_FOUND` semantics, restated for a new function: "belongs
      // to another tenant" and "does not exist" are one code by design, so the
      // endpoint cannot be used to probe for membership ids in tenants the caller
      // cannot see.
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      const { cookie: betaCookie } = await newOrg('Beta Water', 'admin@beta.test');
      await invite(betaCookie, 'b-invitee@beta.test');
      const foreign = await membershipIdOf('b-invitee@beta.test', betaCookie);

      const res = await mint(cookie, foreign).expect(404);
      expect(res.body.error.code).toBe('MEMBERSHIP_NOT_FOUND');

      // Beta's invitee was not minted for, and Acme's admin learned nothing.
      const [n] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.invite_tokens`,
      );
      expect(n!.n, 'a refused mint must write nothing').toBe(0);
    });

    it('an ALREADY-CREDENTIALLED member is refused, not handed a token', async () => {
      // The invite path is not a password-reset path (ADR-016). A member who
      // already has a usable password is not pending, so there is nothing to
      // mint — and minting anyway would hand a tenant admin a credential for an
      // account that exists across the whole system.
      const { cookie, tenantId } = await newOrg('Acme Metering', 'admin@acme.test');
      await newOrg('Beta Water', 'multi@beta.test');
      await invite(cookie, 'multi@beta.test', 'auditor');
      const membershipId = await membershipIdOf('multi@beta.test', cookie);

      const res = await mint(cookie, membershipId).expect(409);
      expect(res.body.error.code).toBe('NOT_PENDING');
      expect(res.body.token, 'a refusal must not carry a token').toBeUndefined();
      expect(await liveTokenCount('multi@beta.test', tenantId)).toBe(0);

      // Their existing credential is untouched.
      await login('multi@beta.test');
    });

    it('a non-admin is refused by the GATE — 403 FORBIDDEN_ROLE', async () => {
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(cookie, 'tech@acme.test');
      await invite(cookie, 'newcomer@acme.test');
      const techMembership = await membershipIdOf('tech@acme.test', cookie);
      const activated = await mint(cookie, techMembership).expect(201);
      await http()
        .post('/api/v1/auth/set-password')
        .send({ token: activated.body.token, password: PASSWORD })
        .expect(204);
      const techCookie = await login('tech@acme.test');

      const target = await membershipIdOf('newcomer@acme.test', cookie);
      const res = await mint(techCookie, target).expect(403);
      // FORBIDDEN_ROLE, not NOT_ADMIN: asserting the GATE acted. The function
      // body's own refusal carries a different code and is proven with nothing in
      // front of it in test/db/mint-invite-token.spec.ts.
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
    });

    it('rejects a malformed membership id at the pipe — 400, in the project envelope', async () => {
      // THE BRIEF §12 BAR, asserted rather than assumed. The DoD box requires
      // every essential endpoint to carry validation and the error envelope.
      // This endpoint's entire input surface is one path parameter — it takes no
      // body, like `POST /auth/logout` — so `ParseUUIDPipe` IS its validation,
      // and it must refuse before any database work rather than passing a junk
      // string to a `::uuid` cast and surfacing 22P02 as a 500.
      const { cookie } = await newOrg('Acme Metering', 'admin@acme.test');
      const res = await http()
        .post('/api/v1/users/pending/not-a-uuid/token')
        .set('Cookie', cookie)
        .send()
        .expect(400);

      expect(res.body.error, 'the project envelope, not Nest default shape').toBeDefined();
      expect(typeof res.body.error.code).toBe('string');
      expect(typeof res.body.error.message).toBe('string');

      // Nothing was written — the refusal really did precede the mint.
      const [n] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.invite_tokens`,
      );
      expect(n!.n).toBe(0);
    });

    it('appears in the OpenAPI document with a summary, like every sibling', async () => {
      // THE THIRD LEG OF THE SAME DoD BAR. Asserted against the GENERATED
      // document rather than by reading the decorator: a decorator can be present
      // and the route still absent from the spec if it is not registered where
      // Swagger looks, which is the failure a reader of the source cannot see.
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('t').setVersion('1').build(),
      );
      const path = doc.paths['/api/v1/users/pending/{membershipId}/token'];
      expect(path, 'the mint route must be in the OpenAPI document').toBeDefined();
      expect(path!.post!.summary, 'and must carry a summary, as its siblings do').toContain('Mint');
      expect(path!.post!.tags).toContain('users');

      // Non-vacuity: the sibling it is being held to the standard of is there too.
      expect(doc.paths['/api/v1/users/pending']!.get!.summary).toBeTruthy();
    });
  });
});
