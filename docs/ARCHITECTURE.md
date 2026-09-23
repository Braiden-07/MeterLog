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
│   │   │   ├── common/rate-limit/       per-email login failure counter (OPEN-16)
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

`apps/web` — Next.js App Router. Slice 1 of the frontend slice (brief §11 step 8) builds auth, the workspace switcher and the tenant-keyed cache; the admin user-management slice and the domain slices add pages on top of this structure without changing it.

```
apps/web/
├── app/
│   ├── layout.tsx              one SessionProvider for the whole app
│   ├── page.tsx                the bootstrap gate and its four states
│   ├── login/ · register/      auth pages (register 201 does not sign in)
│   └── set-password/           invite redemption, token read from the fragment
├── components/                 client components only — app shell, switcher,
│                               picker, the read-only assets list
└── lib/
    ├── api.ts                  relative-base client, ApiError, X-Expected-Tenant
    ├── workspace-session.ts    the cache keys and the reset invariant
    ├── workspace-session.spec.ts   the eviction negative
    ├── session-context.tsx     QueryClient + retry/reset policy, React glue
    ├── broadcast.ts            cross-tab reset propagation
    └── forms.ts                request-body schemas, local by decision
```

**Transport: a same-origin proxy, in every environment.** The API client's base URL is the relative `/api/v1`, and `next.config.mjs` rewrites `/api/:path*` to the API origin. The browser therefore never addresses the API directly, the session cookie is first-party, and `SameSite=Lax` holds (ADR-001's amendment). The rewrite runs in dev too, deliberately: two localhost ports are same-site, so a direct dev client would work locally and fail only once deployed. No path translation is needed — the API already serves `/api/v1`.

**Two key spaces.** `/auth/me` lives under a tenant-independent key and is the single source of truth for which workspace is active. Every tenant-scoped entry is prefixed `['tenant', tenantId]`, which is what lets one predicate cancel all in-flight tenant work and one assertion state that nothing of the previous tenant survives.

**The switch is an invariant:** cancel in-flight tenant-scoped requests → clear the cache → seed the switch response as the new identity → bump the generation, which remounts the tenant subtree. The same reset runs on switch, login, logout and on either reset code, and `BroadcastChannel` propagates it to other tabs. A response that arrives after a reset compares its captured generation and is discarded rather than written. `apps/web/lib/workspace-session.spec.ts` is the proof, and `ISOLATION.md` §9 records what it does and does not cover.

**Tenant data renders in client components only.** A server-rendered list would be held in the Next router cache, keyed by route rather than tenant — a second cache the reset cannot reach. That constraint is the reason, not a style preference.

**Forms** use React Hook Form with Zod resolvers. The error envelope and role enum come from `@meterlog/shared`; login, register and set-password request bodies are declared locally, because the server is the sole authority and client validation is UX.

**Error policy.** A 403 is never retried — `NO_ACTIVE_WORKSPACE` is durable, so retrying only spends round trips — and both reset codes discard the cache and return the app to the picker.

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

**Login rate limiting (OPEN-16)** is per EMAIL, not per IP, and the axis is a measured choice rather than a preference. Every browser request reaches the API through the Next rewrite, and that rewrite is a **verbatim header relay** — it neither originates `X-Forwarded-For` nor appends the peer to an existing chain — so the only XFF the API ever sees is one the caller typed. A hop-count remedy would therefore bucket on attacker-controlled input. `LoginRateLimitService` counts FAILED attempts under `meterlog:loginfail:email:<sha256(email)>` (hashed, so no credential enters a Redis key), ten per fifteen minutes, and `configureApp` mounts it as Express middleware **after** the JSON parser because the key comes from the parsed body. A successful login is never charged. There is deliberately **no global ceiling**: a counter with no client-identity axis is an anonymous site-wide login-outage lever, so bounding mass spray belongs to step-10 observability instead.

## 9. Authorization (RBAC matrix)

