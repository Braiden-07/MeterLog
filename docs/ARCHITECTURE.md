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
│   │   │   ├── common/auth/             @RequiresSession + @RequiresRole metadata
│   │   │   ├── common/http/             error-envelope exception filter
│   │   │   ├── auth/                    register · login · switch · me · logout
│   │   │   ├── memberships/             GET/POST/PATCH/DELETE /users (RBAC-gated)
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

### 4.3 Users (memberships)

`GET / POST / PATCH / DELETE /users` under `/api/v1`. The Users module is a **memberships** module in substance (ADR-006 §7): the resource is a person's access to the active workspace, not the person. `:id` is a **membership id**, not a user id — that makes §7's clause (b) a direct check on the row being written.

- **list** — every member of the active tenant, joined to identity. **Not role-gated**, by decision (ADR-006 §3): co-member visibility is the team-SaaS default, and gating a read on role means a role term in a read policy, the shape that produced OPEN-5. Scoped by `memberships_tenant`, not by a `WHERE tenant_id` clause — app-layer filtering is not what isolates it.
- **invite** (`POST`, admin) — `invite_member` (definer). Existing live identity ⇒ a new membership attaches to it; unknown email ⇒ identity and membership created together, the identity carrying a **sentinel** hash it cannot authenticate with. Already a live member ⇒ **409**, keyed on SQLSTATE `23505`.
- **change-role** (`PATCH`, admin) — `change_member_role` (definer).
- **revoke** (`DELETE`, admin) — `revoke_member` (definer), a soft delete.

Writes carry **two independent checks**: the `@RequiresRole('admin')` gate below, which produces the clean `403` and is where role policy for the API is expressed, and the definer function body, which re-checks the caller is a live admin of the active tenant. The body check is the one that cannot be bypassed — the functions are `EXECUTE`-able by `meterlog_app`, so anything holding that connection can call them directly. Neither may be relaxed on the strength of the other; `test/db/membership-writes.spec.ts` proves the inner one with nothing in front of it.

### 4.4 Assets

### 4.5 Readings

### 4.6 Maintenance

### 4.7 Audit

### 4.8 Common (guards, interceptors, filters, DTOs)

## 5. Frontend structure

Not yet built — the frontend slice (brief §11 step 8).

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

Role comes from `RequestContext.role` — the active membership's role, re-read from the database every request (§7.2). The session's copy is never used for an authorization decision, so a role change takes effect on the next request rather than at next login.

`@RequiresRole('admin')` marks a route; the **tenant-context interceptor enforces it**, at step (5), immediately after the role is resolved.

**It is not a `CanActivate` guard, and that is load-bearing.** Nest runs guards _before_ interceptors, so a role guard executes before the transaction is open, the GUCs are set, or the membership is read — it asks for a role that does not exist yet. Measured at the Phase 2 gate: such a guard 500s **every** request, the admin's included, not merely the non-admin's. This is the Phase 4 session-guard defect one layer up. A null role (no active workspace) never reaches the gate on a tenant-scoped route — it is refused first, below — and the gate's `!role` arm stays so a null role can never read as permission.

`@RequiresRole()` **implies** `@RequiresSession()`, so forgetting one of the two cannot leave a gated route anonymously reachable.

**Before any role is consulted, the interceptor is DEFAULT-DENY (G2, OPEN-18).** Every route not listed in §9.4 is tenant-scoped: a session with no active workspace gets `403 NO_ACTIVE_WORKSPACE` and an anonymous caller `401 UNAUTHENTICATED`, before the transaction, the pipes, the role gate and the handler. So every ✓ in the tables below means "with an active workspace". `NO_ACTIVE_WORKSPACE` is deliberately distinct from `FORBIDDEN_ROLE` — "choose a workspace" and "you may not" call for different client responses.

