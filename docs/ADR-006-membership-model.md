## ADR-006 — Membership-based multi-tenancy (users decoupled from tenants; per-user tenant switching)

- **Date:** 2026-09-04
- **Status:** Accepted, and **amended five times** — every amendment is marked inline where it applies. At **Phase 1 of step 4**: (1) the `users` policy set, which this ADR never specified (§3); (2) **Decision B** (§3, §7), under which the `memberships` tenant axis becomes `FOR SELECT` and the app role loses every write privilege on the table, because the original `FOR ALL` shape was demonstrated against a live database to permit intra-tenant self-promotion. At **Phase 1 of step 5**, closing two gaps this section left open rather than answered: (3) the **last-admin lockout** (§7) — self-demotion and self-revocation are permitted only while another live admin remains; (4) the **invite credential mechanism** (§7), which §7 itself flagged under-specified and deferred to step 5 — resolved as a sentinel hash, with its consumed-email consequence accepted and recorded. At **Phase 2 of step 5**: (5) the **anti-enumeration shape of `MB002`** (§7) — cross-tenant and absent targets return one indistinguishable 404, recorded with the refactor that would reopen it. Corrected before all of these in stage-1 review — see **§0 Review corrections**, which is the reason several lines read the way they do.

- **Supersedes / amends:**
  - The login-identity open question in **ADR-004** (whether email carries a tenant discriminator) — resolved here: email is **globally unique** and carries no tenant discriminator, because tenant is no longer a property of a user.
  - **PROJECT_BRIEF §5** `users` schema — `users.email` becomes globally unique (not per-tenant) and `users.tenant_id` / `users.role` move to a new `memberships` table. §5 explicitly invites schema refinement ("illustrative — refine during design phase, log schema decisions"); this is that refinement, logged.
  - **ADR-004** is extended, not replaced: its two-role-plus-definer structure, `FORCE ROW LEVEL SECURITY`, per-request `SET LOCAL` context, catalog tests, and definer pattern all stand. This ADR adds a **second RLS axis** and grows the definer surface by one function and one table.

### 0. Review corrections (stage-1, verified against a live database)

This ADR was pressure-tested before being frozen. Five defects were found and fixed in the text below; each was reproduced against Postgres 16 rather than reasoned about, and the fix re-verified the same way. They are recorded here because the corrected lines look unremarkable, and the next person to edit them needs to know what they are load-bearing against.

1. **Privilege escalation via the self axis (critical).** §3 originally said `memberships` "carries two permissive policies", both given as `USING (...)`. Implemented as `FOR ALL`, Postgres defaults `WITH CHECK` to the `USING` expression, and permissive policies OR on writes as well as reads — so the self axis became a write path. A technician active in tenant A successfully ran `INSERT INTO memberships (user_id, tenant_id, role) VALUES (<self>, <tenant B>, 'admin')`, granting themselves **admin of a tenant they had no relationship with**, then legitimately switching into it. §4's re-verification is no defence: the membership genuinely exists. Fixed by making the self axis **`FOR SELECT`**, which carries no `WITH CHECK` at all. Re-verified: the same INSERT now raises `new row violates row-level security policy`, while the self-read still returns the user's own memberships.
2. **The `NULLIF` lesson had not been applied.** Every `current_setting` in §3 and §4 used the raw form. Reproduced both failure modes on the new `app.current_user` GUC: `invalid input syntax for type uuid: ""` on a reused connection, and — because §4's query omitted the `missing_ok` argument entirely — `unrecognized configuration parameter "app.current_tenant"` on a fresh one. The re-verify did **not** fail closed; it 500'd, non-deterministically. All occurrences now use the canonical `NULLIF(current_setting('app.<guc>', true), '')::uuid`.
3. **Verification happened after the tenant GUC was set.** §4 set `app.current_tenant` and then checked it. Reordered so the tenant GUC is never set to an unverified value at any instant (§4).
4. **`/auth/me` could not return workspace names.** ADR-004's `tenants` policy is `id = current_tenant`, so every workspace but the active one was invisible. Added a second `FOR SELECT` policy (§3).
5. **`deleted_at IS NULL` in a read policy makes soft delete impossible** — see the boxed finding in §3. Raised as **OPEN-5** rather than silently resolved, and since resolved: accept the residual, keeping liveness in-policy only on the paths that exclusively read.

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
- The partial unique on `(user_id, tenant_id)` above already serves the self-read axis and §4 re-verify lookups; **no separate `memberships(user_id)` index** — it would be write cost for nothing.
- Index `memberships(tenant_id)` — the tenant read axis (the member list) hits this.
- FK `ON DELETE RESTRICT` both ways (consistent with §5; memberships are never cascade-deleted — revocation is a soft delete).

**Attribution FKs unchanged in shape.** `created_by`, `actor_user_id`, etc. continue to reference **`users.id`** (the person). The tenant is already on each row via `tenant_id`, so person-level attribution plus the row's tenant is sufficient. If the _role at the time of action_ is worth auditing, capture it in the `audit_log.after`/payload rather than adding a membership FK to every table — **OPEN-4**.

