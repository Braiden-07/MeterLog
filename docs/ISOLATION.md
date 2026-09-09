# ISOLATION.md — how MeterLog keeps tenants apart, and how that is proven

> The isolation and authentication narrative for MeterLog. Not a vulnerability-disclosure policy.
>
> **Every technical claim below carries a `file:line` citation into this repository, and every security property is backed by a negative — a rejected write, a zero-row read, a refused request — executed against a live PostgreSQL 16 instance.** Click any of them. A document that invites that check should read differently from one that asserts.
>
> **Status:** build-order steps 4 (auth + tenancy) and 5 (RBAC + membership management) complete. §9 states plainly what is _not_ yet proven — and step 5 made that section more important, not less.

---

## 1. The thesis

MeterLog is a multi-tenant SaaS whose isolation guarantee is enforced by PostgreSQL Row-Level Security rather than by application `WHERE` clauses. That much is unremarkable. What this document is actually about is a narrower claim:

**Six separate times, a defect survived design review, code review and a green test suite — and was caught only by running the thing against a real database.** Each one reviewed as correct. Each one would have shipped.

| #   | Step | Defect                                                                                                          | Why reading missed it                                                        |
| --- | ---- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | 4    | Dual-axis isolation: the generic test matrix _passes_ on `memberships` while exercising half the policy surface | A green test is indistinguishable from a covering test                       |
| 2   | 4    | `WHERE u.email = p_email` silently binding **case-sensitive** comparison under a pinned `search_path`           | The line is correct-looking, both operands are `citext`, and nothing errors  |
| 3   | 4    | A guard that fails closed on a fresh connection and **500s on a reused one**                                    | The two connection states differ, and tests land on the fresh one            |
| 4   | 4    | An app-side predicate whose absence is masked by a policy one join away                                         | The obvious test for it passes either way                                    |
| 5   | 5    | A lock-**order** bug invisible to the concurrency test written to catch the lock bug                            | The forced interleaving that proves one race structurally prevents the other |
| 6   | 5    | The RBAC gate could be **deleted with the entire endpoint suite still green**                                   | A correctly-redundant layer is invisible to tests that only assert outcomes  |

Findings 5 and 6 are not code defects — they are **proof** defects, which is the same class one level up. In both cases the security property held; what was broken was the evidence for it. That distinction is the subject of §8.

---

## 2. The model

`users` is pure identity — **no `tenant_id`**, globally unique email among live rows ([migration.sql:22-33](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L22-L33)). `memberships` is the join carrying `user_id`, `tenant_id` and `role` ([migration.sql:37-48](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L37-L48)). One person may hold memberships in many tenants; role is per-tenant, not per-person.

That choice is the whole point. The brief modelled one tenant per user, which makes "tenant A cannot see tenant B" only ever testable across _different_ users. The membership model turns the claim into the strictly stronger:

> **A user who is a member of both A and B, acting in A, cannot see B's rows — and cannot even assert B as active unless they hold a verified live membership in it.**

