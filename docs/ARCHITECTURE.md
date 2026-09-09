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
│   │   │   ├── common/auth/             @RequiresSession route metadata
│   │   │   ├── common/http/             error-envelope exception filter
│   │   │   ├── auth/                    register · login · switch · me · logout
│   │   │   └── health/                  GET /api/v1/health
│   │   ├── test/db/                     catalog RLS · isolation · definer · interceptor
│   │   └── test/api/                    step-4 acceptance, real HTTP + real cookies
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

`POST /auth/register` · `POST /auth/login` · `POST /auth/switch` · `GET /auth/me` · `POST /auth/logout`, all under `/api/v1`.

- **register** — `register_tenant` (definer) writes tenant + person + admin membership atomically. Duplicate email ⇒ **409**, keyed on SQLSTATE `23505` (§16.2). Does not log the user in; registration stays single-purpose.
- **login** — `login_lookup` (definer) → argon2 verify → workspaces read under RLS via `app.current_user`. Zero memberships ⇒ **200** with no active tenant (OPEN-2); one ⇒ auto-selected; many ⇒ session with no active tenant plus the workspace list. Failures are generic and constant-time-ish, so the endpoint cannot enumerate accounts.
- **switch** — the membership-model boundary. Verifies the membership under RLS before touching the session; a well-formed, existent tenant the caller is not a member of ⇒ **403**.
- **me** — the person, the active workspace, and every live workspace. Carries the one documented app-side `deleted_at IS NULL` predicate (OPEN-5).
- **logout** — destroys the Redis session and clears the cookie.

Routes needing identity are marked `@RequiresSession()`; the tenant-context interceptor enforces it and returns **401**. It is deliberately _not_ a `CanActivate` guard — Nest runs guards **before** interceptors, so a guard cannot see a request context that has not been established yet.

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
- [ ] **`20260909000000_membership_write_functions` repeats the same grant/revoke pattern** for its three functions, so check (a) below covers it too — and it is the migration that first gives `meterlog_definer` an `UPDATE` privilege, which makes a stranded role membership strictly more dangerous than it was at step 4.
- [ ] **`20260908000000_auth_definer_functions` is the first migration that would have failed on Render.** Before it, no migration needed anything beyond `CREATE`/`GRANT` on its own objects. Confirm it applies cleanly against Render's non-superuser role, then run check (a) below — it must return false.
- [ ] **Confirm the app role is read-only on the identity tables after deploy** — Decision B; catalog assertion 9 asserts this in CI, but assert it against the real database too. Check (b) below; all rows must be false.
- [ ] **Confirm no `SECURITY DEFINER` function is executable by `PUBLIC`**, and that each pins a `search_path` that does **not** contain `public` (catalog assertions 4, 11, 12).
- [ ] **Set the `meterlog_app` password** — deliberately absent from migration SQL. One-time, from the platform secret store: `ALTER ROLE meterlog_app WITH LOGIN PASSWORD '<secret>';`
- [ ] **Set `SESSION_SECRET`** from the secret store. `SessionService` refuses to construct without one, so an unsigned-cookie deployment cannot happen by accident.
- [ ] **Confirm the session cookie is actually `Secure` in production.** `HttpOnly` and `SameSite=Lax` are set unconditionally and covered by an acceptance test; `Secure` cannot be, because it is gated on `NODE_ENV === 'production'` and the tests run over plain HTTP. That gate is therefore **unverifiable by CI and verifiable only here** — the same shape as the superuser-migrator gap. If `NODE_ENV` is not literally `production` on Render the flag silently does not appear, and a signed session cookie can travel over plain HTTP, which undoes the point of signing it. Run check (c) below against a real deployment.
- [ ] **Make that refusal surface as a FAILED DEPLOY, not a booted-but-broken service.** A fail-closed guard is only worth what the moment it first runs is worth. `SessionService` throws in its constructor, so Nest's DI resolves it at bootstrap and the process exits non-zero — but only if something actually instantiates it and the platform actually watches. Confirm both: the Render service has a **health check configured against `/api/v1/health`** and the deploy is gated on it, so a container that dies at boot (or one that boots without ever touching the session layer) is caught rather than left serving. If the health check ever becomes a static route that does not exercise DI, this guard silently stops being a deploy gate.
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