### 3. RLS model — two axes

Two request-scoped GUCs, both set by the interceptor inside the per-request transaction (extending ADR-004's single-GUC design):

- **`app.current_user`** — the authenticated person's `users.id`. Set on **every** authenticated request.
- **`app.current_tenant`** — the active membership's `tenant_id`. Set on every request that has resolved an active tenant.

**Tenant-scoped tables** (`assets`, `readings`, `maintenance_records`, `asset_events`, `audit_log`, and `tenants` itself) — unchanged from ADR-004: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy keyed on `app.current_tenant`. The new user axis does not touch them.

**`memberships` carries two permissive policies** (permissive policies OR together — this is deliberate and load-bearing):

1. **Self axis — `FOR SELECT`, and this is not negotiable.**

   ```sql
   CREATE POLICY memberships_self_read ON public.memberships
     FOR SELECT TO meterlog_app
     USING (user_id = NULLIF(current_setting('app.current_user', true), '')::uuid);
   ```

   Lets a user read _their own_ memberships across all tenants. This builds the workspace list at login and powers the switcher. At login `app.current_tenant` is still unset, so only this policy matches — the user sees exactly their own memberships and nothing else.

   **It must be `FOR SELECT`, never `FOR ALL`.** A `FOR ALL` policy with only a `USING` clause has its `WITH CHECK` defaulted to the same expression, and because permissive policies OR on writes, the self axis would then permit `INSERT`s where `user_id = self` — letting any user grant themselves **admin of any tenant**, and then switch into it legitimately. This was not hypothetical; it was demonstrated against a live database in stage-1 review (§0). `FOR SELECT` carries no `WITH CHECK` at all, which is precisely why it is the right shape for a read axis.

2. **Tenant read axis — `FOR SELECT`. AMENDED AT PHASE 1 (DECISION B); this was `FOR ALL`.**

   ```sql
   CREATE POLICY memberships_tenant ON public.memberships
     FOR SELECT TO meterlog_app
     USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
   ```

   Lets anyone acting in a tenant read _all_ memberships in that tenant. It is a **read** policy: there is no app-role write path to this table at all.

   > **AMENDMENT — Decision B: the database backstops intra-tenant role authorization.**
   >
   > **What this said before, and why it was wrong.** This axis was `FOR ALL ... USING (...) WITH CHECK (...)`, described as "the only write path", with the sentence: "the _admin-role_ requirement on those writes is enforced by the Nest RBAC guard, not the policy (keeping policy logic simple and role logic in one place)." Neither clause of the policy carries a role term, and `tenant_id` does not change during a role edit — so a **non-admin member of the active tenant could rewrite any membership in it**. Demonstrated against a live database at the Phase 1 gate: a technician in tenant A ran `UPDATE public.memberships SET role = 'admin' WHERE user_id = <self>` and got `UPDATE 1`, `role_now = admin`. The same member could also `INSERT` a fresh admin membership for anyone into A. The guard that was supposed to prevent this is a step-5 artifact that does not exist; "latent until the guard lands" is still exploitable, and a frozen spec that says the escalation is handled elsewhere is worse than one that admits it is open.
   >
   > **The decision.** `meterlog_app` becomes **structurally incapable of writing `memberships`**. The tenant axis becomes `FOR SELECT` (which carries no `WITH CHECK` — the §0.1 lesson, applied a second time), no app-role write policy replaces it, and the `GRANT SELECT, INSERT, UPDATE` on the table narrows to `GRANT SELECT`. Invite, revoke and change-role all route through **admin-checking `SECURITY DEFINER` functions in step 5**, extending the already-blessed `register_tenant` pattern.
   >
   > **Why not the alternatives.**
   >
   > - **A — leave it to RBAC.** Rejected: it leaves a real self-promotion escalation gated only by a guard that does not exist yet. Documented-but-latent is still exploitable.
   > - **C — put a role term in the RLS policy.** Rejected: it recombines the three bug classes this project has already been burned by in one expression — a predicate over a column the statement itself mutates, `FORCE ROW LEVEL SECURITY`, and Postgres applying the SELECT policy to the _new_ row of an `UPDATE … WHERE` (the OPEN-5 mechanism). Role logic in a read policy is the exact shape that produced OPEN-5.
   > - **B keeps role logic out of RLS entirely and adds no third GUC.** The OPEN-5 surface-minimization precedent (a third definer function was rejected there) does **not** bind: that was surface growth to fix a _cosmetic_ residual. This is surface growth to close a _real_ escalation.
   >
   > **The mechanism, verified live — and it is not uniform.** With the grants restored inside a rolled-back transaction, so that RLS is the only thing that can refuse:
   >
   > - `INSERT` **raises** `new row violates row-level security policy for table "memberships"`.
   > - `UPDATE` and `DELETE` **do not raise**. With no policy applicable to the command, no row is visible to modify, so Postgres reports `UPDATE 0` / `DELETE 0` and returns cleanly. The row is unchanged and the tenant's rows survive, but **a test asserting a thrown error on the UPDATE path would fail against a correctly behaving database**. The suite asserts zero-rows-and-unchanged for those two commands, on purpose.
   >
   > `register_tenant` is unaffected and this was proven, not assumed: it writes as `meterlog_definer` under the `TO meterlog_definer` policy, which B does not touch. Its three-row insert still succeeds, while the identical insert as `meterlog_app` is denied.
   >
   > **Durability.** B's guarantee is exactly "`meterlog_app` can never write `memberships`", and a single stray `GRANT` reopens it silently. Catalog assertion 9 asserts the app role holds no `INSERT`/`UPDATE`/`DELETE` on any identity table; assertion 10 asserts it can still read them, so 9 cannot be satisfied by a table nobody can touch.

   > **Reads are deliberately NOT role-gated — recorded so this reads as intent, not accident.**
   >
   > Every member of a tenant can see every co-member's identity and role. Until Phase 1 this was an unremarked side effect of the axis being keyed on `tenant_id` alone; it is now a decision. Co-member visibility is the right default for team SaaS — an auditor seeing who else is in the workspace, and in what role, is a feature. It is **not** gated because gating a _read_ on role means a role term in a read policy, which is the C-shaped danger above, and co-member identity and role are not sensitive enough to justify reopening that class of bug. Anything that genuinely is sensitive (`password_hash`) is withheld by column grant instead.

**New: `tenants` gains a second, `FOR SELECT` policy** so `/auth/me` can name the user's workspaces. ADR-004's policy (`id = app.current_tenant`) exposes only the active tenant, which left the switcher able to render ids and roles but not names.

```sql
CREATE POLICY tenants_workspace_list ON public.tenants
  FOR SELECT TO meterlog_app
  USING (id IN (SELECT m.tenant_id FROM public.memberships m
                WHERE m.user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
                  AND m.deleted_at IS NULL));
```

`FOR SELECT` for the same reason as the self axis — a read-shaped policy must not become a write vector. The subquery is itself filtered by `memberships`' own policies (the self axis scopes it to the acting user, which is exactly the intent) and does **not** recurse, because no `memberships` policy references `tenants`. Verified: a user with memberships in A and B, active in A, reads both names and no others.

`memberships` gets `ENABLE` + `FORCE ROW LEVEL SECURITY` like every other table.

**`users` policy set — AMENDMENT, added at Phase 1 of step 4. This ADR did not specify it.**

A gap, surfaced rather than assumed. §3 lists the tenant-scoped tables as `assets`, `readings`, `maintenance_records`, `asset_events`, `audit_log` and `tenants` — `users` appears in none of them, and §6 mentions it only for definer access. But `users` lost its `tenant_id` in the decoupling, so ADR-004's tenant-keyed policy no longer references a column that exists, and nothing here replaced it. Meanwhile §7 requires `GET /users` to list memberships in the active tenant "joined to user identity for email/name", which needs a `users` read path for the app role. Left unaddressed, `users` would have shipped either with a broken policy or with none at all (RLS enabled, zero policies ⇒ all reads denied ⇒ `/auth/me` returns nobody).

Proposed set — **both app-role policies are `FOR SELECT`**, per the §0 item 1 lesson:

```sql
-- A person can always read their own identity row.
CREATE POLICY users_self_read ON public.users
  FOR SELECT TO meterlog_app
  USING (id = NULLIF(current_setting('app.current_user', true), '')::uuid);

-- Acting in a tenant, you can read the identity of that tenant's live members.
CREATE POLICY users_tenant_members_read ON public.users
  FOR SELECT TO meterlog_app
  USING (id IN (SELECT m.user_id FROM public.memberships m
                WHERE m.tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
                  AND m.deleted_at IS NULL));

-- Pre-auth path (login_lookup, register_tenant).
CREATE POLICY users_definer ON public.users
  FOR ALL TO meterlog_definer USING (true) WITH CHECK (true);
```

Notes on the shape:

- **No app-role write policy at all.** Every `users` write in v1.0 goes through `register_tenant` (definer). Invite (step 5) will need one; it must be added deliberately then, not pre-emptively now. Until then writes fail closed.
- **The tenant-members policy scopes by tenant, not by role — every member of the tenant reads it, not only admins.** An auditor sees the same member list as an admin. Verified live at the Phase 1 gate: a technician in tenant A, acting in A, read every co-member's identity and role. This is accepted as an intentional team-SaaS default, recorded in the boxed note under axis 2 above. _(Wording corrected at Phase 1: this bullet previously ended "the admin-only restriction on user management is the RBAC guard's job, consistent with how §3 treats membership writes." Both halves became wrong — it implied the member list was in some sense admin-scoped, and §3 no longer routes membership writes through the RBAC guard at all. Membership **writes** are now definer-only under Decision B; membership and identity **reads** are open to every member of the tenant.)_
- **`password_hash` is withheld from the app role by column-level grant**, not by policy — RLS is row-level and cannot hide a column. `GRANT SELECT (id, email, created_at, updated_at, deleted_at)`, deliberately omitting `password_hash`, so a member reading co-member identities cannot read their hashes even though the rows are visible. `login_lookup` reads the hash as `meterlog_definer`, which holds the full-table grant.
- **No recursion.** `users`' policies subquery `memberships`; `memberships`' policies reference only GUCs and never `users` or `tenants`. The `tenants` workspace-list policy likewise subqueries `memberships` only.
- Both subqueries fail closed on unset context: `NULLIF` yields `NULL`, the subquery returns no rows, the policy is false.

> **Finding: `deleted_at IS NULL` in a read policy makes soft delete impossible — OPEN-5.**
>
> The intent was to enforce revocation at the database in all three membership-reading paths. It cannot be done in the row policies. When an `UPDATE` carries a `WHERE` clause, Postgres applies the **SELECT** policy to the _new_ row as well as the old, so a `deleted_at IS NULL` predicate in any SELECT-applicable policy causes `UPDATE memberships SET deleted_at = now() WHERE ...` to fail with `new row violates row-level security policy` — revocation, the very operation the predicate exists to make effective, becomes impossible. Verified minimally: identical statement, the only difference being that predicate; and the same `UPDATE` _without_ a `WHERE` clause succeeds. Splitting into `FOR SELECT` + `FOR UPDATE` policies does not help, because it is the SELECT policy that bites.
>
> **What is enforced in the database today (verified):** liveness lives in the two paths that only ever read — §4's re-verify query and the `tenants_workspace_list` subquery above. With those, revocation still takes full effect: the re-verify returns zero rows (→ 403) and the revoked workspace disappears from `/auth/me`. **Residual:** a raw self-axis read of `memberships` still returns the revoked row, with `deleted_at` set for the caller to filter on.
>
> **OPEN-5 — RESOLVED: accept the residual for v1.0 (option a).**
>
> **Where liveness is enforced in-policy:** only on the paths that exclusively read — §4's re-verify query and the `tenants_workspace_list` subquery above. It is **deliberately absent** from the `memberships` self-axis and tenant-axis policies.
>
> **Why it cannot go in those policies — do not "fix" this.** Postgres applies a table's SELECT policy to the **new** row of an `UPDATE … WHERE`, so a liveness predicate in any SELECT-applicable policy on `memberships` blocks the revoking `UPDATE` itself: the predicate defeats the very operation it exists to enforce. Splitting into `FOR SELECT` + `FOR UPDATE` policies does not help — the SELECT policy still bites. Verified against a live database in stage-1 review: identical `UPDATE … SET deleted_at = now() WHERE …`, the only difference being that predicate — with it, `new row violates row-level security policy`; without it, `UPDATE 1`; and the same statement with no `WHERE` clause succeeds either way.
>
> **The residual, stated plainly:** a raw self-axis read returns a revoked row with `deleted_at` set. `/auth/me` and any future self-axis reader **must include `WHERE deleted_at IS NULL` app-side**. This is the one documented app-side predicate in the design.
>
> **Why that is acceptable:** the self-axis read is not a security boundary. The security gate is the re-verify, which enforces liveness in-policy — a revoked membership yields zero rows, so the request 403s and the workspace disappears from the switcher. The residual is a user seeing _their own former membership_, not a cross-tenant leak and not an access grant. Nothing about it lets anyone reach data they could not otherwise reach.
>
> **Rejected: a third `SECURITY DEFINER` function** to enforce self-axis liveness. The definer surface is the highest-value review target in the system (ADR-004); growing it from two functions to three to fix a cosmetic residual is a bad trade. The surface stays at `{login_lookup, register_tenant}`.

**The isolation property this yields, stated precisely:** a user can see (a) their own memberships everywhere, and (b) all memberships in a tenant they are _currently active in_ — and they can only become active in a tenant they hold a verified membership for (§4). They can therefore never enumerate the membership structure of a tenant they don't belong to. That is the guarantee the tests in §8 must prove.

> **Sharp edge for the test harness — read §8.2 before writing the isolation suite.** `memberships` must be **exempted from the generic tenant-only matrix and given a bespoke dual-axis test**. The danger is not that the generic matrix fails loudly — it is that it _passes_. See §8.2 for exactly why; do not rely on a green generic matrix as evidence that `memberships` is covered.

### 4. Request lifecycle and the membership-verification check

The load-bearing security check of the whole model: **the active tenant a request claims must correspond to a live membership the acting user holds.** Enforced in two layers.

**Belt — session is authoritative (ADR-001, session-in-Redis).** The session holds `user_id`, and once resolved, `active_tenant_id` and the `role` for that active membership. The session's active tenant can _only_ be written by login-auto-select or the switch endpoint, both of which verify the membership first. Because the session lives server-side in Redis, the client cannot forge an active tenant — this is a concrete payoff of choosing sessions over JWT in ADR-001.

**Braces — per-request re-verification (handles mid-session revocation).** The ordering is **verify, then set** — the tenant GUC must never hold an unverified value at any instant. Inside the per-request transaction:

1. `SET LOCAL app.current_user` — always, for every authenticated request.
2. Re-verify the claimed tenant, **passing it as a bound parameter, not reading it from a GUC**. The self axis alone can read this row, so no tenant context is needed yet:

   ```sql
   SELECT role FROM public.memberships
   WHERE user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
     AND tenant_id = $1::uuid
     AND deleted_at IS NULL;
   ```

3. Zero rows → the membership was revoked since the session was minted → 403, clear the session's active tenant, and `app.current_tenant` is never set.
4. One row → `SET LOCAL app.current_tenant` to the verified value, and use the freshly-read `role` as the authoritative role for RBAC this request.

This makes the guarantee structural rather than sequential: there is no window, however brief, in which the tenant axis is live for a tenant the user may not hold. It also makes revocation effective on the _next request_ rather than at next login, and a role _change_ likewise.

Two details the earlier draft got wrong, both verified in stage-1 review (§0). The `, true` (`missing_ok`) argument is required — without it the query raises `unrecognized configuration parameter` on a connection where the GUC was never set. And the `NULLIF` is required — without it a reused pooled connection sees `''` and raises `invalid input syntax for type uuid`. With both, an unset context yields `NULL`, the comparison yields no rows, and the request fails closed with a clean 403. Verified to return zero rows rather than error on both a fresh and a reused connection.

Cost: one indexed single-row read per authenticated request. It is served by the partial unique index on `(user_id, tenant_id) WHERE deleted_at IS NULL`, which covers this query exactly.

### 5. Auth flows

**`POST /auth/register`** — creates an organization. Writes **three rows atomically**: `tenants`, `users`, `memberships` (role `admin`). All-or-nothing; a partial failure must leave no tenant, no user, no membership. This widens ADR-004's step-4 atomicity gate from two rows to three.

- **OPEN-1:** if the email already exists as a `users` row, does registration (a) reject with 409 (register is for brand-new people only; an existing user creates additional tenants via an authenticated path), or (b) attach a new tenant + admin membership to the existing user? Recommendation for v1: **reject with 409**, and provide creating-an-additional-tenant as a thin authenticated endpoint (`POST /tenants`) only if it earns its place. Rejecting keeps registration single-purpose and avoids a password-reconciliation question (the existing user already has a password). Decide before writing the register function.

**`POST /auth/login`** — authenticate the person, then resolve workspaces.

1. `login_lookup(email)` (SECURITY DEFINER, §6) → `id, password_hash, deleted_at` or nothing.
2. Verify argon2 hash in the app. Generic failure on no-user-or-bad-password (no user enumeration).
3. `SET LOCAL app.current_user = id`; read live memberships under RLS policy 1.
4. Branch on membership count:
   - **0** → login **succeeds (200)**; issue the session with `user_id` and no active tenant. `/auth/me` returns the person with an empty workspace list — that empty list is the client signal. Tenant-scoped requests then 403 via the existing no-active-tenant fail-closed path, with no special casing. User-facing message is "no workspace access — ask an admin to invite you", not an auth failure. (OPEN-2, resolved: reject-at-login was considered and rejected for muddying the authn/authz boundary.)
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
- RLS on `memberships` structurally prevents a member of tenant A from reading or modifying memberships in tenant B, so the 403-path tests (§8) gain a DB-enforced backstop, not just a guard check.
- **AMENDED AT PHASE 1 (DECISION B) — `POST/PATCH/DELETE /users` are definer-backed, and the guard is no longer the only thing standing between a technician and an admin role.** This section previously assumed the RBAC guard was the sole authority on intra-tenant membership writes, with RLS scoping them to the active tenant. That left a real escalation open until step 5 (see the amendment box in §3). `meterlog_app` now holds no write privilege and no write policy on `memberships`, so every membership mutation must go through a **`SECURITY DEFINER` function that performs its own admin check**, in the same shape as `register_tenant`: owned by `meterlog_definer`, `search_path` pinned, body fully schema-qualified, `EXECUTE` granted only to `meterlog_app`, narrow argument list.
  - The Nest RBAC guard stays — it is what produces a clean `403` instead of a database error, and it is where role policy is expressed for the API. It is now the **outer** of two checks rather than the only one; the definer function re-checks admin against the acting user's live membership, and that check is the one that cannot be bypassed.
  - This grows the definer allowlist beyond `{login_lookup, register_tenant}` at step 5. `EXPECTED_DEFINER_FUNCTIONS` must be edited deliberately when it does (§8.1) — the allowlist is a reviewed set, and these additions are the reason it will change.
  - **Reads are unchanged and stay un-gated:** `GET /users` returns the whole member list to any member of the active tenant, by decision (§3).
  - **STANDING RULE — B moved the write-correctness burden into the function bodies, and nothing sits beneath them.** This is the consequence of Decision B that is easiest to forget and most expensive to forget. Before B, `memberships_tenant` was `FOR ALL ... USING/WITH CHECK (tenant_id = current_tenant)`, so **the policy itself enforced tenant-scoping on every write** — a function body with a bug could still not write across a tenant boundary. After B the app role cannot write at all, and the only write path is the definer, whose policy is `USING (true) WITH CHECK (true)` — **it constrains nothing whatsoever**. So the tenant-scoping the policy used to guarantee, and the admin check that was always RBAC's, are now _both_ entirely the responsibility of the `SECURITY DEFINER` function body. There is no database-layer backstop underneath it. Therefore:
    > **Every definer write function that acts on behalf of an authenticated caller MUST enforce, in its own body: (a) the caller is an admin of the active tenant, and (b) the target row belongs to that tenant — because nothing below it will.**
    >
    > Both checks belong inside the function, against arguments the caller cannot forge (the acting user comes from `app.current_user`, not from a parameter). A guard in Nest is not a substitute: the function is `EXECUTE`-able by `meterlog_app`, so anything holding that connection can call it directly, guard or no guard.
  - **`register_tenant` is the one exemption, and it is exempt for a reason, not by oversight** — it runs pre-auth, where there is no acting user and no active tenant, and it _creates_ the tenant it writes into. Caller-authorization is not merely unnecessary there, it is undefined. Its gate is atomicity instead. `login_lookup` is read-only and likewise exempt. Every function added after these two is subject to the rule above.
  - **What this means for how step 5 is gated.** Atomicity alone proves nothing about authorization — a forced-failure test says the writes roll back cleanly, not that the caller was allowed to make them. The step-5 gate must therefore require, as **live negatives** alongside atomicity: **a non-admin caller is rejected**, and **an admin of tenant A cannot modify tenant B's memberships through the function**. Those are the two failures the pre-B policy would have caught for free and now cannot.

> **AMENDED AT STEP 5 PHASE 1 — the last-admin lockout. §7 specified the three endpoints and the standing rule, and said nothing about who may be demoted or removed.**
>
> **The gap.** `change-role` and `revoke` introduce a lockout class that did not exist while memberships were unwritable: an admin demoting themselves, revoking themselves, or acting on the last remaining admin, leaving a tenant with **zero live admins**. Every membership write requires a live admin caller, so an adminless tenant is unrecoverable through the app — there is no one left who can invite, promote, or revoke. Nothing in this ADR, ADR-004, or the brief addressed it; it was surfaced at the step-5 opening gate and decided there.
>
> **The decision — option A, "last admin standing."** A change that would leave the tenant with zero live admins is refused (`LAST_ADMIN`). Anything that leaves at least one is permitted, explicitly including **hand over then leave**: promote a second admin, then demote or revoke yourself. Self-revocation is permitted on the same terms. A blanket no-self-action rule was rejected as stricter than the risk requires — it would stop a sole founder ever leaving, and stop a single-admin tenant ever changing its own admin's role — and "no guard at all" was rejected outright, since the failure is an unrecoverable tenant.
>
> **The structural collapse, which is why the guard is simple.** Clause (a) requires the caller be a live admin of the active tenant, and `memberships_user_tenant_live_key` permits at most one **live** membership per `(user, tenant)`. So if the target is an admin membership other than the caller's own, the caller's own admin membership is a second live admin **by construction** — demoting or revoking someone else can never zero the tenant. **"Last admin" and "self-action on one's own admin membership" are the same condition.** There is no cross-user lockout case to defend against, and a guard that tried to handle one would be dead code.
>
> **`SELECT … FOR UPDATE`, not a bare count — and the lock is taken before the target row.** The per-request interactive transaction sets no isolation level, so it runs at **READ COMMITTED**. A snapshot `count(*)` of live admins is therefore wrong under concurrency: two admins each demoting themselves both read `count = 2`, both conclude another admin remains, and the tenant lands on zero with neither call erroring. The count must be taken over rows the transaction has **locked**, so the second blocks and — on READ COMMITTED's re-evaluation of the qual against the committed row version — no longer sees the first as an admin. The admin set is locked **before** the target row and **`ORDER BY id`**: locking the target first deadlocks the symmetric case outright (each transaction holds its own row and reaches for the other's), which Postgres resolves with `40P01` rather than with this function's own refusal. Verified live, both halves: sequential refusal, and a forced two-connection interleaving in which one transaction commits and the other is refused `LAST_ADMIN` — with the blocked backend asserted to be genuinely waiting on a `Lock` in `pg_stat_activity`, so a sequential test cannot masquerade as a concurrent one.

