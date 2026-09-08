# PROGRESS.md — MeterLog

> Running log of what was built each session, what's next, and any blockers.
> Newest entry at the top. Do not edit `PROJECT_BRIEF.md` (author-owned).

## Status

- **Current milestone:** v0.1 — auth & tenancy foundation
- **Build-order step (PROJECT_BRIEF §11):** 4 (auth + tenancy) **Phases 1–3 complete** — schema, migrations, the full two-axis RLS policy set, the two pre-auth `SECURITY DEFINER` functions with registration atomicity, and the two-GUC interceptor with per-request membership re-verification. Phase 4 (auth endpoints) not started.
- **Blockers:** —
- **Standing deployment risk (read before step 10):** locally and in CI the migration role is the cluster bootstrap **superuser**; on Render it is not. A superuser satisfies `pg_has_role` unconditionally and bypasses RLS, so a whole class of privilege defect is **invisible in both environments where the tests run** and appears for the first time against Render — green CI does not cover it. Concretely: `ALTER FUNCTION ... OWNER TO meterlog_definer` needs _membership_ in that role, and Postgres matches RLS policy roles by **membership**, so a migration role left inside `meterlog_definer` silently acquires every `TO meterlog_definer USING (true)` policy on every identity table — the FORCE-RLS bypass the three-role model exists to prevent, reintroduced through role membership. `20260908000000_auth_definer_functions` grants that membership only if missing and **revokes it again**; do not collapse that into a standing grant. It is also the **first migration that would have failed on Render**. Checklist in [`ARCHITECTURE.md` §16.1](./ARCHITECTURE.md).

---

## Session log

### 2026-09-08 — Step 4 Phase 3: the two-GUC interceptor and per-request re-verification (§11 step 4)

**Done**

- **`TenantContextInterceptor`** (`src/common/tenant-context/`) — the request machinery from ADR-004 + ADR-006 §4. One interactive transaction per authenticated request, because `SET LOCAL` is scoped to a transaction and therefore to the single pooled connection it holds. Ordering is **verify, then set**: set `app.current_user`; re-verify the claimed tenant with it passed as a **bound parameter**, never read from a GUC; zero rows ⇒ 403 with `app.current_tenant` never assigned; one row ⇒ set the tenant GUC and use the freshly-read role.
- **`RequestContext`** (`src/common/request-context/`) — `AsyncLocalStorage` carrying the transaction client, user, tenant and re-verified role. `requireRequestContext()` throws rather than returning an empty context: a handler reaching for tenant scope outside a request is a bug, and it must be loud rather than silently unscoped.
- **`SessionService`** (`src/common/session/`) — Redis-backed sessions (ADR-001), signed-cookie ids (HMAC-SHA256 over a 128-bit id, `timingSafeEqual`). The client holds only an opaque id, so it cannot forge an active tenant — the "belt" half of ADR-006 §4. **New dependency: `ioredis`**, executing ADR-001's recorded choice; Redis was already in compose, CI and `.env`.
- **`CommonModule`** provides all three. The interceptor is deliberately **not** bound via `APP_INTERCEPTOR` yet — there are no authenticated routes until Phase 4, and binding it globally now would wrap `/health` in an interactive transaction for nothing.
- **CI gained `SESSION_SECRET`.** `SessionService` refuses to construct without one, on purpose, so an unsigned-cookie deployment cannot happen by accident.

**Verified against live Postgres, with negatives**

Every case runs the **real interceptor**, and the app client is pinned to `connection_limit=1` because the failure surface this phase exists to cover is **pooled-connection statefulness**, not policy correctness — Phase 1 already proved the policy.

