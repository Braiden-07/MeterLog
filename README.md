# MeterLog

Multi-tenant SaaS for tracking physical assets — utility meters, equipment — through their lifecycle, with role-based access and a full audit trail. Operations managers get oversight, field technicians record readings and maintenance, auditors get read-only history.

Tenant isolation is enforced by **PostgreSQL Row-Level Security**, not by application `WHERE` clauses, under a **membership model**: a person is not a property of a tenant. One user can hold memberships in several tenants with a different role in each, and the isolation guarantee has to hold even for that user.

**Status: build-order step 6 of 11 complete** — auth + tenancy (step 4), RBAC + admin membership management (step 5), and the full v1.0 domain surface: `assets` with all three children `asset_events`, `readings` and `maintenance_records`. A cursor-paginated REST API, a lifecycle transition engine, and tenant isolation proven **end to end over HTTP, across all four tables, for a user who legitimately holds both tenants**. 299 tests green in CI.

**What that does not cover.** The four domain tables are built; **`audit_log` — the brief's fifth table — is not, and the lifecycle event log is not an audit trail**. `maintenance_records` is **soft-delete only**: the app role holds no `DELETE` privilege, so v1.0 cannot destroy a maintenance record, and hard delete is deliberately deferred until after the audit module so no destructive operation predates the trail that would make it accountable. **There is no audit trail yet** — and the lifecycle event log is not one: `asset_events` records what happened to a physical asset, `audit_log` records who changed which record, and neither derives from the other. Ten mutation types now await that retrofit at step 7 — and a maintenance edit is the sharpest case, because it emits no lifecycle event at all, so `audit_log` would be its only record. Invited users still cannot log in until the set-password flow lands (step 8, deadlined step 10, tracked by a blocking Definition-of-Done checkbox). The API is proven by acceptance tests, not by use: no frontend consumes it, no load test has run. Nothing is deployed. → [what is not yet proven](docs/ISOLATION.md#9-what-this-does-not-prove), kept aligned with the enumerated [open items register](docs/DECISIONS.md).

---

## What this repository demonstrates

The interesting part is not that RLS is used. It is that **seven times, something survived design review, code review and a green test suite, and was caught only by running against a live database.** Five were defects in the code. Two were defects in the _proof_ — the code was right and the evidence for it was blind. Each is written up in full, with its mechanism, the code as it stands, and the live-database negative that holds it:

