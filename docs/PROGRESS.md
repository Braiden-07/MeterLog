# PROGRESS.md — MeterLog

> Running log of what was built each session, what's next, and any blockers.
> Newest entry at the top. Do not edit `PROJECT_BRIEF.md` (author-owned).

## Status

- **Current milestone:** v0.1 — planning & scaffold
- **Build-order step (PROJECT_BRIEF §11):** 3 (scaffold) complete; 4 (auth + tenancy foundation) next
- **Blockers:** —

---

## Session log

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