- **The hard one — revocation between two requests on a reused connection.** Request 1 succeeds with `app.current_tenant = A`; the membership is revoked between requests (`UPDATE 1`, asserted, so the fixture cannot silently no-op); request 2 on the **same backend** throws `ForbiddenException`, **the route handler never runs**, and the connection is left with `app.current_tenant = ''` and zero rows of A reachable. The vacuity guard is explicit: `pg_backend_pid()` is asserted equal across the two requests, because a request 2 landing on a fresh connection would prove nothing about pooled statefulness and would pass either way. (Confirmed separately that pids do differ across connections, so the assertion has real content.)
- **The session's active tenant is cleared on the 403**, so a third request stops re-asserting a workspace the user no longer holds — it succeeds with no tenant context rather than 403-looping.
- **Role changes follow the membership, not the session.** The session still cached `admin`; after an `UPDATE ... SET role = 'auditor'` the very next request reports `auditor`, with the stale session copy still sitting there unused.
- **GUC hygiene across pooled requests.** M-in-A followed by N-in-B on the same backend: no bleed, correct counts, and an unauthenticated third request gets no context at all. Asserted on **both a fresh and a reused connection**, because the ADR-004 heisenbug is asymmetric — `current_setting` returns NULL on a connection that has never had the GUC set, and the **empty string** once `SET LOCAL` has touched it. Checking only one is how that bug survived review the first time.
- **Verify-before-set ordering.** The behavioural cases cannot separate the two orderings — both end in a 403 with a rolled-back transaction and no residue — so ordering is asserted on the **emitted SQL** via Prisma query events: `set_config('app.current_user')` → the memberships re-verify → `set_config('app.current_tenant')`.
- **Liveness through the interceptor.** OPEN-5's DB-side claim, now exercised end-to-end rather than against the policy in isolation: a revoked membership yields zero rows at the re-verify ⇒ 403, with the soft-deleted row asserted still present so the test cannot pass on a fixture that failed to revoke anything.
- **Fail-closed on poisoned context:** a session naming a non-existent user, a tampered cookie signature, and a valid signature over a destroyed session all get no context.

**Mutation sweep — 9 mutations, 9 caught** (after one fix, below).

`verify-after-set`; re-verify skipped entirely; `SET` instead of `SET LOCAL` on the tenant GUC; the same on the user GUC; the `NULLIF` guard dropped; `deleted_at IS NULL` dropped from the re-verify; the re-verify moved above the user-GUC assignment; that same reordering plus the dropped `NULLIF`; and the tenant read from a GUC instead of a bound parameter.

**The one that initially escaped, and what it taught.** Dropping the `NULLIF` from the re-verify reddened _nothing_ — because the interceptor sets `app.current_user` immediately beforehand, so `current_setting` always returns a valid uuid and the guard never fires. It was unreachable-by-construction, not unnecessary: mutations 7 and 8 differ by that guard alone, and the failure modes differ exactly as ADR-004 predicts — **with** the `NULLIF` the misordered code still throws `ForbiddenException` (fail closed), **without** it a `PrismaClientKnownRequestError`, i.e. a 500 instead of a 403. Rather than leave it flagged-but-untested, a reachable case was added: a session with a **blank** `userId` writes `''` into the GUC, which is exactly the state the guard exists for. That is a real poisoned-session state (corrupted Redis value, or a future path that forgets to populate it), not a contrivance, and the property — fail closed with 403, never 500 — is one worth holding. Dropping the `NULLIF` now reddens it.

That test also demonstrated the heisenbug in miniature: run in isolation it **passes** under the mutation, because a fresh connection returns NULL rather than `''`. It only fails in a full run, once the connection has been reused. A per-test-isolation habit would have hidden it.

**Not done, and not claimed.** No endpoints — no `/auth/register`, `/auth/login`, `/auth/me`, `/auth/switch`, `/auth/logout`. No RBAC guard. The interceptor is not globally bound. Step 4's definition of done needs the round-trip, the multi-membership switch, unauthorized-switch 403, revocation as an **observable endpoint behaviour**, and role-follows-active-membership — Phase 3 makes the machinery correct and proves revocation fails closed at the re-verify layer, but none of it is observable over HTTP until Phase 4 exists.

**Next**

- **Phase 4** — the auth endpoints on top of this machinery, binding the interceptor where it belongs, and the `23505` → 409 mapping recorded in `ARCHITECTURE.md` §16.2.

---

### 2026-09-08 — Step 4 Phase 2: the pre-auth SECURITY DEFINER surface (§11 step 4)

**Done**

