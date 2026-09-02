# PROJECT_BRIEF.md — MeterLog

> **Purpose of this file:** single source of truth for the MeterLog build. Read this once at the start of the project and refer back when scope is unclear. The coding agent should treat this as authoritative for _what_ to build and _in what order_. Operational conventions live in `/CLAUDE.md`. Progress and decisions are logged in `docs/PROGRESS.md` and `docs/DECISIONS.md`.
>
> **This is Project 1 of a 10-project portfolio.** Its job is to leverage existing traceability/ERP experience while introducing professional production practices: multi-tenancy, RBAC, audit logging, automated testing, and CI/CD. Do **not** over-build. Ship the essential scope first, then consider stretch goals.

---

## 1. Product Summary

**MeterLog** is a multi-tenant SaaS platform for tracking physical assets (utility meters, equipment) through their full lifecycle — installation, readings, maintenance, and decommissioning — with a complete, tamper-evident audit trail and role-based access control.

- **Real-world problem:** SMEs and municipalities track physical assets in spreadsheets with no audit history, no access control, and no way to see who changed what or when.
- **Target users:** operations managers (full oversight), field technicians (record readings/maintenance), auditors (read-only + audit access).
- **Engineering difficulty:** Medium. The domain is familiar; the _challenge and the learning_ is in doing multi-tenancy, RBAC, audit, testing, and CI/CD to production standard.
- **What recruiters should see:** a real multi-tenant SaaS with proper tenant isolation, role-based permissions, audit logging, a tested codebase, and an automated deployment pipeline — production concerns, not a toy CRUD app.

---

## 2. Scope — Essential vs Stretch

**Build the essential scope completely before touching stretch goals.** A smaller, fully-tested, deployed, documented app beats a larger half-finished one.

### Essential (v1.0 — this is the deliverable)

- Multi-tenant data model with tenant isolation enforced at the database level (Postgres Row-Level Security).
- Authentication (email + password, session or JWT) with secure password handling.
- RBAC with three roles: `owner/admin`, `technician`, `auditor`.
- Core entities: tenants, users, assets, asset events (lifecycle), readings, maintenance records.
- Append-only audit log capturing who did what, when, on which record.
- REST API with validation, pagination, filtering, sorting, consistent error format, and OpenAPI docs.
- Frontend: auth flow, asset list + detail, record a reading, record maintenance, view audit trail, user/role management (admin only).
- Automated tests: unit + integration + a few end-to-end journeys, with coverage reporting.
- CI/CD pipeline: lint → typecheck → test → build → deploy.
- Deployed to a public URL with a custom-ish domain, HTTPS, error monitoring.
- Documentation: README, architecture diagram, API docs, setup instructions.

### Stretch (only after v1.0 ships)

- Background jobs (BullMQ) for scheduled report generation / reading-reminder emails.
- CSV import/export of assets and readings.
- Anomaly flagging on readings (start with simple statistical thresholds, not ML).
- Basic dashboard with asset counts and recent activity.
- Soft-delete + restore UI for admins.
- Rate limiting per tenant.
- Audit-log export for auditors.

**Do not build** (out of scope — belongs to later portfolio projects): microservices, Kubernetes, message-queue-driven architecture, real-time WebSockets, AI features, payment/billing. MeterLog is a modular monolith.

---

## 3. Technology Stack (fixed — do not substitute without logging a decision)

**Frontend**

- Framework: Next.js (App Router) + TypeScript
- Styling: Tailwind CSS
- Server state / data fetching: TanStack Query
- Forms: React Hook Form
- Validation: Zod (shared schemas between client and server where practical)
- Testing: Vitest (unit/component), Playwright (e2e)

**Backend**

- Language: TypeScript
- Framework: NestJS (modular monolith)
- API style: REST, versioned under `/api/v1`, documented with OpenAPI (Nest Swagger)
- Auth: JWT **or** session (pick one, log the decision) with bcrypt/argon2 password hashing
- Authorization: RBAC via Nest guards
- Validation: class-validator + DTOs (Zod on the frontend)
- Background processing (stretch): BullMQ

**Data**

- Primary DB: PostgreSQL, with Row-Level Security for tenant isolation
- Cache/session store: Redis
- Migrations: use the ORM's migration tooling (Prisma or TypeORM — pick one, log it). Prisma recommended for DX; note that RLS needs raw SQL migrations alongside it.

