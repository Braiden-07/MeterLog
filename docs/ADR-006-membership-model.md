## ADR-006 — Membership-based multi-tenancy (users decoupled from tenants; per-user tenant switching)

- **Date:** 2026-09-04
- **Status:** Accepted — with four sub-decisions marked **OPEN** below that must be answered before the code they govern is written. None blocks scaffold-level work.
- **Supersedes / amends:**
  - The login-identity open question in **ADR-004** (whether email carries a tenant discriminator) — resolved here: email is **globally unique** and carries no tenant discriminator, because tenant is no longer a property of a user.
  - **PROJECT_BRIEF §5** `users` schema — `users.email` becomes globally unique (not per-tenant) and `users.tenant_id` / `users.role` move to a new `memberships` table. §5 explicitly invites schema refinement ("illustrative — refine during design phase, log schema decisions"); this is that refinement, logged.
  - **ADR-004** is extended, not replaced: its two-role-plus-definer structure, `FORCE ROW LEVEL SECURITY`, per-request `SET LOCAL` context, catalog tests, and definer pattern all stand. This ADR adds a **second RLS axis** and grows the definer surface by one function and one table.

### 1. Context and decision

The brief models one shape: a tenant owns assets, and every user belongs to exactly one tenant. That makes the tenant-isolation story — the centerpiece of this project (§1, §8, §12) — slightly too easy: a user's tenant is fixed at login and never varies, so "tenant A can't see tenant B" is only ever tested across _different users_.

The metering domain routinely involves **service providers**: a meter-reading or facilities-management firm whose staff operate across several client organizations. One human legitimately holds access to multiple tenants and switches between them, while those tenants must remain completely isolated from each other. Modelling this turns the isolation claim from "A can't see B" into the strictly stronger "**a user who is a member of both A and B, acting in A, cannot see B's rows — and cannot even assert B as active unless they are a verified member.**"

**Decision:** Split the identity of a _person_ from their _role within a tenant_. A `users` row is pure identity (email + credentials). A new `memberships` row grants one user a role in one tenant. A user may hold many memberships. The application maintains an **active tenant** per session, chosen after login and switchable, and every tenant-scoped request runs under the RLS context of that active membership.

This introduces a **two-axis RLS model** — one axis keyed on the acting user (`app.current_user`), one on the active tenant (`app.current_tenant`) — which is the substantive upgrade this ADR exists to justify.

### 2. Data model

**`users`** — pure identity. Loses `tenant_id` and `role`.

