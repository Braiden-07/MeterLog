# DECISIONS.md — MeterLog

> ADR-style log of significant technical choices. One entry per decision, newest at the bottom.
> Status: `Proposed` | `Accepted` | `Superseded by ADR-NNN`.

## Template

```
## ADR-NNN — <Title>

- **Date:**
- **Status:**
- **Context:** <the forces at play; what made this a decision>
- **Decision:** <what we chose>
- **Consequences:** <what this makes easy, what it makes hard, what we now must do>
- **Alternatives considered:** <option — why not>
```

---

## Index

| ADR | Title                                                            | Status   |
| --- | ---------------------------------------------------------------- | -------- |
| 001 | Authentication: session cookie + Redis                           | Accepted |
| 002 | ORM & migrations: Prisma                                         | Accepted |
| 003 | Backend hosting: Render                                          | Accepted |
| 004 | RLS enforcement: per-request tenant context + restricted DB role | Accepted |
| 005 | Repository layout: npm-workspaces monorepo                       | Accepted |
| 006 | Membership-based multi-tenancy (two-axis RLS)                    | Accepted |
| 007 | Child-table tenant consistency: composite foreign key            | Accepted |

---

## ADR-001 — Authentication: session cookie + Redis

- **Date:** 2026-09-02
- **Status:** Accepted
- **Context:** `PROJECT_BRIEF.md` §3 and §7 leave auth as an explicit either/or: stateless JWT (access + refresh) or server-side sessions. Both are defensible. The deciding forces were revocability (§7 requires "support logout/revocation"), the fact that Redis is already in the stack, and a preference for a mechanism whose security properties are easy to reason about and to demonstrate.
- **Decision:** Server-side sessions stored in Redis, transported via an `httpOnly` + `Secure` + `SameSite` cookie. Passwords hashed with argon2.
- **Consequences:**
  - Logout and admin-initiated revocation are real — deleting the Redis key ends the session immediately, with no denylist workaround.
  - The session record is the natural home for the request's `tenant_id` and `role`, which feeds directly into the RLS context set in ADR-004 and into the RBAC guards.
  - Redis becomes a hard runtime dependency of the API, not just a cache. It must be present locally (docker-compose) and in production (Render), and its loss logs everyone out.
  - Cookie-based auth means **CSRF protection is mandatory** (§7) — implemented as part of the auth foundation, not deferred.
  - CORS must allow-list the frontend origin with credentials enabled, and the cookie needs correct `SameSite`/domain settings given frontend (Vercel) and backend (Render) sit on different hosts.
  - Slightly less "stateless-microservice-standard" than JWT, but MeterLog is a single deployable modular monolith, so statelessness buys nothing here.
- **Alternatives considered:**
  - **JWT access + refresh tokens** — more conventional in portfolio projects and avoids a session store, but honest revocation requires a Redis-backed denylist anyway, reintroducing the statefulness while keeping token-storage and expiry-handling complexity. Rejected as more moving parts for no gain at this scale.

## ADR-002 — ORM & migrations: Prisma

- **Date:** 2026-09-02
- **Status:** Accepted
- **Context:** `PROJECT_BRIEF.md` §3 requires picking Prisma or TypeORM and notes Prisma is recommended for DX, with the caveat that Row-Level Security needs raw SQL alongside it. The schema is well-defined up front (§5) and type safety across a TypeScript stack is a primary goal.
- **Decision:** Prisma as ORM and migration tool. RLS policies, database roles, and grants are authored as hand-written SQL inside Prisma migration files.
- **Consequences:**
  - Strong end-to-end type safety from schema to service layer; generated types complement the Zod schemas shared with the frontend.
  - Migrations are versioned, reviewable SQL — the RLS policies live in the same migration history as the tables they protect, so a fresh database and CI both get them automatically.
  - **Tenant context must be set on the same connection as the query.** Prisma pools connections, so `SET LOCAL app.current_tenant` only holds inside an interactive `$transaction`. Every tenant-scoped request therefore runs its work through a transaction wrapper (see ADR-004). This is a real constraint on service design and must be enforced centrally, not remembered per-query.
  - Prisma does not model RLS, roles, or grants in `schema.prisma`; those exist only in raw SQL migrations. `prisma migrate dev` after a schema edit can generate migrations that omit them, so RLS coverage needs an explicit test rather than trust.
  - Parameterised raw SQL remains available via `$queryRaw` for the `EXPLAIN ANALYZE` index exercise in §13.
- **Alternatives considered:**
  - **TypeORM** — closer to the metal, and its query runner makes per-connection session variables slightly more natural for RLS. Rejected for markedly weaker type inference, a heavier decorator/entity layer, and a more manual migration story for a solo build.

## ADR-003 — Backend hosting: Render

- **Date:** 2026-09-02
- **Status:** Accepted
- **Context:** `PROJECT_BRIEF.md` §3 and §10 require choosing Railway or Render for the backend, managed Postgres, and Redis, explicitly on cost-conscious grounds. This is a portfolio deployment that must stay live and reachable indefinitely, not a short-lived demo.
- **Decision:** Render for the NestJS API, managed PostgreSQL, and Redis. Frontend remains on Vercel.
- **Consequences:**
  - Predictable flat-rate pricing rather than metered usage credits that drain while the app idles — the right shape for something that must simply stay up.
  - Managed Postgres backups (§10) and Redis come from the same provider, keeping the data tier in one place with one set of secrets.
  - Deploys are wired from GitHub Actions on `main` (§9), with migrations as a gated deploy step and a `/health` smoke test after.
  - Render's free Postgres tier expires and free web services cold-start; the plan tier must be chosen deliberately before the deploy step, and cold starts noted if they affect the p95 latency metric in §13.
  - Cross-origin cookie configuration (ADR-001) must account for the Vercel/Render host split.
- **Alternatives considered:**
  - **Railway** — nicer developer experience and faster initial setup, but usage-credit billing makes an always-on demo's monthly cost less predictable. Rejected on the brief's own cost-conscious criterion.

## ADR-004 — RLS enforcement: per-request tenant context + restricted DB role