- **Migration `20260908000000_auth_definer_functions`** — `login_lookup(citext)` and `register_tenant(text, citext, text)`, the complete definer surface ADR-006 §6 allows. Both owned by `meterlog_definer`, `SET search_path = pg_catalog, pg_temp`, bodies fully schema-qualified, `EXECUTE` revoked from `PUBLIC` and granted only to `meterlog_app`. `EXPECTED_DEFINER_FUNCTIONS` already named both, so the allowlist needed no edit — which is the point of having declared it early.
- **`register_tenant` writes three rows atomically** — tenant, person, admin membership. Atomicity is structural rather than coded: the body opens no subtransaction because it carries no `EXCEPTION` handler, so any failure unwinds all three. The migration says so at length, because adding a handler around a _subset_ of the inserts is the one edit that breaks it silently.
- **Ownership on a non-superuser migration role.** `ALTER FUNCTION ... OWNER TO meterlog_definer` requires membership in the target role. Locally and in CI the migration role is the bootstrap superuser and this is invisible; **on Render it is not**, and this is the first migration that would have failed there. The migration now grants itself membership only if it lacks it (it holds `ADMIN OPTION` from having created the role in `20260903000000`), does the two `ALTER`s, and **revokes the membership again** — not tidiness: RLS matches policy roles by _membership_, so a migration role left inside `meterlog_definer` would silently pick up every `TO meterlog_definer USING (true)` policy on every identity table. This closes part of the open "migration privileges on Render" question ahead of step 10.
- **Catalog assertions 11 and 12** — no `SECURITY DEFINER` function is executable by `PUBLIC` (counting `proacl IS NULL`, which _is_ the permissive default, as a violation), and every one of them is executable by `meterlog_app` so 11 cannot be satisfied by a function nobody can call.
- **Catalog assertion 4 tightened from presence to content.** It checked only that some `search_path=` entry existed. A mutation showed that accepts `search_path = public, pg_catalog, pg_temp` — pin present, hardening gone. It now asserts `public` is absent from the resolution path.

**The bug this phase found — a silent, unrecoverable account lockout**

`login_lookup` was written with a bare `u.email = p_email`. Both sides are `citext`, so that looks correct and reviews as correct. It is not, under a pinned `search_path`: **citext's `=` operator lives in `public`**, which the pin deliberately excludes. The reference does not fail to resolve — it falls back through citext's implicit cast to `text` and binds case-**sensitive** `text = text`. Verified directly:

```
search_path = pg_catalog, pg_temp   ->  'a'::citext = 'A'::citext  =  false
search_path = public, pg_catalog    ->  'a'::citext = 'A'::citext  =  true
```

The blast radius is worse than a wrong answer. `users_email_live_key` resolved its citext operator class at `CREATE INDEX` time, with `public` in scope, so **uniqueness stayed case-insensitive while the lookup became case-sensitive**. Register as `Founder@acme.test`, then log in as `founder@acme.test`: no row, generic auth failure — and re-registering is refused by the index. The account is unreachable and unrecoverable, with no error anywhere.

Fixed by schema-qualifying the operator, `u.email OPERATOR(public.=) p_email` — **not** by adding `public` to the `search_path`, which is the whole thing the pin exists to prevent. Note the shape: ADR-004 justified the pin on the grounds that an unqualified reference "fails outright rather than resolving wrongly". That is true of functions and tables. It is **not** true of operators, which fall back through implicit casts and resolve to something plausible and wrong. Definer-probe case E covers the failing kind; this was the silent kind.

**Verified against live Postgres, with negatives** (as `meterlog_app`, no request context set)

- **`register_tenant` positive:** three linked rows, membership role `admin`, reachable with no context at all. **Negative:** the same `INSERT`s attempted directly by the app role — `permission denied` on both `tenants` and `users`.
- **Atomicity, failure on insert #2** (duplicate email, the natural OPEN-1 path): raises, and **no orphan tenant survives**. Run in autocommit, because a rolled-back wrapper would make the assertion pass against a non-atomic function. The survival check runs as the **migration** role, because `tenants` is under FORCE RLS and asking the app role would return zero rows regardless — a guaranteed green proving nothing.
- **Atomicity, failure on insert #3** (forced with a `CHECK (false) NOT VALID` constraint on `memberships`, since nothing natural trips that insert): no tenant and no user survive. This is the failure that strands the most state.
- **`login_lookup` positive:** returns `id`, `password_hash`, `deleted_at` with no context. **Negative:** the same role reading `password_hash` directly — `permission denied`, the column-level grant doing what RLS cannot.
- Case-insensitive across mixed/lower/upper; exact-match only (prefix, suffix, trailing space and `%` all miss); at most one row when a soft-deleted account shares the address, preferring the live one.
- **Mutation sweep, 8 mutations, 8 caught** after the assertion-4 tightening: bare `=` restored, `ORDER BY/LIMIT` dropped, an `EXCEPTION` handler added that strands an orphan tenant, `EXECUTE` granted to `PUBLIC`, `EXECUTE` revoked from the app role, owner reverted to the migration role, `search_path` unpinned, and `search_path` widened to include `public`.