| Column                                   | Notes                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id uuid pk`                             |                                                                                                                         |
| `email citext`                           | **Globally unique** among non-deleted rows. Use `citext` (or lower-cased) so uniqueness and login are case-insensitive. |
| `password_hash text`                     | argon2 (ADR-001).                                                                                                       |
| `created_at`, `updated_at`, `deleted_at` | Soft delete per §5 design rules.                                                                                        |

**`memberships`** — the new join carrying the tenant relationship and the role.

| Column                                          | Notes                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `id uuid pk`                                    |                                                                                          |
| `user_id uuid fk → users`                       |                                                                                          |
| `tenant_id uuid fk → tenants`                   |                                                                                          |
| `role text` (enum `admin\|technician\|auditor`) | Role is now **per-tenant**: a user can be admin in one tenant and technician in another. |
| `created_at`, `updated_at`, `deleted_at`        |                                                                                          |

**Constraints and indexes**

- **Unique `(user_id, tenant_id)` where `deleted_at IS NULL`** — at most one _live_ membership per user per tenant. Partial (excludes soft-deleted) so a removed user can be re-invited to the same tenant later without a constraint collision. Apply the same partial-unique pattern to `users.email`.
- Index `memberships(user_id)` — the self-read axis (login, switcher) hits this.
- Index `memberships(tenant_id)` — the tenant-admin axis (user management) hits this.
- FK `ON DELETE RESTRICT` both ways (consistent with §5; memberships are never cascade-deleted — revocation is a soft delete).

**Attribution FKs unchanged in shape.** `created_by`, `actor_user_id`, etc. continue to reference **`users.id`** (the person). The tenant is already on each row via `tenant_id`, so person-level attribution plus the row's tenant is sufficient. If the _role at the time of action_ is worth auditing, capture it in the `audit_log.after`/payload rather than adding a membership FK to every table — **OPEN-4**.

### 3. RLS model — two axes

Two request-scoped GUCs, both set by the interceptor inside the per-request transaction (extending ADR-004's single-GUC design):

- **`app.current_user`** — the authenticated person's `users.id`. Set on **every** authenticated request.
- **`app.current_tenant`** — the active membership's `tenant_id`. Set on every request that has resolved an active tenant.

**Tenant-scoped tables** (`assets`, `readings`, `maintenance_records`, `asset_events`, `audit_log`, and `tenants` itself) — unchanged from ADR-004: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy keyed on `app.current_tenant`. The new user axis does not touch them.

**`memberships` carries two permissive policies** (permissive policies OR together — this is deliberate and load-bearing):

1. **Self axis** — `USING (user_id = current_setting('app.current_user', true)::uuid)`. Lets a user read _their own_ memberships across all tenants. This is what builds the workspace list at login and powers the switcher. At login `app.current_tenant` is still unset, so only this policy matches — the user sees exactly their own memberships and nothing else.
2. **Tenant-admin axis** — `USING (tenant_id = current_setting('app.current_tenant', true)::uuid)`. Lets an admin acting in a tenant read _all_ memberships in that tenant, for user management.

`memberships` gets `ENABLE` + `FORCE ROW LEVEL SECURITY` like every other table. Write policies (`WITH CHECK`) are scoped to `tenant_id = app.current_tenant` so a membership can only ever be created/modified inside the active tenant; the _admin-role_ requirement on those writes is enforced by the Nest RBAC guard, not the policy (keeping policy logic simple and role logic in one place).

**The isolation property this yields, stated precisely:** a user can see (a) their own memberships everywhere, and (b) all memberships in a tenant they are _currently active in_ — and they can only become active in a tenant they hold a verified membership for (§4). They can therefore never enumerate the membership structure of a tenant they don't belong to. That is the guarantee the tests in §8 must prove.

> **Sharp edge for the test harness — read §8.2 before writing the isolation suite.** The generic catalog-driven matrix assumes "under tenant A's context, a row belonging to tenant B is invisible." For `memberships` that is _false by design_ when the B-row is the acting user's own membership: the self axis (policy 1) correctly reveals it. `memberships` must therefore be **exempted from the generic tenant-only matrix and given a bespoke dual-axis test**, or the harness will produce a false failure and someone will "fix" it by weakening a policy. This is the single most likely place for this ADR to go wrong in implementation.

### 4. Request lifecycle and the membership-verification check

The load-bearing security check of the whole model: **the active tenant a request claims must correspond to a live membership the acting user holds.** Enforced in two layers.

**Belt — session is authoritative (ADR-001, session-in-Redis).** The session holds `user_id`, and once resolved, `active_tenant_id` and the `role` for that active membership. The session's active tenant can _only_ be written by login-auto-select or the switch endpoint, both of which verify the membership first. Because the session lives server-side in Redis, the client cannot forge an active tenant — this is a concrete payoff of choosing sessions over JWT in ADR-001.

**Braces — per-request re-verification (handles mid-session revocation).** The interceptor, inside the transaction, after `SET LOCAL app.current_user` and `SET LOCAL app.current_tenant`, runs one cheap indexed read of the acting user's membership in the active tenant _under RLS_:

```
SELECT role FROM memberships
WHERE user_id = current_setting('app.current_user')::uuid
  AND tenant_id = current_setting('app.current_tenant')::uuid
  AND deleted_at IS NULL;