**These tables are asserted against the live routes, in both directions**, by `test/api/route-inventory.spec.ts`: it reads every registered route and its `@RequiresRole` / `@RequiresSession` metadata and requires the set of rows here — role tables plus §9.4 — to match exactly, cell by cell. A route added without a row, a row left behind by a removed route, or a decorator that drifts from its row is red.

| Endpoint                | admin | technician | auditor |
| ----------------------- | ----- | ---------- | ------- |
| `GET /users`            | ✓     | ✓          | ✓       |
| `POST /users`           | ✓     | 403        | 403     |
| `PATCH /users/:id`      | ✓     | 403        | 403     |
| `DELETE /users/:id`     | ✓     | 403        | 403     |
| `GET /users/pending`    | ✓     | 403        | 403     |

`GET /users/pending` was added at G2, transcribed from ADR-016's decision to give pending invites their own admin-only route because the response carries live credentials ([`?pending=true` (DECISIONS.md:816)](DECISIONS.md#L816)). Its shape changes with the pending split, OPEN-14.

### 9.1 Domain endpoints (recorded at step 6 Phase 1; enforced at Phase 3)

`PROJECT_BRIEF.md` gives the role intent in prose — §1 casts technicians as the people who "record readings/maintenance", and §7 requires that "an auditor is read-only" — but it contains no per-endpoint matrix for the domain tables. This is that matrix, decided and recorded **now**, at the step where the tables land, so Phase 3 implements a written decision rather than re-deriving one from prose.

**Enforcement status.** The reads landed **un-gated** at phase 3a. `POST /assets`, `PATCH /assets/:id` and `POST /assets/:id/readings` are **enforced as of phase 3b**, via `@RequiresRole('admin', 'technician')` resolved inside the interceptor at step (5) exactly as §9 above requires — never a `CanActivate` guard. `DELETE /assets/:id` and `POST /assets/:id/events` arrive with the transition engine in phase 3c; the maintenance rows landed at phase 4 and were added to this table at G2.

A caller with **no active workspace** is refused before any row here is consulted: `403 NO_ACTIVE_WORKSPACE` on every route in this table, the un-gated reads included (§9 above). Until G2 only the gated rows refused, through a null role at the gate; the un-gated reads answered `200` with an empty page or `404`.

| Endpoint                                  | admin | technician | auditor |
| ----------------------------------------- | ----- | ---------- | ------- |
| `GET /assets`                             | ✓     | ✓          | ✓       |
| `GET /assets/:id`                         | ✓     | ✓          | ✓       |
| `POST /assets`                            | ✓     | ✓          | 403     |
| `PATCH /assets/:id`                       | ✓     | ✓          | 403     |
| `DELETE /assets/:id` (soft)               | ✓     | 403        | 403     |
| `GET /assets/:id/events`                  | ✓     | ✓          | ✓       |
| `POST /assets/:id/events`                 | ✓     | ✓          | 403     |
| `GET /assets/:id/readings`                | ✓     | ✓          | ✓       |
| `POST /assets/:id/readings`               | ✓     | ✓          | 403     |
| `GET /maintenance-records`                | ✓     | ✓          | ✓       |
| `GET /maintenance-records/:id`            | ✓     | ✓          | ✓       |
| `POST /maintenance-records`               | ✓     | ✓          | 403     |
| `PATCH /maintenance-records/:id`          | ✓     | ✓          | 403     |
| `DELETE /maintenance-records/:id` (soft)  | ✓     | ✓          | 403     |