**A Prisma detail that changes Phase 4.** Postgres raises `duplicate key value violates unique constraint "users_email_live_key"`, but Prisma's raw-query wrapper reduces it to `Raw query failed. Code: 23505. Message: Unique constraint failed: ` — **the constraint name is dropped**. Registration's duplicate-email → 409 mapping must therefore key on SQLSTATE `23505`, not on the constraint name. On this function only the email index can realistically raise it; the other two keys are `gen_random_uuid()` primary keys.

**Recorded, not built: the standing rule Decision B created.** B closed the app-role write path, and in doing so **relocated the write-correctness burden into the definer function bodies**. Pre-B, `memberships_tenant` was `FOR ALL USING/WITH CHECK (tenant_id = current_tenant)` — the policy enforced tenant-scoping on every write, so even a buggy function body could not cross a tenant boundary. Post-B the only write path is the definer, whose policy is `USING (true) WITH CHECK (true)` and constrains nothing. Tenant-scoping and the admin check are now both the function body's sole responsibility. ADR-006 §7 and DECISIONS.md now carry the rule: **every definer write function acting for an authenticated caller must enforce, in its own body, that the caller is an admin of the active tenant and that the target row belongs to it.** `register_tenant` is exempt because it runs pre-auth and creates the tenant it writes into; `login_lookup` is read-only. Everything added after them is subject to it — and the **step-5 gate now requires live authorization negatives, not just atomicity**: a non-admin call rejected, and an admin of A unable to touch B through the function.

**Not done, and not claimed.** No interceptor, no session, no per-request re-verify, no endpoints — Phases 3–4. No step-5 membership-write functions. Step 4's definition of done still needs `register → login → /auth/me`, the multi-membership switch, unauthorized-switch 403, revocation-on-next-request and role-follows-active-membership; none of that exists yet.

**Next**

- **Phase 3** — the interceptor: two GUCs, verify-then-set ordering, per-request membership re-verification with the claimed tenant passed as a bound parameter.
- Phase 4 — the auth endpoints, including the `23505` → 409 mapping above.

---

### 2026-09-08 — Step 4 Phase 1: identity/tenancy schema + two-axis RLS (§11 step 4)

**Done**

- **Migration `20260907000000_identity_tenancy_schema`** — `tenants`, `users` (pure identity, globally-unique live email via partial index, `citext`), `memberships` (the join carrying `role`), the `membership_role` enum, partial unique on `(user_id, tenant_id) WHERE deleted_at IS NULL`, `ENABLE` + `FORCE ROW LEVEL SECURITY` on all three, eight policies, and column-limited grants. Implements ADR-006, with two amendments recorded there.
- **`users` policy set — an ADR gap, surfaced rather than assumed.** ADR-006 never specified one, and `users` had lost the `tenant_id` its ADR-004 policy keyed on; it would have shipped with a broken policy or none at all. Added `users_self_read`, `users_tenant_members_read`, `users_definer`, **no app-role write policy**, and `password_hash` withheld by **column-level grant** (RLS is row-level and cannot hide a column).
- **DECISION B — the database backstops intra-tenant role authorization.** The gate review found that `memberships_tenant`, specified `FOR ALL TO meterlog_app` with the admin check left to a step-5 RBAC guard, permitted **intra-tenant privilege escalation**: a technician in tenant A ran `UPDATE public.memberships SET role='admin' WHERE user_id=<self>` and got `UPDATE 1`. Neither policy clause carries a role term, and `tenant_id` never changes during a role edit. The axis is now `FOR SELECT`, the app role's `INSERT`/`UPDATE` grants on `memberships` are withdrawn, and invite/revoke/change-role move to admin-checking `SECURITY DEFINER` functions in step 5. Recorded in ADR-006 §3 and §7 and in DECISIONS.md, with the A/B/C rationale.
- **Co-member visibility recorded as intentional.** Every member of a tenant reads every co-member's identity and role. That was an unremarked side effect of the tenant axis keying on `tenant_id` alone; it is now a decision (team-SaaS default), and reads stay un-gated because a role term in a _read_ policy is the shape that produced OPEN-5.
- **Catalog assertions 9 and 10** — the app role holds no `INSERT`/`UPDATE`/`DELETE` on any identity table, and can still read all three. 9 is what keeps Decision B durable: one stray `GRANT` would otherwise reopen the escalation with nothing complaining. It also closes the previously-untested `tenants` write-privilege gap.
- **Revoked-membership fixtures.** The OPEN-5 residual argument — "liveness is enforced in-policy on the read paths, so a revoked workspace disappears from `/auth/me`" — is recorded in three places and was tested by nothing: no fixture had a soft-deleted membership, so deleting either liveness predicate was a green mutation. Two revoked memberships now exist in the suite, with assertions on both read paths, plus an assertion pinning the residual itself so nobody "fixes" what cannot be fixed.

