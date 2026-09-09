# MeterLog — multi-tenant isolation, proven rather than asserted

**A multi-tenant SaaS backend where tenant isolation is enforced by PostgreSQL Row-Level Security, built to a standard I set deliberately: no security claim ships without a live-database negative behind it.** That standard paid for itself six times. On six separate occasions something passed design review, passed code review, and passed a green test suite — and was caught only by running the thing against a real database. One was a silent, unrecoverable account lockout. Another was a privilege escalation that let a technician make themselves an admin in a single SQL statement. Both looked correct on the page.

The last two are the ones I'd point a reviewer at, because they are a different kind of miss: **the code was right and the evidence for it was blind.** A concurrency test proved the race it was written for while being structurally incapable of seeing a second race in the same function. And an entire authorisation layer turned out to be deletable with the whole endpoint suite still green. Neither was a vulnerability. Both were holes in the proof, found by attacking the proof.

The finished write-up is [`docs/ISOLATION.md`](https://github.com/Braiden-07/MeterLog/blob/main/docs/ISOLATION.md), where every technical claim carries a `file:line` link into the repository and every security property is backed by a rejected write, a zero-row read, or a refused request quoted as real output.

**Stack:** TypeScript · NestJS · PostgreSQL 16 (Row-Level Security) · Prisma · Redis · Next.js · GitHub Actions
**State:** build-order steps 4 and 5 of 11 complete — auth and tenancy foundation, and RBAC with membership management. 150 tests green in CI. Domain entities are step 6; nothing is deployed yet.

---

## The problem I chose to make harder

The obvious multi-tenant model gives every user exactly one tenant. It also makes the isolation claim easy in a way that hides whether it works: if a user's tenant is fixed, "A cannot see B" is only ever tested across _different people_, and a policy that leaks to the same person leaks silently.

The metering domain has service providers — a meter-reading firm whose staff work across several client organisations. So I split identity from role: a `users` row is a person, a `memberships` row grants that person one role in one tenant, and one person can hold several. That turns the guarantee into something worth testing:

> A user who is a member of both A and B, acting in A, sees A's rows and their own B-membership — and never another user's rows in B.

That is a genuinely harder property. The same person is legitimately authorised on both sides of the boundary, so nothing about _who they are_ can be used to enforce it.

---

## What was actually hard

Six findings, each compressed to its lesson. The mechanisms are in [ISOLATION.md](https://github.com/Braiden-07/MeterLog/blob/main/docs/ISOLATION.md).

**1 — A passing test and a covering test are not the same thing.**
The generic isolation harness sets only the tenant context. Run against the memberships table it never triggers the second policy at all, sees the right rows for the wrong reason, and goes **green** — having exercised half the policy surface. The danger was never a loud failure; it was a quiet pass. That table is now excluded from the generic matrix by an explicit, asserted declaration and covered by a bespoke dual-axis proof instead, so its absence can't be mistaken for an oversight.

**2 — "It fails loud" was true for functions and tables, and false for operators.**
Hardened `SECURITY DEFINER` functions pin their `search_path` so an unqualified name errors instead of resolving to something planted. `WHERE u.email = p_email` — both sides `citext`, entirely ordinary — did not error. Postgres fell through an implicit cast and bound case-**sensitive** text comparison. Meanwhile the unique index, whose operator class was resolved when the index was created, stayed case-**in**sensitive. Register as `Founder@…`, log in as `founder@…`: no match, generic failure, and re-registering blocked by the index. An unreachable account, no error anywhere. The fix qualifies the operator rather than widening the path — the widening would have made the symptom vanish and taken the protection with it. The exception is now written into the ADR next to the rule it qualifies, which is why every function written since qualifies its operators too.

**3 — A guard that passes in isolation and fails only on a reused connection.**
Revocation has to take effect on the next request, and the fragile surface is connection pooling: a Postgres setting reads as `NULL` on a connection that has never seen it and as the **empty string** once it has. A test that lands on a fresh connection proves nothing. So the proof pins the pool to one connection and _asserts the backend process id is identical across both requests_ rather than trusting the pool. Mutation testing then found a guard that reddened nothing — unreachable by construction, not unnecessary — so rather than mark it untested I found a real state that reaches it. That test passes in isolation under the mutation and fails only in a full run. A habit of isolating every test would have hidden it permanently, which is why the test configuration is now documented as load-bearing.

**4 — Closing a hole moves it; the job is knowing where it went.**
A policy that read as a sensible tenant scope had no role term in it, so a technician could run one `UPDATE` and become an admin of their own tenant — gated only by an authorisation guard that was two build steps away from existing. Rather than encode roles into RLS, I made the application role **structurally incapable** of writing that table: no write policy, no write grant, refused at two independent layers, each asserted separately. But that relocated the correctness burden into the privileged functions that now own writes — so the rule was written down before anything was built on it, and the next step is where it had to be honoured.

**5 — Forcing an interleaving to make a concurrency test deterministic can blind it to a second race.**
Membership writes can leave a tenant with **zero** admins if an admin removes their own last admin membership, which is unrecoverable through the application. The guard against it has two failure modes, and they are not the same one. The first is a counting race: read the admin count from a snapshot and two admins demoting themselves concurrently both see "another one remains." The second is a lock-**ordering** race: take the locks in the wrong order and two symmetric attempts deadlock rather than one refusing cleanly.

I had a test that forced the interleaving deterministically — and it proved the counting race genuinely. Then the ordering mutation **passed** it. The forced schedule runs one transaction to completion before the other starts, and the deadlock needs both to overlap _inside_ the statement: the determinism that made it a real proof of the first race made it structurally incapable of seeing the second. The fix was a second test with the orchestration removed entirely. Correct ordering makes the deadlock impossible rather than unlikely, so it cannot produce a false failure — and it caught the mutation on every run.

**6 — A correctly-redundant layer is invisible to tests that only assert outcomes.**
Membership writes are refused twice: an authorisation gate at the HTTP route, and a re-check inside the privileged database function that owns the write. Defence in depth, deliberately. Then I deleted the gate entirely and **the whole endpoint suite stayed green** — because the database refused the same callers and produced a byte-identical response, so nothing could tell which layer had acted.

That is the security property working perfectly and the outer layer being completely untested, and they are the _same fact_. The fix wasn't to weaken either layer but to make them distinguishable: the two refusals now carry different error codes behind the same status, so removing the gate reddens tests immediately. It also pays off operationally — the database's code reaching a client now means a request got past the gate, which is worth being able to see in a log.

---

## The method, which is the actual point

- **Every security claim carries its negative.** A positive alone can't distinguish "the boundary held" from "the boundary was never reached."
- **Proven at the layer that actually enforces it.** Once membership writes moved into privileged database functions, the authorisation lives in those function bodies — and anything holding the application's database connection can call them directly, guard or no guard. So every one of those negatives is produced by calling the function directly, with the request context set by hand and **no HTTP, no framework, nothing in front of it.** A negative routed through the endpoint would have proven the gate instead, and left the design indistinguishable from the one it replaced.
- **Guards on the guards.** Atomicity is asserted in autocommit, because a rolled-back wrapper would pass against a non-atomic function. The "did an orphan survive?" check runs as a role RLS doesn't apply to, because asking the restricted role returns zero rows regardless — a guaranteed green proving nothing. The logout check asserts the session exists _before_ as well as absent after, so a mistyped key can't masquerade as a clean logout.
- **Boundaries proven semantically.** The unauthorised-tenant-switch test targets a real, existing tenant belonging to someone else; the cross-tenant write tests target a real, live membership asserted to exist first. A malformed identifier would only prove that input validation runs.
- **Error codes chosen so a negative can't pass for the wrong reason.** The obvious status code for "you're not an admin" is one Postgres also raises for a plain permission denial — so a test asserting it would pass just as happily against a misconfigured grant that never reached the check being tested. The refusals use codes nothing else in the system can raise, which makes each one attributable to the check it came from.
- **Mutation testing every phase.** Each predicate and guard was deleted in turn and required to break at least one test. Anything that broke nothing was either made reachable or classified honestly — including one mutation correctly recorded as _behaviourally equivalent_ rather than contrived into a failure, because faking that would defeat the point of doing it. Findings 5 and 6 came out of exactly this, which is the argument for keeping it: the sweep's job is to attack the evidence, and twice it found the evidence rather than the code.
- **Two defects found by building, kept in the record.** A protected route returned 500 where it should have returned 401 — the right refusal for the wrong reason — and the first version of the test _asserted the 500_, documenting the bug instead of catching it. The obvious fix made it worse: a guard rejected every request, because in NestJS guards run before interceptors and it couldn't see context that didn't exist yet. Found by running it, not by reasoning. When the same hazard came round again for the role gate a step later, I wired the wrong version up on purpose to re-measure it rather than trust the earlier note.
- **An adversarial review cadence.** Each phase closed at a gate that asked for the negative, not the happy path, and refused to accept "the tests pass" as evidence. Several of the findings above exist because a gate asked for the harder version of a proof that had already gone green.

---

## What is proven, and what is not

This is the part most worth reading, because a security write-up that implies more coverage than it has is the single failure mode this project has spent every phase refusing. Step 5 gave this section more to be careful about, not less.

**Proven, with live-database negatives:** dual-axis membership isolation across the identity tables; the pre-auth privileged-function surface, including three-row registration atomicity forced to fail at the second and third insert and asserted to leave nothing behind; revocation taking effect on the next request across a reused pooled connection, now driven by a real revoke through the API rather than a fixture; the application role's structural inability to write memberships, at both the privilege and policy layers; authorisation for every membership write enforced inside the database functions and proven by calling them with nothing in front; the last-admin guard against both of its concurrency races; and the full authentication and membership-management round trip over real HTTP with real signed session cookies.

**Not proven, and not claimed:**

- **Bulk domain isolation.** Assets, readings, maintenance records and the audit log don't exist yet — they arrive at step 6. The catalog-driven isolation matrix is built and self-tested, but its fixture registry is empty, so it generates **zero cases against real tables today**. It activates automatically when those tables land, and fails the build if one arrives without a fixture. **Isolation is currently proven for the identity and tenancy tables only** — that RBAC and membership management have landed says nothing whatever about domain-level coverage.
- **Invited users cannot log in yet.** An invite creates the person's identity with a placeholder credential that matches nothing, so until the set-password flow exists they can neither sign in nor register their own organisation. I'd rather show how that was handled than hide it: it isn't an acceptable limitation, because the scope already commits to an admin user-management UI and to the frontend covering every essential journey — so an invite button that dead-ends fails the project's own definition of done. It's scheduled as the first slice of the frontend step, with a hard deadline of the deploy step (before deploy, the only people it can lock out are test fixtures), and it's tracked by a **blocking checkbox in the Definition of Done** rather than a note, because notes drift and checklists don't.
- **Audit logging.** Step 7 — and the membership mutations built in step 5 write no audit row at all today, so that step has to go back and retrofit them rather than only wiring up what comes after it. Recorded as a known retrofit.
- **Anything about production.** All evidence is local and CI, where the migration role happens to be a superuser and the hosting provider's will not be. That difference hides a class of privilege defect from both environments the tests run in, so it's enumerated as a pre-deploy checklist rather than assumed away.

---

**Repository:** [github.com/Braiden-07/MeterLog](https://github.com/Braiden-07/MeterLog) · **Full technical write-up:** [`docs/ISOLATION.md`](https://github.com/Braiden-07/MeterLog/blob/main/docs/ISOLATION.md) · **Decision records:** [`docs/DECISIONS.md`](https://github.com/Braiden-07/MeterLog/blob/main/docs/DECISIONS.md) · **Build log, including how each finding was reached:** [`docs/PROGRESS.md`](https://github.com/Braiden-07/MeterLog/blob/main/docs/PROGRESS.md)

Project 1 of a 10-project portfolio. The goal is production practice — multi-tenancy, RBAC, audit, testing, CI/CD — over feature count.