> **AMENDED AT STEP 5 PHASE 1 — the invite credential mechanism, which §7 above flagged as under-specified and deferred to step 5.**
>
> §7 already specifies the branch itself: an existing live `users` row for the email gets a new membership; no row means the identity and the membership are created together. What it left open was **how a newly-invited person gets a password** — and `users.password_hash` is `NOT NULL`, so the insert cannot be written at all without answering it.
>
> **The decision — option A, a sentinel hash.** The new identity is created with a **real argon2id hash of a throwaway secret**, derived app-side from `ARGON2_OPTIONS` and passed into the function as a parameter (argon2 cannot be computed in SQL). It is never a literal in the migration: a hardcoded hash is precisely the drift vector closed at the step-4 gate, where the timing-equalisation hash and the production hash agreed only by coincidence of library default. The account therefore exists and is **deliberately unusable** — `login_lookup` returns it, the argon2 verify fails, and the login path answers with its existing generic failure. Asserted by parsing `m=`, `t=`, `p=` out of the stored value and comparing against `ARGON2_OPTIONS`, the same shape as the step-4 guard.
>
> **THE HASH PARAMETER IS SCOPED TO THE CREATE BRANCH, AND THAT IS A SECURITY BOUNDARY RATHER THAN AN IMPLEMENTATION DETAIL.** It is used **only** when a new identity is being created, and never touches an existing `users` row. Honouring it on the attach branch — writing `password_hash` for an email that already resolves to a person — would make "invite an existing email" an **arbitrary password reset for any address in the system**, callable by any tenant admin against anyone, including people in tenants they have nothing to do with and have never been able to see. That is a **cross-tenant account-takeover primitive**, and it would be reachable through the ordinary invite endpoint with no privilege the admin does not already hold: invite `victim@other-org.test` with a hash you chose, then log in as them.
>
> The reason it is recorded here and not left to the test that covers it: the two branches look like near-duplicates, and the obvious refactor — resolve-or-create the identity, then write the row once — **silently honours the parameter on both paths**. It reads as a tidy-up and is an escalation. Nothing in the function's shape warns you, because the dangerous version is the shorter one. `invite` may create a credential; it may never modify one. Anything that changes an existing person's credential belongs behind that person's own authentication, never behind an inviting admin's.
>
> Enforced by construction (the parameter is referenced only inside the `IF v_user_id IS NULL` branch) and asserted by `membership-writes.spec.ts` — "invite does NOT overwrite an existing identity's password hash".
>
> **The accepted consequence, recorded rather than discovered later.** Creating the identity **consumes the global email uniqueness**. That person cannot then register their own organisation (OPEN-1 answers that with a 409) and cannot log in (no valid password), until a set-password / invite-token flow lands in a later step. This is a **known, intended, temporary dead-end**, not a silent break: the row is deliberately unusable, an admin holds the tenant, and nothing fails silently. Accepted with sign-off at the step-5 gate. Forward marker in `DECISIONS.md`, alongside OPEN-4's audit retrofit.
>
> **A requirement that later step inherits.** Pending-invite accounts carry a valid-looking argon2 hash and are **not distinguishable from credentialled accounts by any column today**. The set-password flow will therefore need a distinguishing signal — a status column, an `invited_at`, or equivalent — to find them. That column is a later-step concern; the requirement is recorded now so it is not discovered as a blocker then.