- **Date:** 2026-09-02
- **Status:** Accepted
- **Context:** `PROJECT_BRIEF.md` §4 lists "how RLS is enforced" as a decision to log, and §7 requires tenant isolation at the database layer rather than in application filtering. Postgres silently bypasses RLS for superusers, for roles with `BYPASSRLS`, and for a table's own owner unless `FORCE ROW LEVEL SECURITY` is set — so the enforcement mechanism is only as good as the role the application connects as.
- **Decision:** Two database roles. A migration/owner role runs Prisma migrations and owns the schema; a restricted application role, with no `BYPASSRLS` and no table ownership, is what the API connects as at runtime. Every tenant-scoped table gets `ENABLE ROW LEVEL SECURITY` plus `FORCE ROW LEVEL SECURITY` and a policy keyed to `current_setting('app.current_tenant', true)`. A Nest interceptor opens an interactive Prisma transaction per authenticated request, issues `SET LOCAL app.current_tenant` from the session's tenant, and runs the request's work inside it.

### Database roles

Three roles, none of which holds `SUPERUSER` or `BYPASSRLS`.

| Role               | Login  | Purpose                                                                                                                                    |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| migration/owner    | yes    | Runs Prisma migrations, owns the schema. Environment-provided: Render's generated default user in production, `meterlog_migrator` locally. |
| `meterlog_definer` | **no** | Owns the pre-auth `SECURITY DEFINER` functions and nothing else. Cannot be connected as; it acts only through those functions.             |
| `meterlog_app`     | yes    | The runtime connection. Explicitly `NOSUPERUSER NOBYPASSRLS`.                                                                              |

- The migration role is **not named in migration SQL** — objects are owned by their creator, so the same migrations run under Render's generated user and under the local role without edits. Only `meterlog_definer` and `meterlog_app` are created by name, which is what lets policies reference them portably.
- `meterlog_definer` is created by the migration role, which is therefore a member of it and can transfer function ownership to it.