- **Dual-axis membership isolation** — a user in tenants A and B, acting in A, sees A's rows and their own B-membership, never another user's rows in B. The generic test matrix _passes_ on this table while exercising half the policy surface. → [ISOLATION.md §3](docs/ISOLATION.md#3-finding-1--dual-axis-isolation-and-the-test-that-passes-for-the-wrong-reason)
- **A silent account lockout from operator resolution** — `WHERE u.email = p_email` binding case-**sensitive** comparison under a pinned `search_path`, while the unique index stayed case-insensitive. → [ISOLATION.md §4](docs/ISOLATION.md#4-finding-2--the-citext-lockout-when-fails-loud-quietly-isnt)
- **Revocation on the next request, across a reused pooled connection** — the case where a stale-but-non-empty GUC survives, not the easy unset-context one; now driven by a real revoke through the API. → [ISOLATION.md §5](docs/ISOLATION.md#5-finding-3--the-pooled-connection-re-verify)
- **An intra-tenant privilege escalation, and the predicate hidden behind a join** — a technician self-promoting to admin in one statement, and a liveness predicate whose absence is masked by a policy one join away. → [ISOLATION.md §6](docs/ISOLATION.md#6-finding-4--decision-b-and-the-predicate-hidden-behind-a-join)
- **Membership writes authorized inside the database, proven with nothing in front** — the authorization lives in `SECURITY DEFINER` function bodies, so the negatives are produced by calling them directly, with no HTTP guard above them. → [ISOLATION.md §7](docs/ISOLATION.md#7-where-decision-b-landed--the-membership-write-backstop)
- **A concurrency test blind to a second race in the same function** — the forced interleaving that proves the counting race structurally prevents the lock-ordering deadlock it was assumed to also cover. → [ISOLATION.md §7c](docs/ISOLATION.md#7c-finding-5--the-last-admin-guard-and-two-races-that-are-not-the-same-race)
- **An authorization layer that could be deleted with every test still green** — the database refused the same callers identically, so a correctly-redundant layer was invisible to outcome-only tests. → [ISOLATION.md §7d](docs/ISOLATION.md#7d-finding-6--the-enumeration-oracle-and-the-layer-that-was-invisible)
- **Tenant isolation proven over HTTP against the hardest case — a user who is an _admin of both tenants_** — acting in one, every verb against the other returns **404, not 403**. The distinction is the property: a 403 would mean "you lack permission", which is false and would confirm the row exists; the 404 means the row is not in the request's universe at all. Switching tenants on the same cookie flips the whole surface. → [ISOLATION.md §7f](docs/ISOLATION.md#7f-finding-8--the-domain-surface-and-the-trap-a-design-choice-closed-instead-of-a-test)
- **A classic lifecycle bug made _unrepresentable_ rather than merely tested for** — two different transitions land on the same status, so the natural "new status → event type" lookup has two answers for one key and must silently pick one. Keying the graph on the transition instead leaves nowhere to put that map. Applying it as a mutation reddened **exactly one** test, with every status assertion, the event count and the log replay still green. → [ISOLATION.md §7f](docs/ISOLATION.md#7f-finding-8--the-domain-surface-and-the-trap-a-design-choice-closed-instead-of-a-test)
- **Child-table tenancy enforced by a constraint, not by application care** — children denormalize `tenant_id` so no policy needs a subquery, and **RLS cannot see the two halves disagreeing**. A composite foreign key makes the mismatch unrepresentable, including against a privileged connection RLS does not filter. → [ISOLATION.md §7f](docs/ISOLATION.md#7f-finding-8--the-domain-surface-and-the-trap-a-design-choice-closed-instead-of-a-test)
- **A keyset cursor that silently lost rows** — a JS `Date` truncates a Postgres microsecond, so the cursor pointed earlier than its own row and every row sharing that millisecond was skipped. It passed its own phase's seven-mutation sweep, because those fixtures used whole-second timestamps; the next phase's real `now()` data exposed it. → [ISOLATION.md §7e](docs/ISOLATION.md#7e-finding-7--the-cursor-that-lost-rows-found-by-the-phase-after-the-one-that-shipped-it)
- **A delete policy encoded as a _missing privilege_ rather than a promise** — `maintenance_records` is soft-delete only for v1.0, and that is true exactly as long as the `DELETE` grant is absent, so the absence is demonstrated (`permission denied for table maintenance_records`) and pinned as a grant-set _equality_ in CI. One `GRANT DELETE` would make v1.0 destructive two steps before anything could record what was destroyed; it reddens three tests. Hard delete is deferred behind audit, not refused. → [ISOLATION.md §7g](docs/ISOLATION.md#7g-finding-9--the-mutable-table-and-a-decision-encoded-as-a-missing-privilege)
- **The same blind spot twice, caught the second time by the sweep** — Finding 7's lesson was applied to the new list endpoint from day one, and restoring the bug as a mutation still reddened **nothing**: the new tests' fixtures used whole-millisecond timestamps, where truncating microseconds is lossless. A test written "for the lesson" does not test the lesson if its fixtures cannot express the failure. → [ISOLATION.md §7g](docs/ISOLATION.md#7g-finding-9--the-mutable-table-and-a-decision-encoded-as-a-missing-privilege)

**→ [`docs/ISOLATION.md`](docs/ISOLATION.md) is the full technical story.** Every claim in it carries a `file:line` citation, and every security property is backed by a negative — a rejected write, a zero-row read, a refused request — quoted as real database output.

## Where the security lives, in code

| Concern                                                                 | File                                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RLS policies, grants, the three-role model                              | [`20260907000000_identity_tenancy_schema/migration.sql`](apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql)                     |
| Pre-auth `SECURITY DEFINER` surface (`login_lookup`, `register_tenant`) | [`20260908000000_auth_definer_functions/migration.sql`](apps/api/prisma/migrations/20260908000000_auth_definer_functions/migration.sql)                       |
| Membership-write functions with in-body authorization                   | [`20260909000000_membership_write_functions/migration.sql`](apps/api/prisma/migrations/20260909000000_membership_write_functions/migration.sql)               |
| That authorization proven by direct calls, no HTTP in the process       | [`membership-writes.spec.ts`](apps/api/test/db/membership-writes.spec.ts)                                                                                     |
| Two-GUC request interceptor, verify-before-set                          | [`tenant-context.interceptor.ts`](apps/api/src/common/tenant-context/tenant-context.interceptor.ts)                                                           |
| The dual-axis isolation proof                                           | [`membership-isolation.spec.ts`](apps/api/test/db/membership-isolation.spec.ts)                                                                               |
| Catalog-level coverage assertions (13)                                  | [`catalog-rls.spec.ts`](apps/api/test/db/catalog-rls.spec.ts)                                                                                                 |
| Auth acceptance, real HTTP + real cookies                               | [`auth.spec.ts`](apps/api/test/api/auth.spec.ts)                                                                                                              |
| RBAC gate + role-gated endpoints over real HTTP                         | [`memberships.spec.ts`](apps/api/test/api/memberships.spec.ts)                                                                                                |
| Domain tables: `assets` + `asset_events`, RLS, the composite FK         | [`20260910000000_domain_assets_asset_events/migration.sql`](apps/api/prisma/migrations/20260910000000_domain_assets_asset_events/migration.sql)               |
| `readings`, append-only, second composite-FK child                      | [`20260911000000_domain_readings/migration.sql`](apps/api/prisma/migrations/20260911000000_domain_readings/migration.sql)                                     |
| The decommission biconditional, enforced as a DB `CHECK`                | [`20260912000000_assets_decommission_biconditional/migration.sql`](apps/api/prisma/migrations/20260912000000_assets_decommission_biconditional/migration.sql) |
| The lifecycle graph — keyed on the transition, never on the status      | [`lifecycle.ts`](apps/api/src/assets/lifecycle.ts)                                                                                                            |
| **The §8.3 capstone** — admin of both tenants, full verb matrix, 404s   | [`step6-acceptance.spec.ts`](apps/api/test/api/step6-acceptance.spec.ts)                                                                                      |
| The catalog-driven isolation matrix (15 generated domain cases)         | [`isolation.spec.ts`](apps/api/test/db/isolation.spec.ts)                                                                                                     |
| The naive-map killer + the log-replay reconciliation                    | [`assets-transitions.spec.ts`](apps/api/test/api/assets-transitions.spec.ts)                                                                                  |
| No endpoint may mutate an append-only resource                          | [`route-inventory.spec.ts`](apps/api/test/api/route-inventory.spec.ts)                                                                                        |
| `maintenance_records` — the mutable child, soft-delete only             | [`20260913000000_domain_maintenance_records/migration.sql`](apps/api/prisma/migrations/20260913000000_domain_maintenance_records/migration.sql)               |
| Its full CRUD-with-soft-delete surface over real HTTP                   | [`maintenance.spec.ts`](apps/api/test/api/maintenance.spec.ts)                                                                                                |
| Measured index decisions, before/after `EXPLAIN ANALYZE`                | [`PERF.md`](docs/PERF.md)                                                                                                                                     |

## Stack

TypeScript throughout. **API:** NestJS, REST under `/api/v1`, Prisma, PostgreSQL 16 with RLS, Redis-backed sessions, argon2id password hashing. **Web:** Next.js App Router, Tailwind, TanStack Query — skeleton only until step 8. **CI:** GitHub Actions — lint, typecheck, the full suite against real Postgres and Redis services, build. `main` is protected: PR required, CI required, no direct pushes.

## Running it

```bash
cp .env.example .env      # then set SESSION_SECRET
docker compose up -d      # Postgres 16 + Redis 7
npm install
npm run db:migrate
npm run test              # 299 tests, including every DB suite
npm run dev
```

Two database roles, two URLs (ADR-004): `MIGRATION_DATABASE_URL` owns the schema; `DATABASE_URL` is the restricted runtime role that RLS applies to in full. Pointing the second at the first disables tenant isolation while every structural test still passes — which is itself asserted against.

## Documentation

|                                                                        |                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`docs/ISOLATION.md`](docs/ISOLATION.md)                               | **Start here.** Isolation and auth security narrative, fully cited. |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)                               | ADR-001…006 with their amendments.                                  |
| [`docs/ADR-006-membership-model.md`](docs/ADR-006-membership-model.md) | The membership model in full.                                       |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                         | Modules, data model, RLS design, deployment topology.               |
| [`docs/PROGRESS.md`](docs/PROGRESS.md)                                 | Phase-by-phase build log — how each finding was actually reached.   |
| [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md)                       | Scope and build order.                                              |

Project 1 of a 10-project portfolio. The goal is production practice — multi-tenancy, RBAC, audit, testing, CI/CD — rather than feature count.
