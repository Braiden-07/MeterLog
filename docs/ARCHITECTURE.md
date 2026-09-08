# ARCHITECTURE.md — MeterLog

> Living architecture description. Keep current as modules land.
> Authoritative scope lives in `PROJECT_BRIEF.md`; choices are justified in `DECISIONS.md`.

## 1. Overview

## 2. System diagram

## 3. Repository layout

```
meterlog/
├── apps/
│   ├── api/                     NestJS — REST under /api/v1
│   │   ├── prisma/
│   │   │   ├── schema.prisma            datasource → MIGRATION_DATABASE_URL (CLI only)
│   │   │   └── migrations/              role bootstrap; RLS ships as hand-written SQL
│   │   ├── src/
│   │   │   ├── common/prisma/           runtime client, bound to DATABASE_URL
│   │   │   ├── common/session/          Redis sessions + signed cookie ids
│   │   │   ├── common/request-context/  AsyncLocalStorage: tx, user, tenant, role
│   │   │   ├── common/tenant-context/   the two-GUC interceptor (verify-before-set)
│   │   │   └── health/                  GET /api/v1/health
│   │   └── test/db/                     catalog RLS · isolation · definer · interceptor
│   ├── web/                     Next.js App Router (Tailwind, TanStack Query, RHF, Zod)
│   └── ...
├── packages/shared/             Zod contracts shared by both apps
├── docker/postgres/             local-only role bootstrap (first-start init)
├── docs/                        BRIEF · PROGRESS · DECISIONS · ARCHITECTURE
├── .github/workflows/ci.yml     lint → typecheck → test → build
└── docker-compose.yml           Postgres 16 + Redis 7
```

## 4. Backend modules

### 4.1 Auth

### 4.2 Tenants

### 4.3 Users

### 4.4 Assets

### 4.5 Readings

### 4.6 Maintenance

### 4.7 Audit

### 4.8 Common (guards, interceptors, filters, DTOs)

## 5. Frontend structure

## 6. Data model

### 6.1 ERD

### 6.2 Tables

### 6.3 Indexes

## 7. Tenant isolation (Row-Level Security)

### 7.1 Policy design

### 7.2 Per-request tenant context

Two request-scoped GUCs, set by `TenantContextInterceptor` inside one interactive transaction per authenticated request. `SET LOCAL` is scoped to a transaction and therefore to the single pooled connection that transaction holds — which is why the whole request runs inside one, rather than setting context per query.

Ordering is **verify, then set** (ADR-006 §4), and it is structural rather than sequential — the tenant GUC is never assigned a value that has not already been proven:

1. `SET LOCAL app.current_user` — every authenticated request. The self-axis policies key on it, which is what lets a user read their own memberships at login before any workspace is chosen.
2. Re-verify the claimed tenant against `public.memberships`, with the candidate tenant as a **bound parameter** — never read from a GUC, because reading it from a GUC would mean setting it first.
3. Zero rows ⇒ the membership was revoked since the session was minted ⇒ **403**, the session's active tenant is cleared, and `app.current_tenant` is never set at any instant.
4. One row ⇒ `SET LOCAL app.current_tenant`, and the freshly-read `role` is the authoritative role for RBAC this request. The role cached in the session is never used for an authorization decision.

The re-verify is also where `deleted_at IS NULL` lives. It cannot live in the `memberships` row policies — the predicate would block the revoking `UPDATE` itself (OPEN-5) — so this query, which only ever reads, is the security gate. Revocation therefore takes effect on the **next request**, and a role change likewise.

### 7.3 Transaction & statement timeouts

### 7.4 Database roles & privileges

### 7.5 Pre-auth access path (SECURITY DEFINER functions)

### 7.6 How isolation is tested (two-tenant + catalog coverage)

## 8. Authentication & session handling

Session cookie + Redis (ADR-001). `SessionService` stores `{ userId, activeTenantId, role }` under `meterlog:sess:<id>`, and the cookie carries `<id>.<HMAC-SHA256>` — a 128-bit random id plus a signature verified with `timingSafeEqual`. The client holds only an opaque id and never an active tenant, so it cannot forge one; that is the "belt" of ADR-006 §4's belt-and-braces, with the per-request re-verify as the braces.

The stored `role` is **not authoritative** — it goes stale the moment an admin changes it. Authorization uses `RequestContext.role`, re-read from the database each request.

## 9. Authorization (RBAC matrix)