```

Zero rows → the membership was revoked since the session was minted → reject with 403 and clear the session's active tenant. This makes revocation effective on the _next request_, not at next login. Cost: one indexed single-row query per authenticated request — acceptable, and it uses the `memberships(user_id)` / `(tenant_id)` indexes. The freshly-read `role` also becomes the authoritative role for RBAC this request, so a role _change_ also takes effect next request without re-login.

### 5. Auth flows

**`POST /auth/register`** — creates an organization. Writes **three rows atomically**: `tenants`, `users`, `memberships` (role `admin`). All-or-nothing; a partial failure must leave no tenant, no user, no membership. This widens ADR-004's step-4 atomicity gate from two rows to three.

- **OPEN-1:** if the email already exists as a `users` row, does registration (a) reject with 409 (register is for brand-new people only; an existing user creates additional tenants via an authenticated path), or (b) attach a new tenant + admin membership to the existing user? Recommendation for v1: **reject with 409**, and provide creating-an-additional-tenant as a thin authenticated endpoint (`POST /tenants`) only if it earns its place. Rejecting keeps registration single-purpose and avoids a password-reconciliation question (the existing user already has a password). Decide before writing the register function.

**`POST /auth/login`** — authenticate the person, then resolve workspaces.

1. `login_lookup(email)` (SECURITY DEFINER, §6) → `id, password_hash, deleted_at` or nothing.
2. Verify argon2 hash in the app. Generic failure on no-user-or-bad-password (no user enumeration).
3. `SET LOCAL app.current_user = id`; read live memberships under RLS policy 1.
4. Branch on membership count:
   - **0** → 403 "no active workspaces" (all memberships revoked; the account exists but grants nothing). **OPEN-2:** confirm this is the desired behavior vs. a dedicated empty-state screen.
   - **1** → auto-select as active; write `active_tenant_id` + `role` into the session; issue the session cookie. Login is complete in one step — identical UX to the brief's single-tenant flow for the common case.
   - **many** → issue the session cookie with `user_id` but **no** active tenant; return the workspace list; the client must call switch before any tenant-scoped request will succeed.

**`POST /auth/switch`** (name **OPEN-3** — `/auth/tenant`, `/auth/workspace`, etc.) — body carries a `tenant_id`. Verify the user holds a live membership in it (read under RLS, self axis); if valid, write `active_tenant_id` + `role` to the session; if not, 403. Returns the new active-workspace summary.

**`GET /auth/me`** — returns the person (`id`, `email`), the active workspace (`tenant_id`, tenant name, `role`) if one is selected, and the **full list of the user's workspaces** (id, name, role) so the switcher can render without a second call.

**`POST /auth/logout`** — unchanged (destroy session).

### 6. SECURITY DEFINER surface (net simpler than ADR-004 assumed)

Because the tenant/role read now happens _under RLS_ via `app.current_user`, the definer surface does **not** grow to cover it. It stays at two functions:

- **`login_lookup(p_email citext)`** → returns `id, password_hash, deleted_at` for at most one row, exact-match on email only. Keyed on email alone (no tenant argument — that was the old model). Does **not** return tenant or role; those come from the post-auth memberships read.
- **`register_tenant(...)`** → performs the three-row atomic insert (tenant + user + membership) in one function, because registration runs before any context exists.

Both keep every ADR-004 hardening: owned by `meterlog_definer`, `SET search_path = pg_catalog, pg_temp`, fully schema-qualified bodies (`public.users`, `public.memberships`, `public.tenants`), `EXECUTE` granted only to `meterlog_app`, exact-match lookups only.

**Grants grow by one table:** `meterlog_definer` now also holds `SELECT, INSERT` on `public.memberships` (for `register_tenant`), and nothing else on it. **Definer-scoped policies now exist on three tables** — `users`, `tenants`, `memberships` — so the CI allowlist for definer policies (ADR-004 catalog test assertion 5) updates from two tables to three. The definer-function allowlist (assertion 4) is exactly `{login_lookup, register_tenant}`.

### 7. RBAC changes (step 5)

- **Role is read from the active membership** (the per-request re-verified `role` from §4), never from `users`.
- The **Users module becomes a Memberships module** in substance: `GET /users` lists memberships in the active tenant (joined to user identity for email/name); `POST /users` (invite) creates a membership in the active tenant; `PATCH /users/:id` changes a membership's role; `DELETE /users/:id` soft-deletes the membership (revokes access to _this_ tenant only, leaving the person and their other memberships intact).
- **Invite semantics with global identity:** inviting `email` to the active tenant — if a `users` row already exists for that email, **attach a new membership to the existing user** (this is the multi-org enabler in action); if not, create the `users` row and the membership together. **OPEN — folded into OPEN-1's decision**, since "attach to existing user on invite" and "reject existing email on register" are the same identity question seen from two endpoints; they should be decided together and consistently.
- **Invite credential mechanism** is under-specified in the brief regardless of this ADR (how a newly-invited user sets a password): invite-token email vs. admin-set temporary password. Note it for step 5; not a step-4 blocker.
- RLS on `memberships` structurally prevents an admin of tenant A from reading or modifying memberships in tenant B, so the 403-path tests (§8) gain a DB-enforced backstop, not just a guard check.

### 8. Test changes

**8.1 Catalog coverage suite (ADR-004, lands at scaffold) — update the allowlists:**

- Definer-function allowlist = `{login_lookup, register_tenant}`.
- Definer-policy allowlist tables = `{users, tenants, memberships}` (was two).
- Definer grant assertion includes `SELECT, INSERT` on `memberships`.
- `memberships` must appear with RLS enabled + forced like every other table (the column-agnostic assertion 1 already covers it; it has a `tenant_id` column so assertion 2 covers it too).

**8.2 Catalog-driven isolation harness (ADR-004) — `memberships` is a special case.** Per the sharp edge in §3: exempt `memberships` from the generic tenant-only matrix and write a **bespoke dual-axis test**:

- **Tenant axis:** user M (member of A only) acting in A cannot see a membership belonging to user N in tenant B. (Standard isolation.)
- **Self axis:** user M who is a member of both A and B, acting in A, _can_ see their own B-membership via policy 1 — assert this is present and correct, not treated as a leak.
- **Negative self axis:** user M acting in A cannot see user N's membership in B even though M is unrelated to it — confirms policy 1 is scoped to `user_id = self`, not "any membership."
- Register `memberships` in the harness's exempt-with-bespoke-handler set explicitly, so its absence from the generic matrix is a declared decision the catalog-equality check accounts for, not a silent gap.

**8.3 New money-test variants (step-4 acceptance):**

- **Cross-tenant with shared user (the headline test):** seed user M into both A and B. Authenticate as M, active in A. Assert M sees A's assets/readings and _not_ B's, across the full SELECT/UPDATE/DELETE/INSERT matrix — proving the isolation holds even though the _same person_ has legitimate access to B.
- **Unauthorized active-tenant:** authenticate as a user with membership only in A; attempt `POST /auth/switch` to B; assert 403 and that no B-scoped data becomes reachable.
- **Revocation takes effect:** with an active session in tenant A, soft-delete M's A-membership; assert the next request 403s and the workspace drops from `/auth/me`.
- **Role-per-tenant:** M is admin in A, technician in B. Assert admin-only endpoints succeed when active in A and 403 when active in B — role follows the active membership, not the person.

**8.4 Frontend cache-isolation test (step 8):** see §9 — a Playwright/Vitest check that switching from A to B shows no A-cached data in B's views.

### 9. Frontend changes (step 8)

- **Post-login workspace picker** when the user has >1 membership; skipped (auto-selected) for exactly 1, so the single-tenant user's experience matches the brief.
- **Persistent active-workspace indicator + switcher** in the app nav, driven by `/auth/me`'s workspace list.
- **TanStack Query cache MUST be keyed by active `tenant_id`** (include it in every query key, or reset the cache on switch). RLS protects the _database_; the browser cache does not know tenants exist, so switching A→B without namespacing the cache will flash A's rows into B's views — a client-side isolation bug that lives entirely above the DB and would undercut the isolation story if a reviewer hit it. This is not optional polish; it is part of the isolation guarantee at the client boundary.
- Switching active tenant triggers session update, cache reset/refetch, and a re-render against the new context.

### 10. Updated step-4 acceptance gates (replacing ADR-004's list)

1. **Registration atomic across three rows** (tenant + user + membership) — forced-failure test asserts none survive a partial failure.
2. **`register → login → me` single-membership** round-trips green: cookie issued, `/auth/me` shows the one workspace auto-selected with the right role.
3. **Multi-membership flow:** a user with two memberships logs in → no active tenant → picker list returned → `switch` → `/auth/me` reflects the chosen tenant + its role.
4. **The shared-user money test (8.3)** is green.
5. **Unauthorized-switch 403 (8.3)** is green.
6. **Revocation-takes-effect (8.3)** is green.
7. **`memberships` dual-axis isolation test (8.2)** is green and the table is correctly registered as a bespoke case in the harness.
8. **`EXPECTED_DEFINER_FUNCTIONS`** updated to `{login_lookup, register_tenant}`; definer-policy allowlist updated to three tables.

### 11. Open decisions (must be answered before the governed code is written)

- **OPEN-1 (governs `register_tenant` + invite):** existing-email on register → reject 409 (recommended) or attach-to-existing-user; and correspondingly, invite-to-tenant attaches to an existing `users` row. Decide register + invite together for consistency.
- **OPEN-2 (governs login):** zero-live-memberships on login → 403 "no workspaces" (recommended) or a dedicated empty state.
- **OPEN-3 (cosmetic, governs the switch route):** endpoint name for tenant switching.
- **OPEN-4 (governs audit, deferrable to step 7):** whether to record role-at-time-of-action in the audit payload, or leave attribution at person + row-tenant.

### 12. Consequences

- The isolation story becomes the project's genuine showpiece: a two-axis RLS model proving that even a user with legitimate multi-tenant access cannot cross tenants, backed by DB-enforced membership scoping rather than app checks. This is a materially stronger portfolio claim than single-tenant isolation.
- Cost is concentrated in steps 4, 5, and 8: the membership schema, the two-GUC interceptor with per-request re-verification, the memberships-module semantics, and the workspace switcher with cache keying. It is a real scope increase over the brief's model and must be justified against §2's "do not over-build" — justified here because it deepens the one thing the project exists to demonstrate rather than adding an orthogonal feature.
- The definer surface is _simpler_ than the pre-membership design assumed (tenant/role read moved under RLS), not more complex — the added definer cost is one table's grants for registration only.
- `memberships`' dual policy is the highest-risk implementation detail (§3, §8.2) and the highest-value review target after the definer functions.
- Multi-org is now a first-class capability, not a future migration: adding a person to a second tenant is an INSERT, exactly the reversibility property that made this worth building correctly the first time.