**Infrastructure & DevOps**

- Local: Docker + docker-compose (Postgres + Redis + app)
- Frontend hosting: Vercel
- Backend + DB + Redis hosting: Railway or Render (cost-conscious; pick one, log it)
- CI/CD: GitHub Actions
- Secrets: platform secret stores + GitHub Actions secrets — never in the repo

**Observability**

- Error monitoring: Sentry
- Logging: structured JSON logs (pino)
- Uptime: a free uptime monitor (e.g. UptimeRobot) pointed at a health endpoint

---

## 4. Architecture

**Pattern: modular monolith.** One deployable backend with clear internal module boundaries. This is the correct choice for a solo build — it teaches proper separation of concerns without the operational cost of microservices.

```
User (browser)
   │
   ▼
Next.js frontend (Vercel)
   │  HTTPS / REST (/api/v1)
   ▼
NestJS API (Railway/Render)
   ├── Auth module        (login, tokens/sessions, password)
   ├── Tenants module     (tenant lifecycle)
   ├── Users module       (users, roles, invitations)
   ├── Assets module      (assets + lifecycle events)
   ├── Readings module    (meter readings)
   ├── Maintenance module (maintenance records)
   ├── Audit module       (append-only audit log, cross-cutting)
   └── Common             (guards, interceptors, filters, DTOs)
   │
   ├──────────────► PostgreSQL (RLS per tenant)
   ├──────────────► Redis (sessions/cache; queues if stretch)
   └──────────────► Sentry (errors) / logs
```

**Key architectural decisions to make and log in `docs/DECISIONS.md`:**

- JWT vs session (session + Redis is simpler to reason about and revoke; JWT is more "portfolio-standard" and stateless — either is defensible).
- Prisma vs TypeORM.
- Railway vs Render.
- How RLS is enforced: set the tenant context per request (e.g. `SET LOCAL app.current_tenant`) inside a transaction/middleware, so Postgres policies filter every query automatically. This is the centerpiece of the tenant-isolation story — document it well.

---

## 5. Data Model

Core tables (illustrative — refine during design phase, log schema decisions):

- **tenants** — `id (uuid, pk)`, `name`, `created_at`, `updated_at`, `deleted_at (nullable, soft delete)`
- **users** — `id (uuid, pk)`, `tenant_id (fk → tenants)`, `email (unique per tenant)`, `password_hash`, `role (enum: admin|technician|auditor)`, `created_at`, `updated_at`, `deleted_at`
- **assets** — `id (uuid, pk)`, `tenant_id (fk)`, `serial_number`, `type`, `status (enum: installed|active|maintenance|decommissioned)`, `location`, `installed_at`, `created_at`, `updated_at`, `deleted_at`
- **asset_events** — `id (uuid, pk)`, `tenant_id (fk)`, `asset_id (fk)`, `event_type (enum)`, `payload (jsonb)`, `created_by (fk → users)`, `created_at` — **append-only**, no updates/deletes
- **readings** — `id (uuid, pk)`, `tenant_id (fk)`, `asset_id (fk)`, `value (numeric)`, `unit`, `read_at`, `created_by (fk)`, `created_at`
- **maintenance_records** — `id (uuid, pk)`, `tenant_id (fk)`, `asset_id (fk)`, `description`, `performed_at`, `created_by (fk)`, `created_at`, `updated_at`
- **audit_log** — `id (uuid, pk)`, `tenant_id (fk)`, `actor_user_id (fk)`, `action`, `entity_type`, `entity_id`, `before (jsonb)`, `after (jsonb)`, `created_at` — **append-only**

**Design rules:**

- Every tenant-scoped table has `tenant_id` and an RLS policy keyed to the current tenant.
- UUID primary keys throughout.
- `created_at` / `updated_at` timestamps on mutable tables; append-only tables get `created_at` only.
- Soft delete (`deleted_at`) on user-facing entities (tenants, users, assets); queries filter out soft-deleted rows by default.
- Indexes: composite `(tenant_id, id)` patterns; index foreign keys; index `assets.serial_number`, `readings.(asset_id, read_at)`, `audit_log.(entity_type, entity_id)`.
- Foreign keys with appropriate `ON DELETE` behavior (usually restrict; audit/events never cascade-delete).
- Prove at least one index decision with `EXPLAIN ANALYZE` and note the before/after in docs — this is a resume-worthy detail.