Check (c) — the deployed login response must carry all three cookie flags:

```
curl -is https://<host>/api/v1/auth/login -H 'content-type: application/json'   -d '{"email":"...","password":"..."}' | grep -i set-cookie
# must contain: HttpOnly; Secure; SameSite=Lax
```

### 16.2 Application-layer notes that bite at deploy

**Every authenticated request holds an interactive transaction for its whole duration.** This is the price of the ADR-004 RLS pattern, not an accident: `SET LOCAL` is scoped to a transaction and therefore to one pooled connection, so the request and its GUCs must share that transaction. It was priced deliberately and is recorded here because of how it fails.

- **A slow request holds a connection.** With `connection_limit` connections in the pool, `connection_limit` concurrent in-flight requests exhaust it, and the next request **waits** rather than erroring. Under load this presents as an apparent hang — rising latency with no error rate — which is the hardest failure shape to diagnose from an error dashboard.
- **Three timeouts bound it, and their ordering is deliberate** (ADR-004): the app role's `statement_timeout` (4s) sits _below_ Prisma's transaction `timeout` (5s), so a runaway query is killed by Postgres with an error naming the statement rather than surfacing as an opaque transaction abort. `idle_in_transaction_session_timeout` (10s) catches a transaction left open by a stalled handler. `maxWait` (2s) is the pool-acquisition ceiling — **exceeding it means pool exhaustion, not a slow query**, and that distinction is the one to look for when latency climbs.
- **At deploy:** size Prisma's `connection_limit` against Render's Postgres connection cap, and alert on `maxWait` timeouts specifically — they are the early signal of exhaustion, and they look like nothing else. Re-check under k6 (PROJECT_BRIEF §13).

- **Duplicate-email → HTTP 409 must key on SQLSTATE `23505`, not on the constraint name.** Postgres raises `duplicate key value violates unique constraint "users_email_live_key"`, but Prisma's raw-query wrapper flattens it to `Raw query failed. Code: 23505. Message: Unique constraint failed: ` — **the constraint name is dropped**. Any handler that string-matches the constraint name will silently never fire, turning a 409 into a 500. On `register_tenant` only the email index can realistically raise `23505`; the other two keys are `gen_random_uuid()` primary keys.

- **The membership-write functions raise CUSTOM SQLSTATEs, and Phase 2 maps them to HTTP from the code, never from the message.** `20260909000000_membership_write_functions` defines three:

  | SQLSTATE | Meaning                                                                          | Intended HTTP (step 5 Phase 2) |
  | -------- | -------------------------------------------------------------------------------- | ------------------------------ |
  | `MB001`  | `NOT_ADMIN` — no context, or the caller is not a live admin of the active tenant | 403                            |
  | `MB002`  | `MEMBERSHIP_NOT_FOUND` — target absent, revoked, or in another tenant            | 404                            |
  | `MB003`  | `LAST_ADMIN` — the change would leave the tenant with zero live admins           | 409                            |

  **Why custom rather than the idiomatic standard codes.** `42501 insufficient_privilege` is the natural fit for `MB001` and is the wrong choice: Postgres raises `42501` itself for a plain table-privilege denial, so a test asserting it would pass just as happily against a misconfigured `GRANT` that never reached the function body — a green negative proving nothing. The same argument rules out `P0002` (plpgsql raises it for `SELECT … INTO STRICT`) and `23514` (a real `CHECK`). A code nothing else in the cluster can raise makes each refusal unambiguously attributable to the body check it came from. `MB002` deliberately covers "belongs to another tenant" and "does not exist" with **one** code, so the endpoint is not an oracle for membership ids the caller cannot see.

## 17. Observability

## 18. Known limitations