The five `/maintenance-records` rows were added at G2, transcribed from the phase-4 decision — reads un-gated, writes admin + technician, and `DELETE` deliberately **not** admin-only because retracting a record of work is recoverable where decommissioning an asset is not ([`/maintenance-records` (PROGRESS.md:129)](PROGRESS.md#L129)).

**The one cell that was genuinely open, and how it was resolved.** `POST /assets` could defensibly have been admin-only. It is **admin _and_ technician**: registering an asset is field work — the technician installing a meter is the person who knows its serial number, type and location, and routing that through an admin invents a bottleneck the product has no reason to have. The destructive act is **decommissioning**, and that is where the admin-only line is drawn: `DELETE /assets/:id` is admin-only.

**Auditor is read-only across every row of the table**, with no exceptions — the §7 requirement, applied without special cases.

**Reads are open to all three roles and are deliberately not role-gated**, consistent with ADR-006 §3's treatment of the member list: gating a read on role means a role term in a read policy, which is the shape this project has repeatedly been burned by. Tenant isolation on reads is RLS's job and RLS's alone.

**None of this is enforced in a policy.** Every domain policy is the canonical single-column tenant expression with no role term anywhere — role logic stays out of RLS (DECISION B), and these distinctions live entirely at the endpoint. The database's contribution is that a technician and an admin acting in tenant A can both only ever touch tenant A's rows.

### 9.2 Asset lifecycle events (recorded step 6 phase 1; emitted at Phase 3)

`asset_events` exists as of Phase 1 and **nothing writes to it yet**. This section records the emission contract now, in the same "recorded now, enforced later" shape as §9.1, so Phase 3 wires a written decision instead of re-deriving one.

The enum is `created`, `installed`, `activated`, `maintenance_started`, `maintenance_completed`, `decommissioned`. `created` records **row genesis**; the other five record **status transitions**.

**Registering an asset emits TWO events: `created` and `installed`.**

The invariant that forces it: **every status an asset has ever held must have an event that put it there.** Emit only `created`, and an asset that goes `installed` → `active` → `decommissioned` has no event marking when it became `installed` — its first status is simply unexplained. Replaying the log to reconstruct "what status did this asset hold at time T" then breaks, and that reconstruction is the entire reason to keep an append-only lifecycle log rather than just reading `assets.status`. A log you cannot replay is a log with no purpose.

**`created` deliberately has no counterpart in the status enum.** Assets start at `installed` (the column default), so there is no `created` status for it to mirror. The asymmetry is intentional, not an oversight.

**The enum encodes TRANSITIONS, not STATES — and anyone wiring emission must know this before writing a lookup table.** `activated` and `maintenance_completed` both land on status `active`. So `event_type` is **not a function of the resulting status alone**: a naïve `statusToEventType[newStatus]` map is wrong by construction and will silently record "activated" for a maintenance completion. The event type depends on the transition — where the asset came from — not merely where it arrived.

**Why `created` is kept rather than collapsing to five values.** Letting `installed` serve as genesis is the more elegant option and it was traded away deliberately. Keeping `created` makes **genesis uniform**: a future bulk import of already-active assets emits `created` + `activated` with no special case, whereas the five-value design would need one — either a fake `installed` event that never happened, or a branch. Import uniformity and a complete, replayable log are worth one extra enum value.

**Against step 7 — this is not redundant with `audit_log`.** They answer different questions. `audit_log` records **the mutation**: who changed what, when, with before/after. `asset_events` records **the domain lifecycle**: what happened to this physical asset. An asset can gain a lifecycle event with no user-facing mutation (a bulk import), and a mutation can touch an asset without being a lifecycle event (correcting a typo in `location`). Neither table's rows are derivable from the other's.

### 9.3 Audit trail

| Endpoint     | admin | technician | auditor |
| ------------ | ----- | ---------- | ------- |
| `GET /audit` | ✓     | 403        | ✓       |

Added at G2, transcribed from ADR-012's RBAC decision that the trail is readable by admin **and** auditor ([`admin AND auditor` (DECISIONS.md:556)](DECISIONS.md#L556)), made an enforcement by ADR-014 ([`@RequiresRole('admin', 'auditor')` (DECISIONS.md:635)](DECISIONS.md#L635)).

### 9.4 Routes exempt from the active-workspace requirement (G2, OPEN-18)

The interceptor is default-deny, so this is the list that is written down and everything else is inferred: a route absent from this table is tenant-scoped. It mirrors [`WORKSPACE_EXEMPT_ROUTES` (tenant-context.interceptor.ts:37-45)](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L37-L45), and `test/api/route-inventory.spec.ts` asserts the two equal, so an exemption cannot be added to or dropped from the code without this table moving too. The second column is asserted against each route's `@RequiresSession` metadata.

| Exempt route              | Session required |
| ------------------------- | ---------------- |
| `POST /auth/register`     | no               |
| `POST /auth/login`        | no               |
| `POST /auth/set-password` | no               |
| `POST /auth/switch`       | yes              |
| `GET /auth/me`            | yes              |
| `POST /auth/logout`       | no               |
| `GET /health`             | no               |

None of these reads tenant data, and three of them are how a caller without a workspace gets one: `GET /auth/me` lists workspaces, `POST /auth/switch` selects one, `POST /auth/logout` leaves.

## 10. Audit logging

Lives in DECISIONS: [ADR-009](DECISIONS.md#L409) capture · [ADR-010](DECISIONS.md#L457) integrity · [ADR-011](DECISIONS.md#L483) payload and redaction · [ADR-012](DECISIONS.md#L528) scope, RBAC and volume · [ADR-013](DECISIONS.md#L599) bootstrap rows · [ADR-014](DECISIONS.md#L625) read surface · [ADR-015](DECISIONS.md#L702) column naming.

## 11. API conventions

Lives elsewhere: the error envelope in [`HttpExceptionFilter`](../apps/api/src/common/http/http-exception.filter.ts#L14), recorded at step 4 phase 4 ([`HttpExceptionFilter` (PROGRESS.md:670)](PROGRESS.md#L670)); the 400 / 422 / 409 split at [`ASSET_TRANSITION_ILLEGAL` (PROGRESS.md:232)](PROGRESS.md#L232); the SQLSTATE → HTTP mapping in §16.2 below; pagination in [ADR-014](DECISIONS.md#L625).

## 12. Error handling & logging

Errors: the envelope filter, [`HttpExceptionFilter`](../apps/api/src/common/http/http-exception.filter.ts#L14) — see §11. Logging: not yet built — PROJECT_BRIEF §11 step 10; [`nestjs-pino` (package.json:31)](../apps/api/package.json#L31) is installed and has no use in `apps/api/src`.

## 13. Configuration & secrets

Lives elsewhere: the two roles and two connection strings in [ADR-004](DECISIONS.md#L129) and [`.env.example`](../.env.example#L1); CI values in the `ci.yml` env comments ([`SESSION_SECRET` (ci.yml:70-74)](../.github/workflows/ci.yml#L70-L74), [`Give the app role a password` (ci.yml:110-113)](../.github/workflows/ci.yml#L110-L113)); production secrets in the §16.1 checklist below.

## 14. Local development

Lives elsewhere: the workspace layout in [ADR-005](DECISIONS.md#L278); the bootstrap sequence in [`docker compose up -d` (CLAUDE.md:24)](../CLAUDE.md#L24) (Commands); local Postgres and Redis in [docker-compose.yml:1-3](../docker-compose.yml#L1-L3); the local-only role bootstrap in [01-bootstrap-roles.sh:2-11](../docker/postgres/01-bootstrap-roles.sh#L2-L11).

## 15. CI/CD

CI: the rationale lives in the `ci.yml` comments — [`DO NOT RENAME THIS JOB` (ci.yml:19)](../.github/workflows/ci.yml#L19), [`Check doc citations` (ci.yml:87)](../.github/workflows/ci.yml#L87), [`Give the app role a password` (ci.yml:110-113)](../.github/workflows/ci.yml#L110-L113). CD: not yet built — PROJECT_BRIEF §11 step 10.

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

Not yet built — PROJECT_BRIEF §11 step 10 (Sentry and uptime monitoring; structured logging is §12).

## 18. Known limitations
