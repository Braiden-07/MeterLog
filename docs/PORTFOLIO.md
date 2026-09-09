# MeterLog — multi-tenant isolation, proven rather than asserted

**A multi-tenant SaaS backend where tenant isolation is enforced by PostgreSQL Row-Level Security, built to a standard I set deliberately: no security claim ships without a live-database negative behind it.** That standard paid for itself four times. On four separate occasions a defect passed design review, passed code review, and passed a green test suite — and was caught only by running the thing against a real database. One of them was a silent, unrecoverable account lockout. Another was a privilege escalation that let a technician make themselves an admin in a single SQL statement. Both looked correct on the page.

The finished write-up is [`docs/ISOLATION.md`](https://github.com/Braiden-07/MeterLog/blob/main/docs/ISOLATION.md), where every technical claim carries a `file:line` link into the repository and every security property is backed by a rejected write, a zero-row read, or a refused request quoted as real output.

**Stack:** TypeScript · NestJS · PostgreSQL 16 (Row-Level Security) · Prisma · Redis · Next.js · GitHub Actions
**State:** build-order step 4 of 11 complete — auth and tenancy foundation. 97 tests green in CI. Not yet deployed.

---

## The problem I chose to make harder

The obvious multi-tenant model gives every user exactly one tenant. It also makes the isolation claim easy in a way that hides whether it works: if a user's tenant is fixed, "A cannot see B" is only ever tested across _different people_, and a policy that leaks to the same person leaks silently.

The metering domain has service providers — a meter-reading firm whose staff work across several client organisations. So I split identity from role: a `users` row is a person, a `memberships` row grants that person one role in one tenant, and one person can hold several. That turns the guarantee into something worth testing:

> A user who is a member of both A and B, acting in A, sees A's rows and their own B-membership — and never another user's rows in B.

That is a genuinely harder property. The same person is legitimately authorised on both sides of the boundary, so nothing about _who they are_ can be used to enforce it.

---

## What was actually hard

Four findings, each compressed to its lesson. The mechanisms are in [ISOLATION.md](https://github.com/Braiden-07/MeterLog/blob/main/docs/ISOLATION.md).

**1 — A passing test and a covering test are not the same thing.**
The generic isolation harness sets only the tenant context. Run against the memberships table it never triggers the second policy at all, sees the right rows for the wrong reason, and goes **green** — having exercised half the policy surface. The danger was never a loud failure; it was a quiet pass. That table is now excluded from the generic matrix by an explicit, asserted declaration and covered by a bespoke dual-axis proof instead, so its absence can't be mistaken for an oversight.

**2 — "It fails loud" was true for functions and tables, and false for operators.**
Hardened `SECURITY DEFINER` functions pin their `search_path` so an unqualified name errors instead of resolving to something planted. `WHERE u.email = p_email` — both sides `citext`, entirely ordinary — did not error. Postgres fell through an implicit cast and bound case-**sensitive** text comparison. Meanwhile the unique index, whose operator class was resolved when the index was created, stayed case-**in**sensitive. Register as `Founder@…`, log in as `founder@…`: no match, generic failure, and re-registering blocked by the index. An unreachable account, no error anywhere. The fix qualifies the operator rather than widening the path — the widening would have made the symptom vanish and taken the protection with it. The exception is now written into the ADR next to the rule it qualifies.

**3 — A guard that passes in isolation and fails only on a reused connection.**
Revocation has to take effect on the next request, and the fragile surface is connection pooling: a Postgres setting reads as `NULL` on a connection that has never seen it and as the **empty string** once it has. A test that lands on a fresh connection proves nothing. So the proof pins the pool to one connection and _asserts the backend process id is identical across both requests_ rather than trusting the pool. Mutation testing then found a guard that reddened nothing — unreachable by construction, not unnecessary — so rather than mark it untested I found a real state that reaches it. That test passes in isolation under the mutation and fails only in a full run. A habit of isolating every test would have hidden it permanently, which is why the test configuration is now documented as load-bearing.

**4 — Closing a hole moves it; the job is knowing where it went.**
A policy that read as a sensible tenant scope had no role term in it, so a technician could run one `UPDATE` and become an admin of their own tenant — gated only by an authorisation guard that was two build steps away from existing. Rather than encode roles into RLS, I made the application role **structurally incapable** of writing that table: no write policy, no write grant, refused at two independent layers, each asserted separately. But that relocated the correctness burden into the privileged functions that now own writes — so the rule is written down before anything is built on it. The same finding surfaced an application-side predicate whose absence was masked by another policy one join away; it turned out to be reachable only through re-invitation, which is exactly the case the schema was designed to allow.

---

## The method, which is the actual point

- **Every security claim carries its negative.** A positive alone can't distinguish "the boundary held" from "the boundary was never reached."
- **Guards on the guards.** Atomicity is asserted in autocommit, because a rolled-back wrapper would pass against a non-atomic function. The "did an orphan survive?" check runs as a role RLS doesn't apply to, because asking the restricted role returns zero rows regardless — a guaranteed green proving nothing. The logout check asserts the session exists _before_ as well as absent after, so a mistyped key can't masquerade as a clean logout.
- **Boundaries proven semantically.** The unauthorised-tenant-switch test targets a real, existing tenant belonging to someone else. A malformed identifier would only prove that input validation runs.
- **Mutation testing every phase.** Each predicate and guard was deleted in turn and required to break at least one test. Anything that broke nothing was either made reachable or classified honestly — including one mutation correctly recorded as _behaviourally equivalent_ rather than contrived into a failure, because faking that would defeat the point of doing it.
- **Two defects found by building, kept in the record.** A protected route returned 500 where it should have returned 401 — the right refusal for the wrong reason — and the first version of the test _asserted the 500_, documenting the bug instead of catching it. The obvious fix made it worse: a guard rejected every request, because in NestJS guards run before interceptors and it couldn't see context that didn't exist yet. Found by running it, not by reasoning.
- **An adversarial review cadence.** Each phase closed at a gate that asked for the negative, not the happy path, and refused to accept "the tests pass" as evidence. Several of the findings above exist because a gate asked for the harder version of a proof that had already gone green.

---

## What is proven, and what is not

This is the part most worth reading, because a security write-up that implies more coverage than it has is the single failure mode this project spent four phases refusing.

**Proven, with live-database negatives:** dual-axis membership isolation across the identity tables; the pre-auth privileged-function surface, including three-row registration atomicity, forced to fail at the second and third insert and asserted to leave nothing behind; revocation taking effect on the next request across a reused pooled connection; the application role's structural inability to write memberships, at both the privilege and policy layers; and the full authentication round trip over real HTTP with real signed session cookies.

**Not proven, and not claimed:**

- **Bulk domain isolation.** Assets, readings, maintenance records and the audit log don't exist yet — they arrive at step 6. The catalog-driven isolation matrix is built and self-tested, but its fixture registry is empty, so it generates **zero cases against real tables today**. It activates automatically when those tables land, and fails the build if one arrives without a fixture. Isolation is currently proven for the identity tables only.
- **RBAC.** Removing the application role's write access closed the escalation; the admin-checking functions that replace it are step 5. Until then there is no invite, revoke or change-role path at all — safe, but that is absence rather than authorisation.
- **Audit logging.** Step 7, and it will need to retrofit the step-5 mutations rather than only wiring what comes after it. Recorded as a known retrofit.
- **Anything about production.** All evidence is local and CI, where the migration role happens to be a superuser and Render's will not be. That difference hides a class of privilege defect from both environments the tests run in, so it's enumerated as a pre-deploy checklist rather than assumed away.

---

**Repository:** [github.com/Braiden-07/MeterLog](https://github.com/Braiden-07/MeterLog) · **Full technical write-up:** [`docs/ISOLATION.md`](https://github.com/Braiden-07/MeterLog/blob/main/docs/ISOLATION.md) · **Decision records:** [`docs/DECISIONS.md`](https://github.com/Braiden-07/MeterLog/blob/main/docs/DECISIONS.md) · **Build log, including how each finding was reached:** [`docs/PROGRESS.md`](https://github.com/Braiden-07/MeterLog/blob/main/docs/PROGRESS.md)

Project 1 of a 10-project portfolio. The goal is production practice — multi-tenancy, RBAC, audit, testing, CI/CD — over feature count.
