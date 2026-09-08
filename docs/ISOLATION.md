# ISOLATION.md — how MeterLog keeps tenants apart, and how that is proven

> The isolation and authentication narrative for MeterLog. Not a vulnerability-disclosure policy.
>
> **Every technical claim below carries a `file:line` citation into this repository, and every security property is backed by a negative — a rejected write, a zero-row read, a refused request — executed against a live PostgreSQL 16 instance.** Click any of them. A document that invites that check should read differently from one that asserts.
>
> **Status:** build-order step 4 (auth + tenancy foundation) complete. §8 states plainly what is _not_ yet proven.

---

## 1. The thesis

MeterLog is a multi-tenant SaaS whose isolation guarantee is enforced by PostgreSQL Row-Level Security rather than by application `WHERE` clauses. That much is unremarkable. What this document is actually about is a narrower claim:

**Four separate times during step 4, a defect survived design review, code review and a green test suite — and was caught only by running the thing against a real database.** Each one reviewed as correct. Each one would have shipped.

| #   | Defect                                                                                                          | Why reading missed it                                                       |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Dual-axis isolation: the generic test matrix _passes_ on `memberships` while exercising half the policy surface | A green test is indistinguishable from a covering test                      |
| 2   | `WHERE u.email = p_email` silently binding **case-sensitive** comparison under a pinned `search_path`           | The line is correct-looking, both operands are `citext`, and nothing errors |
| 3   | A guard that fails closed on a fresh connection and **500s on a reused one**                                    | The two connection states differ, and tests land on the fresh one           |
| 4   | An app-side predicate whose absence is masked by a policy one join away                                         | The obvious test for it passes either way                                   |

Each is documented below with the mechanism, the code as it stands today, and the live-database negative that holds it.

---

## 2. The model

`users` is pure identity — **no `tenant_id`**, globally unique email among live rows ([migration.sql:22-33](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L22-L33)). `memberships` is the join carrying `user_id`, `tenant_id` and `role` ([migration.sql:37-48](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L37-L48)). One person may hold memberships in many tenants; role is per-tenant, not per-person.

That choice is the whole point. The brief modelled one tenant per user, which makes "tenant A cannot see tenant B" only ever testable across _different_ users. The membership model turns the claim into the strictly stronger:

> **A user who is a member of both A and B, acting in A, cannot see B's rows — and cannot even assert B as active unless they hold a verified live membership in it.**