**Verified against live Postgres, with negatives** (`meterlog_app`, `rolbypassrls = f`, on a database built only by `prisma migrate deploy`)

- **The escalation, before and after.** Pre-B: `INSERT 0 1` for the active tenant, and `UPDATE 1` → `role_now = admin`. Post-B: both `permission denied for table memberships`.
- **Both denial layers, separately.** The grant layer is shown by the plain rejections above. The **policy** layer is isolated by restoring the write grants inside a rolled-back transaction — then `INSERT` raises `new row violates row-level security policy`, while `UPDATE`/`DELETE` **do not raise**: no applicable policy means no visible row, so Postgres returns `UPDATE 0` / `DELETE 0` cleanly with the row unchanged. A test asserting a thrown error on the UPDATE path would have failed against a correct database; the suite asserts zero-rows-and-unchanged there deliberately.
- **Cross-tenant boundary unregressed**, and reads unregressed — a technician in A still reads all of A's co-members (the accepted behaviour).
- **`register_tenant` unaffected — proven, not asserted.** Built as ADR-006 §6 specifies inside a rolled-back transaction: the three-row insert succeeds as `meterlog_definer`; the identical insert as `meterlog_app` is denied. Same treatment for `login_lookup`, which still reads `password_hash` through the definer while the app role gets `permission denied`.
- **Mutation sweep, 21 mutations, 20 caught.** Every `USING`/`WITH CHECK` predicate, every `NULLIF` guard, both liveness predicates, the `FOR SELECT`→`FOR ALL` reversals, and stray write grants, dropped one at a time. Reverting `memberships_tenant` to `FOR ALL` is caught **only** by the policy-layer block, which is why that block exists. The one uncaught mutation (`tenants_active` `WITH CHECK` → `true`) is unreachable rather than unguarded — the app role cannot write `tenants` — and assertion 9 now guards the privilege that makes it unreachable, which mutation 21B confirms. All 21 reverted; post-sweep schema dump identical to a freshly-migrated one.
- **Drift** — schema, policies (full `USING`/`WITH CHECK` text), RLS flags, table and column grants and indexes diffed against a scratch database built only from the migrations: identical.

**Verified in CI** — see the run linked on PR #1. 45 tests (catalog-rls 10, membership-isolation 23, isolation 6, definer-probe 5, health 1), up from 34.

**Process smell worth naming.** The local database was found carrying the Phase 1 tables with **no `_prisma_migrations` table at all** — the schema had been applied out-of-band at least once, so `prisma migrate status` reported both migrations unapplied while the objects existed. It was byte-identical to what the migrations produce, so nothing was wrong with the schema; what was wrong is that this could not have been known without diffing. Migrations must be the only path that ever touches a database, most of all Render — an out-of-band change there is invisible, unreviewable, and unreproducible. The local ledger was baselined with `prisma migrate resolve --applied`; CI-on-a-fresh-database remains the real reproducibility proof.

**Repo / process**

