# CLAUDE.md

> Repo-root context for Claude Code. Read automatically every session. Keep this lean (< ~150 lines) — deep detail lives in `docs/`. This is a reusable template; the values below are filled for **MeterLog**. For future projects, copy this file and swap the project-specific sections.

## Project

- **Name:** MeterLog — multi-tenant asset & utility-meter traceability SaaS.
- **What it is:** operations managers, field technicians, and auditors track physical assets through their lifecycle with RBAC and a full audit trail.
- **Full spec:** see `docs/PROJECT_BRIEF.md` (authoritative for scope, data model, API, security, build order). Read it before starting substantial work.
- **This is Project 1 of a 10-project portfolio.** Goal: production practices (multi-tenancy, RBAC, audit, testing, CI/CD) over feature count.

## Stack

- **Frontend:** Next.js (App Router) + TypeScript, Tailwind, TanStack Query, React Hook Form, Zod. Tests: Vitest + Playwright.
- **Backend:** NestJS (modular monolith), REST under `/api/v1`, OpenAPI via Nest Swagger. Auth: session cookie + Redis, argon2id hashing (ADR-001). Authz: RBAC guards. Validation: class-validator DTOs.
- **Data:** PostgreSQL with Row-Level Security for tenant isolation; Redis for sessions/cache. ORM + migrations: see DECISIONS.
- **Infra:** Docker + docker-compose locally; Vercel (frontend), Railway/Render (backend + DB + Redis). CI: GitHub Actions. Errors: Sentry. Logs: pino (structured JSON).

## Commands

> npm workspaces monorepo: `apps/api` (Nest), `apps/web` (Next), `packages/shared` (Zod contracts). Run from the repo root.

- Install: `npm install`
- Dev (all): `cp .env.example .env` → `docker compose up -d` → `npm run db:migrate` → `npm run dev`
- Test (unit/integration): `npm run test`
- Test (DB suites only): `npm run test:db` — catalog RLS coverage, the catalog-driven isolation harness, the membership dual-axis proof, the definer probe, the pre-auth definer functions, the membership-write definer functions and their §7 body-level authorization, the tenant-context interceptor, and (step 7a) the audit-capture proofs
- Test (API acceptance): included in `npm run test` — the step-4 auth suite, the step-5 RBAC suite, and the revocation-over-HTTP proof, all over real HTTP with real signed cookies through the bound interceptor
- Test (e2e): `npm run test:e2e`
- Lint: `npm run lint` · Typecheck: `npm run typecheck` · Build: `npm run build`
- **Doc citations: `npm run docs:check`** — walks `docs/*.md`, and for every `file#Lnn` link asserts the path resolves, the line exists, AND (where the link text quotes a string or an identifier) that the literal appears within a few lines of the anchor. **A distinct CI step**, so drift reads as "citation drift" rather than as a buried test failure. Points 1–2 only catch deletions; point 3 is what catches an anchor that slid.
- DB migrate: `npm run db:migrate` (dev) / `npm run db:migrate:deploy` (CI + prod)
- Prisma client: `npm run db:generate`

**Two database roles, two URLs** (ADR-004). `MIGRATION_DATABASE_URL` owns the schema and runs migrations; `DATABASE_URL` is the restricted runtime role. Never point `DATABASE_URL` at the migration role — it disables tenant isolation while every structural test still passes.

## Conventions

- TypeScript strict mode on; no `any` without a comment justifying it.
- REST: plural nouns, correct status codes, error envelope `{ error: { code, message, details? } }`, pagination + filtering + sorting on list endpoints.
- Every tenant-scoped table has `tenant_id` + an RLS policy; tenant context is set per request. Never rely on app-layer filtering alone for isolation.
- Every create/update/delete on core entities writes an `audit_log` row (actor, action, before/after).
- UUID primary keys; `created_at`/`updated_at` on mutable tables; soft delete (`deleted_at`) on user-facing entities. Append-only tables are never updated or deleted — see the declaration below.
- Validation at the boundary (DTOs server-side, Zod client-side). Reject unknown fields.
- Secrets only via env/secret stores; `.env` stays in `.gitignore`; never commit credentials.
- Conventional commits; small PRs; trunk-based with short-lived feature branches.