---

## 6. API Design

**Conventions:** REST, `/api/v1`, JSON, plural nouns, correct HTTP methods and status codes, consistent error envelope `{ error: { code, message, details? } }`, cursor or offset pagination (`?limit=&cursor=` or `?page=&pageSize=`), filtering + sorting via query params, OpenAPI/Swagger auto-generated.

Representative endpoints:

- **Auth:** `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- **Users (admin):** `GET /users`, `POST /users` (invite), `PATCH /users/:id` (role), `DELETE /users/:id` (soft)
- **Assets:** `GET /assets` (filter/sort/paginate), `POST /assets`, `GET /assets/:id`, `PATCH /assets/:id`, `DELETE /assets/:id` (soft)
- **Asset events:** `GET /assets/:id/events`, `POST /assets/:id/events`
- **Readings:** `GET /assets/:id/readings`, `POST /assets/:id/readings`
- **Maintenance:** `GET /assets/:id/maintenance`, `POST /assets/:id/maintenance`
- **Audit (admin/auditor):** `GET /audit` (filter by entity, actor, date range, paginated)
- **Health:** `GET /health` (for uptime monitoring)

Status codes: 200/201 success, 400 validation, 401 unauthenticated, 403 unauthorized (role/tenant), 404 not found, 409 conflict, 422 semantic validation, 429 rate limit (stretch), 500 server error. Never leak stack traces to clients.

---

## 7. Authentication & Security Model

Implement all of the baseline; note each in the README mapped to OWASP Top 10.

- **Authentication:** email + password; passwords hashed with bcrypt/argon2 (never plaintext, never reversible).
- **Sessions/tokens:** httpOnly + Secure + SameSite cookies (if sessions) or short-lived access token + refresh (if JWT). Support logout/revocation.
- **Authorization:** RBAC guards on every protected route; a technician cannot access admin endpoints, an auditor is read-only. **Tenant isolation is enforced by RLS at the DB layer**, not just app checks — defense in depth.
- **Input validation:** class-validator DTOs on every endpoint; reject unknown fields.
- **Injection:** parameterized queries only (ORM handles this); never string-concatenate SQL.
- **XSS:** React escapes by default; sanitize any rendered user HTML; set CSP.
- **CSRF:** if cookie-based auth, implement CSRF protection.
- **CORS:** allow-list the frontend origin only.
- **Security headers:** Helmet (CSP, HSTS, X-Content-Type-Options, etc.).
- **Brute-force:** rate-limit + lockout/backoff on login.
- **Secrets:** environment variables via platform secret stores; `.env` in `.gitignore`; rotate anything ever committed.
- **Audit:** every create/update/delete on core entities writes an audit_log row (actor, action, before/after).

---

## 8. Testing Strategy

Target ≥70% coverage on core business logic (auth, RBAC, audit, tenant isolation). Publish a coverage badge.

- **Unit (Vitest):** services, RBAC logic, validation, audit-writing, RLS context helpers.
- **Integration (Vitest + test Postgres/Redis via docker-compose or testcontainers):** repository/service against a real DB; **explicitly test that tenant A cannot read tenant B's rows** (the money test for this project).
- **API (Supertest):** endpoints end-to-end through Nest — auth flows, status codes, validation errors, authorization (403 for wrong role).
- **E2E (Playwright):** login → create asset → record reading → view audit trail; admin invites user and sets role.
- **Static analysis:** ESLint + TypeScript strict mode, run in CI.
- **Stretch:** k6 load test on `GET /assets`; note p95 latency.

---

## 9. CI/CD Pipeline (GitHub Actions)

Trigger on push and PR:

```
push / PR
  → install (cached)
  → lint (ESLint)
  → typecheck (tsc --noEmit)
  → unit + integration tests (spin up Postgres + Redis services)
  → build (frontend + backend)
  → e2e (Playwright, against a preview/build)
  → [main only] deploy backend (Railway/Render) + frontend (Vercel)
  → smoke test /health