> **AMENDED AT STEP 5 PHASE 2 — the membership endpoints must not become an existence oracle. `MEMBERSHIP_NOT_FOUND` is ONE code for two situations, deliberately.**
>
> **The rule.** `change_member_role` and `revoke_member` raise `MB002` — surfaced as **HTTP 404** — for _both_ "no such membership" and "that membership exists, but it belongs to another tenant". The two cases are indistinguishable from outside, on purpose, and that is a security property rather than a simplification.
>
> **Why.** §7 clause (b) already stops an admin of A from writing tenant B's rows, so nothing can be _modified_ across the boundary either way. But a caller who can tell the two apart can still _read_ something they are not entitled to: feed the endpoint well-formed uuids and the response code answers "is this a real membership somewhere in this system?" — one bit at a time, for any id, from any authenticated tenant admin. Tenant B's membership ids are not secret in a cryptographic sense, but their existence is exactly the kind of cross-tenant fact this ADR exists to keep unobservable. An isolation model that hides B's rows and then confirms their ids through a status code has a hole in it, and it is a hole that no RLS policy can close because the leak is in the shape of the reply, not in the data returned.
>
> **The refactor hazard, and it is the same shape as the invite-hash vector above — the dangerous version is the one that looks like an improvement.** A future "make the error messages more helpful" pass will want to split them: `403` when the caller is not an admin of the target's tenant, `404` when the row genuinely does not exist. That reads as better API design, reviews as a usability fix, and **reopens the enumeration channel completely** — the distinction it adds _is_ the oracle. Do not split `MB002`. If richer errors are ever genuinely needed, they belong on the paths where the caller is already entitled to the answer (targets inside the active tenant), never on the cross-tenant path.
>
> **`MB001` is not the same case and stays a 403.** "You are not an admin here" is a fact about the caller's own membership in their own active tenant, which they can already read from `GET /users`. It discloses nothing about another tenant.
>
> Proven by an acceptance test asserting that a real, live membership in a real tenant B and a well-formed nonexistent uuid return the **same** status and the **same** error code, and by a mutation in the step-5 Phase 3 sweep that splits the two and must redden a test — because an anti-enumeration claim with no negative behind it is exactly the kind of security claim this project does not ship.