Role comes from `RequestContext.role` — the active membership's role, re-read from the database every request (§7.2). The session's copy is never used for an authorization decision, so a role change takes effect on the next request rather than at next login.

`@RequiresRole('admin')` marks a route; the **tenant-context interceptor enforces it**, at step (5), immediately after the role is resolved.

**It is not a `CanActivate` guard, and that is load-bearing.** Nest runs guards _before_ interceptors, so a role guard executes before the transaction is open, the GUCs are set, or the membership is read — it asks for a role that does not exist yet. Measured at the Phase 2 gate: such a guard 500s **every** request, the admin's included, not merely the non-admin's. This is the Phase 4 session-guard defect one layer up. A null role (no active workspace) never reaches the gate on a tenant-scoped route — it is refused first, below — and the gate's `!role` arm stays so a null role can never read as permission.

`@RequiresRole()` **implies** `@RequiresSession()`, so forgetting one of the two cannot leave a gated route anonymously reachable.

**Before any role is consulted, the interceptor is DEFAULT-DENY (G2, OPEN-18).** Every route not listed in §9.4 is tenant-scoped: a session with no active workspace gets `403 NO_ACTIVE_WORKSPACE` and an anonymous caller `401 UNAUTHENTICATED`, before the transaction, the pipes, the role gate and the handler. So every ✓ in the tables below means "with an active workspace". `NO_ACTIVE_WORKSPACE` is deliberately distinct from `FORBIDDEN_ROLE` — "choose a workspace" and "you may not" call for different client responses.

**These tables are asserted against the live routes, in both directions**, by `test/api/route-inventory.spec.ts`: it reads every registered route and its `@RequiresRole` / `@RequiresSession` metadata and requires the set of rows here — role tables plus §9.4 — to match exactly, cell by cell. A route added without a row, a row left behind by a removed route, or a decorator that drifts from its row is red.

| Endpoint                                     | admin | technician | auditor |
| -------------------------------------------- | ----- | ---------- | ------- |
| `GET /users`                                 | ✓     | ✓          | ✓       |
| `POST /users`                                | ✓     | 403        | 403     |
| `PATCH /users/:id`                           | ✓     | 403        | 403     |
| `DELETE /users/:id`                          | ✓     | 403        | 403     |
| `GET /users/pending`                         | ✓     | 403        | 403     |
| `POST /users/pending/:membershipId/token`    | ✓     | 403        | 403     |

**The pending pair, and why it is two rows rather than one (OPEN-14).** `GET /users/pending` was added at G2 as a single route that both listed pending invites and minted a redemption token for each, transcribed from ADR-016's decision to give pending invites their own admin-only route because the response carried live credentials ([`?pending=true` (DECISIONS.md:835)](DECISIONS.md#L835)). The pending split separates the two jobs, and the role sources differ per row even though the cells agree:

- **`GET /users/pending` — admin ✓ / 403 / 403, and the source of that is now ADR-006 §3 read in the negative rather than ADR-016.** The credential has left the body, so ADR-016's "the response carries live credentials" no longer applies to this route. The gate stays because co-member visibility (ADR-006 §3) is a decision about who is IN the workspace; who has not yet activated their account is administrative state, and nothing in §3 extends the open read to it. Recorded explicitly because "the reason for the gate went away and the gate stayed" is exactly the kind of thing a later reader deletes as vestigial.
- **`POST /users/pending/:membershipId/token` — admin ✓ / 403 / 403, and this row inherits ADR-016's rationale directly.** It is the route whose response body is a live credential, so it is the one the original reasoning was always about. It is also a write, which would gate it at admin under §9's own convention regardless.

Both carry a second, independent check inside their `SECURITY DEFINER` bodies (`SP003` and `MT001` respectively), answering a different error code from the gate's `FORBIDDEN_ROLE` so the two layers stay distinguishable — the step-5 lesson. Neither layer may be relaxed on the strength of the other.

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