- Branch protection on `main`: PR required, CI status check required, no direct pushes, no force-push, no deletion, **0 required approvals** (solo repo). Verified by a refused push, not by reading the settings.
- Secrets scan over full history (gitleaks + a provider-token grep across every blob): clean. The single gitleaks hit is the literal placeholder `replace-me-with-32-bytes-of-hex` in `.env.example`.

**Not done, and not claimed.** Step 4's definition of done needs `register → login → /auth/me` round-tripping, the multi-membership switch, unauthorized-switch 403, revocation-on-next-request and role-follows-active-membership. None of that exists — it is Phases 2–4. What Phase 1 proves is the harder novel part: the shared-user, dual-axis membership isolation, and now a real intra-tenant write boundary at the database layer.

**Next**

- **Phase 2** — the two `SECURITY DEFINER` functions (`login_lookup`, `register_tenant`), including the forced-failure test that asserts no tenant survives a partial registration.
- Phase 3 — the interceptor: two GUCs, verify-then-set, per-request membership re-verification.
- Phase 4 — the auth endpoints.
- Step 5 will add the admin-checking membership-write definer functions Decision B requires, and must edit `EXPECTED_DEFINER_FUNCTIONS` deliberately when it does.

---

### 2026-09-03 — Scaffold (§11 step 3)

**Done**

- `git init` (branch `main`), `.gitignore`, `.env.example`, npm-workspaces root, `tsconfig.base.json` (strict + `noUncheckedIndexedAccess`), ESLint flat config, Prettier.
- `docker-compose.yml`: Postgres 16 + Redis 7 with healthchecks; `docker/postgres/01-bootstrap-roles.sh` seeds the local roles and the app password from an env var.
- **Role bootstrap migration** (`20260903000000_bootstrap_roles`): creates `meterlog_definer` (NOLOGIN) and `meterlog_app` (`NOSUPERUSER NOBYPASSRLS`) idempotently, asserts attributes on re-run, sets `statement_timeout` 4s + `idle_in_transaction_session_timeout` 10s on the app role, grants `USAGE` on `public` and revokes `CREATE`. Never names the migration role, so it runs unchanged locally, in CI, and on Render. Sets no password — those stay out of version control.
- `apps/api`: Nest skeleton with global `/api/v1` prefix, Helmet, credentialed allow-list CORS, `ValidationPipe` with `forbidNonWhitelisted`, Swagger at `/api/v1/docs`, `GET /health`. `PrismaService` binds explicitly to `DATABASE_URL` while `schema.prisma` points at `MIGRATION_DATABASE_URL`, so the two roles cannot be confused; `TRANSACTION_OPTIONS` single-sources the ADR-004 timeouts.
- `apps/web`: Next 15 App Router + Tailwind skeleton, Playwright config (no journeys yet).
- `packages/shared`: error envelope + role Zod schemas.
- **Catalog RLS suite** (`test/db/catalog-rls.spec.ts`) — all seven assertions, running as `meterlog_app`.
- **Definer probe** (`test/db/definer-probe.spec.ts`) — cases A–E, fixtures in a throwaway `rls_probe` schema. Negatives included per review: **B** policy removed → reads nothing, writes rejected; **C** the FORCE/owner-bypass bug itself, with the probe table owned by `meterlog_definer` rather than the migration role (which is a superuser locally and in CI, so an owner-bypass test written against it would have proven nothing); **E** unqualified reference under a pinned `search_path` fails to resolve.
- CI workflow: install → generate → migrate → set app password → lint → typecheck → test → build, with Postgres + Redis services.
- `CLAUDE.md` Commands updated to the real scripts.

**Verified locally:** `npm run lint`, `npm run typecheck`, `npm run build` all clean; the health unit test passes. `nest build` initially emitted to `dist/src/` because the test tree was in compile scope — fixed with `tsconfig.build.json`, so `dist/main.js` now matches the `start` script.