```

- **Branching:** trunk-based with short-lived feature branches; PR required to merge to `main`; branch protection on.
- **Migrations:** run as a gated deploy step; keep them reversible; never auto-drop data.
- **Secrets:** GitHub Actions secrets; nothing sensitive in the repo.
- **Rollback:** platform-native rollback to last good deploy; document the steps.
- **Metrics to surface in README:** pipeline duration (target < 10 min), test coverage %, deploy frequency.

---

## 10. Deployment

- **Frontend:** Vercel (auto previews per PR, production on `main`).
- **Backend + Postgres + Redis:** Railway or Render (managed Postgres + Redis; cost-conscious).
- **Domain/DNS/TLS:** custom subdomain, HTTPS enforced.
- **Env management:** separate `development`, `staging` (optional), `production` configs; secrets in platform stores.
- **Backups:** enable managed Postgres automated backups; note restore procedure in docs.
- **Observability in prod:** Sentry DSN wired; structured logs; uptime monitor on `/health`.

---

## 11. Build Order (within this project)

Follow SDLC phases; work in small PRs. Log decisions as you go.

1. **Requirements & planning:** confirm scope (this doc), write epics + user stories with acceptance criteria into GitHub Issues/Projects. Set milestones (v0.1 → v1.0).
2. **Design:** finalize ERD, API contract (OpenAPI stub), RBAC matrix, RLS approach. Record ADRs.
3. **Scaffold:** repo structure, CLAUDE.md, docker-compose (Postgres + Redis), Nest app skeleton, Next app skeleton, CI pipeline running lint+typecheck on an empty test.
4. **Auth + tenancy foundation:** users/tenants tables, RLS policies, registration/login, session/JWT, `GET /me`. Integration-test tenant isolation early.
5. **RBAC:** roles, guards, user management endpoints; tests for 403 paths.
6. **Core domain:** assets + asset_events, readings, maintenance — API + validation + audit writes. Tests per module.
7. **Audit + reporting reads:** audit_log write on every mutation; `GET /audit` with filters.
8. **Frontend:** auth pages, asset list/detail, record reading/maintenance, audit view, admin user management. TanStack Query + RHF + Zod.
9. **E2E + hardening:** Playwright journeys, security headers, rate-limit login, error handling polish.
10. **Deploy:** Vercel + Railway/Render, secrets, migrations, Sentry, uptime, custom domain. Smoke test.
11. **Document:** README (with architecture diagram, screenshots, metrics), API docs, setup, known limitations, roadmap.
12. **Stretch (optional):** pick from Section 2 only if v1.0 is genuinely done.

---

## 12. Definition of Done (v1.0)

- [ ] Tenant isolation enforced by RLS and proven by an integration test (A can't see B).
- [ ] Three roles with enforced permissions; 403 paths tested.
- [ ] Audit log written on every core mutation; viewable by admin/auditor.
- [ ] All essential endpoints implemented with validation, pagination, error envelope, OpenAPI docs.
- [ ] Frontend covers all essential journeys.
- [ ] ≥70% coverage on core logic; unit + integration + API + at least 2 e2e journeys green.
- [ ] CI pipeline green end-to-end; deploy automated on `main`.
- [ ] Deployed to public HTTPS URL; Sentry + uptime + `/health` live.
- [ ] README with architecture diagram, setup, screenshots, and real metrics (coverage %, p95 latency, pipeline time).
- [ ] `docs/` maintained: PROJECT_BRIEF, PROGRESS, DECISIONS, ARCHITECTURE.

---

## 13. Metrics to Capture (for the README + your CV bullets)

- Test coverage % on core modules.
- API p95 latency on a key endpoint (from a k6 run).
- One `EXPLAIN ANALYZE` before/after showing an index improving a query.
- CI pipeline duration.
- Deploy frequency (commits → prod).

These turn "built a SaaS app" into "engineered a multi-tenant SaaS with DB-enforced tenant isolation, RBAC, and audit logging; 78% test coverage; p95 API latency of Xms; automated CI/CD deploying in under N minutes."

---

## 14. Documentation to Maintain (agent responsibility during build)

- `docs/PROJECT_BRIEF.md` — this file (author-maintained; agent does **not** rewrite it).
- `docs/PROGRESS.md` — running log: what was built each session, what's next, blockers.
- `docs/DECISIONS.md` — ADR-style entries for each significant choice (JWT vs session, Prisma vs TypeORM, RLS approach, hosting).
- `docs/ARCHITECTURE.md` — living architecture description + diagram, updated as modules land.
- `README.md` — public-facing; assembled toward the end from the above.