Three roles, none holding `BYPASSRLS` ([bootstrap:31-40](../apps/api/prisma/migrations/20260903000000_bootstrap_roles/migration.sql#L31-L40)): the migration/owner role, `meterlog_definer` (NOLOGIN, owns the pre-auth functions), and `meterlog_app` (the runtime connection). All three identity tables carry `ENABLE` **and** `FORCE ROW LEVEL SECURITY` ([migration.sql:60-65](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L60-L65)) — `FORCE` matters because it subjects the table _owner_ to its own policies, which is what makes the definer pattern work through explicit policies rather than through a privilege bypass.

Two request-scoped GUCs carry context: `app.current_user` and `app.current_tenant`.

---

## 3. Finding 1 — dual-axis isolation, and the test that passes for the wrong reason

### The mechanism

`memberships` carries two permissive app-role policies, and permissive policies **OR** together:

```sql
CREATE POLICY memberships_self_read ON public.memberships
  FOR SELECT TO meterlog_app
  USING (user_id = NULLIF(current_setting('app.current_user', true), '')::uuid);
```

— [migration.sql:122-124](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L122-L124)

```sql
CREATE POLICY memberships_tenant ON public.memberships
  FOR SELECT TO meterlog_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
```

— [migration.sql:152-154](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L152-L154)

The self axis exists so a user can list their own workspaces at login, before any tenant is active. The tenant axis exists so a member can see who else is in the workspace they are currently in.

### The trap

The project's generic isolation harness sets **only** `app.current_tenant` ([helpers.ts:160-172](../apps/api/test/db/helpers.ts#L160-L172)). Run against `memberships`, the self axis therefore never fires, the matrix sees A's rows and no B rows, and it **passes** — having exercised exactly half the policy surface. A green result there is evidence of nothing.

That is why `memberships` is registered in an explicit exempt-with-bespoke-handler set rather than being quietly absent ([helpers.ts:110](../apps/api/test/db/helpers.ts#L110)), and why the fixture-coverage check asserts registry/catalog equality **in both directions** so a new table cannot arrive without a fixture ([isolation.spec.ts:50-86](../apps/api/test/db/isolation.spec.ts#L50-L86)).

### The evidence

User M is a member of A (admin) and B (technician). N is admin of B. P is an auditor in A. M acts in tenant A. The complete visible set, as `meterlog_app`:

```
=== M is a member of BOTH A and B. Acting in A, the ENTIRE visible set: ===
     member     |  tenant  |    role    | visible_via
----------------+----------+------------+-------------
 m@example.test | Tenant B | technician | self axis
 m@example.test | Tenant A | admin      | tenant axis
 p@example.test | Tenant A | auditor    | tenant axis
(3 rows)

--- N is admin of B. Can M, acting in A, see N's B-membership? ---
 n_rows_of_usern_in_b
                    0
```

Three properties in one result, and the middle one is what a single-tenant model can never demonstrate:

1. M sees A's full membership structure (tenant axis).
2. M sees **their own** B-membership while acting in A — correct, not a leak. This is precisely the row a naive isolation test would flag as a cross-tenant breach.
3. M sees **nothing** of N's B-membership, though it sits in the same table and the same tenant as row 2.

Held by [`M acting in A CAN see their own B-membership (correct, not a leak)`](../apps/api/test/db/membership-isolation.spec.ts#L122), [`the self axis is scoped to self, not to "any membership"`](../apps/api/test/db/membership-isolation.spec.ts#L141), and `M acting in A cannot see another user's membership in B`.

### The cascade onto `users`

`users` lost the `tenant_id` its original policy was keyed on, and the ADR that introduced the membership model never specified a replacement — a spec gap surfaced during implementation rather than assumed away. Its policy set is two `FOR SELECT` policies, keyed on the two axes ([migration.sql:91-103](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L91-L103)), with **no app-role write policy at all**.

The tenant-members policy subqueries `memberships`, which is itself under FORCE RLS — so the correctness of the `users` policy is entirely determined by the `memberships` policy set. Co-member visibility is un-gated by design and recorded as a decision rather than left as a side effect: every member of a tenant reads every co-member's identity and role, which is the right default for team SaaS. Gating a _read_ on role would require a role term in a read policy — the shape that produced the OPEN-5 finding in §6.

**`password_hash` is withheld by column-level grant, not by policy**, because RLS is row-level and cannot hide a column ([migration.sql:170](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L170)):

```
    column     | app_can_read | definer_can_read
---------------+--------------+------------------
 id            | t            | t
 email         | t            | t
 password_hash | f            | t
 created_at    | t            | t
 updated_at    | t            | t
 deleted_at    | t            | t
```

The app role can read the row and not the hash; the definer can read both, which is what lets `login_lookup` work. Held by [`password_hash is unreadable by the app role, even for rows it can see`](../apps/api/test/db/membership-isolation.spec.ts#L362).

### Fail-closed with no context

Every GUC reference uses `NULLIF(current_setting('app.<guc>', true), '')`. Both halves are load-bearing: without `, true` an unset GUC raises `unrecognized configuration parameter`; without the `NULLIF`, a **pooled** connection sees `''` and `''::uuid` raises `22P02`. Either way the request 500s instead of failing closed. Assertion 8 enforces the wrapper structurally on any `app.*` GUC in any policy ([catalog-rls.spec.ts:234](../apps/api/test/db/catalog-rls.spec.ts#L234)) — deliberately generalised from the single GUC it originally named, because the guard had the same blind spot as the bug it exists to catch.

```
=== fail-closed with NO context at all ===
 memberships | users | tenants
-------------+-------+---------
           0 |     0 |       0
```

---

## 4. Finding 2 — the citext lockout: when "fails loud" quietly isn't

### The mechanism

A `SECURITY DEFINER` function runs with its owner's privileges, so ADR-004 pins `SET search_path = pg_catalog, pg_temp` and requires every reference in the body to be schema-qualified ([migration.sql:40](../apps/api/prisma/migrations/20260908000000_auth_definer_functions/migration.sql#L40)). The stated rationale was that with `public` out of the resolution path, an unqualified reference **fails outright rather than resolving wrongly**.

That rationale is true for functions and tables. **It is false for operators.**

`login_lookup` was written with a bare `WHERE u.email = p_email`. Both operands are `citext`. It reviews as correct. But citext's `=` operator lives in `public`, which the pin excludes — and the reference does not fail to resolve. Postgres falls back through citext's implicit cast to `text` and binds case-**sensitive** `text = text`:

```
--- citext = operator: which schema does it live in? ---
 operator_schema
 public

--- under the definer search_path (public EXCLUDED) ---
 bare_equals_case_insensitive
 f
 qualified_operator
 t

--- with public on the path ---
 bare_equals_case_insensitive
 t
```

### Why this was worse than a wrong answer

`users_email_live_key` resolved its citext operator class at `CREATE INDEX` time, with `public` in scope ([migration.sql:33](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L33)). So **uniqueness stayed case-insensitive while the lookup became case-sensitive.**

Register as `Founder@acme.test`; log in as `founder@acme.test` → no row → generic auth failure. Try to re-register → refused by the index. The account is unreachable and unrecoverable, and nothing errors anywhere. It is a silent, permanent lockout that no log line would explain.

### The fix, and where the line is drawn

```sql
WHERE u.email OPERATOR(public.=) p_email
```

— [migration.sql:62](../apps/api/prisma/migrations/20260908000000_auth_definer_functions/migration.sql#L62)

Schema-qualify the **operator** — _not_ add `public` to the `search_path`. Widening the path is the change that makes the symptom disappear while removing the property the pin exists to provide. The distinction is recorded as an amendment to ADR-004 ([DECISIONS.md:132](DECISIONS.md#L132)) so the next definer function comparing an extension type does not walk back into it.

### The guard split — stated so neither half is mistaken for the other

- The **loud** kind (an unqualified function or table reference failing to resolve) is caught structurally by definer-probe case E, and by catalog assertion 4 ([catalog-rls.spec.ts:108](../apps/api/test/db/catalog-rls.spec.ts#L108)).
- The **silent** kind is caught by exactly one thing: the behavioural test [`matches case-insensitively — regression guard, this was broken`](../apps/api/test/db/auth-definer.spec.ts#L223). No structural assertion can replace it, because at the catalog level the broken function and the correct one are **identical** — same owner, same `search_path`, same everything. That test is annotated as load-bearing and must not be deleted as redundant ([CLAUDE.md:50](../CLAUDE.md#L50)).

Assertion 4 was tightened at the same time from checking that a pin _exists_ to checking its _content_ — it previously accepted `search_path = public, pg_catalog, pg_temp`: pin present, hardening gone.

---

## 5. Finding 3 — the pooled-connection re-verify

### The mechanism

`SET LOCAL` is scoped to a transaction, and therefore to the one pooled connection that transaction holds. So every authenticated request runs inside one interactive transaction ([interceptor:86](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L86)), and the ordering inside it is **verify, then set**:

1. `SET LOCAL app.current_user` — always ([interceptor:90](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L90)).
2. Re-verify the claimed tenant, with the candidate passed as a **bound parameter, never read from a GUC** — reading it from a GUC would mean setting it first, which is the ordering this design exists to avoid ([interceptor:113-119](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L113-L119)).
3. Zero rows ⇒ **403**, the session's active tenant is cleared, and `app.current_tenant` is never assigned at any instant ([interceptor:123-131](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L123-L131)).
4. One row ⇒ set the tenant GUC and use the freshly-read role ([interceptor:134-138](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L134-L138)).

The guarantee is structural rather than sequential: there is no window, however brief, in which the tenant axis is live for a tenant the user may not hold. This is also what makes revocation take effect on the **next request** rather than at next login — and a role _change_ likewise.

### Why the easy test proves nothing

"Revocation fails closed" is trivially demonstrable on a fresh connection with no context set. That is not where the risk lives. The risk lives in **pooled connection statefulness**: `current_setting('app.x', true)` returns `NULL` on a connection that has never had the GUC set, but the **empty string** once `SET LOCAL` has touched it even once. A test that lets request 2 land on a fresh connection passes whether or not re-verification works.

So the suite pins the client to `connection_limit=1` ([interceptor.spec.ts:41](../apps/api/test/db/interceptor.spec.ts#L41)) **and asserts `pg_backend_pid()` is identical across the two requests** rather than assuming the pool obliged ([interceptor.spec.ts:248](../apps/api/test/db/interceptor.spec.ts#L248)). It further asserts no stale tenant survived on that connection ([interceptor.spec.ts:253](../apps/api/test/db/interceptor.spec.ts#L253)) — with `SET` instead of `SET LOCAL` that value persists and every subsequent query on the connection still sees the old tenant, which is the fail-open the whole ordering exists to prevent.

Held by [`request 2 fails closed, on the same backend, with no tenant residue`](../apps/api/test/db/interceptor.spec.ts#L215) and, over real HTTP, by [`the next request 403s, on the SAME pooled backend, and the workspace disappears`](../apps/api/test/api/auth.spec.ts#L328) — which reads backend pids from `pg_stat_activity`, baseline-subtracted so a stray connection from another suite cannot make the assertion vacuous.

Ordering itself is asserted on the **emitted SQL** via Prisma query events ([interceptor.spec.ts:379](../apps/api/test/db/interceptor.spec.ts#L379)), because the behavioural cases cannot separate the two orderings: both end in a 403 with a rolled-back transaction and no residue.

### The guard that was unreachable — and what was done about it

Mutation testing found that deleting the `NULLIF` from the re-verify reddened **nothing**. The interceptor sets `app.current_user` immediately beforehand, so `current_setting` always returned a valid uuid and the guard never fired. It was unreachable by construction, not unnecessary — with the guard, a misordered interceptor still throws `ForbiddenException`; without it, a `PrismaClientKnownRequestError`, i.e. a **500 instead of a fail-closed 403**.

Rather than record it as an untested guard, a reachable case was added: a session with a **blank** `userId` writes `''` into the GUC, which is exactly the state the guard exists for — a real poisoned-session state (a corrupted Redis value, or a future path that forgets to populate it), not a contrivance. [`a session with a BLANK user id fails closed with 403, not 500`](../apps/api/test/db/interceptor.spec.ts#L467).

**That test also demonstrates the whole thesis in miniature.** Under the mutation it **passes when run in isolation** — a fresh connection returns `NULL` — and fails only in a full-file run, once the connection has been reused. A per-test-isolation habit would have hidden it permanently. This is why `fileParallelism: false` ([vitest.config.ts:13](../apps/api/vitest.config.ts#L13)) is recorded as a **load-bearing invariant** rather than a performance setting, with the reproduction written down so nobody optimises it away ([CLAUDE.md:45-52](../CLAUDE.md#L45-L52)).

---

## 6. Finding 4 — decision B, and the predicate hidden behind a join

### 6a. The escalation the policy could not see

The tenant axis was originally `FOR ALL`, making it the app role's write path, with the admin-only check left to an RBAC guard scheduled for a later build step. Neither policy clause carries a role term, and `tenant_id` does not change during a role edit. Verified against a live database, a **technician** in tenant A ran:

```sql
UPDATE public.memberships SET role = 'admin' WHERE user_id = <self>
```

and got `UPDATE 1`, `role_now = admin`. Self-promotion to admin in one statement. The guard meant to stop it was a future artifact that did not exist — and "latent until then" is still exploitable.

**Decision B: `meterlog_app` becomes structurally incapable of writing `memberships`.** The axis became `FOR SELECT` (which carries no `WITH CHECK` at all), no app-role write policy replaced it, and the grant narrowed from `SELECT, INSERT, UPDATE` to `GRANT SELECT` ([migration.sql:180](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L180)). Membership writes move to admin-checking `SECURITY DEFINER` functions in step 5.

The alternative of putting a role term into the RLS policy was rejected because it recombines the three bug classes this project had already been burned by: a predicate over a column the statement itself mutates, `FORCE ROW LEVEL SECURITY`, and Postgres applying the SELECT policy to the _new_ row of an `UPDATE … WHERE`.

```
    table    |  priv  | app_role
-------------+--------+----------
 memberships | DELETE | f
 memberships | INSERT | f
 memberships | SELECT | t
 memberships | UPDATE | f
 tenants     | DELETE | f
 tenants     | INSERT | f
 tenants     | SELECT | t
 tenants     | UPDATE | f
 users       | DELETE | f
 users       | INSERT | f
 users       | SELECT | f
 users       | UPDATE | f
```

(`users | SELECT | f` at _table_ level is the column-grant from §3 — the app role reads five of six columns, never `password_hash`.)

### 6b. Two independent layers, proven separately

The write is refused twice over, and the tests assert each layer on its own — otherwise they would pass on the grant alone even if a dangerous policy were reintroduced.

**Layer 1, the privilege**, as `meterlog_app` (`bypassrls = f`):

```
=== LAYER 1 (privilege) : app role holds no write grant on memberships ===
ERROR:  permission denied for table memberships     <- INSERT for its own active tenant
ERROR:  permission denied for table memberships     <- self-promotion UPDATE
```

**Layer 2, the policy** — grants temporarily restored inside a rolled-back transaction, leaving RLS as the only thing that can refuse:

```
=== LAYER 2 (policy) : write grants temporarily RESTORED, so only RLS can refuse ===
ERROR:  new row violates row-level security policy for table "memberships"
UPDATE 0
 role_after_update
 technician
```

**Note the asymmetry, because it is a trap.** A denied `INSERT` raises. A denied `UPDATE` or `DELETE` **does not** — with no applicable policy no row is visible to modify, so Postgres reports `UPDATE 0` and returns cleanly. A test asserting a thrown error on the UPDATE path would fail against a _correctly behaving_ database. The suite asserts zero-rows-and-row-unchanged there deliberately ([membership-isolation.spec.ts:301](../apps/api/test/db/membership-isolation.spec.ts#L301)), and the migration comment says why.

Durability is asserted structurally, because a single stray `GRANT` would reopen the escalation with nothing else complaining: [`9. the app role holds no INSERT, UPDATE or DELETE on any identity table`](../apps/api/test/db/catalog-rls.spec.ts#L299), paired with assertion 10 so it cannot be satisfied by a table nobody can touch.

### 6c. What B moved, and the rule that follows

B closed the app-role write path — and in doing so **relocated the entire write-correctness burden into the definer function bodies**. Before B, the policy itself enforced tenant-scoping on every write, so even a buggy function body could not cross a tenant boundary. After B the only write path is the definer, whose policy is:

```sql
CREATE POLICY memberships_definer ON public.memberships
  FOR ALL TO meterlog_definer USING (true) WITH CHECK (true);
```

— [migration.sql:156-157](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L156-L157)

**That constrains nothing.** Tenant-scoping and the admin check are now both the function body's sole responsibility, with no database-layer backstop beneath them. The standing rule is recorded in ADR-006 §7 and DECISIONS.md: every definer write function acting for an authenticated caller must enforce, in its own body, that the caller is an admin of the active tenant _and_ that the target row belongs to it. `register_tenant` is the one exemption, and exempt for a reason rather than by oversight — it runs pre-auth and _creates_ the tenant it writes into, so caller-authorization there is undefined, not merely unnecessary.

### 6d. The OPEN-5 residual, and the predicate hidden behind a join

Liveness (`deleted_at IS NULL`) **cannot** live in the `memberships` row policies. Postgres applies a table's SELECT policy to the _new_ row of an `UPDATE … WHERE`, so a liveness predicate there blocks the revoking `UPDATE` itself — the predicate defeats the operation it exists to enforce. Splitting into `FOR SELECT` + `FOR UPDATE` does not help; the SELECT policy still bites.

So liveness lives in the paths that only ever read: the re-verify query ([interceptor:118](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L118)), the `tenants_workspace_list` subquery ([migration.sql:80-84](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L80-L84)), `users_tenant_members_read` ([migration.sql:98-103](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L98-L103)), and **one documented app-side predicate** ([auth.service.ts:246](../apps/api/src/auth/auth.service.ts#L246)).

The accepted residual — a raw self-axis read returns a revoked row — is itself asserted, so nobody "fixes" what cannot be fixed: [`the OPEN-5 residual is real: a self-axis read still returns the revoked row`](../apps/api/test/db/membership-isolation.spec.ts#L451).

**The app-side predicate is where finding 4 gets interesting.** Deleting it reddened nothing. The reason is subtle: the `JOIN` to `tenants` is filtered by `tenants_workspace_list`, which carries liveness _of its own_, so a workspace held **only** through a revoked membership is dropped by the join whether or not the predicate is there. The obvious revoked-workspace test proves nothing about it.

The reachable case is **re-invitation** — which the schema explicitly designs for. The unique index is _partial_:

```sql
CREATE UNIQUE INDEX memberships_user_tenant_live_key
  ON public.memberships (user_id, tenant_id) WHERE deleted_at IS NULL;
```

— [migration.sql:50-51](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L50-L51)

One **live** membership may therefore coexist with any number of revoked ones for the same tenant. The tenant is then visible through the live row, the join keeps **both**, and the workspace appears twice — the duplicate carrying whatever role the person held before removal. Someone revoked as admin and re-invited as auditor would be offered admin of a workspace they are an auditor in.

Held by [`a re-invited user sees one workspace, not their revoked membership as well`](../apps/api/test/api/auth.spec.ts#L534).

---

## 7. Method — why the evidence is shaped the way it is

The four findings above share a cause: **a test that passes is not the same as a test that covers.** Several practices exist specifically to close that gap.

**Every security claim carries its negative.** The rejected write, the zero-row read, the refused request. A positive alone cannot distinguish "the boundary held" from "the boundary was never reached".

**Vacuity guards on the guards.** Atomicity is asserted in **autocommit**, because a rolled-back wrapper would leave no orphan whether the function is atomic or not ([auth-definer.spec.ts:130](../apps/api/test/db/auth-definer.spec.ts#L130), [:158](../apps/api/test/db/auth-definer.spec.ts#L158)). The orphan check runs as the **migration** role, because `tenants` is under FORCE RLS and asking the app role would return zero rows regardless — a guaranteed green proving nothing. The Redis logout check asserts the key is **present before** as well as absent after, because otherwise a mistyped key prefix would masquerade as a clean logout ([auth.spec.ts:183](../apps/api/test/api/auth.spec.ts#L183)).

**Boundaries proven semantically, not syntactically.** The unauthorized-switch test targets a **real, existent tenant with a membership belonging to someone else** ([auth.spec.ts:287](../apps/api/test/api/auth.spec.ts#L287)). A malformed uuid would prove only that DTO validation runs.

**Mutation testing across every phase.** Each `USING`/`WITH CHECK` predicate, each `NULLIF`, each liveness clause, and each structural guard was dropped in turn and required to redden at least one test. Anything that reddened nothing was flagged and then either made reachable (the `NULLIF` in §5, the app-side predicate in §6d) or classified honestly:

> Reverting the argon2 dummy hash to an options-free call reddens nothing — and correctly so. Library defaults currently equal the declared parameters, making it a **behaviourally equivalent mutant**, not an untested guard.

That distinction matters: an equivalent mutant is not a coverage hole, and pretending otherwise by contriving a test would be exactly the dishonesty the rest of the discipline exists to prevent.

**Two defects were found by building, and are recorded rather than quietly fixed.** A protected route with no session returned **500 instead of 401** — the right refusal for the wrong reason — and the first version of the test _asserted the 500_, documenting the defect instead of catching it. The obvious fix made it worse: a `CanActivate` guard rejected **every** request, because Nest runs guards _before_ interceptors, so the guard could not see a context the interceptor had not yet established. Found empirically, not by reasoning. The resolution puts the _declaration_ at the route as metadata and keeps the single _enforcement_ point inside the interceptor that already resolved the session ([requires-session.decorator.ts](../apps/api/src/common/auth/requires-session.decorator.ts), [interceptor:74-83](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L74-L83)).

**Timing as a boundary.** The no-such-user login branch performs a real argon2 verify so it costs what the wrong-password branch costs. The dummy hash is derived from the same exported parameters production uses ([auth.service.ts:52](../apps/api/src/auth/auth.service.ts#L52), [:290](../apps/api/src/auth/auth.service.ts#L290)), and a test **parses `m=`, `t=`, `p=`** out of both a dummy hash and a hash taken from the real registration path and asserts they agree ([auth.spec.ts:451](../apps/api/test/api/auth.spec.ts#L451)). Previously both call sites simply inherited library defaults — they agreed, but by coincidence rather than by construction, which is a drift vector regardless of whether the numbers match today.

---

## 8. What this does **not** prove

The strength of everything above is that each claim is scoped and backed by a live negative. That is worth nothing if the document then implies coverage that does not exist.

- **Bulk domain isolation is not yet proven.** `assets`, `readings`, `maintenance_records`, `asset_events` and `audit_log` do not exist yet — they land at step 6. The catalog-driven matrix is built and self-tested against a scratch table, but its fixture registry is empty today ([helpers.ts:157](../apps/api/test/db/helpers.ts#L157)), so it generates **zero cases** against real tables. It activates automatically when those tables arrive, and the registry/catalog equality check will fail the build if one arrives without a fixture. **Today, isolation is proven for the identity tables only.**
- **RBAC does not exist.** Decision B removed the app role's ability to write memberships, but the admin-checking definer functions that replace it are step 5. Until then there is **no invite, revoke or change-role path at all** — which is safe, but is absence rather than authorization. The step-5 gate requires live authorization negatives (a non-admin call rejected; an admin of A unable to touch B), not merely atomicity.
- **Audit logging does not exist.** It lands at step 7, and will need to **retrofit** the step-5 membership mutations rather than only wiring entities built after it — recorded as a known retrofit rather than a second silent gap.
- **Nothing here is proven against production.** All evidence is local and CI, both of which run the migration role as a cluster **superuser**. Render's is not, and a superuser satisfies `pg_has_role` unconditionally and bypasses RLS — so a class of privilege defect is invisible in both environments where the tests run. That gap is enumerated as a pre-deploy checklist ([ARCHITECTURE.md §16.1](ARCHITECTURE.md)), including the `Secure` cookie flag, which is gated on `NODE_ENV` and therefore **unverifiable by CI by construction**.
- **The interactive-transaction-per-request cost is priced, not eliminated.** Every authenticated request holds a transaction for its duration; under load, pool exhaustion presents as an apparent hang — rising latency with no error rate (ARCHITECTURE §16.2).
- **The generic matrix passing on `memberships` still means nothing.** That is why the bespoke dual-axis suite is mandatory and the exemption is declared rather than implicit.

---

## 9. Reproducing the evidence

```bash
cp .env.example .env      # then set SESSION_SECRET
docker compose up -d      # Postgres 16 + Redis 7
npm install && npm run db:migrate
npm run test              # 97 tests
```

**CI evidence — [run 34261795986](https://github.com/Braiden-07/MeterLog/actions/runs/34261795986), commit `ae42000`, verbatim:**

```
 ✓ test/api/auth.spec.ts (23 tests) 1235ms
 ✓ test/db/interceptor.spec.ts (15 tests) 391ms
 ✓ test/db/membership-isolation.spec.ts (23 tests) 241ms
 ✓ test/db/catalog-rls.spec.ts (12 tests) 105ms
 ✓ test/db/auth-definer.spec.ts (12 tests) 238ms
 ✓ test/db/isolation.spec.ts (6 tests) 201ms
 ✓ test/db/definer-probe.spec.ts (5 tests) 226ms
 ✓ src/health/health.controller.spec.ts (1 test) 2ms

 Test Files  8 passed (8)
      Tests  97 passed (97)
```

Each run builds the schema from migrations on a **fresh** database, so the policies under test are the ones the migrations produce, not ones a developer's database happened to accumulate. The suites connect as `meterlog_app` — the same restricted role the API uses at runtime — which is load-bearing: connecting as anything else would let every structural assertion pass while isolation was gone ([catalog-rls.spec.ts:210](../apps/api/test/db/catalog-rls.spec.ts#L210)).

The definer surface, read from the live catalog:

```
    function     |      owner       | secdef |             config              |                                  acl
-----------------+------------------+--------+---------------------------------+-----------------------------------------------------------------------
 login_lookup    | meterlog_definer | t      | search_path=pg_catalog, pg_temp | {meterlog_definer=X/meterlog_definer,meterlog_app=X/meterlog_definer}
 register_tenant | meterlog_definer | t      | search_path=pg_catalog, pg_temp | {meterlog_definer=X/meterlog_definer,meterlog_app=X/meterlog_definer}
```

Exactly two functions, both owned by the definer role, both with the path pinned, and **no `PUBLIC`** in either ACL — Postgres grants `EXECUTE` to `PUBLIC` by default, so that had to be revoked explicitly ([migration.sql:179-183](../apps/api/prisma/migrations/20260908000000_auth_definer_functions/migration.sql#L179-L183)). The allowlist is asserted against the catalog ([helpers.ts:81](../apps/api/test/db/helpers.ts#L81)), so a third cannot appear without a reviewed edit.

---

## 10. Further reading

- [`ADR-006-membership-model.md`](ADR-006-membership-model.md) — the membership model in full, its stage-1 review corrections, and the Phase-1 amendments (decision B, the `users` policy set).
- [`DECISIONS.md`](DECISIONS.md) — ADR-001…006, including ADR-004's operator amendment (§4 above).
- [`PROGRESS.md`](PROGRESS.md) — the phase-by-phase history, including how each finding was reached.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — §7 isolation, §8 sessions, §16 deployment topology and the pre-deploy checklist.
