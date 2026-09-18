import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module';
import { NEST_APP_OPTIONS, configureApp } from '../../src/bootstrap';
import { ARGON2_OPTIONS } from '../../src/auth/auth.service';
import { SESSION_COOKIE } from '../../src/common/session/session.service';
import { loadEnv, migratorClient, resetDatabase } from '../db/helpers';

/**
 * Step 8 (OPEN-7) over real HTTP — the invite → set-password → login journey,
 * the uniform invite response, and the login-uniformity triple.
 *
 * WHAT THIS FILE IS AND IS NOT. These are the OUTER checks: the HTTP surface
 * behaves, the response bodies carry no oracle, the gate refuses cleanly. The
 * database-layer properties — single-use consume, TTL, the monotonic guard, the
 * both-or-neither transaction, tenant scoping inside the function bodies — are
 * proven in `test/db/set-password.spec.ts` by calling the definer functions
 * DIRECTLY as `meterlog_app` with nothing in front of them. Neither file may be
 * read as covering the other's ground: the functions are `EXECUTE`-able by the
 * app role, so anything holding that connection bypasses everything here.
 */
describe('set-password and invite uniformity over HTTP (step 8 — OPEN-7)', () => {
  let app: INestApplication;
  let migrator: PrismaClient;

  const http = () => request(app.getHttpServer());
  const PASSWORD = 'correct horse battery staple';

  beforeAll(async () => {
    loadEnv();
    migrator = migratorClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    // The SAME pipeline production runs — prefix, parsers, headers,
    // validation — rather than a hand-copy of it (src/bootstrap.ts).
    configureApp(app);
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

  async function login(email: string, password = PASSWORD): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = setCookie?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    if (!cookie) throw new Error(`no session cookie issued for ${email}`);
    return cookie;
  }

  async function newOrg(tenantName: string, email: string): Promise<string> {
    await http()
      .post('/api/v1/auth/register')
      .send({ tenantName, email, password: PASSWORD })
      .expect(201);
    return login(email);
  }

  async function invite(cookie: string, email: string, role = 'technician'): Promise<void> {
    await http().post('/api/v1/users').set('Cookie', cookie).send({ email, role }).expect(201);
  }

  /**
   * MIGRATED AT THE PENDING SPLIT (OPEN-14). This used to return a token per row,
   * because the GET minted one on every read. It is now the metadata read it
   * always should have been, and `mintFor` below is where a token comes from.
   *
   * The signature no longer names `token`, which is the point: every call site
   * that wanted a credential had to be rewritten to ask for one explicitly, and
   * the ones that only ever wanted the LIST — the tenant-scoping assertions
   * below — are unchanged and now no longer mint as a side effect of asserting.
   */
  async function pendingList(
    cookie: string,
  ): Promise<{ membershipId: string; email: string; role: string }[]> {
    const res = await http().get('/api/v1/users/pending').set('Cookie', cookie).expect(200);
    return res.body;
  }

  /** Mints a redemption token for one pending invitee, by email. */
  async function mintFor(cookie: string, email: string): Promise<string> {
    const row = (await pendingList(cookie)).find((p) => p.email === email);
    if (!row) throw new Error(`${email} is not pending`);
    const res = await http()
      .post(`/api/v1/users/pending/${row.membershipId}/token`)
      .set('Cookie', cookie)
      .send()
      .expect(201);
    return res.body.token;
  }

  // =========================================================================
  describe('the journey OPEN-7 exists to make possible', () => {
    it('admin invites → invitee sets a password → invitee logs in → sees exactly one workspace', async () => {
      // THE DEAD-END, CLOSED. Before step 8 this sequence was impossible: the
      // invited identity carried a sentinel hash matching nothing, and the global
      // email uniqueness meant they could not register their own org either.
      const adminCookie = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(adminCookie, 'newcomer@acme.test');

      const [pending] = await pendingList(adminCookie);
      expect(pending!.email).toBe('newcomer@acme.test');

      // MIGRATED AT OPEN-14: the token comes from an explicit mint now, not from
      // having looked at the list. The journey gains one step and loses the
      // property that reading the list destroyed the link.
      const token = await mintFor(adminCookie, 'newcomer@acme.test');

      await http()
        .post('/api/v1/auth/set-password')
        .send({ token, password: PASSWORD })
        .expect(204);

      const cookie = await login('newcomer@acme.test');
      const me = await http().get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

      expect(me.body.user.email).toBe('newcomer@acme.test');
      expect(me.body.workspaces).toHaveLength(1);
      expect(me.body.activeWorkspace).toMatchObject({
        name: 'Acme Metering',
        role: 'technician',
      });
    });

    it('set-password needs NO session — it is reachable by someone who cannot log in', async () => {
      // The endpoint carries no `@RequiresSession()`, and that is the design
      // rather than an omission: the caller is by definition someone with no
      // credentials. Asserted by sending no cookie at all.
      const adminCookie = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(adminCookie, 'newcomer@acme.test');
      const token = await mintFor(adminCookie, 'newcomer@acme.test');

      await http()
        .post('/api/v1/auth/set-password')
        .send({ token, password: PASSWORD })
        .expect(204);
    });

    it('a redeemed token is refused on replay, as a 400 with one generic code', async () => {
      const adminCookie = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(adminCookie, 'newcomer@acme.test');
      const token = await mintFor(adminCookie, 'newcomer@acme.test');

      await http()
        .post('/api/v1/auth/set-password')
        .send({ token, password: PASSWORD })
        .expect(204);

      const replay = await http()
        .post('/api/v1/auth/set-password')
        .send({ token, password: 'a different password entirely' })
        .expect(400);
      expect(replay.body.error.code).toBe('INVALID_TOKEN');

      // And the ORIGINAL password still works — the replay changed nothing.
      await login('newcomer@acme.test');
    });

    it('a forged token gets the SAME 400 and the SAME code as a replayed one', async () => {
      // One code for unknown, expired and consumed alike. Distinguishing them
      // would confirm to a caller that a token was once real, which is an oracle
      // over the token space (the MB002 reasoning applied to tokens).
      await newOrg('Acme Metering', 'admin@acme.test');

      const forged = await http()
        .post('/api/v1/auth/set-password')
        .send({ token: 'f'.repeat(64), password: PASSWORD })
        .expect(400);
      expect(forged.body.error.code).toBe('INVALID_TOKEN');
    });
  });

  // =========================================================================
  describe('the invite response carries no account-existence oracle', () => {
    it('body AND status are byte-identical whether or not the email already had an account', async () => {
      // `userCreated` was on the wire until step 8. Any tenant admin could invite
      // an address, read the flag, and learn whether that person holds an account
      // ANYWHERE — across every tenant, including ones the caller cannot see.
      // `users` is global identity (ADR-006 §2), which is exactly what makes the
      // leak cross-tenant rather than local.
      const adminCookie = await newOrg('Acme Metering', 'admin@acme.test');
      // A person who already exists, in a DIFFERENT tenant the admin cannot see.
      await newOrg('Beta Water', 'multi@beta.test');

      const unknown = await http()
        .post('/api/v1/users')
        .set('Cookie', adminCookie)
        .send({ email: 'brand-new@acme.test', role: 'technician' });

      const existing = await http()
        .post('/api/v1/users')
        .set('Cookie', adminCookie)
        .send({ email: 'multi@beta.test', role: 'auditor' });

      expect(unknown.status, 'status must not distinguish the branches').toBe(existing.status);
      expect(unknown.status).toBe(201);
      expect(
        JSON.stringify(unknown.body),
        'body must not distinguish the branches',
        // Byte-for-byte, not "shape matches": a field whose VALUE differed would
        // be just as much of an oracle as a field whose presence did.
      ).toBe(JSON.stringify(existing.body));
      expect(unknown.body).toEqual({ message: 'Invitation sent.' });

      // Non-vacuity: the two calls really did take different internal branches.
      // Without this the assertion above would pass if both had, say, failed
      // identically, or if neither email had existed.
      const [counts] = await migrator.$queryRawUnsafe<{ created: number; attached: number }[]>(
        `SELECT (SELECT count(*)::int FROM public.users WHERE email = 'brand-new@acme.test'::citext) AS created,
                (SELECT count(*)::int FROM public.users WHERE email = 'multi@beta.test'::citext)    AS attached`,
      );
      expect(counts!.created, 'the unknown email must have created an identity').toBe(1);
      expect(counts!.attached, 'the existing email must NOT have created a second identity').toBe(1);
    });

    it('an already-credentialled invitee is never offered a token', async () => {
      // The invite path is not a password-reset path. An existing user joining a
      // second workspace changes their password through an authenticated flow,
      // never through an invitation.
      const adminCookie = await newOrg('Acme Metering', 'admin@acme.test');
      await newOrg('Beta Water', 'multi@beta.test');

      await invite(adminCookie, 'multi@beta.test', 'auditor');
      await invite(adminCookie, 'brand-new@acme.test');

      const pending = await pendingList(adminCookie);
      expect(
        pending.map((p) => p.email),
        'only the pending identity may be offered a token',
      ).toEqual(['brand-new@acme.test']);

      // And their existing credential still works, unchanged.
      await login('multi@beta.test');
    });
  });

  // =========================================================================
  describe('login uniformity — the triple', () => {
    /**
     * THE HAZARD THIS GUARDS (ADR-006 §7 (ii)). `password_set_at` gives the
     * system, for the first time, a column that says "this account is a pending
     * invite". An `if (invitePending) return early` in the login path would be a
     * THIRD branch costing nothing, beside two that deliberately cost a full
     * argon2 verify each — and it would be remotely observable, letting an
     * attacker time the endpoint and learn which addresses hold un-activated
     * invites.
     *
     * THE GRANT IS A FLOOR UNDER THE OBVIOUS PATH, NOT UNDER ALL OF THEM, and
     * the difference was established by mutation rather than assumed. Two
     * structural defences stop a direct read from the login path: `meterlog_app`
     * holds no grant on `password_set_at` (catalog assertion 18), and RLS would
     * return zero rows anyway, because login runs pre-session with no GUCs set
     * and no `users` policy matches. Installing an `if (pending) return early`
     * that queries the column directly produces a 500, not an oracle.
     *
     * **But `login_lookup` is SECURITY DEFINER, and it bypasses both.** Extending
     * its `RETURNS TABLE` with `password_set_at` — a two-line change that looks
     * entirely reasonable — hands the pending flag to the login path with no
     * grant and no policy in the way. Verified: with that change plus an early
     * return, `pending` drops to ~15ms while the other branches stay at ~43ms.
     *
     * **So this test is not a backstop for that path; it is the ONLY cover.**
     * Do not delete it on the grounds that the grant handles it — the grant
     * does not reach the definer function, which is exactly where a future
     * change is most likely to go looking for the column.
     */
    async function seedTriple(): Promise<void> {
      const adminCookie = await newOrg('Acme Metering', 'admin@acme.test');
      // A genuinely pending invite: real row, sentinel hash, password_set_at NULL.
      await invite(adminCookie, 'pending@acme.test');
    }

    it('all three failures return the identical status and body', async () => {
      await seedTriple();

      const pendingUser = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'pending@acme.test', password: PASSWORD });

      const wrongPassword = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'admin@acme.test', password: 'not the right password at all' });

      const unknownEmail = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@acme.test', password: PASSWORD });

      for (const [name, res] of [
        ['placeholder-password user', pendingUser],
        ['wrong password', wrongPassword],
        ['unknown email', unknownEmail],
      ] as const) {
        expect(res.status, `${name} must be 401`).toBe(401);
        expect(res.body.error.code, `${name} must carry the generic code`).toBe(
          'INVALID_CREDENTIALS',
        );
      }

      // Byte-identical bodies across all three — a differing message would be as
      // much of an oracle as a differing status.
      expect(JSON.stringify(pendingUser.body)).toBe(JSON.stringify(wrongPassword.body));
      expect(JSON.stringify(pendingUser.body)).toBe(JSON.stringify(unknownEmail.body));
    });

    it('all three cost a real argon2 verify — no branch returns early', async () => {
      await seedTriple();

      /**
       * Medians over repeated samples, not single measurements: a single sample
       * on a loaded CI box says nothing.
       *
       * THE THRESHOLD IS CALIBRATED AGAINST A MEASURED ARGON2 VERIFY, and that
       * calibration is the whole design of this test. The first version asserted
       * relative bounds instead — every median within 4x of the slowest, spread
       * under 3x — and a mutation proved those were DECORATION: with the hazard
       * branch actually installed in the login path, the test still passed. An
       * argon2id verify at the production cost is ~33ms against a total request
       * of ~50ms, so skipping it leaves a branch at ~17ms — comfortably inside
       * any loose ratio, and completely invisible to one.
       *
       * So the property is stated in the units of the thing being protected: if
       * every branch runs one argon2 verify, the SPREAD between the fastest and
       * slowest branch must be a fraction of ONE verify. If a branch skips it,
       * the spread is approximately one whole verify. Half a verify separates
       * those two worlds with room for ordinary jitter on either side.
       *
       * The verify cost is measured here, in-process, rather than hardcoded: a
       * millisecond constant would be a statement about this machine, and would
       * silently stop meaning anything the moment ARGON2_OPTIONS is tuned — the
       * same drift that made `dummyVerifyTarget` derive its hash from the shared
       * options object instead of a literal.
       */
      const sample = async (email: string, password: string): Promise<number> => {
        const started = process.hrtime.bigint();
        await http().post('/api/v1/auth/login').send({ email, password }).expect(401);
        return Number(process.hrtime.bigint() - started) / 1e6;
      };

      const median = (xs: number[]): number => {
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)]!;
      };

      const argonProbe = await argonHash('a value that is never a real password', ARGON2_OPTIONS);

      /*
       * FOUR ARMS, NOT THREE. The fourth is a CONTROL: the unknown-email branch
       * sampled a second time under a different address. Two arms that exercise
       * IDENTICAL code must differ only by measurement noise, so the control
       * spread is this machine's noise floor, measured rather than guessed.
       *
       * It is needed because the first calibration was not robust enough: the
       * argon2 probe alone read anywhere between 11ms and 33ms depending on
       * machine load, which moved the threshold by 3x while the HTTP noise stayed
       * around 6-10ms. A threshold that swings independently of the thing it is
       * bounding produces exactly the flaky test this suite must not contain.
       *
       * ORDER IS ROTATED EACH ITERATION. Sampling the arms in a fixed order gave
       * the last one a consistent penalty — visible as a stable ~6ms ordering
       * effect that had nothing to do with argon2. Rotation spreads that cost
       * evenly instead of attributing it to one branch.
       *
       * The argon2 probe is INTERLEAVED with the HTTP samples rather than run up
       * front, so the calibration experiences the same machine conditions as the
       * measurements it calibrates.
       */
      const RUNS = 9;
      const arms: Record<string, number[]> = { pending: [], wrong: [], unknown: [], control: [] };
      const probe: number[] = [];
      const order = ['pending', 'wrong', 'unknown', 'control'] as const;
      const call: Record<string, () => Promise<number>> = {
        pending: () => sample('pending@acme.test', PASSWORD),
        wrong: () => sample('admin@acme.test', 'not the right password at all'),
        unknown: () => sample('nobody@acme.test', PASSWORD),
        control: () => sample('also-nobody@acme.test', PASSWORD),
      };

      for (let i = 0; i < RUNS; i++) {
        for (let k = 0; k < order.length; k++) {
          const arm = order[(i + k) % order.length]!;
          arms[arm]!.push(await call[arm]!());
        }
        const started = process.hrtime.bigint();
        await argonVerify(argonProbe, 'definitely the wrong password').catch(() => false);
        probe.push(Number(process.hrtime.bigint() - started) / 1e6);
      }

      const medians = {
        pending: median(arms.pending!),
        wrong: median(arms.wrong!),
        unknown: median(arms.unknown!),
      };
      const argonCost = median(probe);

      // Noise floor: two arms running IDENTICAL code (unknown vs control).
      const noise = Math.abs(median(arms.unknown!) - median(arms.control!));
      const spread = Math.max(...Object.values(medians)) - Math.min(...Object.values(medians));

      // Non-vacuity on the calibration itself. A probe reporting an implausible
      // cost would make the comparison meaningless — the `readWorkspaces` lesson
      // applied to a measurement rather than a row count.
      expect(argonCost, 'the argon2 calibration probe is implausibly fast').toBeGreaterThan(1);

      // THE ASSERTION. Subtract the measured noise from the measured spread, and
      // require the remainder to be under half an argon2 verify. A branch that
      // skips the verify contributes a WHOLE verify to the spread and cannot hide
      // under this; ordinary jitter is accounted for rather than tolerated by a
      // loose constant.
      const excess = spread - noise;
      expect(
        excess,
        `login timing differs across the three branches by ${spread.toFixed(1)}ms, ` +
          `${excess.toFixed(1)}ms of which is beyond this machine's measured noise floor ` +
          `(${noise.toFixed(1)}ms, from two arms running identical code). That excess is ` +
          `${(excess / argonCost).toFixed(2)}x a measured argon2 verify (${argonCost.toFixed(1)}ms), ` +
          `and a branch that SKIPS the verify contributes about one whole verify. ` +
          `Medians: ${JSON.stringify(medians)}. This is the enumeration oracle ADR-006 §7 (ii) ` +
          `warns about — check for an early return in the login path, or for a real argon2 ` +
          `verify running on some branches but not others.`,
      ).toBeLessThan(argonCost * 0.5);
    });
  });

  // =========================================================================
  describe('tenant scoping over HTTP', () => {
    it("an admin of A cannot read B's pending invites", async () => {
      const aCookie = await newOrg('Acme Metering', 'admin@acme.test');
      const bCookie = await newOrg('Beta Water', 'admin@beta.test');
      await invite(aCookie, 'a-invitee@acme.test');
      await invite(bCookie, 'b-invitee@beta.test');

      // Non-vacuity: B really does have a pending invite to leak.
      expect((await pendingList(bCookie)).map((p) => p.email)).toEqual(['b-invitee@beta.test']);

      // A sees only A. There is no cross-tenant parameter to pass — the tenant
      // comes from the session-derived GUC — so the isolation is structural and
      // this asserts the result of that rather than a rejected attempt.
      expect((await pendingList(aCookie)).map((p) => p.email)).toEqual(['a-invitee@acme.test']);
    });

    it('an admin of A inviting into B is impossible: the invite has no tenant parameter', async () => {
      // ADR-006 §7 (b) is STRUCTURAL for invite — `invite_member` takes the
      // tenant from `app.current_tenant`, which the interceptor sets only after
      // re-verifying the caller's live membership. There is no tenant field on
      // the DTO to abuse, so the assertion is that a body carrying one is
      // REJECTED at the boundary rather than silently honoured.
      const aCookie = await newOrg('Acme Metering', 'admin@acme.test');
      const bCookie = await newOrg('Beta Water', 'admin@beta.test');

      const [beta] = await migrator.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM public.tenants WHERE name = 'Beta Water'`,
      );

      // `forbidNonWhitelisted` turns a smuggled tenant field into a 400. If this
      // ever became a 201, the field would be reaching the service.
      await http()
        .post('/api/v1/users')
        .set('Cookie', aCookie)
        .send({ email: 'target@acme.test', role: 'admin', tenantId: beta!.id })
        .expect(400);

      // And B is untouched — the negative is not merely "the request failed".
      expect((await pendingList(bCookie)).map((p) => p.email)).toEqual([]);
      const [count] = await migrator.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.memberships WHERE tenant_id = $1::uuid`,
        beta!.id,
      );
      expect(count!.n, "B's membership set must be unchanged").toBe(1);
    });

    it('a non-admin member cannot read the pending list, and gets the GATE 403', async () => {
      // Two independent checks stand behind this endpoint: the RBAC gate
      // (`FORBIDDEN_ROLE`) and `list_pending_invites`'s own live-admin check
      // (`NOT_ADMIN`). They carry DIFFERENT codes on purpose — the step-5 lesson,
      // where two layers answering identically meant the outer one could be
      // deleted with every test still green.
      //
      // Asserting FORBIDDEN_ROLE here is therefore asserting that the GATE acted.
      // The inner check is proven separately, with nothing in front of it, in
      // `test/db/set-password.spec.ts`.
      const adminCookie = await newOrg('Acme Metering', 'admin@acme.test');
      await invite(adminCookie, 'tech@acme.test');
      const token = await mintFor(adminCookie, 'tech@acme.test');
      await http()
        .post('/api/v1/auth/set-password')
        .send({ token, password: PASSWORD })
        .expect(204);
      const techCookie = await login('tech@acme.test');

      const res = await http()
        .get('/api/v1/users/pending')
        .set('Cookie', techCookie)
        .expect(403);
      expect(res.body.error.code, 'the RBAC gate must be what refuses here').toBe('FORBIDDEN_ROLE');

      // The ordinary member list is still open to them — the gate is on this
      // route, not on the module (ADR-006 §3 co-member visibility).
      await http().get('/api/v1/users').set('Cookie', techCookie).expect(200);
    });
  });
});