Three roles, none holding `BYPASSRLS` ([bootstrap:31-40](../apps/api/prisma/migrations/20260903000000_bootstrap_roles/migration.sql#L31-L40)): the migration/owner role, `meterlog_definer` (NOLOGIN, owns the definer functions), and `meterlog_app` (the runtime connection). All three identity tables carry `ENABLE` **and** `FORCE ROW LEVEL SECURITY` ([migration.sql:60-65](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L60-L65)) — `FORCE` matters because it subjects the table _owner_ to its own policies, which is what makes the definer pattern work through explicit policies rather than through a privilege bypass.

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

The project's generic isolation harness sets **only** `app.current_tenant` ([helpers.ts:179-193](../apps/api/test/db/helpers.ts#L179-L193)). Run against `memberships`, the self axis therefore never fires, the matrix sees A's rows and no B rows, and it **passes** — having exercised exactly half the policy surface. A green result there is evidence of nothing.

That is why `memberships` is registered in an explicit exempt-with-bespoke-handler set rather than being quietly absent ([helpers.ts:129](../apps/api/test/db/helpers.ts#L129)), and why the fixture-coverage check asserts registry/catalog equality **in both directions** so a new table cannot arrive without a fixture ([isolation.spec.ts:50-86](../apps/api/test/db/isolation.spec.ts#L50-L86)).

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

Every GUC reference uses `NULLIF(current_setting('app.<guc>', true), '')`. Both halves are load-bearing: without `, true` an unset GUC raises `unrecognized configuration parameter`; without the `NULLIF`, a **pooled** connection sees `''` and `''::uuid` raises `22P02`. Either way the request 500s instead of failing closed. Assertion 8 enforces the wrapper structurally on any `app.*` GUC in any policy ([catalog-rls.spec.ts:254](../apps/api/test/db/catalog-rls.spec.ts#L254)) — deliberately generalised from the single GUC it originally named, because the guard had the same blind spot as the bug it exists to catch.

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

**Step 5 is where that amendment earned its keep.** The three membership-write functions are schema-qualified on _every_ operator — `OPERATOR(public.=)` for citext, `OPERATOR(pg_catalog.=)` for uuid and enum — rather than only on the one comparison that had already burned the project. In `invite_member` the consequence of getting it wrong would have been subtler than the original: a case-different existing address would miss the lookup, the create branch would fire, and the case-**insensitive** unique index would refuse it — an invite that cannot succeed for a person who is already in the system.

### The guard split — stated so neither half is mistaken for the other

- The **loud** kind (an unqualified function or table reference failing to resolve) is caught structurally by definer-probe case E, and by catalog assertion 4 ([catalog-rls.spec.ts:108](../apps/api/test/db/catalog-rls.spec.ts#L108)).
- The **silent** kind is caught by exactly one thing: the behavioural test [`matches case-insensitively — regression guard, this was broken`](../apps/api/test/db/auth-definer.spec.ts#L223). No structural assertion can replace it, because at the catalog level the broken function and the correct one are **identical** — same owner, same `search_path`, same everything. That test is annotated as load-bearing and must not be deleted as redundant ([CLAUDE.md:50](../CLAUDE.md#L50)). Its step-5 counterpart is [`invite attaches a membership to an EXISTING identity, case-insensitively`](../apps/api/test/db/membership-writes.spec.ts#L752).

Assertion 4 was tightened at the same time from checking that a pin _exists_ to checking its _content_ — it previously accepted `search_path = public, pg_catalog, pg_temp`: pin present, hardening gone.

---

## 5. Finding 3 — the pooled-connection re-verify

### The mechanism

`SET LOCAL` is scoped to a transaction, and therefore to the one pooled connection that transaction holds. So every authenticated request runs inside one interactive transaction ([interceptor:97](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L97)), and the ordering inside it is **verify, then set**:

1. `SET LOCAL app.current_user` — always ([interceptor:101](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L101)).
2. Re-verify the claimed tenant, with the candidate passed as a **bound parameter, never read from a GUC** — reading it from a GUC would mean setting it first, which is the ordering this design exists to avoid ([interceptor:124-131](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L124-L131)).
3. Zero rows ⇒ **403**, the session's active tenant is cleared, and `app.current_tenant` is never assigned at any instant ([interceptor:134-142](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L134-L142)).
4. One row ⇒ set the tenant GUC and use the freshly-read role ([interceptor:145-150](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L145-L150)).

The guarantee is structural rather than sequential: there is no window, however brief, in which the tenant axis is live for a tenant the user may not hold. This is also what makes revocation take effect on the **next request** rather than at next login — and a role _change_ likewise.

### Why the easy test proves nothing

"Revocation fails closed" is trivially demonstrable on a fresh connection with no context set. That is not where the risk lives. The risk lives in **pooled connection statefulness**: `current_setting('app.x', true)` returns `NULL` on a connection that has never had the GUC set, but the **empty string** once `SET LOCAL` has touched it even once. A test that lets request 2 land on a fresh connection passes whether or not re-verification works.

So the suite pins the client to `connection_limit=1` ([interceptor.spec.ts:41](../apps/api/test/db/interceptor.spec.ts#L41)) **and asserts `pg_backend_pid()` is identical across the two requests** rather than assuming the pool obliged ([interceptor.spec.ts:248](../apps/api/test/db/interceptor.spec.ts#L248)). It further asserts no stale tenant survived on that connection ([interceptor.spec.ts:253](../apps/api/test/db/interceptor.spec.ts#L253)) — with `SET` instead of `SET LOCAL` that value persists and every subsequent query on the connection still sees the old tenant, which is the fail-open the whole ordering exists to prevent.

### Now driven by a real revoke

Through step 4, this property was proven against a hand-written `UPDATE ... SET deleted_at = now()` executed by the migration role — a fixture standing in for a feature that did not exist. Step 5 built the feature, so the proof now runs behind an actual `revoke_member` call, performed the way an admin performs it: over HTTP, through the RBAC gate, as the app role.

Captured live against the merged code, API pinned to a single connection:

```
=== REVOCATION ON THE NEXT REQUEST, driven by a REAL revoke_member ===
M request 1  GET /users        -> [200]
             backend pid(s)     : 3464
admin        DELETE /users/:id  -> [204]
             soft-deleted?      : deleted_at = 2026-09-09 20:55:21.055015+00  (row still present: 1)
M request 2  GET /users        -> {"error":{"code":"MEMBERSHIP_REVOKED", ... }} [403]
             backend pid(s)     : 3464
             SAME BACKEND       : yes (3464)
```

Three vacuity guards in that one result. The soft delete is **asserted**, so a revoke that silently no-ops cannot make the following 403 look like proof of anything. The row is asserted still present, because a hard delete would break re-invitation (§6d). And the backend pid is asserted **equal**, because on a fresh connection the 403 would be produced by a context that was never set rather than by re-verification.

There is a sharper detail: the admin's `DELETE` runs on that same single backend, **between** M's two requests. Request 2 therefore arrives on a connection whose last transaction belonged to a different user, in a different role, with that user's id left behind in the GUCs. If the re-verify ever read identity from the connection rather than from the session, this is the shape that would catch it.

Held by [`an admin revoking M over HTTP makes M's NEXT request fail closed, on the same backend`](../apps/api/test/api/revocation.spec.ts#L110), with [`M does not 403-loop: the cleared active tenant leaves an empty workspace list`](../apps/api/test/api/revocation.spec.ts#L173) and [`the revoking admin's own session is unaffected`](../apps/api/test/api/revocation.spec.ts#L208) — the last of which exists so the first two cannot pass by having broken the tenant for everyone.

Ordering itself is asserted on the **emitted SQL** via Prisma query events ([interceptor.spec.ts:379](../apps/api/test/db/interceptor.spec.ts#L379)), because the behavioural cases cannot separate the two orderings: both end in a 403 with a rolled-back transaction and no residue.

### The guard that was unreachable — and what was done about it

Mutation testing found that deleting the `NULLIF` from the re-verify reddened **nothing**. The interceptor sets `app.current_user` immediately beforehand, so `current_setting` always returned a valid uuid and the guard never fired. It was unreachable by construction, not unnecessary — with the guard, a misordered interceptor still throws `ForbiddenException`; without it, a `PrismaClientKnownRequestError`, i.e. a **500 instead of a fail-closed 403**.

Rather than record it as an untested guard, a reachable case was added: a session with a **blank** `userId` writes `''` into the GUC, which is exactly the state the guard exists for — a real poisoned-session state (a corrupted Redis value, or a future path that forgets to populate it), not a contrivance. [`a session with a BLANK user id fails closed with 403, not 500`](../apps/api/test/db/interceptor.spec.ts#L467).

**That test also demonstrates the whole thesis in miniature.** Under the mutation it **passes when run in isolation** — a fresh connection returns `NULL` — and fails only in a full-file run, once the connection has been reused. A per-test-isolation habit would have hidden it permanently. This is why `fileParallelism: false` ([vitest.config.ts:13](../apps/api/vitest.config.ts#L13)) is recorded as a **load-bearing invariant** rather than a performance setting, with the reproduction written down so nobody optimises it away ([CLAUDE.md:46-52](../CLAUDE.md#L46-L52)).

---

## 6. Finding 4 — decision B, and the predicate hidden behind a join

### 6a. The escalation the policy could not see

The tenant axis was originally `FOR ALL`, making it the app role's write path, with the admin-only check left to an RBAC guard scheduled for a later build step. Neither policy clause carries a role term, and `tenant_id` does not change during a role edit. Verified against a live database, a **technician** in tenant A ran:

```sql
UPDATE public.memberships SET role = 'admin' WHERE user_id = <self>
```

and got `UPDATE 1`, `role_now = admin`. Self-promotion to admin in one statement. The guard meant to stop it was a future artifact that did not exist — and "latent until then" is still exploitable.

**Decision B: `meterlog_app` becomes structurally incapable of writing `memberships`.** The axis became `FOR SELECT` (which carries no `WITH CHECK` at all), no app-role write policy replaced it, and the grant narrowed from `SELECT, INSERT, UPDATE` to `GRANT SELECT` ([migration.sql:180](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L180)). Membership writes moved to admin-checking `SECURITY DEFINER` functions, which step 5 built — §7.

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

Durability is asserted structurally, because a single stray `GRANT` would reopen the escalation with nothing else complaining: [`9. the app role holds no INSERT, UPDATE or DELETE on any identity table`](../apps/api/test/db/catalog-rls.spec.ts#L319), paired with assertion 10 so it cannot be satisfied by a table nobody can touch. That assertion still holds after step 5 — the app role gained no privilege on `memberships`; the definer did.

### 6c. What B moved, and the rule that follows

B closed the app-role write path — and in doing so **relocated the entire write-correctness burden into the definer function bodies**. Before B, the policy itself enforced tenant-scoping on every write, so even a buggy function body could not cross a tenant boundary. After B the only write path is the definer, whose policy is:

```sql
CREATE POLICY memberships_definer ON public.memberships
  FOR ALL TO meterlog_definer USING (true) WITH CHECK (true);
```

— [migration.sql:156-157](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L156-L157)

**That constrains nothing.** Tenant-scoping and the admin check are now both the function body's sole responsibility, with no database-layer backstop beneath them. The standing rule is recorded in ADR-006 §7 and DECISIONS.md: every definer write function acting for an authenticated caller must enforce, in its own body, that the caller is an admin of the active tenant _and_ that the target row belongs to it. `register_tenant` is the one exemption, and exempt for a reason rather than by oversight — it runs pre-auth and _creates_ the tenant it writes into, so caller-authorization there is undefined, not merely unnecessary.

§7 is that rule discharged.

### 6d. The OPEN-5 residual, and the predicate hidden behind a join

Liveness (`deleted_at IS NULL`) **cannot** live in the `memberships` row policies. Postgres applies a table's SELECT policy to the _new_ row of an `UPDATE … WHERE`, so a liveness predicate there blocks the revoking `UPDATE` itself — the predicate defeats the operation it exists to enforce. Splitting into `FOR SELECT` + `FOR UPDATE` does not help; the SELECT policy still bites.

So liveness lives in the paths that only ever read: the re-verify query ([interceptor:129](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L129)), the `tenants_workspace_list` subquery ([migration.sql:80-84](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L80-L84)), `users_tenant_members_read` ([migration.sql:98-103](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L98-L103)), and **one documented app-side predicate** ([auth.service.ts:246](../apps/api/src/auth/auth.service.ts#L246)).

The accepted residual — a raw self-axis read returns a revoked row — is itself asserted, so nobody "fixes" what cannot be fixed: [`the OPEN-5 residual is real: a self-axis read still returns the revoked row`](../apps/api/test/db/membership-isolation.spec.ts#L451).

_(Step 5 note: `revoke_member`'s soft-delete is unaffected by OPEN-5 for a stronger reason than the residual — it writes under the definer policy, which admits both the old and the new row version regardless.)_

**The app-side predicate is where finding 4 gets interesting.** Deleting it reddened nothing. The reason is subtle: the `JOIN` to `tenants` is filtered by `tenants_workspace_list`, which carries liveness _of its own_, so a workspace held **only** through a revoked membership is dropped by the join whether or not the predicate is there. The obvious revoked-workspace test proves nothing about it.

The reachable case is **re-invitation** — which the schema explicitly designs for. The unique index is _partial_:

```sql
CREATE UNIQUE INDEX memberships_user_tenant_live_key
  ON public.memberships (user_id, tenant_id) WHERE deleted_at IS NULL;
```

— [migration.sql:50-51](../apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql#L50-L51)

One **live** membership may therefore coexist with any number of revoked ones for the same tenant. The tenant is then visible through the live row, the join keeps **both**, and the workspace appears twice — the duplicate carrying whatever role the person held before removal. Someone revoked as admin and re-invited as auditor would be offered admin of a workspace they are an auditor in.

Held by [`a re-invited user sees one workspace, not their revoked membership as well`](../apps/api/test/api/auth.spec.ts#L534). Step 5 made re-invitation a real product path rather than a schema affordance: [`a revoked person can be re-invited to the same tenant`](../apps/api/test/db/membership-writes.spec.ts#L824).

---

## 7. Where decision B landed — the membership-write backstop

Step 5 discharged §6c's standing rule. Every membership write now goes through one of three `SECURITY DEFINER` functions — `invite_member` ([migration.sql:98](../apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql#L98)), `change_member_role` ([migration.sql:213](../apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql#L213)), `revoke_member` ([migration.sql:310](../apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql#L310)) — each enforcing, in its own body, that the caller is a live admin of the active tenant ([:237](../apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql#L237)) and that the target row belongs to that tenant. The acting identity is read from `app.current_user`, never from a parameter, so it cannot be forged by the caller.

The definer role gained exactly one new privilege for this — `GRANT UPDATE ON public.memberships` ([migration.sql:417](../apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql#L417)) — because a role change and a soft-delete revoke are both `UPDATE`s. **That is the moment B's grant-level backstop weakened by design**, and it is worth being explicit about what was lost: until then, catalog assertion 6 asserted the definer held _no_ `UPDATE` on any table, so a function body that tried to write one was unreachable no matter how wrong it was. The assertion was narrowed to an equality on the exact new shape rather than relaxed ([catalog-rls.spec.ts:191](../apps/api/test/db/catalog-rls.spec.ts#L191)) — `memberships:UPDATE` and nothing else, still no `UPDATE` on `users` or `tenants`, still no `DELETE`/`TRUNCATE`/`REFERENCES` anywhere.

### 7a. Proven with nothing in front of it

This is the part that matters, and it is a statement about **how** the evidence is produced rather than what it shows.

The functions are `EXECUTE`-able by `meterlog_app`. Anything holding that connection can call them directly — guard or no guard. So a negative produced through an HTTP endpoint would be proving the _guard_, and would leave decision B indistinguishable from the option it rejected (leave it to RBAC) while looking green. Every negative below is therefore produced by calling the function **as `meterlog_app`, over a plain connection, with the GUCs set by hand — no interceptor, no Nest, no HTTP.** Captured live:

```
=== BACKSTOP: called DIRECTLY as meterlog_app, GUCs set by hand, no HTTP, no guard ===

--- a TECHNICIAN of tenant A tries to promote themselves to admin ---
ERROR:  NOT_ADMIN
CONTEXT:  PL/pgSQL function public.change_member_role(uuid,public.membership_role) line 25 at RAISE

--- the ADMIN of A aims at a REAL, LIVE membership in tenant B ---
ERROR:  MEMBERSHIP_NOT_FOUND
CONTEXT:  PL/pgSQL function public.change_member_role(uuid,public.membership_role) line 51 at RAISE

--- no context at all / empty-string context (the pooled-connection value) ---
ERROR:  NOT_ADMIN
ERROR:  NOT_ADMIN
```

The first is §6a's escalation attempted through the only write path that still exists — and refused by the function body, with nothing above it. Held by [`change_member_role refuses a technician promoting THEMSELVES to admin`](../apps/api/test/db/membership-writes.spec.ts#L253), with the cross-tenant case at [`change_member_role: admin of A cannot demote B's admin`](../apps/api/test/db/membership-writes.spec.ts#L313) — whose target is asserted real and live first, so the negative cannot pass on a missed lookup ([:307](../apps/api/test/db/membership-writes.spec.ts#L307)).

The empty-string case is the §5 heisenbug again, and it is proven on a genuinely **reused** connection with `pg_backend_pid` asserted equal and the GUC asserted to have reverted to `''` ([`EMPTY-STRING arrives naturally on a REUSED connection, and still fails closed`](../apps/api/test/db/membership-writes.spec.ts#L380)).

Because this suite is now the only thing exercising the body checks with nothing in front, it is annotated load-bearing in the file and in the repo's test-suite invariants ([CLAUDE.md:53](../CLAUDE.md#L53)) — specifically against being "simplified" into HTTP tests later.

### 7b. The error codes are deliberately not the idiomatic ones

The three refusals raise custom SQLSTATEs — `MB001` NOT_ADMIN, `MB002` MEMBERSHIP_NOT_FOUND, `MB003` LAST_ADMIN ([migration.sql:32-38](../apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql#L32-L38)).

The obvious choice for the first is the standard `42501 insufficient_privilege`. It is the wrong choice, for a vacuity reason: **Postgres raises `42501` itself for a plain table-privilege denial**, so a test asserting it would pass just as happily against a misconfigured `GRANT` that never reached the function body at all — a green negative proving nothing, the same shape as the rolled-back wrapper in §8. The same argument rules out `P0002` (plpgsql raises it for `SELECT … INTO STRICT`) and `23514` (a real `CHECK`). A code nothing else in the cluster can raise makes each refusal unambiguously attributable to the body check it came from ([migration.sql:41](../apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql#L41)).

### 7c. Finding 5 — the last-admin guard, and two races that are not the same race

`change-role` and `revoke` introduced a lockout class the read-only design never had: an admin demoting or revoking themselves out of a tenant, leaving it with **zero admins** and unrecoverable through the app, since every membership write requires a live admin caller. ADR-006 was silent on it; the rule chosen is "refuse anything that would zero the tenant's live admins, permit hand-over-then-leave."

The guard is simpler than it looks, for a structural reason. Clause (a) requires the caller be a live admin, and the partial unique index permits at most one live membership per `(user, tenant)` — so if the target is an admin membership other than the caller's own, a second live admin exists by construction. **"Last admin" and "self-action on one's own admin membership" are the same condition**; there is no cross-user lockout case to defend against.

```
--- tenant A has exactly ONE admin. That admin demotes themselves. ---
ERROR:  MB003: LAST_ADMIN

--- hand over first: promote the technician, THEN self-revoke ---
 live_admins_left
                1
```

**Race one — the count.** Transactions run at READ COMMITTED, so a snapshot `count(*)` of live admins is wrong under concurrency: two admins each demoting themselves both read `count = 2`, both conclude another remains, and the tenant lands on zero with neither call erroring. The count is therefore taken over rows the transaction has **locked** ([migration.sql:255](../apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql#L255)), so the second blocks and — on READ COMMITTED's re-evaluation against the committed row version — no longer sees the first as an admin. Held by [`CONCURRENT: two last-two-admins self-demotions — one wins, one is refused`](../apps/api/test/db/membership-writes.spec.ts#L543), which **forces** the interleaving rather than hoping for it: T1 holds its locks uncommitted, T2 blocks, and a third connection asserts T2 is genuinely waiting on a `Lock` in `pg_stat_activity` before T1 is released.

**Race two — the order, and this is finding 5.** The admin set must be locked **before** the target row, `ORDER BY id`. Lock the target first — the natural way to write it — and two admins self-demoting each hold their own row and then reach for the other's: Postgres breaks the cycle with `40P01`, so the function fails with a deadlock instead of its own clean refusal.

That mutation was expected to redden the concurrency test above. **It passed.** The diagnosis is the finding:

> The forced interleaving is `T1 completes → T2 starts`. A deadlock requires both transactions to be holding their own target row **before** either scans the admin set — they must overlap _inside_ the statement. The determinism that makes that test a real proof of the count-race is exactly what makes it structurally blind to the ordering-race.

Two properties; the orchestration that proves one excludes the other. The fix was a second test that removes the orchestration entirely — both self-demotions fired simultaneously, autocommit, six rounds ([`UNFORCED CONCURRENCY: simultaneous self-demotions never deadlock — the lock ORDER`](../apps/api/test/db/membership-writes.spec.ts#L658)). Correct lock order makes a deadlock **impossible**, not merely unlikely, so the test cannot flake on correct code — a red is always a real defect. Against the flipped order it reddened on every run, naming `40P01` explicitly.

The generalisable lesson, and the reason this is in the document at all: **a deterministic test and a race test prove different things, and a single test cannot be both.**

### 7d. Finding 6 — the enumeration oracle, and the layer that was invisible

`MB002` covers **both** "no such membership" and "that membership exists, but belongs to another tenant" — one code, deliberately. Clause (b) already prevents writing across the boundary; what one code additionally prevents is _reading_. A caller who can tell the two apart can feed the endpoint well-formed uuids and have the status code answer "is this a real membership somewhere in this system?", one bit at a time, from any authenticated tenant admin. That is a cross-tenant fact the isolation model exists to keep unobservable, and no RLS policy can close it, because the leak is in the shape of the reply rather than in the data returned.

Live, over real HTTP, an admin of Acme probing:

```
=== ENUMERATION ORACLE, over HTTP: admin of Acme probing ===
PATCH a REAL membership in Beta      -> {"error":{"code":"MEMBERSHIP_NOT_FOUND", ...}} [404]
PATCH a uuid that does not exist     -> {"error":{"code":"MEMBERSHIP_NOT_FOUND", ...}} [404]

Beta unchanged:
admin@beta.test = admin
```

Byte-identical. Recorded in ADR-006 §7 as a design rule with the refactor that would reopen it named explicitly ([ADR-006:291](ADR-006-membership-model.md#L291)) — a "make the error messages more helpful" pass that splits them into `403` when the caller is not an admin of the target's tenant and `404` when the row is absent. That reads as better API design, reviews as a usability fix, and **the distinction it adds _is_ the oracle**. Held by [`a nonexistent-but-well-formed membership id is indistinguishable from B's`](../apps/api/test/api/memberships.spec.ts#L390), and by a mutation in the step-5 sweep that performs exactly that split and must redden a test — because an anti-enumeration claim with no negative behind it is not a claim this project ships.

**Finding 6 proper is about the layer above.** The HTTP write endpoints are admin-gated by `@RequiresRole('admin')` ([controller:60](../apps/api/src/memberships/memberships.controller.ts#L60)), enforced inside the interceptor at the point where the role has already been re-read from the database ([interceptor:153-182](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L153-L182)) — never in a `CanActivate` guard, because Nest runs guards _before_ interceptors. That was measured rather than assumed: such a guard, wired to a real route, **500s every request including the admin's**, because at guard time no request has a resolved context at all ([requires-role.decorator.ts:21](../apps/api/src/common/auth/requires-role.decorator.ts#L21)).

```
=== THE OUTER LAYER: the RBAC gate refuses the technician ===
POST   /users        -> {"error":{"code":"FORBIDDEN_ROLE", ...}} [403]
PATCH  /users/:id    -> {"error":{"code":"FORBIDDEN_ROLE", ...}} [403]
DELETE /users/:id    -> {"error":{"code":"FORBIDDEN_ROLE", ...}} [403]
GET    /users        -> [200] (read is deliberately NOT gated)
```

The `GET` is not an oversight — co-member reads stay open to every member by decision (§3), and its presence here is a vacuity guard: without it, the three 403s could be passing because the controller was unreachable rather than because writes are gated.

**And then removing the gate entirely left the whole endpoint suite green.** The definer body refused the same callers, `MB001` mapped to a 403, and the response was byte-identical — so nothing could tell which layer had acted. That is defence-in-depth working exactly as intended and the outer layer being completely untested, and they are the _same fact_: **a correctly-redundant layer is invisible to tests that only assert outcomes.**

The fix was to make the layers distinguishable rather than to weaken either: the gate answers `FORBIDDEN_ROLE`, the function body answers `NOT_ADMIN` ([memberships.service.ts:210](../apps/api/src/memberships/memberships.service.ts#L210)), both `403`. Deleting the gate now reddens three tests with `expected 'NOT_ADMIN' to be 'FORBIDDEN_ROLE'`. The reasoning is recorded next to the code so a future tidy-up does not re-merge them ([memberships.service.ts:174](../apps/api/src/memberships/memberships.service.ts#L174)).

There is an operational payoff beyond the test: `NOT_ADMIN` reaching a client now means a request **got past the gate and was stopped by the database** — either the caller's role changed between the interceptor's read and the function's, or a route is missing its gate. That is a distinction worth having in a log.

---

## 8. Method — why the evidence is shaped the way it is

The findings above share a cause: **a test that passes is not the same as a test that covers.** Several practices exist specifically to close that gap.

**Every security claim carries its negative.** The rejected write, the zero-row read, the refused request. A positive alone cannot distinguish "the boundary held" from "the boundary was never reached".

**Vacuity guards on the guards.** Atomicity is asserted in **autocommit**, because a rolled-back wrapper would leave no orphan whether the function is atomic or not ([auth-definer.spec.ts:130](../apps/api/test/db/auth-definer.spec.ts#L130), [:158](../apps/api/test/db/auth-definer.spec.ts#L158)) — and step 5's invite atomicity test sets its GUCs at _session_ scope precisely so it can run without that wrapper ([membership-writes.spec.ts:426](../apps/api/test/db/membership-writes.spec.ts#L426)). The orphan check runs as the **migration** role, because `tenants` is under FORCE RLS and asking the app role would return zero rows regardless — a guaranteed green proving nothing. The Redis logout check asserts the key is **present before** as well as absent after, because otherwise a mistyped key prefix would masquerade as a clean logout ([auth.spec.ts:183](../apps/api/test/api/auth.spec.ts#L183)).

**Boundaries proven semantically, not syntactically.** The unauthorized-switch test targets a **real, existent tenant with a membership belonging to someone else** ([auth.spec.ts:287](../apps/api/test/api/auth.spec.ts#L287)); the cross-tenant membership-write tests target a real, live membership asserted present first. A malformed uuid would prove only that DTO validation runs.

**Mutation testing across every phase.** Each `USING`/`WITH CHECK` predicate, each `NULLIF`, each liveness clause, each body-level check and each structural guard was dropped in turn and required to redden at least one test. Anything that reddened nothing was flagged and then either made reachable — the `NULLIF` in §5, the app-side predicate in §6d, the lock order in §7c, the RBAC gate in §7d — or classified honestly:

> Reverting the argon2 dummy hash to an options-free call reddens nothing — and correctly so. Library defaults currently equal the declared parameters, making it a **behaviourally equivalent mutant**, not an untested guard.

That distinction matters: an equivalent mutant is not a coverage hole, and pretending otherwise by contriving a test would be exactly the dishonesty the rest of the discipline exists to prevent. It is also why the two step-5 escapers were _not_ classified that way — both were real defects that no existing test could see.

**Two defects were found by building, and are recorded rather than quietly fixed.** A protected route with no session returned **500 instead of 401** — the right refusal for the wrong reason — and the first version of the test _asserted the 500_, documenting the defect instead of catching it. The obvious fix made it worse: a `CanActivate` guard rejected **every** request, because Nest runs guards _before_ interceptors, so the guard could not see a context the interceptor had not yet established. Found empirically, not by reasoning. The resolution puts the _declaration_ at the route as metadata and keeps the single _enforcement_ point inside the interceptor that already resolved the session ([requires-session.decorator.ts](../apps/api/src/common/auth/requires-session.decorator.ts), [interceptor:74-95](../apps/api/src/common/tenant-context/tenant-context.interceptor.ts#L74-L95)). Step 5's role gate follows the identical shape for the identical reason ([requires-role.decorator.ts:50](../apps/api/src/common/auth/requires-role.decorator.ts#L50)) — and the hazard was re-measured rather than inherited on faith.

**Timing as a boundary.** The no-such-user login branch performs a real argon2 verify so it costs what the wrong-password branch costs. The dummy hash is derived from the same exported parameters production uses ([auth.service.ts:52](../apps/api/src/auth/auth.service.ts#L52), [:290](../apps/api/src/auth/auth.service.ts#L290)), and a test **parses `m=`, `t=`, `p=`** out of both a dummy hash and a hash taken from the real registration path and asserts they agree ([auth.spec.ts:451](../apps/api/test/api/auth.spec.ts#L451)). Previously both call sites simply inherited library defaults — they agreed, but by coincidence rather than by construction, which is a drift vector regardless of whether the numbers match today. The same rule governs the sentinel hash step 5's invite writes for a new identity: derived from those parameters, never a literal, and asserted by parsing them back out ([membership-writes.spec.ts:784](../apps/api/test/db/membership-writes.spec.ts#L784)).

---

## 9. What this does **not** prove

The strength of everything above is that each claim is scoped and backed by a live negative. That is worth nothing if the document then implies coverage that does not exist. **Step 5 gave this document more to sell, which is exactly when this section matters most — it has not been shortened to make room.**

- **Bulk domain isolation is still not proven, and step 5 did not move it.** `assets`, `readings`, `maintenance_records`, `asset_events` and `audit_log` do not exist — they land at step 6. The catalog-driven matrix is built and self-tested against a scratch table, but its fixture registry is **still empty** ([helpers.ts:176](../apps/api/test/db/helpers.ts#L176)), so it generates **zero cases against real tables**. It activates automatically when those tables arrive, and the registry/catalog equality check will fail the build if one arrives without a fixture. **Today, isolation is proven for the identity and tenancy tables only.** "RBAC and membership management landed" says nothing whatever about domain-level coverage.
- **The generic matrix passing on `memberships` still means nothing.** That is why the bespoke dual-axis suite is mandatory and the exemption is declared rather than implicit.
- **Invited users cannot log in yet.** `invite_member` creates an identity whose password hash is a sentinel that matches nothing, so an invited person can neither sign in nor register their own organisation (the email is taken). This is a **known, scheduled, temporary** state, not a hidden one: the set-password / invite-token flow is the first slice of step 8, with a hard deadline of step 10 (before deploy, the only people it can lock out are test fixtures), and it is enforced by a Definition-of-Done checkbox rather than by a comment ([PROJECT_BRIEF.md:266](PROJECT_BRIEF.md#L266)) because markers drift and checklists block. Reasoning in [DECISIONS.md:269](DECISIONS.md#L269).
- **Audit logging does not exist.** It lands at step 7 — and the membership mutations built in step 5 write **no `audit_log` row at all**. Step 7 must go back and **retrofit** them rather than only wiring entities built after it; that is also where the open question of recording role-at-time-of-action is answered. Recorded as a known retrofit rather than a second silent gap.
- **Nothing here is proven against production.** All evidence is local and CI, both of which run the migration role as a cluster **superuser**. Render's is not, and a superuser satisfies `pg_has_role` unconditionally and bypasses RLS — so a class of privilege defect is invisible in both environments where the tests run. That gap is enumerated as a pre-deploy checklist ([ARCHITECTURE.md §16.1](ARCHITECTURE.md)), including the `Secure` cookie flag, which is gated on `NODE_ENV` and therefore **unverifiable by CI by construction**.
- **The interactive-transaction-per-request cost is priced, not eliminated.** Every authenticated request holds a transaction for its duration; under load, pool exhaustion presents as an apparent hang — rising latency with no error rate (ARCHITECTURE §16.2).

---

## 10. Reproducing the evidence

```bash
cp .env.example .env      # then set SESSION_SECRET
docker compose up -d      # Postgres 16 + Redis 7
npm install && npm run db:migrate
npm run test              # 150 tests
```

**CI evidence — [run 34401848080](https://github.com/Braiden-07/MeterLog/actions/runs/34401848080), `main` at commit `52d0d51`, verbatim:**

```
 ✓ test/db/membership-writes.spec.ts (31 tests) 811ms
 ✓ test/api/auth.spec.ts (23 tests) 1198ms
 ✓ test/db/interceptor.spec.ts (15 tests) 380ms
 ✓ test/api/memberships.spec.ts (19 tests) 1564ms
 ✓ test/db/membership-isolation.spec.ts (23 tests) 237ms
 ✓ test/db/catalog-rls.spec.ts (12 tests) 99ms
 ✓ test/db/auth-definer.spec.ts (12 tests) 237ms
 ✓ test/api/revocation.spec.ts (3 tests) 532ms
 ✓ test/db/isolation.spec.ts (6 tests) 193ms
 ✓ test/db/definer-probe.spec.ts (5 tests) 219ms
 ✓ src/health/health.controller.spec.ts (1 test) 2ms

 Test Files  11 passed (11)
      Tests  150 passed (150)
```

The first line is the §7a backstop suite — the one that calls the definer functions directly, with no HTTP anywhere in the process.

Each run builds the schema from migrations on a **fresh** database, so the policies under test are the ones the migrations produce, not ones a developer's database happened to accumulate. The suites connect as `meterlog_app` — the same restricted role the API uses at runtime — which is load-bearing: connecting as anything else would let every structural assertion pass while isolation was gone ([catalog-rls.spec.ts:230](../apps/api/test/db/catalog-rls.spec.ts#L230)).

The definer surface, read from the live catalog:

```
      function      |      owner       | secdef |             config              | public_execute
--------------------+------------------+--------+---------------------------------+----------------
 change_member_role | meterlog_definer | t      | search_path=pg_catalog, pg_temp | f
 invite_member      | meterlog_definer | t      | search_path=pg_catalog, pg_temp | f
 login_lookup       | meterlog_definer | t      | search_path=pg_catalog, pg_temp | f
 register_tenant    | meterlog_definer | t      | search_path=pg_catalog, pg_temp | f
 revoke_member      | meterlog_definer | t      | search_path=pg_catalog, pg_temp | f
```

Five functions — the two pre-auth ones from step 4 and the three membership writers from step 5 — all owned by the definer role, all with the path pinned, and **none executable by `PUBLIC`**: Postgres grants `EXECUTE` to `PUBLIC` by default, so that had to be revoked explicitly ([migration.sql:179-183](../apps/api/prisma/migrations/20260908000000_auth_definer_functions/migration.sql#L179-L183)). The allowlist is asserted against the catalog ([helpers.ts:94](../apps/api/test/db/helpers.ts#L94)), so a sixth cannot appear without a reviewed edit.

---

## 11. Further reading

- [`ADR-006-membership-model.md`](ADR-006-membership-model.md) — the membership model in full, its stage-1 review corrections, and five amendments: the `users` policy set and decision B (step 4), the last-admin rule and the invite credential mechanism (step 5 phase 1), and the anti-enumeration shape of `MB002` (step 5 phase 2).
- [`DECISIONS.md`](DECISIONS.md) — ADR-001…006, including ADR-004's operator amendment (§4 above) and the step-5 closeout scheduling.
- [`PROGRESS.md`](PROGRESS.md) — the phase-by-phase history, including how each finding was reached and the two forward debts step 5 leaves behind.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — §7 isolation, §8 sessions, §9 the RBAC matrix, §16 deployment topology and the pre-deploy checklist.