**Verified in CI** — [run 33877274316](https://github.com/Braiden-07/MeterLog/actions/runs/33877274316), commit `5539224`, success in 1m54s. Migrations connected to the CI Postgres service (`Datasource "db": PostgreSQL database "meterlog" ... at "localhost:5432"` → `All migrations have been successfully applied`), and the API workspace reported real counts: definer-probe 5, isolation 6, catalog-rls 7, health 1 — **19 passed**. `--passWithNoTests` applied only to the web workspace, so a mis-globbed or empty DB suite would still fail rather than pass on zero matches.

**What is actually exercised, honestly.** With no domain tables, catalog assertions 1–6 and 8 iterate empty sets; only 7 (runtime role identity) has real content today. The isolation harness's `describe.each` matrix generates zero cases — its 6 passing tests are 1 vacuous fixture-coverage check plus 5 scratch-table self-tests. The definer probe is fully real (5 cases against its own fixtures). Negatives in the probe and the self-test were each confirmed to fail when their bug is mutated back in.

**Next**

- Build-order step 4 (auth + tenancy foundation) — acceptance criteria below.

---

### 2026-09-02 — Planning & foundational decisions

**Done**

- Read `CLAUDE.md` and `docs/PROJECT_BRIEF.md` in full; confirmed Essential-only scope (§2).
- Created `docs/PROGRESS.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md` as structured skeletons.
- Settled and recorded the three open decisions from the brief, plus two that follow from them:
  - ADR-001 — auth: **session cookie + Redis** (argon2 hashing).
  - ADR-002 — ORM: **Prisma**, with RLS as hand-written SQL in migrations.
  - ADR-003 — backend hosting: **Render** (API + Postgres + Redis); Vercel for frontend.
  - ADR-004 — RLS enforcement: per-request `SET LOCAL app.current_tenant` inside an interactive Prisma transaction, with a **restricted app DB role** separate from the migration/owner role.
  - ADR-005 — repo layout: **npm-workspaces monorepo** (`apps/api`, `apps/web`, `packages/shared`), no build orchestrator.
- Monorepo structure and toolchain approved by the author.
- Extended ADR-004 on author review with three explicit sections: the **auth-table policy** (pre-auth access via a narrow allowlisted set of `SECURITY DEFINER` functions), the **interactive-transaction timeout choices**, and a **catalog-level RLS coverage test** that lands at scaffold rather than later.
- Second ADR-004 review round — corrected a design error and scaled the isolation test:
  - **Named the three DB roles** (environment-provided migration/owner, `meterlog_definer`, `meterlog_app`) and established that **none holds `BYPASSRLS`**. Verified Render grants no superuser and that Postgres only lets `BYPASSRLS` be granted by a role holding it, so that route was unavailable — but it was also unnecessary and wrong: under `FORCE ROW LEVEL SECURITY` the table owner is subject to policies too, so the originally-assumed owner bypass would have left the login path silently fail-closed. Definer access now runs through permissive policies scoped `TO meterlog_definer`, which needs no role attributes.
  - **Schema-qualification of definer function bodies** made mandatory and tied to the pinned `search_path` — with `public` out of the resolution path, an unqualified reference fails outright rather than resolving wrongly.
  - **Definer policies are `FOR ALL ... USING (true) WITH CHECK (true)`** so registration inserts aren't denied (a `USING`-only policy doesn't apply to `INSERT` at all), with least privilege coming from narrow `SELECT, INSERT` grants that CI asserts.
  - **Functional proof of the pre-auth path** added on top of the structural checks: a definer-pattern probe at scaffold, and `register → login → /auth/me` as the acceptance gate for step 4.
  - **Two-tenant isolation test is now catalog-driven**: a fixture registry whose key set must equal the catalog's tenant-scoped table set in both directions, running a per-table matrix (read invisibility, cross-tenant UPDATE/DELETE affecting zero rows, `WITH CHECK` rejection of foreign-tenant INSERT, and zero rows with no context set). Correctness coverage now scales automatically like presence coverage does.

**Next (PROJECT_BRIEF §11 step 3 — scaffold)**