**`BYPASSRLS` is deliberately absent, because it is both unavailable and unnecessary.** Unavailable: [Render does not grant superuser](https://render.com/docs/databases), and per the [Postgres role-attribute docs](https://www.postgresql.org/docs/current/role-attributes.html) a role may only grant `BYPASSRLS` if it holds it — `CREATEROLE` does not confer it. Unnecessary: `FORCE ROW LEVEL SECURITY` (specified above) applies policies to the table _owner_ as well, so owner-based bypass would not work regardless. `meterlog_definer` instead reaches the auth tables through **named permissive policies scoped `TO meterlog_definer`** plus explicit table grants — ordinary DDL, no role attributes, no superuser, identical locally and on Render.

An earlier draft of this ADR assumed the definer role would bypass RLS by ownership. Under `FORCE`, it does not; the functions would have been fail-closed and silently broken at first login. Recorded here because the correction is the reason the design has a third role at all.

### The canonical policy expression

Every tenant-scoped policy uses this exact expression, for both `USING` and `WITH CHECK`:

```sql
<key column> = NULLIF(current_setting('app.current_tenant', true), '')::uuid
```

The `NULLIF` is not decoration, and the harness caught its absence on the first run against a real database.

`current_setting(name, true)` returns NULL only while the setting has _never_ been set on that session. Once `SET LOCAL` has set it even once, the parameter exists for the life of the session and reverts at transaction end to the **empty string**, not to NULL. So on a pooled connection — which is every connection after its first authenticated request — an unset context yields `''`, and `''::uuid` raises `22P02 invalid input syntax for type uuid` instead of evaluating false.

That breaks the fail-closed baseline this ADR claims twice over: the "no context set ⇒ zero rows" property becomes "no context set ⇒ 500", and the failure appears only after a connection has been reused, which is exactly the kind of bug that survives a clean-database test run and shows up under load. `NULLIF(..., '')` maps both the never-set and the reverted-to-empty cases to NULL, the comparison evaluates NULL, and the row is filtered. Fail-closed, no error, on the first request and the thousandth.

**Enforced by catalog assertion 8**, not by discipline. A behavioural test cannot be trusted to catch this — whether it fails depends on whether the pooled connection it happens to land on has previously set the GUC, so a policy missing the `NULLIF` can pass a full green run and fail in production. Assertion 8 is therefore structural: any policy expression that references `current_setting('app.current_tenant'` must also wrap it in `NULLIF`. Phrased as "references it ⇒ must wrap it", so the definer policies (`USING (true)`) are unaffected and `tenants` (keyed on `id`) needs no special case. Verified to fail on the pre-fix form while assertions 1-7 all still pass — which is the whole reason it exists.

### Auth-table policy

The pre-authentication paths are the one place where a tenant context cannot exist yet, so they are specified rather than left to judgement.

- **`tenants`** is tenant-scoped but has no `tenant_id` column — its key _is_ the tenant. Its policy is keyed on `id`, using the canonical expression below. This is called out because a coverage check keyed on the presence of a `tenant_id` column would skip this table entirely; see the catalog test below, whose primary assertion is column-agnostic for exactly this reason.
- **~~`users` carries the standard `tenant_id` policy for all authenticated access, so admin user management is tenant-scoped like any other module.~~ SUPERSEDED by ADR-006.** `users` no longer has a `tenant_id` column at all — it became pure identity and the tenant relationship moved to `memberships` (ADR-006 §2). Its policy set is therefore two `FOR SELECT` policies keyed on the two axes (`users_self_read`, `users_tenant_members_read`) plus a definer policy, with no app-role write path; see the `users`-policy amendment under ADR-006. Struck rather than rewritten because every other superseded line in this ADR carries a marker, and an unmarked wrong fact is worse than a marked one.
- **Login and registration cannot use those policies.** They run before a session exists, so `app.current_tenant` is unset, the canonical expression above evaluates NULL, the policy evaluates false, and the app role sees zero rows. That is the correct fail-closed behaviour, and it means the credential lookup must not go through the ordinary query path.
- **Pre-auth database access goes through a small, fixed set of `SECURITY DEFINER` functions**, owned by `meterlog_definer`, which reaches these two tables via permissive policies scoped `TO meterlog_definer` (see Database roles). Each function:
  - takes a narrow argument list and returns only the columns that operation needs (~~the login lookup returns `id`, `tenant_id`, `role`, `password_hash`, `deleted_at` for at most one row~~ — **SUPERSEDED by ADR-006 §6:** `login_lookup(p_email citext)` returns `id, password_hash, deleted_at` only. Tenant and role are no longer properties of a user, so they are read post-auth from `memberships` under RLS rather than returned by the definer; the implemented signature is in `20260908000000_auth_definer_functions/migration.sql`);
  - performs exact-match lookups only — no `LIKE`, no wildcards, no caller-supplied ordering or limits, so the function cannot be used to enumerate users or tenants;
  - pins `SET search_path = pg_catalog, pg_temp` on the function definition, without which a `SECURITY DEFINER` function is itself a privilege-escalation vector;
  - **schema-qualifies every object reference in its body** — `public.users`, `public.tenants`, never bare `users`. This is not stylistic: pinning `search_path` to `pg_catalog, pg_temp` deliberately removes `public` from resolution, so an unqualified reference does not resolve to the wrong table, it fails outright. Qualification is what makes the pinned path workable, and the two must be applied together.
  - **AMENDED at Phase 2 of step 4 — the "fails outright" guarantee does NOT extend to operators, and that carve-out is the dangerous one.** The bullet above is the founding rationale for the pin, and it is true **for functions and tables**: an unresolvable name is an error, loud and immediate. It is **false for operators.** An operator whose schema is outside the pinned path does not fail to resolve — Postgres falls back through the operands' implicit casts and binds a _different, plausible, wrong_ operator, silently and with no diagnostic anywhere.
    - **This shipped, and it was verified live, not theorised.** `login_lookup` compared `citext` with a bare `=`. `citext`'s `=` lives in `public`, which the pin excludes, so the comparison fell through citext's implicit cast to `text` and bound case-**sensitive** `text = text`:

      ```
      search_path = pg_catalog, pg_temp   ->  'a'::citext = 'A'::citext  =  false
      search_path = public, pg_catalog    ->  'a'::citext = 'A'::citext  =  true
      ```

    - **The blast radius was an unrecoverable account lockout**, not a cosmetic wrong answer. `users_email_live_key` resolved its `citext` operator class at `CREATE INDEX` time, with `public` in scope, so **uniqueness stayed case-insensitive while the lookup became case-sensitive**. Register as `Founder@acme.test`, log in as `founder@acme.test`: no row, generic auth failure — and re-registering is refused by the index. The account is unreachable, and nothing errors.
    - **Rule: every operator in a pinned-path `SECURITY DEFINER` body must be schema-qualified** — `u.email OPERATOR(public.=) p_email`, never a bare `=`, wherever either operand's type comes from an extension or any schema off the pinned path. The fix is drawn at the operator, **not** by adding `public` to the `search_path`: widening the path is the one change that makes the symptom vanish while removing the property the pin exists to provide.
    - **The guard split, stated so neither half is mistaken for covering the other.** Definer-probe case E covers the **loud** kind — an unqualified function/table reference failing to resolve under the pinned path. It cannot catch this kind, because nothing fails. The **silent operator kind** is caught only by the behavioural case-insensitivity assertion in `auth-definer.spec.ts` (`matches case-insensitively — regression guard, this was broken`). **That test is load-bearing and must not be deleted as redundant**; no structural or catalog assertion can replace it, because at the catalog level the mutated function is indistinguishable from the correct one. Catalog assertion 4 was tightened at the same time to assert the pin's _content_ (that `public` is absent) rather than its mere presence, which is the complementary structural half.
    - Companion record to the Decision B consequence in ADR-006 §7: both are cases where a protection was removed from one layer and the burden landed silently on another.
  - grants `EXECUTE` to `meterlog_app` and to no one else.
- **The definer policies are `FOR ALL` with an explicit `WITH CHECK`.** Registration inserts a tenant and its first admin, and a policy carrying only `USING` does not apply to `INSERT` at all — with no applicable permissive policy, the insert is denied and registration fails closed exactly as login would have. So each is written `FOR ALL TO meterlog_definer USING (true) WITH CHECK (true)`.
  - Postgres does default `WITH CHECK` to the `USING` expression when it is omitted on a `FOR ALL` policy, so the shorter form would happen to work today. It is written out anyway: the implicit coupling means any future narrowing of `USING` would silently narrow write permission too, which is precisely the kind of quiet, action-at-a-distance change this ADR exists to prevent.
- **Least privilege comes from the grants, not the policy.** `meterlog_definer` is granted `SELECT, INSERT` on `public.users` and `public.tenants` and nothing else — no `UPDATE`, `DELETE`, `TRUNCATE`, or `REFERENCES`. Table privileges are checked before policies, so a broad `FOR ALL` policy cannot widen what the grants withhold; the policy governs which rows are visible, the grant governs which commands are possible. CI asserts the grant set (below), so the two halves cannot drift apart.
- **The definer-scoped policies are themselves allowlisted.** A permissive policy `TO meterlog_definer` is a hole in the isolation boundary by construction, so CI asserts such policies exist only on `users` and `tenants` — one cannot appear on `assets` without a reviewed test edit.
- **The set of `SECURITY DEFINER` functions is an allowlist asserted in CI** (below). Adding a bypass requires editing the expected list in a reviewed test, which is the point — the escape hatch cannot widen quietly.
- **After login, no pre-auth path is needed per request.** The session in Redis holds `user_id`, `tenant_id`, and `role` (ADR-001), so `GET /auth/me` and every other authenticated request take the normal RLS-scoped path. The permanent pre-auth Postgres surface is therefore just: credential lookup, registration (create tenant + first admin atomically), and `/health`.
- **~~Open question~~ RESOLVED by ADR-006.** This ADR originally deferred the login-identity question — §5 made `users.email` unique _per tenant_, so email alone did not identify a user at login. ADR-006 dissolves it rather than answering it: tenant is no longer a property of a user, so `users.email` is **globally unique** and carries no tenant discriminator. `login_lookup(email)` therefore takes email alone.

### Interactive-transaction timeouts

Because every authenticated request now runs inside an interactive transaction, Prisma's transaction defaults silently become the API's request deadline and its behaviour under load. They are therefore set explicitly rather than inherited:

| Setting                                          | Value    | Why                                                                                                                               |
| ------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Prisma `maxWait`                                 | 2000 ms  | Time to wait for a pooled connection. Exceeded means the pool is exhausted — surfaced as a 503, not a hung request.               |
| Prisma `timeout`                                 | 5000 ms  | Ceiling on one request's transaction. Generous against an expected p95 in the low tens of ms.                                     |
| `statement_timeout` (app role)                   | 4000 ms  | Server-side backstop, set _below_ the Prisma ceiling so Postgres kills the runaway query first and the error names the statement. |
| `idle_in_transaction_session_timeout` (app role) | 10000 ms | Stops a wedged request holding an open transaction, which would pin a connection and block vacuum.                                |

- The two server-side timeouts are set on the app role in migration SQL, so they apply to production and CI alike and cannot be forgotten in platform config.
- The layering matters: `statement_timeout` < Prisma `timeout` means a slow query produces a precise Postgres error rather than an opaque Prisma transaction abort.
- **Connection-holding is the new failure mode.** Each in-flight request occupies a pooled connection for its whole duration, so pool exhaustion — not CPU — is what saturation will look like. Pool size must be set against Render's Postgres connection cap, and the k6 run (§13) is where these numbers get validated rather than guessed.
- Any endpoint that legitimately needs longer overrides `timeout` at the call site with a comment justifying it. No global raise.

### Catalog-level RLS coverage test (lands at scaffold)

The two-tenant row test proves the mechanism works on tables it knows about. It cannot catch a _new_ table shipped without `ENABLE ROW LEVEL SECURITY`, and the failure modes are asymmetric: RLS enabled with no policy denies all rows (safe, loud), while RLS never enabled leaves an ordinary table fully readable by the app role (unsafe, silent). A test that reads the catalog closes that gap by inverting the default — a new table must be justified as exempt rather than remembered as protected.

Landing at scaffold (build-order step 3), connecting **as the restricted app role**, and asserting:

1. **Coverage** — every ordinary table in `public` has both `relrowsecurity` and `relforcerowsecurity` set in `pg_class`, except those in a short, reviewed exempt list (`_prisma_migrations`). Column-agnostic, so it covers `tenants` and any future table whose tenant key isn't named `tenant_id`.
2. **The `tenant_id` rule specifically** — no table carrying a `tenant_id` column lacks enabled-and-forced RLS. Redundant with (1) by construction, kept because it names the actual convention and so fails with a far more legible message.
3. **Policy presence** — every RLS-enabled table has at least one policy in `pg_policies`. Turns the fail-closed case into a build failure instead of a runtime mystery where every query correctly returns nothing.
4. **`SECURITY DEFINER` allowlist** — the set of such functions in `public` equals the reviewed expected set, every one of them is owned by `meterlog_definer`, and every one has `search_path` pinned in `proconfig`. A definer function without a pinned path fails CI.
5. **Definer-policy allowlist** — permissive policies scoped `TO meterlog_definer` exist only on `users` and `tenants`.
6. **Definer grant set** — `meterlog_definer` holds `SELECT, INSERT` on `users` and `tenants` and holds no `UPDATE`, `DELETE`, `TRUNCATE`, or `REFERENCES` on any table. This is what makes the broad `FOR ALL` policy safe, so it is asserted rather than assumed.
7. **Role sanity** — neither `current_user` nor `meterlog_definer` is `rolsuper` or `rolbypassrls`. This one is load-bearing: if `DATABASE_URL` is ever pointed at the migration role, assertions 1–6 all still pass while isolation is completely gone.
8. **Canonical tenant-context expression** — any policy referencing `current_setting('app.current_tenant'` wraps it in `NULLIF` (see The canonical policy expression). Structural rather than behavioural because the bug it guards is connection-dependent and can pass a green run.

At scaffold there are no domain tables yet, so the suite passes near-vacuously. That is deliberate — it is in CI _before_ the first tenant-scoped table exists, so step 4 cannot introduce one unprotected.

### Functional proof of the definer path

Every assertion above is structural, and structure is not behaviour. A definer function that is present, correctly owned, `search_path`-pinned, and covered by an allowlisted policy will satisfy all seven checks while returning zero rows — which is exactly the `FORCE ROW LEVEL SECURITY` bug recorded under Database roles, and exactly the bug a structural suite cannot see. The pre-auth path therefore needs a test that actually executes it.

Two tests, landing at different points, because the honest constraint is that `users` and `tenants` do not exist until build-order step 4:

- **At scaffold — a definer-pattern probe.** Inside one transaction, a migration-role connection creates a throwaway table, enables and forces RLS, creates a `FOR ALL ... USING (true) WITH CHECK (true)` policy scoped to `meterlog_definer`, and defines a schema-qualified, `search_path`-pinned definer function over it. An app-role connection then asserts both directions: the function can insert and read a row, and direct app-role access to the same table returns nothing. The transaction rolls back, so no fixture table persists and no catalog exemption is needed. This validates the _mechanism_ before any real code depends on it — it is the test that would have failed loudly last round instead of surfacing as a broken login in step 4.
- **At step 4 — the real round trip.** `POST /auth/register` → `POST /auth/login` → `GET /auth/me` through the running Nest app, asserting a session cookie is issued, the returned identity carries the right `tenant_id` and `role`, and a second registration on the same email is rejected 409 (ADR-006 OPEN-1). This is the acceptance gate for step 4: the auth foundation is not done until it is green.

The probe cannot substitute for the round trip, and the round trip cannot land at scaffold. Both are listed so neither is quietly dropped.

### Catalog-driven isolation test

Presence and correctness are different properties, and only one of them scaled. The checks above guarantee a new table has RLS enabled, forced, and carrying at least one policy — but not that the policy is _right_. A policy of `USING (true)`, or one keyed to the wrong column, satisfies every assertion above and isolates nothing. Meanwhile the two-tenant row test only covers tables someone remembered to hand-write a case for, which is the same discipline problem the catalog check was introduced to eliminate.

So the two-tenant test is driven from the same catalog query:

- **A fixture registry** maps each tenant-scoped table to a row factory. Factories are hand-written — foreign keys, enums, and `NOT NULL` columns make generic row construction impractical — and declare their FK dependencies so the harness can seed parents first (`tenants` → `assets` → `readings`).
- **The registry's key set is asserted equal to the catalog's table set, in both directions.** A new table with no factory fails the suite; a factory for a dropped table fails it too. This is the move that makes correctness coverage scale like presence coverage — writing an isolation case stops being something to remember and becomes something CI demands.
- **Each table then runs the same matrix**, seeded with a row for tenant A and a row for tenant B:
  - under A's context, `SELECT` returns A's row and not B's;
  - under A's context, `UPDATE` and `DELETE` targeting B's row report zero rows affected — a `USING`-only policy silently permits neither, but a wrong one does;
  - under A's context, `INSERT` with B's `tenant_id` is rejected, which is what catches a policy written with `USING` but no `WITH CHECK` — a common and quiet mistake that leaves reads isolated while writes are not;
  - with **no** tenant context set, every table returns zero rows, confirming the fail-closed baseline is real rather than assumed.

The cost is honest: every new tenant-scoped table now requires a fixture before CI goes green. That is the intended trade — it is the same cost as writing the migration, and it buys a correctness guarantee that holds for tables nobody has thought about yet.

- **Consequences:**
  - Isolation holds even if a service forgets its `where tenant_id` clause; application-layer filtering becomes defence in depth rather than the boundary, exactly as §7 requires.
  - Two connection strings and two sets of credentials to manage locally and on Render, and migrations run as a different role than the app — a deliberate cost for a meaningful guarantee.
  - Every tenant-scoped query path must flow through the transaction wrapper; a query issued outside it sees no rows rather than the wrong rows, which fails loudly and safely.
  - Directly testable, and the test is the centrepiece of the project (§8, §12): seed two tenants, authenticate as A, assert B's rows are invisible — backed by the catalog suite above, which is what keeps that guarantee true for tables written later.
  - `prisma migrate dev` generates table DDL but never the RLS that protects it (ADR-002). The catalog test is the mechanism that makes that gap impossible to ship rather than merely documented.
  - The pre-auth `SECURITY DEFINER` functions are a deliberate, enumerated hole in the isolation boundary. They are the highest-value review target in the codebase and should be treated as such.
- **Alternatives considered:**
  - **Single database role for migrations and runtime** — one fewer credential, but the app would own the tables, requiring `FORCE ROW LEVEL SECURITY` to be flawless with no second line of defence, and one accidental `BYPASSRLS` or superuser connection string silently disables the entire isolation story. Rejected: the guarantee is the product here.
  - **Application-layer tenant filtering only** — rejected outright by §7.
  - **Granting the app role `SELECT` on `users` outside RLS for login** — simpler than a `SECURITY DEFINER` function, but it opens the whole table to every code path rather than to one narrow, reviewed signature. Rejected.
  - **Catalog test keyed only on the `tenant_id` column** — the obvious form, but it silently skips `tenants` (whose key is `id`) and any future table using a different column name. Kept as assertion (2) for its error message, with the column-agnostic assertion (1) as the actual guarantee.

## ADR-005 — Repository layout: npm-workspaces monorepo

- **Date:** 2026-09-02
- **Status:** Accepted
- **Context:** Two deployables (Next.js on Vercel, NestJS on Render) that share validation schemas and API contract types. §3 pins the stack but not the repository shape.
- **Decision:** A single monorepo using npm workspaces: `apps/api`, `apps/web`, `packages/shared`. No Turborepo, Nx, or other build orchestrator.
- **Consequences:**
  - Zod schemas and contract types live in `packages/shared` and are imported by both sides, satisfying the brief's "shared schemas between client and server where practical" (§3).
  - One install, one lockfile, one CI checkout; lint/typecheck/test/build fan out to both workspaces from root scripts.
  - No additional tooling dependency, in line with the brief's cost-consciousness and CLAUDE.md's "ask before new dependencies".
  - Both hosting platforms need a configured root directory and build command, since neither app sits at the repo root.
  - Without a task orchestrator there is no build caching or dependency-aware task graph; at two apps this is not yet a cost, and Turborepo can be added later if CI duration (§13, target < 10 min) demands it.
- **Alternatives considered:**
  - **Two separate repositories** — simpler platform wiring, but shared schemas would need publishing or duplication, and a single feature's audit trail would span two PRs. Rejected.
  - **Monorepo with Turborepo** — better caching, but an extra dependency and config surface for a two-app repo. Deferred, not rejected.

## ADR-006 — Membership-based multi-tenancy (two-axis RLS)

- **Date:** 2026-09-04
- **Status:** Accepted. Full text in [`ADR-006-membership-model.md`](./ADR-006-membership-model.md); this entry is the index summary.
- **Context:** The brief models one tenant per user, which makes the isolation claim — the centrepiece of the project — only ever testable across _different_ users. The metering domain routinely involves service providers whose staff operate across several client organizations.
- **Decision:** Split person from role-in-tenant. `users` becomes pure identity with a **globally unique** email; a new `memberships` table grants one user one role in one tenant. Sessions carry an active tenant, switchable via `POST /auth/switch`. This introduces a **second RLS axis** (`app.current_user`) alongside ADR-004's `app.current_tenant`.
- **Consequences:**
  - The isolation claim strengthens from "A can't see B" to "a user who is a member of both A and B, acting in A, cannot see B — and cannot assert B as active unless verified."
  - **Supersedes ADR-004's login-identity open question** and refines `PROJECT_BRIEF` §5: `users.email` global-unique, `users.tenant_id`/`users.role` move to `memberships`.
  - The definer surface stays at two functions (`login_lookup`, `register_tenant`) and grows by one table's grants; the tenant/role read moves _under_ RLS rather than into a definer.
  - `memberships`' dual policy is the highest-risk implementation detail in the system. Its self axis **must be `FOR SELECT`** — see below.
  - Cost concentrates in steps 4, 5 and 8. Step 8 is capped by decision: a minimal switcher with a hard cache reset, not a polished picker.
- **Corrected in stage-1 review, verified against a live database** (detail in §0 of the full ADR):
  - **Critical — privilege escalation.** The self axis written `FOR ALL` lets a user INSERT themselves a membership granting **admin of any tenant**, because Postgres defaults `WITH CHECK` to `USING` and permissive policies OR on writes. Demonstrated, then fixed by `FOR SELECT`.
  - Every `current_setting` now uses `NULLIF(current_setting('app.<guc>', true), '')` — the raw form in the draft did not fail closed, it errored.
  - Re-verification reordered to **verify-then-set**, with the candidate tenant as a bound parameter, so `app.current_tenant` never holds an unverified value.
  - Added a `FOR SELECT` policy on `tenants` so `/auth/me` can name workspaces the user is not currently active in.
  - **OPEN-5 — RESOLVED (accept the residual for v1.0).** `deleted_at IS NULL` cannot live in the membership row policies: with a `WHERE`-filtered UPDATE, Postgres applies the SELECT policy to the _new_ row, so the predicate blocks the revoking UPDATE itself — it defeats the operation it exists to enforce. Splitting into `FOR SELECT` + `FOR UPDATE` does not help; the SELECT policy still bites. Verified against a live database. Liveness is therefore enforced in-policy only on the paths that exclusively read (§4 re-verify, `tenants` workspace-list subquery), and `/auth/me` and any future self-axis reader carry `WHERE deleted_at IS NULL` app-side — the one documented app-side predicate in the design. Acceptable because the self-axis read is not a security boundary: the gate is the re-verify, which enforces liveness in-policy (revoked ⇒ 403, workspace disappears). The residual is a user seeing their own former membership — not a cross-tenant leak, not an access grant. A third `SECURITY DEFINER` function to close it was **rejected**: the definer surface is the highest-value review target and stays at `{login_lookup, register_tenant}`.
  - **`users` policy set added at Phase 1 as an amendment.** ADR-006 never specified one, and `users` lost the `tenant_id` its ADR-004 policy was keyed on — it would have shipped with a broken policy or none at all. Two `FOR SELECT` app-role policies (own identity; identities of live members of the active tenant), a definer policy, and no app-role write path until invite lands in step 5. `password_hash` is withheld from `meterlog_app` by column-level grant, since RLS cannot hide a column. **Wording corrected at the Phase 1 gate:** the original draft was written assuming the member list was in some sense admin-scoped. It is not — the policy keys on `tenant_id` alone, and a technician acting in tenant A was verified live to read every co-member's identity and role. That behaviour is now recorded as a deliberate decision (below), not left as an implication.
- **Amended at Phase 1 of step 4 — DECISION B: the database backstops intra-tenant role authorization.** ADR-006 §3/§7 specified `memberships_tenant` as `FOR ALL TO meterlog_app`, leaving the admin-only check on membership writes to the Nest RBAC guard. Verified live at the Phase 1 gate, that permitted **intra-tenant privilege escalation**: neither policy clause carries a role term and `tenant_id` does not change during a role edit, so a technician in tenant A ran `UPDATE public.memberships SET role='admin' WHERE user_id=<self>` and got `UPDATE 1`, `role_now = admin` — gated only by a guard that is a step-5 artifact and does not exist.
  - **Decision:** `meterlog_app` becomes **structurally incapable of writing `memberships`**. The tenant axis becomes `FOR SELECT` (no `WITH CHECK`, per the §0.1 lesson), no app-role write policy replaces it, and the grant narrows from `SELECT, INSERT, UPDATE` to `SELECT`. Invite / revoke / change-role route through **admin-checking `SECURITY DEFINER` functions in step 5**, extending the blessed `register_tenant` pattern. The RBAC guard stays as the outer check that yields a clean 403; the definer's own admin check is the one that cannot be bypassed.
  - **Alternatives rejected.** _(A) RBAC-only_ — leaves a real self-promotion escalation gated by a guard that does not exist yet; latent-but-documented is still exploitable. _(C) role term in the RLS policy_ — recombines the three bug classes this project has already been burned by: a predicate over a column the statement mutates, `FORCE ROW LEVEL SECURITY`, and Postgres applying the SELECT policy to the new row of an `UPDATE … WHERE` (the OPEN-5 mechanism). B keeps role logic out of RLS entirely and adds no third GUC. The OPEN-5 precedent that rejected a third definer function does **not** bind: that was surface growth for a _cosmetic_ residual, this is surface growth to close a _real_ escalation.
  - **The denial is not uniform, and the tests say so on purpose.** With grants restored inside a rolled-back transaction so RLS is the only thing that can refuse: `INSERT` raises `new row violates row-level security policy`, but `UPDATE`/`DELETE` **do not raise** — with no applicable policy no row is visible to modify, so Postgres returns `UPDATE 0` / `DELETE 0` cleanly. A test asserting a thrown error on the UPDATE path would fail against a correctly behaving database. Both denial layers (missing grant, missing policy) are asserted separately.
  - **`register_tenant` is unaffected, and this was proven rather than assumed** — it writes as `meterlog_definer` under the `TO meterlog_definer` policy, which B does not touch.
  - **Durability:** catalog assertion 9 asserts `meterlog_app` holds no `INSERT`/`UPDATE`/`DELETE` on any identity table (a single stray `GRANT` would otherwise reopen the escalation silently); assertion 10 asserts it can still read them, so 9 cannot be satisfied by a table nobody can touch. Assertion 9 also subsumes the previously-untested `tenants` write-privilege gap.
  - **Forward marker for the step-5 close-out — the membership mutations will need an audit RETROFIT.** Step 5's definer write functions (invite / revoke / change-role) are the mutations where role-at-time-of-action matters most, and they land **two steps before** the audit module. PROJECT_BRIEF §11 step 7 is "audit_log write on every mutation", which reads as wiring entities built after it — but by then the membership mutations will already exist and will not be covered. Record this in the step-5 close-out as a **known retrofit**, not a second silent hole: step 7 must go back and add audit writes to the step-5 membership functions, and that is also where **OPEN-4** (whether role-at-time-of-action belongs in the `audit_log` payload) is finally answered. OPEN-4 itself needs no step-4 action — it is a payload-shape question with nothing structural depending on it (attribution FKs already point at `users.id` per ADR-006 §2, with no membership FK on core tables), which is precisely why it could be parked while OPEN-1/2/3 could not.
  - **Forward marker landed at step 5 Phase 1 — the invited-but-uncredentialled DEAD-END, accepted with sign-off.** `invite_member` creates an identity for an unknown email with a **sentinel** argon2id hash (derived from `ARGON2_OPTIONS`, never a literal), because `users.password_hash` is `NOT NULL` and ADR-006 §7 left the invite credential mechanism explicitly under-specified. The consequence is recorded here rather than left to be discovered: creating that identity **consumes the global email uniqueness**, so the invited person can neither register their own organisation (OPEN-1 answers that with a 409) nor log in (the sentinel matches nothing), until a **set-password / invite-token flow lands in a later step**. This is a **known, intended, temporary** dead-end and not a silent break — the row is deliberately unusable, an admin holds the tenant, and no path fails silently. **The requirement that later step inherits:** pending-invite accounts carry a valid-looking hash and are **not distinguishable from credentialled accounts by any column today**, so that flow will need a distinguishing signal — a status column, an `invited_at`, or equivalent — to find them. The column is a later-step concern; the requirement is recorded now so it is not met as a blocker then. Full reasoning in the second step-5 amendment box in ADR-006 §7.
  - **SCHEDULED AT THE STEP-5 CLOSEOUT — the set-password / invite-token flow is the FIRST SLICE OF STEP 8, and it is not optional through v1.0.**
    - **Why it cannot be an accepted limitation, argued from the brief rather than asserted.** Essential scope includes an admin user-management UI — _"Frontend: auth flow, asset list + detail, record a reading, record maintenance, view audit trail, **user/role management (admin only)**"_ (PROJECT_BRIEF §2, line 32) — and the Definition of Done requires _"Frontend covers all essential journeys"_ (§12, line 265). That UI has an invite button, and `POST /users` (invite) is itself an essential endpoint (§7, line 161). As things stand, pressing it creates a person who can never enter the application, with no path back. That is not a documented limitation for a README; it is an **essential journey that dead-ends**, and it fails the DoD on the DoD's own terms.
    - **"Acceptable through v1.0" is not actually available as an answer.** Taking it would require cutting invite from the frontend, which cuts the admin user-management journey, which is essential scope. The option collapses when followed through, so it was not taken.
    - **Home: the first slice of step 8.** Step 8 is _"Frontend: auth pages … admin user management"_ (§11, line 251), so the set-password page already has a home there. Pairing token issuance and redemption with the page it serves keeps it one coherent PR, rather than a backend endpoint with nothing calling it. It also lands **before** step 9's _"at least 2 e2e journeys"_ (§12, line 266), and **"admin invites a colleague → they set a password → they log in → they see exactly one workspace"** is the strongest second journey available: it exercises the two-axis membership model end to end, which is precisely what a reader should see working.
    - **The honest deadline is step 10 (deploy), not step 8.** Until deploy, the only people this can lock out are test fixtures. Slipping the flow **within** the build order is fine; slipping it **past deploy** is not. That is what makes step 8 a choice rather than an emergency, and it is the answer if step 8 gets crowded.
    - **Enforced by a checklist, not by this marker.** A forward marker in a document drifts — OPEN-4 survived only because it was hunted for. So the DoD in `PROJECT_BRIEF.md` §12 now carries `- [ ] Invited users can set a password and log in; no invite creates an unreachable account.` A box that blocks v1.0 from being called done is the same reasoning that put the definer-function allowlist in a **test** rather than a comment.
    - Carries the distinguishing-signal requirement above: pending-invite accounts are indistinguishable from credentialled ones by any column today, so this flow must add that signal to find them.
  - **Consequence — B relocated the write-correctness burden into the definer function bodies.** Recorded before anything is built on top of it. Pre-B, `memberships_tenant` was `FOR ALL USING/WITH CHECK (tenant_id = current_tenant)`, so the policy enforced tenant-scoping on every write and a buggy function body still could not cross a tenant boundary. Post-B the app role cannot write at all and the only write path is the definer, whose policy is `USING (true) WITH CHECK (true)` — it constrains nothing. Tenant-scoping and the admin check are now **both** the function body's sole responsibility, with no database-layer backstop beneath them. **Standing rule: every definer write function acting on behalf of an authenticated caller must enforce, in its own body, (a) that the caller is an admin of the active tenant and (b) that the target row belongs to that tenant — because nothing below it will.** `register_tenant` is exempt because it runs pre-auth and creates the tenant it writes into, so caller-authorization is undefined there; `login_lookup` is read-only. Every function added after those two is subject to the rule. Consequently the **step-5 gate requires live negatives for authorization, not only atomicity**: a non-admin call is rejected, and an admin of tenant A cannot modify tenant B's memberships through the function. A forced-failure test proves writes roll back cleanly, not that the caller was permitted to make them. Full text in ADR-006 §7.
- **Amended at Phase 1 of step 4 — co-member visibility accepted as an intentional default.** Every member of a tenant can read every co-member's identity and role. This existed only as a side effect of the tenant axis being keyed on `tenant_id` alone; it is now a decision. Co-member visibility is the right default for team SaaS. Reads are deliberately **not** role-gated, because gating a read on role means a role term in a read policy — the option-C danger above — and co-member identity and role are not sensitive enough to justify reopening that class. What genuinely is sensitive (`password_hash`) is withheld by column grant.
- **Alternatives considered:**
  - **Keep the brief's one-tenant-per-user model** — less work, and defensible against "do not over-build". Rejected because a membership model deepens the single thing the project exists to demonstrate rather than adding an orthogonal feature, and `PROJECT_BRIEF` §5 explicitly invites schema refinement.

## ADR-007 — Child-table tenant consistency: composite foreign key

- **Date:** 2026-09-09
- **Status:** Accepted
- **Context:** Step 6 introduces the first tables that are **children of another tenant-scoped table**: `asset_events`, `readings` and `maintenance_records` all belong to an `asset`, and the asset belongs to a tenant. That creates a question the identity/tenancy tables never raised — how does a child row's tenancy stay consistent with its parent's?

  Two shapes were on the table. **(b) FK-derived:** the child carries no `tenant_id` and its RLS policy establishes tenancy by joining to `assets`. **(a) denormalized:** the child carries its own `tenant_id` and its policy keys directly on `app.current_tenant`, exactly like every other tenant-scoped table.

  **(a) is not a free choice — it is what the authoritative documents already specify.** `PROJECT_BRIEF.md` §5 gives `tenant_id (fk)` to `asset_events` (:137), `readings` (:138) and `maintenance_records` (:139) individually, and its first design rule (:144) is "every tenant-scoped table has `tenant_id` and an RLS policy keyed to the current tenant". ADR-006 §3 lists all three among the tables whose policy is "keyed on `app.current_tenant`". This ADR does not re-decide that; it decides the part both documents leave open — **what keeps the denormalized `tenant_id` honest.**

  **(b) was never available anyway, and the reason is this project's entire bug history.** A policy that derives one row's tenancy by joining to another table is a **subquery inside an RLS policy on a `FORCE ROW LEVEL SECURITY` table** — the precise shape that produced the OPEN-5 `deleted_at` deadlock (a policy predicate blocking the very statement it was meant to guard), the `FOR ALL` write-vector defaults (ADR-006 §0.1, §3), and the citext operator-resolution lockout (ADR-004's operator amendment). Three separate wounds, one shape. It is also slower on every read of a hot time-series table.

  Denormalization has a real cost, and naming it is the point of this entry: `readings.tenant_id` must **stay** equal to its asset's. Nothing in shape (a) makes that true by itself. Left to application discipline, a single service that sets `tenant_id` from the session while taking `asset_id` from the request body writes a row whose two halves disagree — and it is **invisible to RLS**, because the policy only ever checks `tenant_id` against the GUC and that half is correct. The row is isolated; it is simply attached to the wrong asset. So the mechanism is the decision.

- **Decision:** A **composite foreign key**, declared in migration SQL.

  ```sql
  -- parent
  ALTER TABLE public.assets ADD CONSTRAINT assets_id_tenant_key UNIQUE (id, tenant_id);

  -- every child
  FOREIGN KEY (asset_id, tenant_id)
    REFERENCES public.assets (id, tenant_id) ON DELETE RESTRICT
  ```

  The child keeps its own `tenant_id` (so its policy stays the canonical single-column expression, no subquery), and the composite FK makes a mismatched pair **unrepresentable** rather than merely discouraged.

- **Consequences:**
  - **It is declarative and always-on.** It holds against the app role, against the migration role, against any future `SECURITY DEFINER` function, against a `psql` session, and against any code path that bypasses the application entirely. This is the property a trigger cannot match without being written as `ALWAYS` and written correctly, and the property application-layer validation cannot match at all.
  - **It adds no procedural code to the danger zone.** ADR-004 and ADR-006 are a sustained argument that logic inside policies and inside definer bodies is where this project's bugs live. A constraint is not logic; it is a shape. Nothing new becomes bypassable, and nothing new needs a mutation test to prove it is reachable — though one is run anyway (step 6 Phase 1 sweep).
  - **`UNIQUE (id, tenant_id)` on `assets` is not an extra artifact.** `PROJECT_BRIEF.md` §5 (:148) already calls for "composite `(tenant_id, id)` patterns". The unique index is required by Postgres as the FK's referenced target, and it serves the brief's index rule at the same time.
  - **An asset's `tenant_id` becomes effectively immutable once it has children** — changing it would violate every child's FK. **This is correct, not a limitation: assets do not move between tenants.** There is no product story in which they do, and if one ever arose it would need to be a deliberate, audited migration rather than an `UPDATE`. Recorded explicitly so a future reader meets it as a decision rather than as a puzzling constraint violation.
  - **The rejection surfaces as `23503` (foreign key violation), not as an RLS error.** A cross-tenant `INSERT` blocked by `WITH CHECK` raises `42501`/"new row violates row-level security policy"; a tenant-mismatched child row raises `23503`. **Two mechanisms, two SQLSTATEs, and the tests assert them distinctly.** Conflating them into one "it is rejected" assertion would let either mechanism silently stop working while the other kept the test green — the same trap catalog assertion 9 exists to avoid on the grants-versus-policy axis, and the same one that made the step-5 RBAC gate un-testable until the two layers were given distinct error codes.
  - Children still carry their own single-column `tenant_id` policy, so the generic isolation matrix covers them with no special case and no subquery anywhere.
- **Alternatives considered:**
  - **A trigger** (`BEFORE INSERT OR UPDATE`, deriving or verifying `tenant_id` from the parent) — works, and is the common answer. Rejected: it is procedural code executing inside the write path, it must be written `ALWAYS` to survive a session that disables triggers, it needs its own mutation coverage to prove it is reachable, and it can be dropped by one statement with nothing else complaining. A constraint has none of those failure modes.
  - **A `CHECK` constraint** — cannot express this at all. `CHECK` may not reference another table, which is exactly what "agrees with its asset" requires.
  - **Application-layer validation only** — rejected by `PROJECT_BRIEF.md` §7's defence-in-depth requirement and by the whole premise of ADR-004: the database is the boundary, not the application.
  - **Shape (b), FK-derived tenancy with a subquery in the policy** — rejected above and in Context. Contradicts the brief and ADR-006, and reopens the exact policy-complexity class this project has been burned by three times.