### 8. Test changes

**8.1 Catalog coverage suite (ADR-004, lands at scaffold) — update the allowlists:**

- Definer-function allowlist = `{login_lookup, register_tenant}`.
- Definer-policy allowlist tables = `{users, tenants, memberships}` (was two).
- Definer grant assertion includes `SELECT, INSERT` on `memberships`.
- **Generalize catalog assertion 8 to any `app.*` GUC.** It currently matches only `current_setting('app.current_tenant'` and would not have caught this ADR's raw `app.current_user` usages — the guard had the same blind spot the bug exploited. Broaden it to require the `NULLIF(..., '')` wrapper on any `current_setting('app.*', ...)` reference in any policy qual or with-check.
- `memberships` must appear with RLS enabled + forced like every other table (the column-agnostic assertion 1 already covers it; it has a `tenant_id` column so assertion 2 covers it too).

**8.2 Catalog-driven isolation harness (ADR-004) — `memberships` is a special case.**

**Why the generic matrix cannot be trusted here, stated correctly.** An earlier draft of this ADR said the generic matrix would produce a _false failure_ on `memberships`, because the self axis legitimately reveals the acting user's own B-membership under A's context. That reasoning is wrong, and wrong in the more dangerous direction. The harness sets **only** `app.current_tenant` and never `app.current_user`, so the self axis matches nothing and never fires at all. Verified against a live database: under tenant A's context with the user GUC unset, the matrix sees A's rows only, no B rows leak, and it **passes** — having exercised exactly half the policy surface. On a connection where `app.current_user` had previously been set, it instead raises `22P02` (see §0 item 2), so the other possible outcome is a flaky error. Neither is a true red.