- `git init`; `.gitignore`, `.env.example`, root `package.json` (workspaces) + `tsconfig.base.json`.
- `docker-compose.yml`: Postgres 16 + Redis 7, with the two-role bootstrap from ADR-004.
- NestJS skeleton in `apps/api` (module layout per §4) and Next.js App Router skeleton in `apps/web`.
- `packages/shared` for Zod schemas / contract types.
- **Role bootstrap in migration SQL (ADR-004)** — create `meterlog_definer` (NOLOGIN) and `meterlog_app` (`NOSUPERUSER NOBYPASSRLS`); never name the migration role, so the same SQL runs locally and on Render.
- **Catalog-level RLS coverage test (ADR-004), wired into CI at scaffold** — connects as the restricted app role and asserts: (1) every `public` table has RLS enabled _and_ forced, bar a reviewed exempt list; (2) no `tenant_id`-bearing table lacks it; (3) every RLS-enabled table has ≥1 policy; (4) the `SECURITY DEFINER` set matches its allowlist, is owned by `meterlog_definer`, and has `search_path` pinned; (5) definer-scoped policies exist only on `users`/`tenants`; (6) neither `current_user` nor `meterlog_definer` is superuser or `BYPASSRLS`. Passes near-vacuously until step 4, which is the point — it exists before the first tenant table does.
- **Catalog-driven isolation harness (ADR-004)** — fixture registry + per-table matrix, with registry/catalog set equality asserted both ways. Harness lands at scaffold; it gains its first real fixtures in step 4.
- **Definer-pattern probe test (ADR-004)** — throwaway table + definer function + `FOR ALL` policy created and rolled back inside one transaction, asserting the function reads/writes while direct app-role access sees nothing. Proves the mechanism at scaffold, before auth code depends on it.
- Set `statement_timeout` (4s) and `idle_in_transaction_session_timeout` (10s) on the app role in migration SQL.
- GitHub Actions CI running lint + typecheck + the test suite above.
- Update the Commands block in `CLAUDE.md` to the real scripts once they exist.
- Fill in `docs/ARCHITECTURE.md` §3 (repo layout) and §7 (RLS) as the scaffold lands.

**Known-thin at scaffold (not defects, but do not mistake them for coverage)**

- `packages/shared` is declared by both apps but imported by neither. The API build was verified to compile an import of it; the web side is untested.
- `apps/web/e2e/` is empty. Playwright browsers are installed, so `npm run test:e2e` is untested rather than broken. CI does not run it.
- The Nest skeleton's `ValidationPipe` and CORS config are configured but unexercised — no DTO endpoint and no cross-origin request exists yet. `/api/v1/health`, Helmet headers, Swagger and the route prefix were verified against a running instance.

**Step 4 acceptance gates (named, not parenthetical)**

1. **Registration is atomic — tenant + first admin, or neither.** Both INSERTs run through the definer path and must share one transaction. A partial failure that strands a tenant with no admin is a real failure mode: the tenant row exists, nobody can log into it, and registration cannot be retried because the tenant already exists. Step 4 is not done until a test forces a failure on the second INSERT and asserts no tenant row survives.
2. **`register → login → /auth/me` round-trips green.** The functional counterpart to the scaffold probe: session cookie issued, identity carries the right `tenant_id` and `role`. Structural checks cannot see a fail-closed definer path; this is what does.
3. **The two-tenant isolation matrix runs on every new table**, driven by the catalog with the fixture registry asserted equal in both directions.
4. **`EXPECTED_DEFINER_FUNCTIONS` in `test/db/helpers.ts` is updated** as the credential-lookup and registration functions land — the allowlist is empty at scaffold and is meant to be edited deliberately.

**Open questions**

- **Login identity (blocks the credential-lookup function in step 4).** §5 makes `users.email` unique _per tenant_, so email alone doesn't identify a user at login. Either the login form carries a tenant discriminator (subdomain/slug) or email becomes globally unique. Does not block scaffolding.
- Prisma connection-pool size vs Render's Postgres connection cap — every in-flight request now holds a connection (ADR-004). Settle at deploy (step 10), validate with k6 (§13).
- **Migration privileges on Render (verify at step 10).** Locally and in CI the migration role is the cluster bootstrap user and therefore a superuser; on Render it is not. The bootstrap migration needs `CREATEROLE` and role-admin rights to run `CREATE ROLE` and `ALTER ROLE ... SET`. Expected to work with Render's default user, but it is an assumption, not a verified fact — confirm against a real Render database before relying on the deploy step. The probe is written to be superuser-agnostic precisely so this difference cannot mask a failure.
- Local Postgres is 18; `docker-compose.yml` pins 16 to match the intended Render version. No feature used here differs between them, but the mismatch is worth keeping in view.

**Blockers**

- None. Deferred to their build-order step: GitHub repo creation and branch protection (§9), Render plan-tier selection (ADR-003), Sentry DSN and uptime monitor (§10).
