# MeterLog

Multi-tenant SaaS for tracking physical assets — utility meters, equipment — through their lifecycle, with role-based access and a full audit trail. Operations managers get oversight, field technicians record readings and maintenance, auditors get read-only history.

Tenant isolation is enforced by **PostgreSQL Row-Level Security**, not by application `WHERE` clauses, under a **membership model**: a person is not a property of a tenant. One user can hold memberships in several tenants with a different role in each, and the isolation guarantee has to hold even for that user.

**Status: build-order step 4 of 11 complete** (auth + tenancy foundation); **step 5 (RBAC) in progress — phases 1 and 2 of 3**: the membership-write definer functions with their authorization enforced _in the database_, and the RBAC guard and role-gated endpoints on top of them. 146 tests green in CI. The cross-layer mutation sweep is the rest of step 5, the domain entities are step 6, and nothing is deployed yet — see [what is not yet proven](docs/ISOLATION.md#8-what-this-does-not-prove).

---

## What this repository demonstrates

The interesting part is not that RLS is used. It is that **four times during step 4, a defect survived design review, code review and a green test suite, and was caught only by running against a live database.** Each is written up in full, with its mechanism, the code as it stands, and the live-database negative that holds it:

- **Dual-axis membership isolation** — a user in tenants A and B, acting in A, sees A's rows and their own B-membership, never another user's rows in B. The generic test matrix _passes_ on this table while exercising half the policy surface. → [ISOLATION.md §3](docs/ISOLATION.md#3-finding-1--dual-axis-isolation-and-the-test-that-passes-for-the-wrong-reason)
- **A silent account lockout from operator resolution** — `WHERE u.email = p_email` binding case-**sensitive** comparison under a pinned `search_path`, while the unique index stayed case-insensitive. → [ISOLATION.md §4](docs/ISOLATION.md#4-finding-2--the-citext-lockout-when-fails-loud-quietly-isnt)
- **Revocation on the next request, across a reused pooled connection** — the case where a stale-but-non-empty GUC survives, not the easy unset-context one. → [ISOLATION.md §5](docs/ISOLATION.md#5-finding-3--the-pooled-connection-re-verify)
- **An intra-tenant privilege escalation, and the predicate hidden behind a join** — a technician self-promoting to admin in one statement, and a liveness predicate whose absence is masked by a policy one join away. → [ISOLATION.md §6](docs/ISOLATION.md#6-finding-4--decision-b-and-the-predicate-hidden-behind-a-join)

**→ [`docs/ISOLATION.md`](docs/ISOLATION.md) is the full technical story.** Every claim in it carries a `file:line` citation, and every security property is backed by a negative — a rejected write, a zero-row read, a refused request — quoted as real database output.

## Where the security lives, in code

| Concern                                                                 | File                                                                                                                                      |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| RLS policies, grants, the three-role model                              | [`20260907000000_identity_tenancy_schema/migration.sql`](apps/api/prisma/migrations/20260907000000_identity_tenancy_schema/migration.sql) |
| Pre-auth `SECURITY DEFINER` surface (`login_lookup`, `register_tenant`) | [`20260908000000_auth_definer_functions/migration.sql`](apps/api/prisma/migrations/20260908000000_auth_definer_functions/migration.sql)   |
| Two-GUC request interceptor, verify-before-set                          | [`tenant-context.interceptor.ts`](apps/api/src/common/tenant-context/tenant-context.interceptor.ts)                                       |
| The dual-axis isolation proof                                           | [`membership-isolation.spec.ts`](apps/api/test/db/membership-isolation.spec.ts)                                                           |
| Catalog-level coverage assertions (12)                                  | [`catalog-rls.spec.ts`](apps/api/test/db/catalog-rls.spec.ts)                                                                             |
| Step-4 acceptance, real HTTP + real cookies                             | [`auth.spec.ts`](apps/api/test/api/auth.spec.ts)                                                                                          |

## Stack

TypeScript throughout. **API:** NestJS, REST under `/api/v1`, Prisma, PostgreSQL 16 with RLS, Redis-backed sessions, argon2id password hashing. **Web:** Next.js App Router, Tailwind, TanStack Query — skeleton only until step 8. **CI:** GitHub Actions — lint, typecheck, the full suite against real Postgres and Redis services, build. `main` is protected: PR required, CI required, no direct pushes.

## Running it

```bash
cp .env.example .env      # then set SESSION_SECRET
docker compose up -d      # Postgres 16 + Redis 7
npm install
npm run db:migrate
npm run test              # 146 tests, including every DB suite
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