The practical consequence: **a green generic matrix on `memberships` is not evidence of anything**, and anyone who sees it green must not conclude the table is covered. That is why the bespoke test below is mandatory rather than a nicety, and why `memberships` is registered as an explicit exempt-with-bespoke-handler entry so its absence from the generic matrix is a declared decision rather than a silent gap.

The bespoke dual-axis test:

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

**Scope decision (made deliberately, to stop step 8 ballooning):** a **minimal workspace switcher with a hard cache reset on switch** satisfies the cache-isolation security property below and is what v1.0 ships. A polished picker — search, avatars, recent-workspace ordering, transition states — is explicitly **out of scope for v1.0**. The backend contract is what earns the portfolio claim; the switcher has to be secure, not pretty. Step 8 is the likeliest place for this ADR's cost to run away, and this is the line against it.

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

### 11. Sub-decisions (resolved)

- **OPEN-1 — RESOLVED. One `users` row per email, ever; multi-tenancy is expressed purely through memberships.**
  - Register with an already-existing email → **reject 409**. Registration is new-org-with-new-account only.
  - Invite with an already-existing email → **attach a new membership to the existing user**. This is the multi-org mechanism, and it is the same identity question as register seen from the other side, answered consistently.
  - **Escape hatch — do not build now.** If self-serve second-org creation is ever wanted, it belongs behind an authenticated `POST /tenants`, never as a change to `register`. Recorded here as the designated future home so `register` does not accrete a second purpose later.