The five `/maintenance-records` rows were added at G2, transcribed from the phase-4 decision — reads un-gated, writes admin + technician, and `DELETE` deliberately **not** admin-only because retracting a record of work is recoverable where decommissioning an asset is not ([`/maintenance-records` (PROGRESS.md:192)](PROGRESS.md#L192)).

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

Added at G2, transcribed from ADR-012's RBAC decision that the trail is readable by admin **and** auditor ([`admin AND auditor` (DECISIONS.md:576)](DECISIONS.md#L576)), made an enforcement by ADR-014 ([`@RequiresRole('admin', 'auditor')` (DECISIONS.md:655)](DECISIONS.md#L655)).

### 9.4 Routes exempt from the active-workspace requirement (G2, OPEN-18)

The interceptor is default-deny, so this is the list that is written down and everything else is inferred: a route absent from this table is tenant-scoped. It mirrors [`WORKSPACE_EXEMPT_ROUTES` (tenant-context.interceptor.ts:55-63)](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L55-L63), and `test/api/route-inventory.spec.ts` asserts the two equal, so an exemption cannot be added to or dropped from the code without this table moving too. The second column is asserted against each route's `@RequiresSession` metadata.

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

Lives in DECISIONS: [ADR-009](DECISIONS.md#L429) capture · [ADR-010](DECISIONS.md#L477) integrity · [ADR-011](DECISIONS.md#L503) payload and redaction · [ADR-012](DECISIONS.md#L548) scope, RBAC and volume · [ADR-013](DECISIONS.md#L619) bootstrap rows · [ADR-014](DECISIONS.md#L645) read surface · [ADR-015](DECISIONS.md#L722) column naming.

## 11. API conventions

Lives elsewhere: the error envelope in [`HttpExceptionFilter`](../apps/api/src/common/http/http-exception.filter.ts#L14), recorded at step 4 phase 4 ([`HttpExceptionFilter` (PROGRESS.md:732)](PROGRESS.md#L732)); the 400 / 422 / 409 split at [`ASSET_TRANSITION_ILLEGAL` (PROGRESS.md:295)](PROGRESS.md#L295); the SQLSTATE → HTTP mapping in §16.2 below; pagination in [ADR-014](DECISIONS.md#L645).

## 12. Error handling & logging

Errors: the envelope filter, [`HttpExceptionFilter`](../apps/api/src/common/http/http-exception.filter.ts#L14) — see §11. **One exception, by construction:** the login rate limiter runs in Express, upstream of Nest, so the filter never sees its **429** and the middleware writes the `RATE_LIMITED` envelope itself (plus `Retry-After`). `codeFor()` carries a `TOO_MANY_REQUESTS` case regardless, so a 429 raised from inside Nest cannot ship under the default `ERROR` code. Logging: not yet built — PROJECT_BRIEF §11 step 10; [`nestjs-pino` (package.json:31)](../apps/api/package.json#L31) is installed and has no use in `apps/api/src`.

## 13. Configuration & secrets

Lives elsewhere: the two roles and two connection strings in [ADR-004](DECISIONS.md#L149) and [`.env.example`](../.env.example#L1); CI values in the `ci.yml` env comments ([`SESSION_SECRET` (ci.yml:70-74)](../.github/workflows/ci.yml#L70-L74), [`Give the app role a password` (ci.yml:124-127)](../.github/workflows/ci.yml#L124-L127)); production secrets in the §16.1 checklist below.

## 14. Local development

Lives elsewhere: the workspace layout in [ADR-005](DECISIONS.md#L298); the bootstrap sequence in [`docker compose up -d` (CLAUDE.md:24)](../CLAUDE.md#L24) (Commands); local Postgres and Redis in [docker-compose.yml:1-3](../docker-compose.yml#L1-L3); the local-only role bootstrap in [01-bootstrap-roles.sh:2-11](../docker/postgres/01-bootstrap-roles.sh#L2-L11).

## 15. CI/CD

CI: the rationale lives in the `ci.yml` comments — [`DO NOT RENAME THIS JOB` (ci.yml:19)](../.github/workflows/ci.yml#L19), [`Check doc citations` (ci.yml:101)](../.github/workflows/ci.yml#L101), [`Give the app role a password` (ci.yml:124-127)](../.github/workflows/ci.yml#L124-L127).

CD: **decided and not yet built.** Its shape is [ADR-019](DECISIONS.md#L953) — a `deploy` job on push to `main`, gated on `verify` and `e2e`, with migrations as a step ahead of the deploy and a smoke test behind it — and the deploy target is declared in [`render.yaml`](../render.yaml), which sets `autoDeploy: false` precisely so nothing ships before that job exists. The job itself is a later slice of `PROJECT_BRIEF` §11 step 10, deliberately sequenced after an author has watched one deploy by hand (§16.B).

## 16. Deployment topology

**Two platforms, one browser-visible origin.** The Next app runs on Vercel and is the only origin a browser ever addresses; it proxies `/api/*` to the NestJS API on Render, which holds managed Postgres and Redis alongside it (ADR-003). None of that split is visible to the browser, and §16.A below is the list of conditions that keeps it that way.

**Nothing here is provisioned by this repository.** [`render.yaml`](../render.yaml) is a blueprint an author applies; Vercel has no config file because Next needs none, so its settings are recorded in §16.B rather than split across two places. Both are inert until someone acts. **Read §16.1 before the first migration runs against Render** — it is eleven checkboxes rather than a register row, which makes it the easiest thing on this page to skip and the most expensive to have skipped: its standing risk is a privilege-defect class that **green CI cannot see**, because the migration role is a superuser locally and in CI and is not one there.

**What runs where, and what each side needs:**

| Where              | What                             | Configuration that must be right                                                                                                                                |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel             | the Next app; the `/api/*` proxy | Root directory `apps/web`. **`API_ORIGIN`** — see §16.A. No other variable decides whether the deployed app works at all.                                        |
| Render (web)       | the Nest API                     | `NODE_ENV=production` (literal), `SESSION_SECRET`, `DATABASE_URL` (app role), `REDIS_URL`. Health check on `/api/v1/health`. `PORT` is injected by the platform. |
| Render (Postgres)  | the eight core tables, with RLS  | Two roles, two URLs (ADR-004). The provisioned owner is the **migration** role; `meterlog_app` is created by migration and given a password by hand (§16.1).     |
| Render (Key Value) | sessions, login-failure counters | A hard runtime dependency, not a cache (ADR-001). Needs no access from outside Render.                                                                           |
| GitHub Actions     | migrations, deploy, smoke        | `MIGRATION_DATABASE_URL` and the platform deploy credentials live here, not in the application container (ADR-019).                                              |

### 16.A The four conditions the session cookie depends on

The cookie is `httpOnly`, `secure` in production, `SameSite=Lax`, and carries **no `Domain`** ([`cookieOptions` (auth.controller.ts:16-31)](../apps/api/src/auth/auth.controller.ts#L16-L31)). It is first-party on the Vercel origin because the browser only ever talks to that origin — which is a property of **configuration, not of code**, and every way of getting it wrong fails silently, in production, on a path no local run reaches. Both apps run on `localhost` in dev and in CI, where differing ports do not change the site, so the cookie is same-site there no matter what is misconfigured: a green E2E run is not evidence about any of this, and `ISOLATION.md` §9 says so where it records what the build does not prove.

1. **`API_ORIGIN` is set on Vercel at BUILD time, not only at runtime.** `rewrites()` is evaluated when Next loads its config, and `next build` bakes the result into the routing manifest — so a runtime-only value ships the localhost fallback in [`API_ORIGIN` (next.config.mjs:9)](../apps/web/next.config.mjs#L9) instead, and every API call in production reaches for an origin that is not there. It must also be plain rather than `NEXT_PUBLIC_`, carry `https://`, and stop at the origin, because the rewrite appends `/api/:path*` itself. The four rules, each with the failure it prevents, sit on the variable itself in [`.env.example`](../.env.example#L34).
2. **Nothing in the browser addresses Render.** Held by construction today: [`API_BASE`](../apps/web/lib/api.ts#L11) is relative, and the client pins [`credentials: 'same-origin'`](../apps/web/lib/api.ts#L153). That pin is a floor rather than a style choice — if an absolute API origin were ever introduced, the cookie would not be sent **at all** rather than sent cross-site, so the failure is a visible 401 loop instead of a quietly weakened posture.
3. **`NODE_ENV` is literally `production` on Render**, or [`secure`](../apps/api/src/auth/auth.controller.ts#L26) evaluates false and the flag never appears. §16.1's check (c) is how that is confirmed, and it is **unverifiable by CI by construction**, because the tests run over plain HTTP.
4. **Render terminates HTTPS on the origin `API_ORIGIN` names**, so the `Secure` cookie survives the Vercel→Render hop.

**What breaks it, stated so it is recognisable in the wild:** a missing or runtime-only `API_ORIGIN` (every call fails at once); a `NEXT_PUBLIC_` copy, or an absolute base URL in the client (login appears to succeed and every call after it 401s — the silent one); `NODE_ENV` unset or spelled differently (no `Secure` flag); a `Domain=` added to the cookie (it stops being host-only); a trailing `/api/v1` on `API_ORIGIN` (404s everywhere).

**And none of it is proven until it is deployed.** The acceptance gate is the deploy smoke test: a real login through the deployed Vercel origin sets the cookie, a subsequent API call through the same origin sends it, and the same cookie sent **directly** to Render is refused — the third assertion being what stops the first two passing for the wrong reason. That test is owed by a later slice of step 10. Until it has run, everything above is a design rather than a result.

### 16.B The author actions no pull request can perform

Deploy config in this repo declares; it does not act. The order matters: the last three exist because §16.1's standing risk means the first migration against Render wants a human watching it.

- [ ] Create the Render Blueprint from [`render.yaml`](../render.yaml), and **choose the plan tier deliberately** — ADR-003 accepted Render on the condition that free-Postgres expiry and free-tier cold starts are priced rather than discovered.
- [ ] Verify the identifiers Render renames: plan names, `runtime:`, and the Key Value / Redis service type. A wrong one fails validation in the dashboard, which is the safe direction to be wrong in.
- [ ] Set `SESSION_SECRET` and `DATABASE_URL` on the Render service. `DATABASE_URL` must name **`meterlog_app`**, never the provisioned owner: pointing it at the owner disables tenant isolation while every structural test still passes.
- [ ] Open the database's IP allow-list to your own address, run §16.1's checks (a) and (b) plus the one-time `ALTER ROLE meterlog_app WITH LOGIN PASSWORD`, then **close it again**.
- [ ] Create the Vercel project with root directory `apps/web`, and set **`API_ORIGIN`** per §16.A.
- [ ] Add the GitHub Actions secrets the deploy job will need (ADR-019): `MIGRATION_DATABASE_URL`, and the two platform deploy credentials.
- [ ] **Add `e2e` to the `main` ruleset's required status checks.** It is required by nothing today — [`adding the job does NOT make it required` (ci.yml:182-183)](../.github/workflows/ci.yml#L182-L183) says so in the file — so a red e2e blocks no merge, and DoD :270 cannot honestly tick until it does.
- [ ] Work §16.1's eleven boxes against the real database, and enable managed Postgres backups with the restore procedure written down (`PROJECT_BRIEF` §10).
- [ ] **Run the first migration and the first deploy by hand, and watch them.** `20260908000000_auth_definer_functions` is the first migration that would have failed on Render.
- [ ] Run the deploy smoke test against the live deployment by hand, **before** anything automates it. Its first result is the finding, whichever way it goes.
- [ ] Only then enable the automated path (ADR-019), and write down the platform-native rollback steps (`PROJECT_BRIEF` §9).

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