## Append-only tables — a DECLARED property, never an inferred one

**The list.** These tables are append-only: rows are inserted and read, never updated and never deleted. A correction is a **new row**, not an edit.

| Table          | Declared since               | Basis                                                                                                                      |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `asset_events` | step 6 phase 1               | `PROJECT_BRIEF.md` §5 :137 — "**append-only**, no updates/deletes"                                                         |
| `readings`     | step 6 phase 2               | `PROJECT_BRIEF.md` §5 :138 + :146 — implied by omission; see below. **Declared and enforced from step 6 phase 2.**         |
| `audit_log`    | **step 7 phase 7a — LANDED** | `PROJECT_BRIEF.md` §5 :140 — "**append-only**", and the strongest case here: the app role cannot write it AT ALL (ADR-010) |

**Why this is written down instead of left to be noticed.** The brief marks `asset_events` (:137) and `audit_log` (:140) append-only in so many words. It never says it about `readings` (:138) — the property is there only **by omission**, because :146 says "append-only tables get `created_at` only" and `readings` is the one domain table with no `updated_at` and no `deleted_at`. That is a true inference and a **dangerous way to hold a security-relevant property.**

Implicit-by-omission is the exact shape of this repo's worst bugs. `WITH CHECK` defaulting from `USING` on a `FOR ALL` policy was a write vector nobody wrote down (ADR-006 §0.1). An operator resolving through an implicit cast because `public` was off the pinned `search_path` was an account lockout nobody wrote down (ADR-004's operator amendment). In both cases the correct behaviour was inferable and the wrong behaviour was silent. A reader reconstructing "is `readings` append-only?" from which column is _absent_ is one refactor away from adding an `updated_at` "for consistency" and quietly ending the property.

**So the property is declared, and the declaration is enforced:**

- `APPEND_ONLY_TABLES` in `apps/api/test/db/helpers.ts` is this table's executable mirror. Keep the two in step — the constant is what CI reads.
- **Catalog assertion 13** binds the declaration to the grants: a declared append-only table must hold **exactly `SELECT, INSERT`** for `meterlog_app` — or **exactly `SELECT`** where the writer is a `SECURITY DEFINER` trigger rather than the app role. A future `GRANT UPDATE ON public.asset_events TO meterlog_app` turns the suite **red** instead of silently widening the table's write surface.
  - **The second case arrived with `audit_log` at step 7a and is DERIVED, not hand-listed:** `DEFINER_WRITTEN_APPEND_ONLY_TABLES` is the intersection of `APPEND_ONLY_TABLES` with `DEFINER_ACCESSIBLE_TABLES`. So the expected grant is still an **equality** in both cases, never relaxed to a subset — and if `audit_log` were ever removed from the definer-reachable list, assertion 13 would tighten back to demanding `INSERT` and turn red, which is the correct alarm. **Widening the grant to make one expected string work would hand the app role the very `INSERT` ADR-010 exists to withhold** — the same trap as granting `TRUNCATE` to fix a teardown.
- The isolation matrix reads the same declaration through each fixture's `appWrites` capability, and asserts `permission denied` on UPDATE/DELETE where writes are not declared — so the property is proven behaviourally too, not only structurally.
- **`appWrites` is read from the declaration, never from `has_table_privilege`.** Deriving it from the live grant would make the test assert whatever the grant happens to be, which catches nothing by construction — the tautology that made a mutated policy indistinguishable from a correct one until catalog assertion 4 was tightened to assert the pin's _content_.

Adding a table here means adding it to `APPEND_ONLY_TABLES` and giving it a `SELECT, INSERT`-only grant — or, if a definer trigger is its writer, a `SELECT`-only grant plus an entry in `DEFINER_ACCESSIBLE_TABLES`. It also needs a URL segment in `TABLE_TO_SEGMENT` (`test/api/route-inventory.spec.ts`), which is asserted set-equal to the declaration and went red the moment `audit_log` landed — as designed. Removing one requires a reviewed edit in every one of those places, which is the point.

## Test-suite invariants (do not "optimize" these away)