## 10. Audit logging

## 11. API conventions

## 12. Error handling & logging

## 13. Configuration & secrets

## 14. Local development

## 15. CI/CD

## 16. Deployment topology

### 16.1 Pre-deploy checklist — Render (read before the first migration runs there)

> **Standing risk: green CI cannot see this class of bug.** Locally and in CI the migration role is the cluster bootstrap **superuser**. On Render it is not. A superuser satisfies `pg_has_role` unconditionally, bypasses RLS outright, and can `ALTER ... OWNER` anything — so an entire class of privilege defect is invisible in both environments where the tests run, and appears for the first time against Render. **Definer-related migrations therefore carry deployment risk that a green pipeline does not cover.** Treat every migration that creates, owns, or grants on a `SECURITY DEFINER` object as needing a real dry-run against a non-superuser role before it reaches production.

- [ ] **Role membership must not be left behind — this is a real RLS bypass, not hygiene.** `ALTER FUNCTION ... OWNER TO meterlog_definer` requires the executing role to be a **member** of `meterlog_definer`. `20260908000000_auth_definer_functions` therefore grants itself that membership _only if it lacks it_ (it holds `ADMIN OPTION` from having created the role in `20260903000000`), performs the two `ALTER`s, and **revokes the membership again**. Postgres matches a policy's role by **membership**, not by identity, so a migration role left inside `meterlog_definer` silently acquires every `FOR ALL TO meterlog_definer USING (true) WITH CHECK (true)` policy on `users`, `tenants` and `memberships` — reintroducing, through role membership, exactly the FORCE-RLS bypass the three-role model exists to prevent. It would fail no test: locally and in CI the migrator is a superuser and bypasses RLS regardless, so the assertion that would catch it never gets the chance. **Do not "simplify" the grant/revoke pair into a standing grant.**
- [ ] **`20260908000000_auth_definer_functions` is the first migration that would have failed on Render.** Before it, no migration needed anything beyond `CREATE`/`GRANT` on its own objects. Confirm it applies cleanly against Render's non-superuser role, then run check (a) below — it must return false.
- [ ] **Confirm the app role is read-only on the identity tables after deploy** — Decision B; catalog assertion 9 asserts this in CI, but assert it against the real database too. Check (b) below; all rows must be false.
- [ ] **Confirm no `SECURITY DEFINER` function is executable by `PUBLIC`**, and that each pins a `search_path` that does **not** contain `public` (catalog assertions 4, 11, 12).
- [ ] **Set the `meterlog_app` password** — deliberately absent from migration SQL. One-time, from the platform secret store: `ALTER ROLE meterlog_app WITH LOGIN PASSWORD '<secret>';`
- [ ] **Set `SESSION_SECRET`** from the secret store. `SessionService` refuses to construct without one, so an unsigned-cookie deployment cannot happen by accident.
- [ ] Confirm `DATABASE_URL` points at `meterlog_app` and `MIGRATION_DATABASE_URL` at the migration role. Pointing `DATABASE_URL` at the migration role disables tenant isolation while every structural test still passes.
- [ ] Re-check the ADR-004 open question with a real answer, not an assumption: the migration role needs `CREATEROLE` and role-admin rights for `20260903000000`'s `CREATE ROLE` / `ALTER ROLE ... SET`.

Check (a) — the migration role must **not** be left inside `meterlog_definer`:

```sql
SELECT pg_has_role('<render migration role>', 'meterlog_definer', 'MEMBER');  -- must be false
```

Check (b) — the app role must hold no write privilege on any identity table:

```sql
SELECT c.relname, priv, has_table_privilege('meterlog_app', c.oid, priv)
FROM pg_class c CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) priv
WHERE c.relname IN ('users','tenants','memberships');   -- all must be false
```

### 16.2 Application-layer notes that bite at deploy

- **Duplicate-email → HTTP 409 must key on SQLSTATE `23505`, not on the constraint name.** Postgres raises `duplicate key value violates unique constraint "users_email_live_key"`, but Prisma's raw-query wrapper flattens it to `Raw query failed. Code: 23505. Message: Unique constraint failed: ` — **the constraint name is dropped**. Any handler that string-matches the constraint name will silently never fire, turning a 409 into a 500. On `register_tenant` only the email index can realistically raise `23505`; the other two keys are `gen_random_uuid()` primary keys.

## 17. Observability

## 18. Known limitations