- **OPEN-2 — RESOLVED. Zero live memberships → login succeeds (200).** Session issued with `user_id` and no active tenant; `/auth/me` returns the person with an empty workspace list, which is the client's signal. Tenant-scoped requests 403 through the existing no-active-tenant fail-closed path — no special casing. Message is "no workspace access — ask an admin to invite you", not an auth failure. Reject-at-login was explicitly rejected for muddying the authn/authz boundary. The frontend empty-state page is an optional step-8 upgrade, not a step-4 requirement; the backend contract is identical either way.
- **OPEN-3 — RESOLVED.** The tenant-switch endpoint is **`POST /auth/switch`**.
- **OPEN-4 — DEFERRED to step 7.** Whether to record role-at-time-of-action in the audit payload is decided when the audit module is built. Until then attribution stays at person (`users.id`) + the row's own `tenant_id`.
- **OPEN-5 — RESOLVED. Accept the residual for v1.0.** Liveness is enforced in-policy only on the two exclusively-reading paths (re-verify, workspace-list subquery), deliberately absent from the `memberships` row policies because the predicate would block the revoking UPDATE itself. `/auth/me` and any future self-axis reader carry `WHERE deleted_at IS NULL` app-side — the one documented app-side predicate in the design. A third definer function to close the residual was rejected. Full reasoning in the boxed finding in §3.

### 12. Consequences

- The isolation story becomes the project's genuine showpiece: a two-axis RLS model proving that even a user with legitimate multi-tenant access cannot cross tenants, backed by DB-enforced membership scoping rather than app checks. This is a materially stronger portfolio claim than single-tenant isolation.
- Cost is concentrated in steps 4, 5, and 8: the membership schema, the two-GUC interceptor with per-request re-verification, the memberships-module semantics, and the workspace switcher with cache keying. It is a real scope increase over the brief's model and must be justified against §2's "do not over-build" — justified here because it deepens the one thing the project exists to demonstrate rather than adding an orthogonal feature.
- The definer surface is _simpler_ than the pre-membership design assumed (tenant/role read moved under RLS), not more complex — the added definer cost is one table's grants for registration only.
- `memberships`' dual policy is the highest-risk implementation detail (§3, §8.2) and the highest-value review target after the definer functions.
- Multi-org is now a first-class capability, not a future migration: adding a person to a second tenant is an INSERT, exactly the reversibility property that made this worth building correctly the first time.