- **The database suites must run in a mode where connection reuse actually happens.** `apps/api/vitest.config.ts` sets `fileParallelism: false`, and `test/db/interceptor.spec.ts` pins its client to `connection_limit=1`. Both are load-bearing, not performance accidents.
  - **Why:** the whole pooled-connection bug class is only observable across a _reused_ connection. `current_setting('app.x', true)` returns `NULL` on a connection that has never had the GUC set, but the **empty string** once `SET LOCAL` has touched it once — so a guard against the empty-string case passes on a fresh connection and fails only after reuse.
  - **The proof this is real:** drop the `NULLIF(..., '')` from the re-verify in `tenant-context.interceptor.ts` and run `test/db/interceptor.spec.ts`. The test `a session with a BLANK user id fails closed with 403, not 500` **passes when run in isolation** (`-t` a single test → fresh connection → `NULL`) and **fails only in a full-file run**, once the connection has been reused (`''` → `''::uuid` → 22P02 → a 500 instead of a fail-closed 403).
  - **Therefore:** do not add per-test connection isolation, do not give each test its own client, and do not enable `fileParallelism` for `test/db/**` in pursuit of CI speed. Any of those silently blinds the suite to the entire class while leaving it green.
- **`test/db/interceptor.spec.ts` asserts `pg_backend_pid()` equality across requests.** That assertion is the guard that reuse actually occurred; without it the tests pass whether or not re-verification works.
- **`test/db/membership-writes.spec.ts` is load-bearing as a whole file, and its negatives must keep being produced by calling the definer functions DIRECTLY** — as `meterlog_app`, with `app.current_user` / `app.current_tenant` set by hand, no interceptor and no HTTP.
  - **Why, and this is not visible from outside the file:** these negatives are carrying weight a `GRANT` used to carry. Before step 5, catalog assertion 6 asserted `meterlog_definer` held **no `UPDATE` on any table**, so a definer-body bug attempting one was _unreachable_ — the privilege did not exist. change-role and revoke (a soft delete) are both UPDATEs, so the definer now holds surgical `UPDATE` on `memberships` and assertion 6 is narrowed to an equality on that exact shape. **The grant no longer stands underneath the function bodies.** What replaces it is the §7 body checks plus this suite, which is the only thing that exercises them with nothing in front. There is no third layer.
  - **Therefore:** do not rewrite these negatives to go through the step-5 Phase 2 HTTP endpoints, and do not delete them as duplicates of the endpoint tests. They are not duplicates — the guard is the **outer** check and the function body the **inner** one, and defence-in-depth is only real if each is proven _without_ the other. A negative that runs through the guard proves the guard; the inner check then becomes untested and DECISION B has silently reverted to option A, the rejected design where a guard is the only thing between a technician and an admin role.
  - **And do not relax a body check because "the RBAC guard handles it now."** This suite is the tripwire for precisely that, so a red test here after an endpoint change is the intended signal, not an inconvenience.
- **Teardown goes through `resetDatabase(migrator)` in `test/db/helpers.ts`. Do not hand-roll `DELETE` lists.**
  - **Why:** teardown ordering used to be duplicated across a dozen sites, each hard-coding the FK order. When `readings` landed at step 6 phase 2, one of those lists did not know about it, threw `23503` partway, never reached its later deletes, and the residue broke **31 tests in an unrelated suite** with an error naming neither the cause nor the culprit.
  - `resetDatabase` issues one `TRUNCATE … CASCADE` over the catalog-derived table list, so **Postgres resolves the FK graph** and the ordering knowledge does not exist anywhere in the suite. New tables need no edit.
  - It then calls `assertNoResidualRows`, so a teardown that stops cleaning fails **at its own site, naming the table**, instead of surfacing elsewhere. `test/db/teardown.spec.ts` proves that guard fires by planting a stray row.
  - **It must run on a `migratorClient()`, never the app client** — catalog assertion 6 deliberately asserts `meterlog_app` holds no `TRUNCATE`. If you see `permission denied`, the fix is to pass the migrator, **never** to grant the app role `TRUNCATE`: that silently defeats a real assertion to make a test convenient.
  - Row counts in the guard are taken on the migrator for the same reason they must be: an app-client count is RLS-filtered and returns zero with no tenant GUC set, which would make the guard vacuous forever.
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
