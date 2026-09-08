# CLAUDE.md

> Repo-root context for Claude Code. Read automatically every session. Keep this lean (< ~150 lines) — deep detail lives in `docs/`. This is a reusable template; the values below are filled for **MeterLog**. For future projects, copy this file and swap the project-specific sections.

## Project

- **Name:** MeterLog — multi-tenant asset & utility-meter traceability SaaS.
- **What it is:** operations managers, field technicians, and auditors track physical assets through their lifecycle with RBAC and a full audit trail.
- **Full spec:** see `docs/PROJECT_BRIEF.md` (authoritative for scope, data model, API, security, build order). Read it before starting substantial work.
- **This is Project 1 of a 10-project portfolio.** Goal: production practices (multi-tenancy, RBAC, audit, testing, CI/CD) over feature count.

## Stack

- **Frontend:** Next.js (App Router) + TypeScript, Tailwind, TanStack Query, React Hook Form, Zod. Tests: Vitest + Playwright.
- **Backend:** NestJS (modular monolith), REST under `/api/v1`, OpenAPI via Nest Swagger. Auth: JWT/session (see DECISIONS). Authz: RBAC guards. Validation: class-validator DTOs.
- **Data:** PostgreSQL with Row-Level Security for tenant isolation; Redis for sessions/cache. ORM + migrations: see DECISIONS.
- **Infra:** Docker + docker-compose locally; Vercel (frontend), Railway/Render (backend + DB + Redis). CI: GitHub Actions. Errors: Sentry. Logs: pino (structured JSON).

## Commands

> npm workspaces monorepo: `apps/api` (Nest), `apps/web` (Next), `packages/shared` (Zod contracts). Run from the repo root.

- Install: `npm install`
- Dev (all): `cp .env.example .env` → `docker compose up -d` → `npm run db:migrate` → `npm run dev`
- Test (unit/integration): `npm run test`
- Test (DB suites only): `npm run test:db` — catalog RLS coverage + definer probe
- Test (e2e): `npm run test:e2e`
- Lint: `npm run lint` · Typecheck: `npm run typecheck` · Build: `npm run build`
- DB migrate: `npm run db:migrate` (dev) / `npm run db:migrate:deploy` (CI + prod)
- Prisma client: `npm run db:generate`

**Two database roles, two URLs** (ADR-004). `MIGRATION_DATABASE_URL` owns the schema and runs migrations; `DATABASE_URL` is the restricted runtime role. Never point `DATABASE_URL` at the migration role — it disables tenant isolation while every structural test still passes.

## Conventions

- TypeScript strict mode on; no `any` without a comment justifying it.
- REST: plural nouns, correct status codes, error envelope `{ error: { code, message, details? } }`, pagination + filtering + sorting on list endpoints.
- Every tenant-scoped table has `tenant_id` + an RLS policy; tenant context is set per request. Never rely on app-layer filtering alone for isolation.
- Every create/update/delete on core entities writes an `audit_log` row (actor, action, before/after).
- UUID primary keys; `created_at`/`updated_at` on mutable tables; soft delete (`deleted_at`) on user-facing entities; append-only tables (asset_events, audit_log) are never updated or deleted.
- Validation at the boundary (DTOs server-side, Zod client-side). Reject unknown fields.
- Secrets only via env/secret stores; `.env` stays in `.gitignore`; never commit credentials.
- Conventional commits; small PRs; trunk-based with short-lived feature branches.

## Test-suite invariants (do not "optimize" these away)

- **The database suites must run in a mode where connection reuse actually happens.** `apps/api/vitest.config.ts` sets `fileParallelism: false`, and `test/db/interceptor.spec.ts` pins its client to `connection_limit=1`. Both are load-bearing, not performance accidents.
  - **Why:** the whole pooled-connection bug class is only observable across a _reused_ connection. `current_setting('app.x', true)` returns `NULL` on a connection that has never had the GUC set, but the **empty string** once `SET LOCAL` has touched it once — so a guard against the empty-string case passes on a fresh connection and fails only after reuse.
  - **The proof this is real:** drop the `NULLIF(..., '')` from the re-verify in `tenant-context.interceptor.ts` and run `test/db/interceptor.spec.ts`. The test `a session with a BLANK user id fails closed with 403, not 500` **passes when run in isolation** (`-t` a single test → fresh connection → `NULL`) and **fails only in a full-file run**, once the connection has been reused (`''` → `''::uuid` → 22P02 → a 500 instead of a fail-closed 403).
  - **Therefore:** do not add per-test connection isolation, do not give each test its own client, and do not enable `fileParallelism` for `test/db/**` in pursuit of CI speed. Any of those silently blinds the suite to the entire class while leaving it green.
- **`test/db/interceptor.spec.ts` asserts `pg_backend_pid()` equality across requests.** That assertion is the guard that reuse actually occurred; without it the tests pass whether or not re-verification works.
- Individual load-bearing tests are marked as such in their own comments (e.g. the citext case-insensitivity regression guard in `auth-definer.spec.ts`, which is the _only_ thing that can catch the silent-operator-resolution class — see ADR-004's operator amendment). Do not delete a test annotated that way as redundant.

## Guardrails (important)

- **Do not over-build.** Complete the Essential scope in `docs/PROJECT_BRIEF.md` §2 before any Stretch item. Out of scope: microservices, Kubernetes, message queues, WebSockets, AI, billing.
- **Don't substitute stack choices** (e.g. swap NestJS for Express, Postgres for Mongo) without proposing it first and logging it in `docs/DECISIONS.md`.
- **Ask before large refactors or new dependencies** — this repo is cost- and quota-conscious; prefer minimal installs.
- Write/extend tests alongside features, not "later." Tenant-isolation and RBAC paths must be tested.
- Prefer editing existing files over creating parallel ones; don't scaffold speculative structure.

## Documentation duties (maintain as we build)

- `docs/PROGRESS.md` — append what changed this session, what's next, any blockers. **Do not** edit `docs/PROJECT_BRIEF.md` (author-owned).
- `docs/DECISIONS.md` — add an ADR-style entry for each significant choice.
- `docs/ARCHITECTURE.md` — keep the architecture description + diagram current as modules land.

## Definition of done

See `docs/PROJECT_BRIEF.md` §12. In short: essential scope complete, tenant isolation proven by test, RBAC + audit working, ≥70% coverage on core, CI green, deployed to HTTPS with Sentry + uptime, README with diagram + real metrics.
