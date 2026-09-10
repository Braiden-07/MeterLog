# PROGRESS.md — MeterLog

> Running log of what was built each session, what's next, and any blockers.
> Newest entry at the top. Do not edit `PROJECT_BRIEF.md` (author-owned).

## Status

- **Current milestone:** v0.1 — auth & tenancy foundation
- **Build-order step (PROJECT_BRIEF §11):** 4 (auth + tenancy) **complete and merged** (PR #1). 5 (RBAC + membership management) **complete and merged** across three phases (PRs #2, #3, #4). **Step 6 (domain entities) IN PROGRESS — Phases 1 and 2 merged (`assets`, `asset_events`, `readings`; matrix 0 -> 15). Phases 3a, 3b and 3c complete: the READ surface with cursor pagination, the basic WRITE surface with the genesis emission, and the lifecycle TRANSITION ENGINE — all nine §9.1 RBAC cells now enforced and proven live.** Phase 3d is the §8.3 capstone and the deferred doc refresh. Phase 4 / 6b `maintenance_records` (slippable within step 6, but essential v1.0 scope — needed before step 8's frontend).
- **Blockers:** —
- **Standing deployment risk (read before step 10):** locally and in CI the migration role is the cluster bootstrap **superuser**; on Render it is not. A superuser satisfies `pg_has_role` unconditionally and bypasses RLS, so a whole class of privilege defect is **invisible in both environments where the tests run** and appears for the first time against Render — green CI does not cover it. Concretely: `ALTER FUNCTION ... OWNER TO meterlog_definer` needs _membership_ in that role, and Postgres matches RLS policy roles by **membership**, so a migration role left inside `meterlog_definer` silently acquires every `TO meterlog_definer USING (true)` policy on every identity table — the FORCE-RLS bypass the three-role model exists to prevent, reintroduced through role membership. `20260908000000_auth_definer_functions` grants that membership only if missing and **revokes it again**; do not collapse that into a standing grant. It is also the **first migration that would have failed on Render**. Checklist in [`ARCHITECTURE.md` §16.1](./ARCHITECTURE.md).

---

## Session log

### 2026-09-11 — Step 6 Phase 3c: the transition engine (§11 step 6)

The novel core of Phase 3. Everything before it was CRUD onto proven machinery; this is where the (from -> to) lifecycle logic lives, and where §9.2's "transition not state" trap is made **unrepresentable** rather than merely avoided.

**The graph is the only place the mapping exists (`src/assets/lifecycle.ts`).** `POSTABLE_TRANSITIONS` is keyed on the **event type**, with its legal source statuses declared alongside and the target status derived from it. Confirmed by grep: the only two occurrences of `statusToEventType` in the codebase are the comments warning against it, and every lookup in the service is event-type-keyed. **There is nowhere to put a status-keyed map**, because no code path ever starts from "the new status".

`ASSET_STATUSES` / `ASSET_EVENT_TYPES` were also consolidated here — phase 3a had declared them in the DTO file, before a graph existed, and leaving both would have let the DTO and the graph disagree about what an event type is.

**Two endpoints.** `POST /assets/:id/events` is the single transition driver (admin + technician): the client names the transition, the service derives the target status, validates the edge against current status, then writes the status change and its event atomically in the interceptor's transaction — the 3b pattern unchanged. `DELETE /assets/:id` is decommission (**admin only** — §9.1 draws the line at the destructive act): one transaction setting `status` **and** `deleted_at` plus the `decommissioned` event carrying the prior status.

**The graph, with the two edge cases decided.** `installed -> maintenance` **disallowed** (maintenance means withdrawn from service; an uncommissioned asset already is). `installed -> decommissioned` **allowed** (assets get scrapped before commissioning; refusing it would strand them with no legal exit). `decommissioned` **terminal** — which phase 1's `assets_tenant_serial_live_key ... WHERE deleted_at IS NULL` already presupposed, and the re-registration test now closes that loop: decommission frees the serial, and the returning asset is a new row.

**The full-enum DTO is deliberate, and carries the reasoning.** `PostEventDto` accepts all six event types and the **service** decides postability. Narrowing it to the three postable values would make `ValidationPipe` reject `decommissioned` with a generic 400 — indistinguishable from a typo — and the 422 naming `DELETE /assets/:id` would become unreachable code, telling a caller their perfectly valid input does not exist. Same shape as the argon2-sentinel lesson: a later "tidy-up" removes a diagnostic while every test checking only "rejected" stays green.

**Three codes, three causes:** 400 = not an event type at all; **422** = a real event type not postable here, naming the path that owns it (`ASSET_EVENT_GENESIS_ONLY`, `ASSET_EVENT_USE_DELETE`); **409 `ASSET_TRANSITION_ILLEGAL`** = postable but illegal from the current status, with `from`/`to` in `details`. Asserted distinct, per the step-5 byte-identical-403 lesson.

**THE LOAD-BEARING TEST, and the sweep proved it earns the label.** One journey — register, then `activated` -> `maintenance_started` -> `maintenance_completed` — asserting the log reads `created, installed, activated, maintenance_started, maintenance_completed`. Under a status-keyed map the fifth event would be `activated`, because `activated` and `maintenance_completed` both land on `active`.

The sweep's Q1 applied exactly that naive map. **It reddened exactly one test — this one.** Every other assertion stayed green: the statuses were still correct, the replay reconciliation still passed, the event count was right, the payloads still plausible, the API still returned 201. That is the claim in the test's own comment, confirmed experimentally rather than asserted.

**The replay reconciliation, with its two preconditions stated on the test.** For every asset, `status` must equal the `to` of its latest status-bearing event. Both guards are necessary or it false-positives: derive only from events whose payload has a `to` (`created` carries `{}` and shares the genesis `created_at`, so including it makes "latest" ambiguous), and run against **API-created assets only** (`seedIsolationContext` inserts assets with no events by design, so a replay over scaffolding would flag status-with-no-event). Five assets across five different lifecycles, with a non-vacuity check that each replayed to something.

**The route-inventory guard — derived, not listed.** Enumerates registered routes and asserts no PATCH/PUT/DELETE targets an append-only resource. The resource set comes from `APPEND_ONLY_TABLES` via one commented `TABLE_TO_SEGMENT` convention, asserted equal in both directions — so `audit_log` joining at step 7 extends it by one entry and fails until it does, rather than silently stopping covering a table (the teardown-PR lesson). It is the API-layer echo of assertion 13: the database refuses the write, and now no route can offer it without a reviewed edit.

**Built on Nest metadata, not Express internals — the first attempt was wrong.** Reading `app.router` throws in Express 4 (deprecated getter) and `_router` is private and has already changed shape once. **A guard that silently stops finding routes passes**, so it now walks `ModulesContainer` and the `PATH_METADATA`/`METHOD_METADATA` decorators, which also means a new controller is covered with no edit. It carries a non-vacuity check that it found routes at all.

**Mutation sweep — 10 mutations, 10 caught.**

| #   | mutation                                       | caught by                                   |
| --- | ---------------------------------------------- | ------------------------------------------- |
| Q1  | **the naive status-keyed map**                 | **exactly one test — the load-bearing one** |
| Q2  | narrow the DTO enum to three values            | 4 tests — all the 422-code assertions       |
| Q3  | allow `installed -> maintenance`               | the disallowed-edge test                    |
| Q4  | make `decommissioned` non-terminal             | the terminal-state test                     |
| Q5  | `DELETE` sets status without `deleted_at`      | 9 tests — the CHECK refuses the row         |
| Q6  | `DELETE` gated admin+technician                | the admin-only test                         |
| Q7  | a transition updates status but emits no event | 3, incl. the replay reconciliation          |
| Q8  | drop `readings` from the guard convention      | the both-directions convention check        |
| Q9  | expose `PATCH /assets/:id/events`              | the no-mutating-route check                 |
| Q10 | illegal edge returns 422 instead of 409        | 5 tests — the code-distinctness assertions  |

**Q5 is worth noting:** breaking `DELETE` so it sets only `status` reddened **nine** tests, because the 3b biconditional CHECK refuses the row outright. The floor built last phase is load-bearing for this one, exactly as intended — and the floor is also proven independently, by a migrator-role `UPDATE status='decommissioned'` leaving `deleted_at` null raising `23514` with the constraint named. The 422 on `POST /events` is the friendly error; the CHECK is the guarantee.

**All nine §9.1 cells are now enforced and proven live.** 3c adds the two 3b could not reach: transitions at admin ✓ / technician ✓ / auditor 403, and decommission at **admin only** (technician 403, auditor 403, with the asset verified still `installed` and not deleted after both attempts). Plus 401 distinct from 403, and the null-role case 403-never-500 on both new endpoints.

**§8.3 write axis completed for 3c's endpoints.** M, an **admin** of both tenants and active in A, gets **404 — not 403** — on B's asset for both `POST /events` and `DELETE`; B's asset verified still `installed`, not deleted, with a genesis-only log. Being an admin of B makes the point sharper: the refusal is not about permissions at all.

**256 tests green** (was 225; +31). Lint, typecheck, build and format verified by exit code.

**Next**

- Phase 3d — the §8.3 full-matrix capstone and consolidated acceptance, plus the deferred refresh of `ISOLATION.md` / `README.md` / `PORTFOLIO.md`, which have described the fixture registry as empty since step 4 and are now three phases stale.

---

### 2026-09-10 — Step 6 Phase 3b: the write surface, RBAC, and the genesis emission (§11 step 6)

The writes whose emission is trivial or absent, so the novel (from -> to) transition logic stays quarantined in 3c. Also the project's first write to `asset_events`, which establishes the emission pattern 3c extends.

**Three endpoints, all `@RequiresRole('admin', 'technician')`.** `POST /assets`, `PATCH /assets/:id` (metadata only), `POST /assets/:id/readings`.

**The genesis pair — three rows, one transaction, proven on disk.** `POST /assets` writes the asset then **both** `created` and `installed` in a single statement. Asserted by reading back as the migration role rather than trusting the response: exactly one asset (`installed`, `deleted_at` null, correct `tenant_id`), exactly **two** events, payloads `{}` and `{"from": null, "to": "installed"}` (decision 10), `created_by` = caller on both, and **identical `created_at`** — the observable evidence of the single transaction.

**Atomicity came for free, which was the point of decision 3.** The interceptor already opens an interactive transaction to issue `SET LOCAL`, and `requireRequestContext().tx` _is_ that transaction, so the three statements are in it by construction. No new machinery, no definer (no privilege gap — the app role holds `INSERT` on both tables), no trigger. The trigger rejection is recorded at the call site with its concrete repo reason, because it is the obvious suggestion: a trigger needs `created_by`, would have to read `app.current_user`, and every migrator-seeded fixture inserts assets with no such GUC — so it would need a "skip when unset" fallback, and that fallback _is_ the silent skip the trigger existed to prevent, now fail-open.

**`tenant_id` is not client-supplied and a cross-tenant write is not expressible.** `CreateAssetDto` has no `tenantId` field, so `forbidNonWhitelisted` makes the attempt a 400 rather than a field RLS then quietly refuses. Same for `status`.

**The biconditional CHECK — the DB floor, in before 3c builds the path it guards.** New migration: `CHECK ((status = 'decommissioned') = (deleted_at IS NOT NULL))`. One row, no subquery, no policy interaction — which is why a `CHECK` works here and could not for ADR-007 (that needed a _parent_ table). Verified to reject **both** directions and accept both consistent shapes, including against the migration role — the whole reason it is a constraint rather than a service invariant.

**It immediately forced one fixture consistent, exactly as expected.** The phase-1 serial re-registration test soft-deleted by setting `deleted_at` alone, which the constraint now forbids. **Corrected, not weakened:** soft-deleting an asset _is_ decommissioning it (decision 9), so a fixture writing only `deleted_at` was modelling a state the product does not have. That was the only one in 225 tests.

**A REAL BUG IN 3a's CURSOR, found by 3b's real data.** The genesis-pair pagination test failed: walking two tied events at `limit=1` returned **one** row, not two.

Diagnosis: `encodeCursor` took a JS `Date` and called `.toISOString()`. **Postgres `timestamptz` is microsecond-precision; a JS `Date` is millisecond.** The cursor therefore pointed at an instant slightly _earlier_ than the row it came from, so `(created_at, id) < (truncated, id)` excluded that row **and every row sharing its millisecond**, and pagination stopped early having silently lost rows.

It was invisible in 3a because those tests seeded whole-second timestamps, where truncation is lossless. It appeared the moment real rows were created with `now()` — and worst on the genesis pair, where two rows share a microsecond timestamp _by design_, which is precisely the case the tiebreaker exists for. **This was merged in 3a and was a live defect**, not a new-code mistake.

Fixed by never letting the value pass through a JS date: every paginated query now re-selects its sort column as `::text` (`cursor_key`), that exact string travels in the cursor, and it returns to Postgres as `$n::timestamptz`. `encodeCursor`'s signature now **refuses** a `Date`, so the mistake cannot recur silently.

**Mutation sweep — 7 mutations, 7 caught.**

| #   | mutation                                                                         | caught by                             |
| --- | -------------------------------------------------------------------------------- | ------------------------------------- |
| P1  | emit only `created`, drop `installed`                                            | genesis shape + the cursor-tie test   |
| P2  | wrong `installed` payload                                                        | genesis shape                         |
| P3  | **build the cursor from the mapped `Date`** (the precision bug restored)         | the genesis cursor-tie test           |
| P4  | remove `@RequiresRole` from all three routes                                     | auditor-403 + null-role               |
| P5  | **add `status` to `UpdateAssetDto`** (the future "so the UI can set it" mistake) | the `PATCH { status }` 400 test       |
| P6  | emit an event on reading creation                                                | "leaves asset_events untouched"       |
| P7  | drop the CHECK constraint                                                        | the DB-enforced-against-migrator test |

**P5 is the one worth naming.** `forbidNonWhitelisted` only refuses fields the DTO does not declare — it does nothing the moment someone adds `status` to the DTO, which would make `PATCH` a second status-write path with no emission and silently break §9.2. So **the DTO shape is the guard, not the pipe**, and the test exists to pin that absence. The comment says so, because the test otherwise reads like it is testing ValidationPipe.

**RBAC, live over HTTP.** admin ✓ / technician ✓ / auditor **403** on all three endpoints, with `FORBIDDEN_ROLE` asserted by **code and message** (the step-5 lesson: two byte-identical 403s from different layers made the gate untestable), plus the auditor's attempts verified to have written nothing. `401 UNAUTHENTICATED` distinct from 403. And the **null-role case: 403, never 500** — the CanActivate-ordering defect one layer up.

**§8.3 write axis (for 3b's endpoints).** M, a member of both tenants and active in A, gets **404** — not 403 — on `PATCH` and on attaching a reading to B's asset, because B's row does not exist for that request; B's asset is verified untouched with zero readings. And M's own `POST` lands in A, never B — since the tenant is not client-supplied, writing into B is _inexpressible_ rather than merely refused.

**The forward-marker register — `DECISIONS.md`, "Open items register".** Put there rather than in a new `docs/` file so each debt sits beside the ADR that created it; `PROGRESS.md` stays the narrative log, the register is the checklist. Four enumerated rows with owed-by and due-step: **OPEN-4** (role-at-time-of-action → step 7), **OPEN-6** (the audit retrofit, **extended from three to seven mutation types** — the five step-5/3b ones plus 3c's transition and decommission; with `PATCH` flagged specifically, since it emits no lifecycle event and so is the one Phase 3 mutation for which `audit_log` will be the _only_ record), **OPEN-7** (set-password, step 8 / deadline step 10), **OPEN-8** (`maintenance_records`: does it get a `DELETE` grant at all — `SELECT, INSERT, UPDATE`, a shape no existing table has, or the project's first genuine hard delete against an all-soft-delete, all-RESTRICT codebase). Rows are marked `DONE` when paid, never deleted.

**225 tests green** (was 202; +23). Lint, typecheck, build and format verified by exit code.

**Next**

- Phase 3c — the transition engine: the legal (from -> to) graph, `POST /assets/:id/events` as the single transition driver, `DELETE /assets/:id` as decommission, 409 on an illegal transition, and the route-inventory guard once every append-only route is registered.

---

### 2026-09-10 — Step 6 Phase 3a: the asset read surface (§11 step 6)

First of four sub-phases. Deliberately the low-risk one: RLS and the existing interceptor do the isolation, so the handlers query and paginate. It establishes the controller/DTO/pagination patterns 3b–3d reuse.

**What landed.** `AssetsModule` — controller, service, DTOs — with four reads, all `@RequiresSession()` and **none role-gated**: `GET /assets` (cursor-paginated, filters `status`/`type`/`serialNumber`/`includeDecommissioned`, sort `createdAt` desc or `serialNumber` asc), `GET /assets/:id`, `GET /assets/:id/events` (filter `eventType`), `GET /assets/:id/readings` (filter `from`/`to` on `read_at`). Plus `common/pagination/cursor.ts`.

**No `tenant_id` appears in any WHERE clause, deliberately.** Every query runs on the request transaction where the interceptor set `app.current_tenant`, so the policies scope the results. A redundant app-layer tenant predicate would not strengthen isolation — it would keep returning correct results after the thing that actually protects the data stopped working, hiding a policy regression. Same rule as `MembershipsService.list`.

**Cursor pagination, and the tiebreaker.** Keyset, opaque base64 cursors, `limit + 1` lookahead for `nextCursor`, no total count. Every `ORDER BY` carries `id`: `readings (read_at, id)`, `events (created_at, id)`, `assets (created_at|serial_number, id)`. **For events the tie is guaranteed, not occasional** — §9.2 has registration emit `created` and `installed` in one transaction, so every asset's genesis is two rows sharing a `created_at` to the microsecond, and a page boundary landing between them without a tiebreaker is a certainty rather than a race.

**The soft-delete rule, asserted both ways.** `deleted_at IS NULL` is a **list-scope default**, never an existence check: `GET /assets` hides decommissioned assets, `?includeDecommissioned=true` includes them, and `GET /assets/:id` plus both child reads return them regardless. Filtering them in `findOne` would 404 a row the list endpoint returns with one query parameter. The filter lives in the query builder and **never in a policy** — a liveness predicate in a policy is the OPEN-5 shape that blocks the very UPDATE performing the soft delete.

**The §8.3 read axis is green.** User M holds a legitimate membership in both tenants; active in A, M sees A's assets/readings/events and 404s on B's — then, after `POST /auth/switch` on the _same session_, sees B's and 404s on A's. The boundary follows the active tenant, not the person or the session.

**A mutation escaped, was diagnosed, and the gap was closed.** 7 mutations run; 6 caught immediately. **N2 — dropping the `id` tiebreaker from the _readings_ ORDER BY and cursor tuple — went green.** Diagnosis: the tied-timestamp test seeded tied _events_ (where §9.2 guarantees the tie) but never tied _readings_, so the readings keyset never met a tie and the tiebreaker was unreachable. Readings tie in practice — a bulk upload, or two meters recorded at the same rounded minute. Added a tied-`read_at` case; N2 re-run now reddens it. Final: **7 mutations, 7 caught.**

| #   | mutation                                                          | caught by                                                 |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| N1  | events: drop the `id` tiebreaker                                  | tied-timestamp ordering                                   |
| N2  | readings: drop the `id` tiebreaker                                | **escaped, then caught** by the added tied-`read_at` case |
| N3  | remove the soft-delete list default                               | 2 list-scope tests                                        |
| N4  | `findOne` filters soft-deleted rows                               | the decommissioned-still-readable test                    |
| N5  | naive boolean coercion (`includeDecommissioned=false` fails open) | the fail-open test                                        |
| N6  | `listEvents` skips the existence check                            | the §8.3 read-axis test                                   |
| N7  | drop the `limit + 1` lookahead                                    | 3 pagination tests                                        |

**The index question — measured, recommendation deferred to the gate (`docs/PERF.md` §2).** Keyset queries against the existing two-column indexes vs three-column replacements, 100k readings / 20k events, cursor 5,000 rows deep, run as the app role with the GUC set:

|                        | 2-col                                      | 3-col                        |
| ---------------------- | ------------------------------------------ | ---------------------------- |
| readings plan          | **Incremental Sort** → Index Scan Backward | Index Scan Backward, no sort |
| cursor predicate       | `Filter:` (scan and discard)               | **`Index Cond:`** (seek)     |
| readings execution     | 0.354 ms                                   | 0.186 ms                     |
| events execution       | 0.145 ms                                   | 0.094 ms                     |
| index size (100k rows) | 3984 kB                                    | 5768 kB (**+45%**)           |

**The timing delta is not the argument** — both are sub-millisecond and `Incremental Sort` with a presorted key is cheap. The structural difference is: with two columns the row-wise cursor comparison is demoted to a **Filter**, so rows failing the tuple comparison are read and discarded; with three it becomes an **Index Cond** and the position is sought. That is invisible at 52-scanned-for-50 and becomes the whole cost when timestamps tie — which for `asset_events` is guaranteed by the genesis pair. **Recommendation: amend both, replacing rather than stacking** (the 3-col still leads with `asset_id`, so the composite-FK support and the range prefix survive, making the 2-col redundant). **Not done in 3a** — it touches merged indexes and is the author's call; nothing is blocked, because the 2-col indexes are correct, just less direct.

**202 tests green** (was 181; +21). Lint, typecheck, build and format verified **by exit code** — the phase-2 lesson, after a piped `| tail` hid three real lint errors.

**Next**

- Phase 3b — `POST /assets` (emitting the fixed `created` + `installed` genesis pair), `POST /assets/:id/readings`, `PATCH /assets/:id` (metadata only, `status` rejected), and all nine §9.1 RBAC cells with live 403 negatives.

---

### 2026-09-10 — Test-teardown hardening: one catalog-derived TRUNCATE, twelve sites collapsed

Test infrastructure only — no migration, schema, policy, grant or API change. Follows the cross-suite coupling surfaced (and deliberately not fixed) at the close of step 6 phase 2.

**The trap, and why it was worth a PR of its own.** Teardown ordering was duplicated across the suite, hand-coupled to the child-table set, and silent. When `readings` landed, `isolation.spec.ts`'s list did not know about it, threw `23503` partway, never reached its `users`/`tenants` deletes, and the residue broke **31 tests in `membership-writes.spec.ts`** — a file with no relationship to the change, reporting a foreign-key error naming neither cause nor culprit.

**The grep found more sites than the brief named.** The brief listed five; the exhaustive sweep found **twelve teardown sites across nine files** — ten blanket `memberships → users → tenants` triples plus two domain-aware cleanups. The three unnamed files (`interceptor.spec.ts`, `membership-isolation.spec.ts`, `membership-writes.spec.ts`) each carried **two** sites, a `beforeEach`/`beforeAll` reset as well as an `afterAll`. Every one converted. Three `DELETE`s were deliberately left alone: they are **behavioural assertions inside tests** (the matrix's cross-tenant DELETE case, and two membership revocation negatives), not teardown.

**The mechanism.** `resetDatabase(migrator)` in `helpers.ts` issues one `TRUNCATE "t1", "t2", … CASCADE` over a catalog-derived list — `pg_tables` in `public`, minus the reused `RLS_EXEMPT_TABLES` (which already names `_prisma_migrations`, correctly excluded because truncating it destroys migration-state tracking). **Postgres resolves the FK graph**, so the ordering knowledge does not move into a helper someone still has to extend — it ceases to exist. `maintenance_records` and `audit_log` will need zero edits.

Four hazards documented at the site: it runs as the **migrator, never the app client** (catalog assertion 6 asserts `meterlog_app` holds no `TRUNCATE`, so the obvious "fix" for a `permission denied` silently defeats a real assertion); `CASCADE` is deliberately broader than its arguments; `_prisma_migrations` is excluded; and the row counts are taken on the migrator because an app-client count is RLS-filtered to zero with no GUC set, which would make the guard **vacuous forever**.

**The half never fixed — silence.** `assertNoResidualRows(migrator)` runs after every truncate and throws naming each offending table and the fix. Passing by construction today, which is the point: it is the regression guard. If teardown ever stops cleaning, the suite that caused it fails **at its own site** rather than three suites away.

**Proven to fire, not assumed.** `test/db/teardown.spec.ts` (4 tests) plants a single stray row and calls the guard directly — the same method that confirmed the phase 2 breakage. It also asserts every dirty table is named (not just the first), and truncates a full tenant → asset → readings/asset_events graph in one statement to show CASCADE doing the ordering.

**And proven to fire in the REAL path, by mutation.** Making `resetDatabase` skip one table produced, from `auth-definer.spec.ts`'s own teardown: `teardown left rows behind: tenants=1. A later suite's cleanup will fail with an opaque foreign-key error instead of naming this. Call resetDatabase(migrator) rather than hand-rolling DELETEs.` That is the whole claim demonstrated — named, at the causing site. Reverted.

**A regression caught during the work, worth recording.** Routing `seedIsolationContext` through `resetDatabase` broke 6 isolation tests: the helper used to clear only domain tables, but `resetDatabase` truncates `users` and `tenants` too, destroying the `FIXTURE_USER` seeded moments earlier so every child's `created_by` FK failed. Fixed by making the reset the **caller's** responsibility, ordered explicitly at the call site — reset, then seed — with the reason commented in both places. A self-resetting seed helper was safe only while it deleted less than it appeared to.

**Load-bearing invariants verified untouched:** `fileParallelism: false`, `connection_limit=1`, and the `pg_backend_pid` equality assertions all intact. Teardown ordering is orthogonal to the connection-reuse invariants — nothing here changes which connection a test gets or how many run at once.

**181 tests green** (was 177; +4 guard tests), three consecutive runs. Lint, typecheck, build, format clean. A `CLAUDE.md` test-suite invariant records the helper and the never-grant-TRUNCATE rule.

**Next**

- Step 6 Phase 3 — the API surface, the `assets` ↔ `asset_events` lifecycle wiring per ARCHITECTURE §9.2, and the ADR-006 §8.3 shared-user headline test over real HTTP.

---

### 2026-09-10 — Step 6 Phase 2: readings, and the EXPLAIN ANALYZE requirement (§11 step 6)

Deliberately short and low-risk: every mechanism `readings` needs was built and proven at Phase 1. The job was to land the table faithfully, register its fixture, and prove `readings` is genuinely **under** the contract rather than assuming it inherits.

**THE HEADLINE — the matrix generalised to a second child: 10 -> 15 cases.**

|                        | Phase 1 | Phase 2                                           |
| ---------------------- | ------- | ------------------------------------------------- |
| generated matrix cases | 10      | **15** (5 × `assets`, `asset_events`, `readings`) |
| suite total            | 171     | **177**                                           |

**No new mechanism, and that is the result.** `readings` needed no special case anywhere — same canonical policy, same ADR-007 composite FK, same append-only grant shape, same fixture contract. Had it needed one, the Phase 1 contract would have been wrong. The `appWrites`/`dependsOn`/seed-context design met a table it was not written against and held.

**The migration.** Faithful to `PROJECT_BRIEF` §5 (:138), with the decisions recorded at the columns:

- `value numeric` **unbounded, NOT NULL, no CHECK** — no precision commitment (a cumulative meter total has no natural ceiling, and truncation in an append-only table is unrecoverable), and no non-negativity or monotonicity rule because value-domain logic is the **anomaly-flagging** feature the brief schedules as stretch (:42). A CHECK now would pre-empt that design by _rejecting_ rows where the feature wants to _flag_ them — and a meter reading lower than last month is a real event (replacement, rollover, correction) that must be recordable.
- `unit text NOT NULL` — free text, not an enum. The brief marks `status` and `event_type` as enums and pointedly does **not** mark `unit`. NOT NULL because a number without a unit is unusable data.
- `read_at timestamptz NOT NULL, no default` vs `created_at ... DEFAULT now()` — **domain time versus server time**, and both exist because they answer different questions ("when was the meter read" / "when did we learn about it"). No default on `read_at`: a server-generated value would be a lie about the physical world, and back-dating after a site visit is ordinary use.
- **`readings` is a LEAF — no `UNIQUE (id, tenant_id)`.** That composite on `assets` is the _parent half_ of a child's FK; nothing in v1.0 is a child of a reading. Adding one would be cargo-culting the pattern, paying an index's write cost on the hottest-inserting table in the schema for a relationship that does not exist.
- **`created_by` unindexed — third instance**, now named as one pattern rather than three omissions (with `asset_events.created_by` and the rejected `memberships(user_id)` index, ADR-006 §2). Nothing queries readings by actor, and the unindexed-FK penalty falls on parent deletes, which `ON DELETE RESTRICT` plus soft-deleted identity makes impossible.
- Indexes: `readings_tenant_id_idx`, and the brief's explicitly-named `readings_asset_id_read_at_idx (asset_id, read_at)` — whose leading column also gives the composite FK its `ON DELETE RESTRICT` check an index, so no separate `asset_id` index.

**`readings` is append-only BY CONSTRUCTION — the dangerous kind, foregrounded at the table.** `asset_events` (:137) and `audit_log` (:140) are marked append-only in the brief in words. **`readings` (:138) is not.** It is append-only only because :138 gives it no `updated_at`/`deleted_at` and :146 turns that absence into the property. The migration states plainly that **the authority is the CLAUDE.md declaration, not the absent columns**, and that adding `updated_at` "for consistency with assets" would silently end the property — caught only by catalog assertion 13, which binds the declaration to the grant. This is the entry the whole declaration mechanism was built for.

**The proofs.**

- **Composite-FK negative for `readings`** — acting in B, `tenant_id = B` (so the WITH CHECK is satisfied), pointing at A's asset: `23503` + `readings_asset_tenant_fkey`, asserted `.not /row-level security/`. Constructed so only the FK can fire, mirroring the `asset_events` negative. The privileged-connection sibling was not repeated: that is a property of the _mechanism_, proven once at Phase 1.
- **Catalog assertion 13 now covers `readings`** — declared append-only, holding exactly `SELECT, INSERT`. Green.
- **Two targeted mutations**, the proportionate stand-in for a full sweep re-run:

| #   | mutation                          | result                                                                                                        |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| M9  | `readings` policy keyed on `true` | **caught** — 3 readings-specific cases (read isolation, WITH CHECK, fail-closed baseline)                     |
| M10 | `GRANT UPDATE ON readings`        | **caught twice** — assertion 13 (now listing both append-only tables) _and_ the matrix's readings UPDATE case |

Both reverted; policy clauses and grants re-verified against the catalog (`readings` at `SELECT, INSERT`, both policy clauses present).

**A REAL DEFECT CAUGHT BY THE NEW TABLE — and it broke a different suite.**

The first full run after `readings` landed failed **31 tests in `membership-writes.spec.ts`**, a file Phase 2 never touched. Diagnosed rather than re-run until green:

`isolation.spec.ts`'s teardown deleted `asset_events` then `assets` — written at Phase 1 when those were the only domain tables. `readings` also references `assets` `ON DELETE RESTRICT`, so the teardown threw `23503` partway, which meant the _subsequent_ `DELETE FROM public.users` and `DELETE FROM public.tenants` never ran. The leftover `assets` rows then blocked `membership-writes`'s own blanket `DELETE FROM public.tenants`.

**Confirmed by direct reproduction, not inference:** planting a single stray `assets` row and running `membership-writes.spec.ts` alone reproduces it exactly — `update or delete on table "tenants" violates foreign key constraint "assets_tenant_id_fkey"`. Fixed by ordering children before parents in both cleanup paths (`isolation.spec.ts` teardown and `seedIsolationContext`'s residue clear), each now carrying a comment that every new FK-child of `assets` must be added.

**The coupling this exposes is worth naming, and is NOT fixed here.** `membership-writes.spec.ts` and `membership-isolation.spec.ts` both blanket-`DELETE FROM public.tenants`, so **any** domain row left anywhere breaks them, with an error naming neither the suite nor the cause. It gets worse with `maintenance_records` and `audit_log`. Hardening those two files to clear domain tables first would make them ordering-independent, but they are marked load-bearing and are outside Phase 2's boundary — **recommended as a small follow-up, deliberately not done unilaterally.**

**The standing `EXPLAIN ANALYZE` requirement — discharged (`docs/PERF.md`, new).**

`PROJECT_BRIEF` :150 / :279 require proving one index decision with before/after plans. `readings` is its natural table. 100,000 readings across 5 assets, measured **as `meterlog_app` with the tenant GUC set** so the RLS predicate is part of the plan rather than something measured around:

|                      | without index                           | with index                                  | delta            |
| -------------------- | --------------------------------------- | ------------------------------------------- | ---------------- |
| Execution time       | 18.128 ms                               | **1.565 ms**                                | **11.6× faster** |
| Buffers (shared hit) | 1576                                    | **81**                                      | **19.5× fewer**  |
| Rows discarded       | 49,579 per worker                       | 0                                           | —                |
| Plan                 | Parallel Seq Scan → Sort → Gather Merge | Bitmap Index Scan → Bitmap Heap Scan → Sort | —                |

The honest framing is in the doc: **the plan shape matters more than the 11.6×.** The seq-scan cost grows with the table, the index-scan cost with the result — at 10M rows the factor is far larger, and the unindexed plan also recruited a parallel worker to reach 18 ms. Two observations recorded so they are not misread later: the RLS filter is visible in both plans (evidence the measurement used the real path), and a `Sort` node survives the indexed plan because a bitmap scan does not return rows in index order. The harness was run once and **deliberately not committed** — a measurement, not a test; committing it would add a 100k-row insert to every CI run to re-prove a recorded decision.

**177 tests green**, three consecutive clean runs after the teardown fix. Lint, typecheck, build, format clean.

**One open cell for the author.** `value` carries no `CHECK`, per the locked decision. My view, for the record: I agree with leaving it off — a `CHECK (value >= 0)` reads as obviously safe but would make a meter rollover or a corrected over-read unrecordable in a table that has no UPDATE path to fix them, and negative deltas are exactly what anomaly flagging (:42) is meant to surface rather than refuse. If you want it enforced now, it is a one-line migration.

**Boundary held:** no `maintenance_records`, no API or emission wiring, no changes to Phase-1 mechanisms. **No registry-empty doc refresh** — and note those docs are now _further_ stale: `ISOLATION.md`, `README.md` and `PORTFOLIO.md` still say the fixture registry is empty, when it holds **three** domain fixtures generating 15 cases. Still the scoped later turn.

**Next**

- Phase 3 — the API surface, the `assets` ↔ `asset_events` lifecycle wiring per ARCHITECTURE §9.2 (a status transition emits an event, atomically), and the ADR-006 §8.3 shared-user headline test over real HTTP.

---

### 2026-09-10 — Step 6 Phase 1: assets + asset_events, and the isolation harness made real (§11 step 6)

**Scope decided before building.** All four brief domain tables are in v1.0 (`assets`, `asset_events`, `readings`, `maintenance_records`). Phase 1 deliberately lands the **two different write shapes at once** — `assets` mutable, `asset_events` append-only — because a fixture contract that had only ever met one shape would need rework the moment the other arrived, and v1.0 holds two more of each.

**THE HEADLINE — the generic matrix went from zero cases to ten.**

Built at step 4 and self-tested against a scratch table ever since, the catalog-driven matrix had generated **zero cases against real tables** for two whole build steps: `tenants`, `users` and `memberships` are all registered bespoke, because the app role cannot write any of them. `assets` and `asset_events` are the first tables it genuinely can.

|                           | before | after                                     |
| ------------------------- | ------ | ----------------------------------------- |
| generated matrix cases    | **0**  | **10** (5 × `assets`, 5 × `asset_events`) |
| `isolation.spec.ts` total | 6      | 21                                        |
| suite total               | 150    | **166**                                   |

**Three records, made before any code (all decisions were the author's; none were filled silently).**

- **ADR-007 — child-table tenant consistency by composite FK.** `assets` carries `UNIQUE (id, tenant_id)`; children carry `FOREIGN KEY (asset_id, tenant_id) REFERENCES assets (id, tenant_id)`. Declarative and always-on: it holds against the app role, the migration role, any future definer function and psql. A trigger is procedural code in the write path needing its own reachability proof; a `CHECK` cannot reference another table. **Consequence recorded explicitly:** an asset's `tenant_id` is effectively immutable once it has children — correct, because assets do not move between tenants.
- **ARCHITECTURE §9.1 — the domain RBAC matrix.** Create and update at admin **and** technician; soft-delete admin-only; reads for all three roles; auditor read-only throughout. The one genuinely open cell resolved: `POST /assets` is admin **and** technician, because registering an asset being installed is field work, and the destructive act is decommissioning. **Recorded now, enforced at Phase 3** — and enforced at the endpoint, never in a policy: no domain policy carries a role term (DECISION B).
- **CLAUDE.md — the append-only declaration.** `asset_events` is its first explicit member, cross-referenced to the brief. The brief states the property outright for `asset_events` (:137) and `audit_log` (:140) but **never for `readings` (:138)**, where it exists only by omission via :146. Implicit-by-omission is the shape of this repo's two worst bugs, so the property is now declared per-table and enforced in three places rather than inferred from which column is absent.

**The migration.** `assets` (brief §5 fields, soft delete, canonical policy with `WITH CHECK` written out in full, grants `SELECT, INSERT, UPDATE` and **no `DELETE`** so a hard delete is impossible for the runtime role, brief indexes, plus `UNIQUE (id, tenant_id)`); `asset_events` (append-only, grants `SELECT, INSERT` only, canonical policy, and the ADR-007 composite FK). No `TO meterlog_definer` policy on either — assertion 5 allowlists the three identity tables only.

**The harness — all three wrinkles closed, and each proven closed by a mutation.**

1. **Migrator-seeded tenant hook (wrinkle 1).** The matrix generated tenant ids with `randomUUID()` and never created rows for them. That went unnoticed for two steps only because the sole table it ran against was a scratch table with no foreign keys; `assets.tenant_id REFERENCES tenants(id)` fails its first seed with `23503`, and the fixture cannot fix it (the app role is `SELECT`-only on `tenants`). `seedIsolationContext` now seeds tenants, a user and one parent asset per tenant as the migration role. **M7 proves it is load-bearing:** remove the hook and the entire file aborts in `beforeAll` with `23503` on `assets_tenant_id_fkey`, 21 tests skipped.
2. **`dependsOn` RETIRED, explicitly.** ADR-004 promised fixtures would "declare their FK dependencies so the harness can seed parents first". **Nothing ever read the field** — the matrix is a `describe.each` over independent tables, so there was no point at which one fixture's output could become another's input. It was documentation shaped like code. The _parent-first seeding_ half of that promise was real and is now delivered centrally by `seedIsolationContext`; children read their parent out of `IsolationSeedContext` instead of declaring a dependency nothing could satisfy.
3. **`appWrites` — declared, never derived.** Read from an explicit per-fixture declaration, not `has_table_privilege`, which would make the assertion agree with whatever the grant happens to be and catch nothing. Matrix case 2 asserts zero-rows-affected where a write is declared and outright refusal where it is not. **Note it is not simply "is it append-only":** `assets` is mutable and still declares `delete: false`, because it is soft-deleted and holds no `DELETE` grant — so the matrix proves the no-hard-delete property as a side effect. **Catalog assertion 13** binds the declaration to the grant: an append-only table must hold **exactly** `SELECT, INSERT`.

**A finding that changed the assertions: RLS rejection and missing-grant rejection SHARE SQLSTATE `42501`.** Measured live, not assumed:

| rejection               | SQLSTATE | message                                                          |
| ----------------------- | -------- | ---------------------------------------------------------------- |
| RLS `WITH CHECK`        | `42501`  | `new row violates row-level security policy`                     |
| missing table privilege | `42501`  | `permission denied for table ...`                                |
| composite-FK mismatch   | `23503`  | `violates foreign key constraint asset_events_asset_tenant_fkey` |

Postgres uses `insufficient_privilege` for both "a policy refused this row" and "this role was never granted this command" — two mechanisms, one code. A negative asserting only `42501` stays green when the _other_ layer does the refusing, which is the same trap that made the step-5 RBAC gate untestable until the guard and the function body were given distinct codes. So `capturePgFailure` returns **both halves** and every negative asserts the pair; the FK negative additionally asserts it is **not** the RLS message.

**The mutation sweep — 8 mutations, 7 caught, 1 declared equivalent with reasoning.**

| #   | mutation                                                         | result                                                                                             |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| M1  | `assets` policy `WITH CHECK (true)`                              | **caught** — 1 test (foreign-tenant INSERT no longer rejected)                                     |
| M1b | `WITH CHECK` omitted entirely from the `FOR ALL` policy          | **GREEN — equivalent mutant, declared** (see below)                                                |
| M2  | `NULLIF` dropped from the `assets` policy                        | **caught twice** — catalog assertion 8 (structural) _and_ a behavioural `22P02` in the matrix      |
| M3  | `assets` policy keyed on `true`                                  | **caught** — 4 tests (read isolation, cross-tenant UPDATE, INSERT rejection, fail-closed baseline) |
| M4  | composite FK dropped                                             | **caught** — both ADR-007 negatives (app role and migration role)                                  |
| M5  | `GRANT UPDATE ON asset_events` — the one-line silent widening    | **caught twice** — catalog assertion 13 _and_ the matrix's append-only case                        |
| M6  | append-only declaration flipped (`appWrites.update = true`)      | **caught** — the fixture/declaration agreement check _and_ the matrix UPDATE case                  |
| M7  | migrator tenant-seeding hook removed                             | **caught** — whole file aborts, `23503`, wrinkle 1 reproduced exactly                              |
| M8  | partial `WHERE deleted_at IS NULL` dropped from the serial index | **caught twice** — the structural index pin _and_ the re-registration positive (`23505`)           |

**M1b is an honest equivalent mutant, not an escaper waved through.** Omitting `WITH CHECK` from a `FOR ALL` policy is genuinely equivalent, because Postgres defaults it to the `USING` expression — the behaviour ADR-004 documents. No test can distinguish them, and none should. **The clause is still written out in full**, for the reason ADR-004 gives: the implicit coupling means any future narrowing of `USING` would silently narrow write permission too. The mutation that removes real protection is `WITH CHECK (true)`, which is M1, and M1 is caught.

All mutations reverted; policies, grants and the constraint byte-verified against the catalog afterwards (both policy clauses carrying the canonical `NULLIF` expression, `assets` at `SELECT, INSERT, UPDATE`, `asset_events` at `SELECT, INSERT`, the composite FK present).

**171 tests green, twice in a row** (the second run confirms teardown is idempotent — domain rows are removed before the identity rows they reference, so a later suite's blanket `DELETE FROM public.tenants` cannot hit `ON DELETE RESTRICT`). Lint, typecheck, build and format clean.

**The three surfaced gaps, all closed at the gate (author decisions)**

- **`assets.serial_number` is now UNIQUE PER TENANT, AMONG LIVE ROWS** — `assets_tenant_serial_live_key`, partial on `deleted_at IS NULL`, replacing the plain index rather than stacking on it. Follows the `memberships_user_tenant_live_key` precedent (ADR-006 §2) exactly: re-registering a decommissioned serial is the analogue of re-inviting a revoked member. `assets_tenant_id_idx` is kept deliberately — the partial index cannot serve queries that must see soft-deleted rows, including the RLS check on the UPDATE that _performs_ the soft delete. No separate plain `serial_number` index: every lookup is tenant-scoped under RLS, so the composite serves them all, and a second would be write cost for nothing (the rejected `memberships(user_id)` reasoning again). **Timing was the argument for deciding now:** a unique index can only be created if existing data satisfies it — today the table is empty and it cannot fail; after step 10 the same change is a reconcile-live-duplicates migration that can fail against production data.
- **`asset_event_type`: the six values stay, and the EMISSION CONTRACT is now recorded** in ARCHITECTURE §9.2, cross-referenced from the migration. The two points that are not inferable from the values: registration emits **both** `created` and `installed` (every status an asset has held must have an event that put it there, or the log cannot be replayed); and the enum encodes **transitions, not states** — `activated` and `maintenance_completed` both land on `active`, so a lookup table keyed on the resulting status is wrong by construction. `created` is kept rather than collapsing to five values so that a future bulk import of already-active assets emits `created` + `activated` with no special case.
- **`created_by` stays unindexed, and the judgment is now recorded** in the migration rather than left to read as an oversight: nothing queries events by actor, and the unindexed-FK penalty falls on parent deletes, which cannot happen (ON DELETE RESTRICT plus soft-deleted identity rows). Second instance of the same judgment as ADR-006 §2, which is worth being visible as a pattern.

**A second measured finding — Prisma DISCARDS the constraint name on unique violations.** The serial negative was specified to assert the index name, and that turned out not to be available. Measured:

| path                           | `meta.code` | `meta.message`                                                 |
| ------------------------------ | ----------- | -------------------------------------------------------------- |
| app role (Prisma query engine) | `23505`     | `Unique constraint failed: ` — **name stripped, target empty** |
| migration role                 | `23505`     | `Key (tenant_id, serial_number)=(...) already exists.`         |

So `assets_tenant_serial_live_key` cannot be asserted from the app-role error at all. Weakening the negative to a bare `23505` was not acceptable — **any** unique constraint on the table satisfies that, including `assets_id_tenant_key`, which exists for a completely different reason. Closed with two assertions that together give what the message match would have: a **structural pin** on the index (name, columns, and the `WHERE (deleted_at IS NULL)` predicate, read from `pg_indexes`), and a **migration-role sibling** that recovers the violated column pair from the un-normalised error. The app-role negative keeps its `.not` guards against `/row-level security/` and `/permission denied/`, so it still cannot pass because some other layer refused the row.

**ADR-004's dangling promise closed (`DECISIONS.md`).** The fixture-registry bullet still said factories "declare their FK dependencies so the harness can seed parents first" — the `dependsOn` mechanism retired in this phase because nothing ever read it. Amended in place with the same restated-not-deleted framing used for the superseded `users` line: the declaration half never worked, the parent-first seeding half was real and is now delivered by `seedIsolationContext`. The source-of-truth ADR and the code now agree, which is what makes wrinkle 2's retirement actually explicit rather than merely true in a code comment.

**Not in Phase 1 (boundary held):** no `readings`, no API or event-emission wiring, no `maintenance_records`, and **no refresh of `ISOLATION.md` / `README.md` / `PORTFOLIO.md`** — retiring their "domain isolation is step 6" caveats is a later turn against a merged step 6, not this phase's work. Those three documents still describe the fixture registry as empty, which is now **stale, and knowingly so**.

**Next**

- Phase 2 — `readings`, reusing the now-proven composite-FK and append-only patterns. `readings` joins `APPEND_ONLY_TABLES` and the consistency proof extends to a second child.

---

### 2026-09-09 — Step 5 Phase 3: the cross-layer sweep, the real-revoke proof, and Step 5 closeout (§11 step 5)

**Done**

- **Revocation-on-next-request, driven by a real revoke** (`test/api/revocation.spec.ts`). Step 4 proved this property against a hand-written `UPDATE ... SET deleted_at` executed by the migration role — a fixture standing in for a feature that did not exist. The revoke is now performed the way an admin performs it: over HTTP, through the RBAC gate, through `revoke_member`, as the app role. M's request 1 succeeds on pooled backend P; the admin's `DELETE /users/:id` returns 204 and the soft delete is **asserted** (so a silent no-op cannot make the next 403 look like proof); M's request 2 fails closed **403 `MEMBERSHIP_REVOKED`** with `pg_backend_pid` asserted equal to P, baseline-subtracted. The admin's delete runs on that same backend _between_ M's two requests, so request 2 arrives on a connection whose last transaction belonged to a different user — a sharper version of the reuse hazard than step 4 had.
- **ADR-006 §7 amendment (5)** — the `MB002` anti-enumeration property recorded as a design rule with the refactor that would reopen it, same shape as the invite-hash vector: cross-tenant and absent both return one indistinguishable 404, and the "more helpful error messages" pass that splits them into 403/404 _is_ the oracle.

**The mutation sweep — 7 mutations, 7 caught, and TWO of them escaped first**

Both escapers were real defects with no coverage, not equivalent mutants, and both were made reachable rather than waved through.

- **Escaper 1 — the lock ORDER.** Flipping it (target row locked before the admin set) was expected to redden the concurrent test with `40P01`. It **passed**. Diagnosis: that test forces the schedule "T1 runs its entire call to completion, then T2 starts", and a deadlock needs both transactions to hold their own target row _before_ either scans the admin set — they must overlap **inside** the statement. The determinism that makes it a real proof of the READ COMMITTED race is exactly what makes it blind to the lock order. Two different properties; the orchestration that proves one excludes the other. Fixed with a second test that removes the orchestration entirely — both self-demotions fired simultaneously, autocommit, six rounds. Correct lock order makes a deadlock **impossible**, so it cannot flake on correct code; the flipped order now reddens 5/5 runs on round 0-2 with the exact 40P01 diagnosis.
- **Escaper 2 — the RBAC gate itself.** Removing `@RequiresRole('admin')` from all three routes left the **entire** Phase 2 suite green. Diagnosis: the definer body refuses the same callers with `MB001`, which mapped to a 403 carrying the _same_ `FORBIDDEN_ROLE` code — the two responses were byte-identical, so nothing could tell which layer acted. Defence-in-depth doing its job, and simultaneously an untestable claim. Fixed by making the layers distinguishable: the gate answers `FORBIDDEN_ROLE`, the function body answers `NOT_ADMIN`, both 403. Dropping the gate now reddens three tests with `expected 'NOT_ADMIN' to be 'FORBIDDEN_ROLE'`. The operational payoff is real too — `NOT_ADMIN` reaching a client means the request got past the gate and was stopped by the database.

All seven reverted; function bodies byte-verified (NULLIF present, admin-set lock ordered before the target, no mutation residue, owner `meterlog_definer`) and the three route decorators restored.

**150 tests green** (was 146). Lint, typecheck, build and format clean.

**Step 5 is done. What it proved**

Three membership-write definer functions with §7 body-level authorization proven **directly, with nothing in front** (Phase 1); the last-admin guard with a genuinely concurrent negative and now a lock-order negative too; the RBAC guard and role-gated write endpoints without reintroducing the guards-before-interceptors defect, reads left un-gated per §3 (Phase 2); the cross-tenant enumeration oracle closed and _tested_ (Phase 3); revocation-on-next-request behind a real revoke (Phase 3); every negative proven non-vacuous by a mutation. The Phase 1 backstop suite is byte-identical to what merged and green throughout — no body check was relaxed on the strength of the guard.

**What Step 5 does NOT do — stated plainly so "RBAC landed" does not imply more than it should**

- **Domain isolation is still step 6.** `assets`, `readings`, `maintenance_records` do not exist. The catalog-driven isolation matrix still generates **zero cases against real tables** — `ISOLATION_FIXTURES` is empty and `memberships`/`users`/`tenants` are registered as bespoke-handled. The isolation proof today covers the identity/tenancy tables only.
- **No `audit_log` row is written for any membership mutation**, and no invited person can log in. Both are owed by this step and paid later — see the two forward debts immediately below.

**TWO FORWARD DEBTS NOW POINT AT STEP-5 CODE — both are owed by this step, neither is paid here.** Listed together so whoever opens this entry next sees both at once instead of discovering them a step apart:

1. **The audit retrofit — step 7.** The membership mutations (`invite_member`, `change_member_role`, `revoke_member`) are exactly the writes where role-at-time-of-action matters most, and they land **two steps before** the audit module, so step 7's "audit_log write on every mutation" will not cover them unless it goes back for them. Step 7 must retrofit audit writes onto these three functions, and that is also where **OPEN-4** is finally answered. Unresolved; recorded in `DECISIONS.md`.
2. **The set-password / invite-token flow — first slice of step 8, hard deadline step 10 (deploy).** `invite_member` creates an identity with a sentinel hash that authenticates against nothing, so today an invite produces a person who can never log in and cannot self-recover (registering their own org is a 409 — OPEN-1). This is **not** an acceptable v1.0 limitation: essential scope includes the admin user-management UI (`PROJECT_BRIEF.md` §2 line 32) and the DoD requires the frontend to cover all essential journeys (§12 line 265), so an invite button that dead-ends fails the DoD on its own terms. Scheduled to step 8 because that is where the auth pages live (§11 line 251) and because it enables the strongest step-9 e2e journey — _admin invites a colleague → they set a password → they log in → they see exactly one workspace_. The real deadline is **step 10**: before deploy the only people this can lock out are test fixtures; after deploy they are real. Enforced by a **DoD checkbox** in `PROJECT_BRIEF.md` §12 rather than by this note, because markers drift and checklists block. Full reasoning in `DECISIONS.md`.

**Next**

- Step 6 — domain entities (assets, readings, maintenance records), and the fixture registry that finally makes the generic isolation matrix generate real cases.

---

### 2026-09-09 — Step 5 Phase 2: the RBAC gate and the role-gated endpoints (§11 step 5)

**Done**

- **`@RequiresRole('admin')`** (`src/common/auth/requires-role.decorator.ts`) — route metadata, enforced at **step (5) of the interceptor**, immediately after the role is resolved from the live database read. Same shape as `@RequiresSession()`, for the same reason.
- **Memberships module** (`src/memberships/`) — `GET / POST / PATCH / DELETE /users`, `:id` = **membership id**. Writes admin-gated; **`GET` deliberately un-gated** per ADR-006 §3, with the absence of the decorator commented so it does not read as an oversight.
- **SQLSTATE → HTTP mapping** keyed on `PrismaClientKnownRequestError.meta.code`, verified to carry the custom code structurally (`P2010`, `meta = { code: 'MB001', … }`) rather than only in the message: `MB001` → 403, `MB002` → 404, `MB003` → 409, `23505` → 409. `MB002` maps to 404 so "belongs to another tenant" and "does not exist" stay indistinguishable.
- **`@RequiresRole` implies `@RequiresSession`** in the interceptor, so forgetting one decorator cannot leave a gated route anonymously reachable.

**The ordering defect, measured rather than avoided by argument**

The decorator's comment used to be a claim. It is now an observation: a `CanActivate` role guard reading `requireRequestContext().role` was written, wired to `POST /users`, and the suite went red on the **admin's** invite — `expected 201, got 500` — before any non-admin case was reached. The guard does not mis-handle non-admins; it **500s every request**, admin included, because at guard time no request has a context yet. That is the Phase 4 session-guard defect one layer up. Probe reverted; the finding is recorded in the decorator and in ARCHITECTURE §9.

**Verified over real HTTP, with negatives (146 tests, was 127)**

Every case goes through supertest with real signed session cookies through the bound interceptor. Calling `MembershipsService` directly would be testing a world where the gate does not exist.

- **Positives:** invite an unknown email (identity + membership), invite an existing email (attaches — one human, two memberships, original untouched), change a role, revoke (asserted **soft** — the row survives, which is what re-invite needs). Last-admin surfaces as a clean **409 `LAST_ADMIN`**.
- **Negative — non-admin:** technician gets **403 `FORBIDDEN_ROLE`** on POST / PATCH / DELETE, each paired with a database assertion that nothing changed. Self-promotion to admin — the escalation DECISION B exists to prevent — is now attempted through the front door and refused. **Plus the pairing case: the same technician's `GET /users` still returns 200**, so the three 403s cannot be passing because the controller was unreachable.
- **Negative — semantic cross-tenant:** admin of A against a **real, live** membership in a real tenant B ⇒ **404**, with B asserted unchanged and asserted live first so the negative is not vacuous. A well-formed nonexistent id returns the same 404.
- **No session ⇒ 401**, not 403 and not 500. **Authenticated with no active workspace ⇒ 403** — a null role fails the gate rather than passing it.
- **Role follows the active membership:** one person, admin in Beta and technician in Acme, switching between them — 201 in one workspace and 403 in the other. And a role changed underneath a live session is refused on the **next** request, with no re-login.

**The Phase 2 gate condition — the Phase 1 suite still passes, unchanged**

`git diff main -- test/db/membership-writes.spec.ts` and the migration are **empty**: neither was touched. The suite runs **30/30 green** alongside the new endpoints. No body check was relaxed on the strength of the guard, which is the way DECISION B would silently revert to option A.

**Not done, and not claimed.** No mutation sweep — Phase 3, and its own reviewable artifact. No revocation-on-next-request proof: the revoke _endpoint_ exists and authorizes here, but the proof that a revoked member's subsequent request fails closed on the pooled connection is Phase 3. The **step-7 audit retrofit** stays a referenced forward marker, unresolved.

**Next**

- Phase 3 — the cross-layer mutation sweep (drop the gate → the HTTP negatives redden; drop a body check → the Phase 1 direct-call negatives redden), and revocation-on-next-request driven by a real `revoke` write with the `pg_backend_pid` discipline.

---

### 2026-09-09 — Step 5 Phase 1: the membership-write definer functions and §7 body-level authz (§11 step 5)

**Two gaps closed first, both recorded as ADR-006 §7 amendments before any code**

1. **The last-admin lockout — a genuine gap.** §7 specified the three endpoints and the standing rule and said nothing about who may be demoted or removed. Decided as **option A**: refuse a change that would leave a tenant with **zero live admins**; permit "hand over then leave". The guard is simple because of a **structural collapse** — clause (a) requires a live-admin caller and the partial unique index allows one live membership per `(user, tenant)`, so demoting or revoking _anyone else_ proves a second live admin exists. **"Last admin" and "self-action" are the same condition**; there is no cross-user lockout case.
2. **The invite credential mechanism** — flagged under-specified by §7 itself, and unavoidable because `users.password_hash` is `NOT NULL`. Resolved as a **sentinel hash** derived from `ARGON2_OPTIONS`. The **consumed-email dead-end is accepted and recorded** (DECISIONS), together with the requirement it hands the later set-password flow: pending-invite accounts are **not distinguishable from credentialled ones by any column today**.

**Done**

- **`20260909000000_membership_write_functions`** — `invite_member`, `change_member_role`, `revoke_member`. Every ADR-004 hardening carried over, and **every operator schema-qualified** (`OPERATOR(public.=)` for citext, `OPERATOR(pg_catalog.=)` for uuid/enum) — the citext lockout was this exact class and it is silent.
- **§7 enforced in each body:** the acting user comes from `app.current_user`, NULLIF-guarded, **never from a parameter**; the target is resolved **by membership id** and scoped to `app.current_tenant`. Unset _and_ empty-string context fail closed.
- **Custom SQLSTATEs `MB001`/`MB002`/`MB003`**, and the reason is a vacuity argument: the idiomatic `42501` is also what Postgres raises for a plain privilege denial, so a test asserting it would pass just as happily against a misconfigured GRANT that never reached the body. `MB002` covers "another tenant's" and "does not exist" with **one** code, so the function is not an oracle for ids the caller cannot see.
- **`GRANT UPDATE ON public.memberships TO meterlog_definer`** — surgical, and **the moment DECISION B's grant-level backstop weakens by design**. Catalog assertion 6 is narrowed from "no UPDATE on ANY table" to an **equality** on the exact new shape (`memberships:UPDATE` and nothing else); still no UPDATE on `users`/`tenants`, still no DELETE/TRUNCATE/REFERENCES anywhere. `EXPECTED_DEFINER_FUNCTIONS` 2 → 5. Assertions 11/12 are catalog-driven and scaled to the new functions with **no edit** — confirmed live: all five are executable by the app role, none by PUBLIC, all with `search_path` pinned.

**Verified against live Postgres, with negatives — and no Nest in the process (127 tests, was 97)**

Every call in `test/db/membership-writes.spec.ts` is made **as `meterlog_app` with the GUCs set by hand**. That is the property under test, not a convenience: the RBAC guard is Phase 2 and does not exist yet, so these negatives cannot be the guard's. A negative that ran through HTTP would prove the guard and leave B indistinguishable from the rejected option A while looking green.

- **(a) non-admin rejected, all three functions** — including a technician promoting **themselves**, the exact `UPDATE … SET role='admin' WHERE user_id=<self>` that returned `UPDATE 1` at the Phase 1 gate. Also: a real-but-unaffiliated user, and a **revoked** admin (liveness is part of the check).
- **(b) cross-tenant rejected** — admin of A against B's **real, live** membership, asserted present first so the negative is semantic, not a missed lookup. Invite's cross-tenant case **collapses onto (a)** (it takes no tenant argument), asserted so the collapse reads as a property rather than a missing test.
- **Fail-closed context** on a **reused** connection: `pg_backend_pid` asserted equal across two transactions, the GUC asserted to have reverted to `''`, and the refusal asserted to be `MB001` and **not** `22P02`.
- **Atomicity under autocommit** — GUCs set at **session** scope so there is no wrapping transaction to hide a non-atomic function; forced with `CHECK (false) NOT VALID`, no orphan identity survives.
- **The last-admin guard, sequentially and CONCURRENTLY.** The concurrent case forces the interleaving rather than hoping for it: T1 holds its locks uncommitted, T2 blocks, and **a third connection asserts T2 is genuinely waiting on a `Lock` in `pg_stat_activity`** before T1 is released — the tell that plays the role `pg_backend_pid` plays for connection reuse. T1 commits, T2 re-evaluates under READ COMMITTED, sees itself as the last admin, and is refused. The tenant is left with exactly one admin.
- **Positives:** invite attaches to an existing identity **case-insensitively** (the `OPERATOR(public.=)` path), never overwrites an existing hash, creates identity + membership for an unknown email with a sentinel whose `m=`/`t=`/`p=` are **parsed and compared to `ARGON2_OPTIONS`**, re-invite after revoke works, revoke soft-deletes, double-revoke is refused.

**Non-vacuity sweep — 5 guard drops, 5 caught, each by its intended test.** Caller-admin check → the non-admin negative reddens. Target-in-tenant check → the cross-tenant negative reddens. Last-admin guard → the sequential self-demotion negative reddens. `NULLIF` → the reused-connection test reddens with `invalid input syntax for type uuid: ""` instead of `MB001` — the 500-not-403 class, exactly as CLAUDE.md describes it. **`FOR UPDATE` → bare count → the concurrent test reddens on the interleaving assertion itself** ("T2 never actually blocked"), which is the sharpest result of the five: it proves that assertion has teeth and is not decoration. The full cross-layer sweep is Phase 3.

**Not done, and not claimed.** No RBAC guard, no `@RequiresRole`, no endpoints, no Nest wiring — Phase 2. No revoke-over-HTTP re-verification — Phase 3. The **step-7 audit retrofit** for these mutations remains a referenced forward marker, unresolved.

**Next**

- Phase 2 — the RBAC gate and the role-gated endpoints. The gate belongs where the resolved context exists (metadata read **inside** the interceptor, as `@RequiresSession()` is), not in a `CanActivate` guard: Nest runs guards **before** interceptors, and the Phase 4 500→401 defect is the same hazard in different clothes.

---

### 2026-09-08 — Step 4 Phase 4: the auth endpoints and the step-4 acceptance suite (§11 step 4)

**Done**

- **Five endpoints** (`src/auth/`): `POST /auth/register`, `POST /auth/login`, `POST /auth/switch`, `GET /auth/me`, `POST /auth/logout`, wiring ADR-006's resolved OPEN-1/2/3 behaviours. Argon2id password hashing (ADR-001) via `@node-rs/argon2` — prebuilt bindings, so CI needs no compiler.
- **The interceptor is now bound globally** (`APP_INTERCEPTOR`), the wiring deferred through Phase 3. Global rather than per-route is correct because it opens a transaction only when a session is actually present, so `/health`, register and login pass straight through untouched.
- **`HttpExceptionFilter`** normalises every error to the project envelope `{ error: { code, message, details? } }`, including `ValidationPipe` rejections, which otherwise ship Nest's own shape.
- **`@RequiresSession()`** marks the routes that need identity; the interceptor enforces it. See the two defects below for why it is not a guard.
- New dev dependency `@types/express`; new runtime dependency `@node-rs/argon2`.

**Two defects found while building, both fixed rather than papered over**

1. **A protected route with no session returned 500, not 401.** The interceptor deliberately does not reject session-less requests — `/health`, register and login legitimately have none — so a handler calling `requireRequestContext()` threw a raw `Error` and the filter turned it into a 500. The refusal was right; the status and the reason were wrong. Worse, the first version of the acceptance test **asserted the 500**, which documents a defect instead of catching it. Now `@RequiresSession()` + a 401 with `UNAUTHENTICATED`, and the test asserts that.
2. **The obvious fix — a `CanActivate` guard — rejects every request, authenticated or not.** Nest runs **guards before interceptors**, so the guard cannot see a request context the interceptor has not established yet. Observed, not reasoned about: every acceptance test went 401 at once. A guard could re-read and re-verify the session itself, but that means a second Redis round-trip per request and two places deciding what a valid session is. So the _declaration_ lives at the route as metadata and the single _enforcement_ point stays inside the interceptor that already resolved the session.

**Verified over real HTTP, with negatives** — every case goes through supertest with real signed session cookies through the bound interceptor. Calling `AuthService` directly would bypass the interceptor and prove strictly less, the same shape as a rolled-back wrapper hiding non-atomicity.

- **DoD 1 — register → login → `/auth/me` round-trips.** 201 → 200 with the single membership auto-selected → `/auth/me` naming the person, the active workspace and its role. Cookie asserted `HttpOnly` and `SameSite=Lax`. Logout destroys the session and the same cookie then 401s.
- **Risk A — the interceptor is genuinely live.** _Positive:_ `/auth/me` returns real content, which is only possible if both GUCs were set — `users` and `tenants` are under FORCE RLS with policies keyed on them. _Negative:_ no cookie, a garbage cookie, and a well-formed-shape-but-bad-signature cookie all return **401**, not 200-with-nothing. Pre-auth routes still work, so the global binding costs them nothing.
- **DoD 2 — the multi-membership switch.** Two memberships ⇒ login returns 200 with `activeWorkspace: null` and both workspaces; `POST /auth/switch` moves the active tenant and it persists to the next request.
- **DoD 3 / Risk B — unauthorized switch.** Proven against a **real, existent second tenant with a real membership belonging to someone else** — 403 `NOT_A_MEMBER`, and nothing of that tenant becomes reachable afterwards. A malformed uuid would only have proven that `@IsUUID` runs; it says nothing about the boundary. The nonexistent-but-well-formed uuid case is covered separately, also 403.
- **DoD 4 — revocation over HTTP.** Request 1 succeeds; the membership is revoked (`UPDATE 1`, asserted); request 2 returns **403 `MEMBERSHIP_REVOKED`** on the **same pooled backend** — pids read from `pg_stat_activity`, baseline-subtracted so a stray connection from another suite cannot make the assertion vacuous. The pooled-connection discipline does not lapse because there is an HTTP layer on top. Request 3 then succeeds with an empty workspace list rather than 403-looping, because the 403 cleared the session's active tenant.
- **DoD 5 — role follows the active membership.** The same person is `admin` in one workspace and `technician` in the other, switching between them; and a role changed underneath a live session is picked up on the very next request.
- **DoD 6 — isolation holds through the API.** A member of two tenants sees exactly those two and never the third.
- **OPEN-1** duplicate register ⇒ **409** keyed on SQLSTATE `23505`, with no orphan tenant left behind, and case-insensitively (matching the index). **OPEN-2** zero memberships ⇒ **200** with no active tenant, landing in the no-active-tenant state without 403-looping. Login failures are byte-identical for unknown-email and wrong-password, and the no-such-user branch still performs an argon2 verify against a real dummy hash so the timing does not answer the question either.

**Mutation sweep — 6 mutations, 6 caught** (after making one reachable).

Interceptor unbound (**13 red** — the single most consequential wiring in the phase); switch authorization removed (2 red, both against the real-second-tenant case); the 409 keyed on the constraint name in the message rather than SQLSTATE (2 red — the Phase 2 carry-forward, now proven rather than asserted); `@RequiresSession` not enforced (2 red); login skipping password verification (1 red); and the app-side liveness predicate dropped from the workspace query.

**The one that initially escaped, and why it mattered.** Dropping `AND m.deleted_at IS NULL` from `readWorkspaces` reddened nothing — the `JOIN` to `tenants` is filtered by `tenants_workspace_list`, which carries liveness of its own, so a workspace held **only** through a revoked membership is dropped by the join regardless. The obvious revoked-workspace test therefore proves nothing about that predicate. The reachable case is **re-invitation**, which ADR-006 §2 designs the _partial_ unique index for: `(user_id, tenant_id) WHERE deleted_at IS NULL` permits one live membership alongside any number of revoked ones for the same tenant. The tenant is then visible through the live row, the join keeps **both**, and the workspace appears twice — the duplicate carrying whatever role the person held before removal. In the added test that stale role is `admin` against a current `auditor`, so without the predicate the switcher would offer someone admin of a workspace they are an auditor in. Same treatment as Phase 3's `NULLIF`: diagnosed as unreachable-by-construction, then made reachable through a real scenario rather than left flagged.

**Two boundaries closed at the gate, and one cost priced.**

- **Logout is now a two-assertion negative, split into two tests so each fails on its own.** It was asserted positive-only ("the cookie stops working"), which is a 401 doing a negative's job: a cookie can be refused for reasons unrelated to the session's existence — signature, rotation, expiry — while the Redis key sits there replayable server-side. Now: the session key is read **directly out of Redis**, asserted present before logout (so a mistyped prefix cannot masquerade as a clean logout) and absent after; and the exact pre-logout cookie is separately replayed and refused. A cookie-only logout reddens both.
- **The argon2 timing-equalisation hash is bound to the production parameters, not confirmed against them.** The no-such-user login branch runs a real argon2 verify so "unknown email" costs what "wrong password" costs. Both call sites previously omitted options and agreed **by coincidence of library default**, which is a drift vector regardless of whether the numbers match today — tune production cost, forget the dummy, and the enumeration oracle reopens with every test green. There is now one exported `ARGON2_OPTIONS`, used by both, and a test that **parses `m=`, `t=`, `p=` out of the dummy hash and out of a hash taken from the real registration path** and asserts they agree. Not a comment; a test.
- **The interactive-transaction-per-request cost is now on the record** (ARCHITECTURE §16.2) rather than implicit. Every authenticated request holds a transaction for its duration — the price of `SET LOCAL`-scoped RLS. It matters because of how it fails: pool exhaustion presents as an **apparent hang**, rising latency with no error rate, and `maxWait` timeouts are the one signal that distinguishes exhaustion from a slow query. Priced deliberately, not stumbled into.

**Mutation sweep on the two blockers — 5 mutations, 4 caught, 1 equivalent.** Cookie-only logout and clear-active-tenant-instead-of-destroy each redden both logout tests. A dummy hash cheaper than production, and production tuned upward with the dummy left behind (the actual drift scenario), each redden the parameter assertion. The fifth — reverting the dummy to an options-free call — reddens nothing, and correctly so: library defaults currently equal `ARGON2_OPTIONS`, so it is a **behaviourally equivalent mutant**, not an untested guard. It is the pre-fix state, and the reason the explicit binding exists is to remove the vector rather than to change today's behaviour.

**Not done, and not claimed.** No RBAC guard and no role-gated endpoints — step 5. No membership-write definer functions (invite / revoke / change-role); when they land they are bound by the standing rule in ADR-006 §7, and their gate requires **live authorization negatives**, not just atomicity. No frontend: the empty-state page for the zero-membership login is step 8, and only the API behaviour exists today.

**Next**

- Step 5 — RBAC, and the admin-checking membership-write definer functions Decision B requires. `EXPECTED_DEFINER_FUNCTIONS` must be edited deliberately when they land.

---

### 2026-09-08 — Step 4 Phase 3: the two-GUC interceptor and per-request re-verification (§11 step 4)

**Done**

- **`TenantContextInterceptor`** (`src/common/tenant-context/`) — the request machinery from ADR-004 + ADR-006 §4. One interactive transaction per authenticated request, because `SET LOCAL` is scoped to a transaction and therefore to the single pooled connection it holds. Ordering is **verify, then set**: set `app.current_user`; re-verify the claimed tenant with it passed as a **bound parameter**, never read from a GUC; zero rows ⇒ 403 with `app.current_tenant` never assigned; one row ⇒ set the tenant GUC and use the freshly-read role.
- **`RequestContext`** (`src/common/request-context/`) — `AsyncLocalStorage` carrying the transaction client, user, tenant and re-verified role. `requireRequestContext()` throws rather than returning an empty context: a handler reaching for tenant scope outside a request is a bug, and it must be loud rather than silently unscoped.
- **`SessionService`** (`src/common/session/`) — Redis-backed sessions (ADR-001), signed-cookie ids (HMAC-SHA256 over a 128-bit id, `timingSafeEqual`). The client holds only an opaque id, so it cannot forge an active tenant — the "belt" half of ADR-006 §4. **New dependency: `ioredis`**, executing ADR-001's recorded choice; Redis was already in compose, CI and `.env`.
- **`CommonModule`** provides all three. The interceptor is deliberately **not** bound via `APP_INTERCEPTOR` yet — there are no authenticated routes until Phase 4, and binding it globally now would wrap `/health` in an interactive transaction for nothing.
- **CI gained `SESSION_SECRET`.** `SessionService` refuses to construct without one, on purpose, so an unsigned-cookie deployment cannot happen by accident.

**Verified against live Postgres, with negatives**

Every case runs the **real interceptor**, and the app client is pinned to `connection_limit=1` because the failure surface this phase exists to cover is **pooled-connection statefulness**, not policy correctness — Phase 1 already proved the policy.

- **The hard one — revocation between two requests on a reused connection.** Request 1 succeeds with `app.current_tenant = A`; the membership is revoked between requests (`UPDATE 1`, asserted, so the fixture cannot silently no-op); request 2 on the **same backend** throws `ForbiddenException`, **the route handler never runs**, and the connection is left with `app.current_tenant = ''` and zero rows of A reachable. The vacuity guard is explicit: `pg_backend_pid()` is asserted equal across the two requests, because a request 2 landing on a fresh connection would prove nothing about pooled statefulness and would pass either way. (Confirmed separately that pids do differ across connections, so the assertion has real content.)
- **The session's active tenant is cleared on the 403**, so a third request stops re-asserting a workspace the user no longer holds — it succeeds with no tenant context rather than 403-looping.
- **Role changes follow the membership, not the session.** The session still cached `admin`; after an `UPDATE ... SET role = 'auditor'` the very next request reports `auditor`, with the stale session copy still sitting there unused.
- **GUC hygiene across pooled requests.** M-in-A followed by N-in-B on the same backend: no bleed, correct counts, and an unauthenticated third request gets no context at all. Asserted on **both a fresh and a reused connection**, because the ADR-004 heisenbug is asymmetric — `current_setting` returns NULL on a connection that has never had the GUC set, and the **empty string** once `SET LOCAL` has touched it. Checking only one is how that bug survived review the first time.
- **Verify-before-set ordering.** The behavioural cases cannot separate the two orderings — both end in a 403 with a rolled-back transaction and no residue — so ordering is asserted on the **emitted SQL** via Prisma query events: `set_config('app.current_user')` → the memberships re-verify → `set_config('app.current_tenant')`.
- **Liveness through the interceptor.** OPEN-5's DB-side claim, now exercised end-to-end rather than against the policy in isolation: a revoked membership yields zero rows at the re-verify ⇒ 403, with the soft-deleted row asserted still present so the test cannot pass on a fixture that failed to revoke anything.
- **Fail-closed on poisoned context:** a session naming a non-existent user, a tampered cookie signature, and a valid signature over a destroyed session all get no context.

**Mutation sweep — 9 mutations, 9 caught** (after one fix, below).

`verify-after-set`; re-verify skipped entirely; `SET` instead of `SET LOCAL` on the tenant GUC; the same on the user GUC; the `NULLIF` guard dropped; `deleted_at IS NULL` dropped from the re-verify; the re-verify moved above the user-GUC assignment; that same reordering plus the dropped `NULLIF`; and the tenant read from a GUC instead of a bound parameter.

**The one that initially escaped, and what it taught.** Dropping the `NULLIF` from the re-verify reddened _nothing_ — because the interceptor sets `app.current_user` immediately beforehand, so `current_setting` always returns a valid uuid and the guard never fires. It was unreachable-by-construction, not unnecessary: mutations 7 and 8 differ by that guard alone, and the failure modes differ exactly as ADR-004 predicts — **with** the `NULLIF` the misordered code still throws `ForbiddenException` (fail closed), **without** it a `PrismaClientKnownRequestError`, i.e. a 500 instead of a 403. Rather than leave it flagged-but-untested, a reachable case was added: a session with a **blank** `userId` writes `''` into the GUC, which is exactly the state the guard exists for. That is a real poisoned-session state (corrupted Redis value, or a future path that forgets to populate it), not a contrivance, and the property — fail closed with 403, never 500 — is one worth holding. Dropping the `NULLIF` now reddens it.

That test also demonstrated the heisenbug in miniature: run in isolation it **passes** under the mutation, because a fresh connection returns NULL rather than `''`. It only fails in a full run, once the connection has been reused. A per-test-isolation habit would have hidden it.

**Not done, and not claimed.** No endpoints — no `/auth/register`, `/auth/login`, `/auth/me`, `/auth/switch`, `/auth/logout`. No RBAC guard. The interceptor is not globally bound. Step 4's definition of done needs the round-trip, the multi-membership switch, unauthorized-switch 403, revocation as an **observable endpoint behaviour**, and role-follows-active-membership — Phase 3 makes the machinery correct and proves revocation fails closed at the re-verify layer, but none of it is observable over HTTP until Phase 4 exists.

**Next**

- **Phase 4** — the auth endpoints on top of this machinery, binding the interceptor where it belongs, and the `23505` → 409 mapping recorded in `ARCHITECTURE.md` §16.2.

---

### 2026-09-08 — Step 4 Phase 2: the pre-auth SECURITY DEFINER surface (§11 step 4)

**Done**

- **Migration `20260908000000_auth_definer_functions`** — `login_lookup(citext)` and `register_tenant(text, citext, text)`, the complete definer surface ADR-006 §6 allows. Both owned by `meterlog_definer`, `SET search_path = pg_catalog, pg_temp`, bodies fully schema-qualified, `EXECUTE` revoked from `PUBLIC` and granted only to `meterlog_app`. `EXPECTED_DEFINER_FUNCTIONS` already named both, so the allowlist needed no edit — which is the point of having declared it early.
- **`register_tenant` writes three rows atomically** — tenant, person, admin membership. Atomicity is structural rather than coded: the body opens no subtransaction because it carries no `EXCEPTION` handler, so any failure unwinds all three. The migration says so at length, because adding a handler around a _subset_ of the inserts is the one edit that breaks it silently.
- **Ownership on a non-superuser migration role.** `ALTER FUNCTION ... OWNER TO meterlog_definer` requires membership in the target role. Locally and in CI the migration role is the bootstrap superuser and this is invisible; **on Render it is not**, and this is the first migration that would have failed there. The migration now grants itself membership only if it lacks it (it holds `ADMIN OPTION` from having created the role in `20260903000000`), does the two `ALTER`s, and **revokes the membership again** — not tidiness: RLS matches policy roles by _membership_, so a migration role left inside `meterlog_definer` would silently pick up every `TO meterlog_definer USING (true)` policy on every identity table. This closes part of the open "migration privileges on Render" question ahead of step 10.
- **Catalog assertions 11 and 12** — no `SECURITY DEFINER` function is executable by `PUBLIC` (counting `proacl IS NULL`, which _is_ the permissive default, as a violation), and every one of them is executable by `meterlog_app` so 11 cannot be satisfied by a function nobody can call.
- **Catalog assertion 4 tightened from presence to content.** It checked only that some `search_path=` entry existed. A mutation showed that accepts `search_path = public, pg_catalog, pg_temp` — pin present, hardening gone. It now asserts `public` is absent from the resolution path.

**The bug this phase found — a silent, unrecoverable account lockout**

`login_lookup` was written with a bare `u.email = p_email`. Both sides are `citext`, so that looks correct and reviews as correct. It is not, under a pinned `search_path`: **citext's `=` operator lives in `public`**, which the pin deliberately excludes. The reference does not fail to resolve — it falls back through citext's implicit cast to `text` and binds case-**sensitive** `text = text`. Verified directly:

```
search_path = pg_catalog, pg_temp   ->  'a'::citext = 'A'::citext  =  false
search_path = public, pg_catalog    ->  'a'::citext = 'A'::citext  =  true
```

The blast radius is worse than a wrong answer. `users_email_live_key` resolved its citext operator class at `CREATE INDEX` time, with `public` in scope, so **uniqueness stayed case-insensitive while the lookup became case-sensitive**. Register as `Founder@acme.test`, then log in as `founder@acme.test`: no row, generic auth failure — and re-registering is refused by the index. The account is unreachable and unrecoverable, with no error anywhere.

Fixed by schema-qualifying the operator, `u.email OPERATOR(public.=) p_email` — **not** by adding `public` to the `search_path`, which is the whole thing the pin exists to prevent. Note the shape: ADR-004 justified the pin on the grounds that an unqualified reference "fails outright rather than resolving wrongly". That is true of functions and tables. It is **not** true of operators, which fall back through implicit casts and resolve to something plausible and wrong. Definer-probe case E covers the failing kind; this was the silent kind.

**Verified against live Postgres, with negatives** (as `meterlog_app`, no request context set)

- **`register_tenant` positive:** three linked rows, membership role `admin`, reachable with no context at all. **Negative:** the same `INSERT`s attempted directly by the app role — `permission denied` on both `tenants` and `users`.
- **Atomicity, failure on insert #2** (duplicate email, the natural OPEN-1 path): raises, and **no orphan tenant survives**. Run in autocommit, because a rolled-back wrapper would make the assertion pass against a non-atomic function. The survival check runs as the **migration** role, because `tenants` is under FORCE RLS and asking the app role would return zero rows regardless — a guaranteed green proving nothing.
- **Atomicity, failure on insert #3** (forced with a `CHECK (false) NOT VALID` constraint on `memberships`, since nothing natural trips that insert): no tenant and no user survive. This is the failure that strands the most state.
- **`login_lookup` positive:** returns `id`, `password_hash`, `deleted_at` with no context. **Negative:** the same role reading `password_hash` directly — `permission denied`, the column-level grant doing what RLS cannot.
- Case-insensitive across mixed/lower/upper; exact-match only (prefix, suffix, trailing space and `%` all miss); at most one row when a soft-deleted account shares the address, preferring the live one.
- **Mutation sweep, 8 mutations, 8 caught** after the assertion-4 tightening: bare `=` restored, `ORDER BY/LIMIT` dropped, an `EXCEPTION` handler added that strands an orphan tenant, `EXECUTE` granted to `PUBLIC`, `EXECUTE` revoked from the app role, owner reverted to the migration role, `search_path` unpinned, and `search_path` widened to include `public`.

**A Prisma detail that changes Phase 4.** Postgres raises `duplicate key value violates unique constraint "users_email_live_key"`, but Prisma's raw-query wrapper reduces it to `Raw query failed. Code: 23505. Message: Unique constraint failed: ` — **the constraint name is dropped**. Registration's duplicate-email → 409 mapping must therefore key on SQLSTATE `23505`, not on the constraint name. On this function only the email index can realistically raise it; the other two keys are `gen_random_uuid()` primary keys.

**Recorded, not built: the standing rule Decision B created.** B closed the app-role write path, and in doing so **relocated the write-correctness burden into the definer function bodies**. Pre-B, `memberships_tenant` was `FOR ALL USING/WITH CHECK (tenant_id = current_tenant)` — the policy enforced tenant-scoping on every write, so even a buggy function body could not cross a tenant boundary. Post-B the only write path is the definer, whose policy is `USING (true) WITH CHECK (true)` and constrains nothing. Tenant-scoping and the admin check are now both the function body's sole responsibility. ADR-006 §7 and DECISIONS.md now carry the rule: **every definer write function acting for an authenticated caller must enforce, in its own body, that the caller is an admin of the active tenant and that the target row belongs to it.** `register_tenant` is exempt because it runs pre-auth and creates the tenant it writes into; `login_lookup` is read-only. Everything added after them is subject to it — and the **step-5 gate now requires live authorization negatives, not just atomicity**: a non-admin call rejected, and an admin of A unable to touch B through the function.

**Not done, and not claimed.** No interceptor, no session, no per-request re-verify, no endpoints — Phases 3–4. No step-5 membership-write functions. Step 4's definition of done still needs `register → login → /auth/me`, the multi-membership switch, unauthorized-switch 403, revocation-on-next-request and role-follows-active-membership; none of that exists yet.

**Next**

- **Phase 3** — the interceptor: two GUCs, verify-then-set ordering, per-request membership re-verification with the claimed tenant passed as a bound parameter.
- Phase 4 — the auth endpoints, including the `23505` → 409 mapping above.

---

### 2026-09-08 — Step 4 Phase 1: identity/tenancy schema + two-axis RLS (§11 step 4)

**Done**

- **Migration `20260907000000_identity_tenancy_schema`** — `tenants`, `users` (pure identity, globally-unique live email via partial index, `citext`), `memberships` (the join carrying `role`), the `membership_role` enum, partial unique on `(user_id, tenant_id) WHERE deleted_at IS NULL`, `ENABLE` + `FORCE ROW LEVEL SECURITY` on all three, eight policies, and column-limited grants. Implements ADR-006, with two amendments recorded there.
- **`users` policy set — an ADR gap, surfaced rather than assumed.** ADR-006 never specified one, and `users` had lost the `tenant_id` its ADR-004 policy keyed on; it would have shipped with a broken policy or none at all. Added `users_self_read`, `users_tenant_members_read`, `users_definer`, **no app-role write policy**, and `password_hash` withheld by **column-level grant** (RLS is row-level and cannot hide a column).
- **DECISION B — the database backstops intra-tenant role authorization.** The gate review found that `memberships_tenant`, specified `FOR ALL TO meterlog_app` with the admin check left to a step-5 RBAC guard, permitted **intra-tenant privilege escalation**: a technician in tenant A ran `UPDATE public.memberships SET role='admin' WHERE user_id=<self>` and got `UPDATE 1`. Neither policy clause carries a role term, and `tenant_id` never changes during a role edit. The axis is now `FOR SELECT`, the app role's `INSERT`/`UPDATE` grants on `memberships` are withdrawn, and invite/revoke/change-role move to admin-checking `SECURITY DEFINER` functions in step 5. Recorded in ADR-006 §3 and §7 and in DECISIONS.md, with the A/B/C rationale.
- **Co-member visibility recorded as intentional.** Every member of a tenant reads every co-member's identity and role. That was an unremarked side effect of the tenant axis keying on `tenant_id` alone; it is now a decision (team-SaaS default), and reads stay un-gated because a role term in a _read_ policy is the shape that produced OPEN-5.
- **Catalog assertions 9 and 10** — the app role holds no `INSERT`/`UPDATE`/`DELETE` on any identity table, and can still read all three. 9 is what keeps Decision B durable: one stray `GRANT` would otherwise reopen the escalation with nothing complaining. It also closes the previously-untested `tenants` write-privilege gap.
- **Revoked-membership fixtures.** The OPEN-5 residual argument — "liveness is enforced in-policy on the read paths, so a revoked workspace disappears from `/auth/me`" — is recorded in three places and was tested by nothing: no fixture had a soft-deleted membership, so deleting either liveness predicate was a green mutation. Two revoked memberships now exist in the suite, with assertions on both read paths, plus an assertion pinning the residual itself so nobody "fixes" what cannot be fixed.

**Verified against live Postgres, with negatives** (`meterlog_app`, `rolbypassrls = f`, on a database built only by `prisma migrate deploy`)

- **The escalation, before and after.** Pre-B: `INSERT 0 1` for the active tenant, and `UPDATE 1` → `role_now = admin`. Post-B: both `permission denied for table memberships`.
- **Both denial layers, separately.** The grant layer is shown by the plain rejections above. The **policy** layer is isolated by restoring the write grants inside a rolled-back transaction — then `INSERT` raises `new row violates row-level security policy`, while `UPDATE`/`DELETE` **do not raise**: no applicable policy means no visible row, so Postgres returns `UPDATE 0` / `DELETE 0` cleanly with the row unchanged. A test asserting a thrown error on the UPDATE path would have failed against a correct database; the suite asserts zero-rows-and-unchanged there deliberately.
- **Cross-tenant boundary unregressed**, and reads unregressed — a technician in A still reads all of A's co-members (the accepted behaviour).
- **`register_tenant` unaffected — proven, not asserted.** Built as ADR-006 §6 specifies inside a rolled-back transaction: the three-row insert succeeds as `meterlog_definer`; the identical insert as `meterlog_app` is denied. Same treatment for `login_lookup`, which still reads `password_hash` through the definer while the app role gets `permission denied`.
- **Mutation sweep, 21 mutations, 20 caught.** Every `USING`/`WITH CHECK` predicate, every `NULLIF` guard, both liveness predicates, the `FOR SELECT`→`FOR ALL` reversals, and stray write grants, dropped one at a time. Reverting `memberships_tenant` to `FOR ALL` is caught **only** by the policy-layer block, which is why that block exists. The one uncaught mutation (`tenants_active` `WITH CHECK` → `true`) is unreachable rather than unguarded — the app role cannot write `tenants` — and assertion 9 now guards the privilege that makes it unreachable, which mutation 21B confirms. All 21 reverted; post-sweep schema dump identical to a freshly-migrated one.
- **Drift** — schema, policies (full `USING`/`WITH CHECK` text), RLS flags, table and column grants and indexes diffed against a scratch database built only from the migrations: identical.

**Verified in CI** — see the run linked on PR #1. 45 tests (catalog-rls 10, membership-isolation 23, isolation 6, definer-probe 5, health 1), up from 34.

**Process smell worth naming.** The local database was found carrying the Phase 1 tables with **no `_prisma_migrations` table at all** — the schema had been applied out-of-band at least once, so `prisma migrate status` reported both migrations unapplied while the objects existed. It was byte-identical to what the migrations produce, so nothing was wrong with the schema; what was wrong is that this could not have been known without diffing. Migrations must be the only path that ever touches a database, most of all Render — an out-of-band change there is invisible, unreviewable, and unreproducible. The local ledger was baselined with `prisma migrate resolve --applied`; CI-on-a-fresh-database remains the real reproducibility proof.

**Repo / process**

- Branch protection on `main`: PR required, CI status check required, no direct pushes, no force-push, no deletion, **0 required approvals** (solo repo). Verified by a refused push, not by reading the settings.
- Secrets scan over full history (gitleaks + a provider-token grep across every blob): clean. The single gitleaks hit is the literal placeholder `replace-me-with-32-bytes-of-hex` in `.env.example`.

**Not done, and not claimed.** Step 4's definition of done needs `register → login → /auth/me` round-tripping, the multi-membership switch, unauthorized-switch 403, revocation-on-next-request and role-follows-active-membership. None of that exists — it is Phases 2–4. What Phase 1 proves is the harder novel part: the shared-user, dual-axis membership isolation, and now a real intra-tenant write boundary at the database layer.

**Next**

- **Phase 2** — the two `SECURITY DEFINER` functions (`login_lookup`, `register_tenant`), including the forced-failure test that asserts no tenant survives a partial registration.
- Phase 3 — the interceptor: two GUCs, verify-then-set, per-request membership re-verification.
- Phase 4 — the auth endpoints.
- Step 5 will add the admin-checking membership-write definer functions Decision B requires, and must edit `EXPECTED_DEFINER_FUNCTIONS` deliberately when it does.

---

### 2026-09-03 — Scaffold (§11 step 3)

**Done**

- `git init` (branch `main`), `.gitignore`, `.env.example`, npm-workspaces root, `tsconfig.base.json` (strict + `noUncheckedIndexedAccess`), ESLint flat config, Prettier.
- `docker-compose.yml`: Postgres 16 + Redis 7 with healthchecks; `docker/postgres/01-bootstrap-roles.sh` seeds the local roles and the app password from an env var.
- **Role bootstrap migration** (`20260903000000_bootstrap_roles`): creates `meterlog_definer` (NOLOGIN) and `meterlog_app` (`NOSUPERUSER NOBYPASSRLS`) idempotently, asserts attributes on re-run, sets `statement_timeout` 4s + `idle_in_transaction_session_timeout` 10s on the app role, grants `USAGE` on `public` and revokes `CREATE`. Never names the migration role, so it runs unchanged locally, in CI, and on Render. Sets no password — those stay out of version control.
- `apps/api`: Nest skeleton with global `/api/v1` prefix, Helmet, credentialed allow-list CORS, `ValidationPipe` with `forbidNonWhitelisted`, Swagger at `/api/v1/docs`, `GET /health`. `PrismaService` binds explicitly to `DATABASE_URL` while `schema.prisma` points at `MIGRATION_DATABASE_URL`, so the two roles cannot be confused; `TRANSACTION_OPTIONS` single-sources the ADR-004 timeouts.
- `apps/web`: Next 15 App Router + Tailwind skeleton, Playwright config (no journeys yet).
- `packages/shared`: error envelope + role Zod schemas.
- **Catalog RLS suite** (`test/db/catalog-rls.spec.ts`) — all seven assertions, running as `meterlog_app`.
- **Definer probe** (`test/db/definer-probe.spec.ts`) — cases A–E, fixtures in a throwaway `rls_probe` schema. Negatives included per review: **B** policy removed → reads nothing, writes rejected; **C** the FORCE/owner-bypass bug itself, with the probe table owned by `meterlog_definer` rather than the migration role (which is a superuser locally and in CI, so an owner-bypass test written against it would have proven nothing); **E** unqualified reference under a pinned `search_path` fails to resolve.
- CI workflow: install → generate → migrate → set app password → lint → typecheck → test → build, with Postgres + Redis services.
- `CLAUDE.md` Commands updated to the real scripts.

**Verified locally:** `npm run lint`, `npm run typecheck`, `npm run build` all clean; the health unit test passes. `nest build` initially emitted to `dist/src/` because the test tree was in compile scope — fixed with `tsconfig.build.json`, so `dist/main.js` now matches the `start` script.

**Verified in CI** — [run 33877274316](https://github.com/Braiden-07/MeterLog/actions/runs/33877274316), commit `5539224`, success in 1m54s. Migrations connected to the CI Postgres service (`Datasource "db": PostgreSQL database "meterlog" ... at "localhost:5432"` → `All migrations have been successfully applied`), and the API workspace reported real counts: definer-probe 5, isolation 6, catalog-rls 7, health 1 — **19 passed**. `--passWithNoTests` applied only to the web workspace, so a mis-globbed or empty DB suite would still fail rather than pass on zero matches.

**What is actually exercised, honestly.** With no domain tables, catalog assertions 1–6 and 8 iterate empty sets; only 7 (runtime role identity) has real content today. The isolation harness's `describe.each` matrix generates zero cases — its 6 passing tests are 1 vacuous fixture-coverage check plus 5 scratch-table self-tests. The definer probe is fully real (5 cases against its own fixtures). Negatives in the probe and the self-test were each confirmed to fail when their bug is mutated back in.

**Next**

- Build-order step 4 (auth + tenancy foundation) — acceptance criteria below.

---

### 2026-09-02 — Planning & foundational decisions

**Done**

- Read `CLAUDE.md` and `docs/PROJECT_BRIEF.md` in full; confirmed Essential-only scope (§2).
- Created `docs/PROGRESS.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md` as structured skeletons.
- Settled and recorded the three open decisions from the brief, plus two that follow from them:
  - ADR-001 — auth: **session cookie + Redis** (argon2 hashing).
  - ADR-002 — ORM: **Prisma**, with RLS as hand-written SQL in migrations.
  - ADR-003 — backend hosting: **Render** (API + Postgres + Redis); Vercel for frontend.
  - ADR-004 — RLS enforcement: per-request `SET LOCAL app.current_tenant` inside an interactive Prisma transaction, with a **restricted app DB role** separate from the migration/owner role.
  - ADR-005 — repo layout: **npm-workspaces monorepo** (`apps/api`, `apps/web`, `packages/shared`), no build orchestrator.
- Monorepo structure and toolchain approved by the author.
- Extended ADR-004 on author review with three explicit sections: the **auth-table policy** (pre-auth access via a narrow allowlisted set of `SECURITY DEFINER` functions), the **interactive-transaction timeout choices**, and a **catalog-level RLS coverage test** that lands at scaffold rather than later.
- Second ADR-004 review round — corrected a design error and scaled the isolation test:
  - **Named the three DB roles** (environment-provided migration/owner, `meterlog_definer`, `meterlog_app`) and established that **none holds `BYPASSRLS`**. Verified Render grants no superuser and that Postgres only lets `BYPASSRLS` be granted by a role holding it, so that route was unavailable — but it was also unnecessary and wrong: under `FORCE ROW LEVEL SECURITY` the table owner is subject to policies too, so the originally-assumed owner bypass would have left the login path silently fail-closed. Definer access now runs through permissive policies scoped `TO meterlog_definer`, which needs no role attributes.
  - **Schema-qualification of definer function bodies** made mandatory and tied to the pinned `search_path` — with `public` out of the resolution path, an unqualified reference fails outright rather than resolving wrongly.
  - **Definer policies are `FOR ALL ... USING (true) WITH CHECK (true)`** so registration inserts aren't denied (a `USING`-only policy doesn't apply to `INSERT` at all), with least privilege coming from narrow `SELECT, INSERT` grants that CI asserts.
  - **Functional proof of the pre-auth path** added on top of the structural checks: a definer-pattern probe at scaffold, and `register → login → /auth/me` as the acceptance gate for step 4.
  - **Two-tenant isolation test is now catalog-driven**: a fixture registry whose key set must equal the catalog's tenant-scoped table set in both directions, running a per-table matrix (read invisibility, cross-tenant UPDATE/DELETE affecting zero rows, `WITH CHECK` rejection of foreign-tenant INSERT, and zero rows with no context set). Correctness coverage now scales automatically like presence coverage does.

**Next (PROJECT_BRIEF §11 step 3 — scaffold)**

- `git init`; `.gitignore`, `.env.example`, root `package.json` (workspaces) + `tsconfig.base.json`.
- `docker-compose.yml`: Postgres 16 + Redis 7, with the two-role bootstrap from ADR-004.
- NestJS skeleton in `apps/api` (module layout per §4) and Next.js App Router skeleton in `apps/web`.
- `packages/shared` for Zod schemas / contract types.
- **Role bootstrap in migration SQL (ADR-004)** — create `meterlog_definer` (NOLOGIN) and `meterlog_app` (`NOSUPERUSER NOBYPASSRLS`); never name the migration role, so the same SQL runs locally and on Render.
- **Catalog-level RLS coverage test (ADR-004), wired into CI at scaffold** — connects as the restricted app role and asserts: (1) every `public` table has RLS enabled _and_ forced, bar a reviewed exempt list; (2) no `tenant_id`-bearing table lacks it; (3) every RLS-enabled table has ≥1 policy; (4) the `SECURITY DEFINER` set matches its allowlist, is owned by `meterlog_definer`, and has `search_path` pinned; (5) definer-scoped policies exist only on `users`/`tenants`; (6) neither `current_user` nor `meterlog_definer` is superuser or `BYPASSRLS`. Passes near-vacuously until step 4, which is the point — it exists before the first tenant table does.
- **Catalog-driven isolation harness (ADR-004)** — fixture registry + per-table matrix, with registry/catalog set equality asserted both ways. Harness lands at scaffold; it gains its first real fixtures in step 4.
- **Definer-pattern probe test (ADR-004)** — throwaway table + definer function + `FOR ALL` policy created and rolled back inside one transaction, asserting the function reads/writes while direct app-role access sees nothing. Proves the mechanism at scaffold, before auth code depends on it.
- Set `statement_timeout` (4s) and `idle_in_transaction_session_timeout` (10s) on the app role in migration SQL.
- GitHub Actions CI running lint + typecheck + the test suite above.
- Update the Commands block in `CLAUDE.md` to the real scripts once they exist.
- Fill in `docs/ARCHITECTURE.md` §3 (repo layout) and §7 (RLS) as the scaffold lands.

**Known-thin at scaffold (not defects, but do not mistake them for coverage)**

- `packages/shared` is declared by both apps but imported by neither. The API build was verified to compile an import of it; the web side is untested.
- `apps/web/e2e/` is empty. Playwright browsers are installed, so `npm run test:e2e` is untested rather than broken. CI does not run it.
- The Nest skeleton's `ValidationPipe` and CORS config are configured but unexercised — no DTO endpoint and no cross-origin request exists yet. `/api/v1/health`, Helmet headers, Swagger and the route prefix were verified against a running instance.

**Step 4 acceptance gates (named, not parenthetical)**

1. **Registration is atomic — tenant + first admin, or neither.** Both INSERTs run through the definer path and must share one transaction. A partial failure that strands a tenant with no admin is a real failure mode: the tenant row exists, nobody can log into it, and registration cannot be retried because the tenant already exists. Step 4 is not done until a test forces a failure on the second INSERT and asserts no tenant row survives.
2. **`register → login → /auth/me` round-trips green.** The functional counterpart to the scaffold probe: session cookie issued, identity carries the right `tenant_id` and `role`. Structural checks cannot see a fail-closed definer path; this is what does.
3. **The two-tenant isolation matrix runs on every new table**, driven by the catalog with the fixture registry asserted equal in both directions.
4. **`EXPECTED_DEFINER_FUNCTIONS` in `test/db/helpers.ts` is updated** as the credential-lookup and registration functions land — the allowlist is empty at scaffold and is meant to be edited deliberately.

**Open questions**

- **Login identity (blocks the credential-lookup function in step 4).** §5 makes `users.email` unique _per tenant_, so email alone doesn't identify a user at login. Either the login form carries a tenant discriminator (subdomain/slug) or email becomes globally unique. Does not block scaffolding.
- Prisma connection-pool size vs Render's Postgres connection cap — every in-flight request now holds a connection (ADR-004). Settle at deploy (step 10), validate with k6 (§13).
- **Migration privileges on Render (verify at step 10).** Locally and in CI the migration role is the cluster bootstrap user and therefore a superuser; on Render it is not. The bootstrap migration needs `CREATEROLE` and role-admin rights to run `CREATE ROLE` and `ALTER ROLE ... SET`. Expected to work with Render's default user, but it is an assumption, not a verified fact — confirm against a real Render database before relying on the deploy step. The probe is written to be superuser-agnostic precisely so this difference cannot mask a failure.
- Local Postgres is 18; `docker-compose.yml` pins 16 to match the intended Render version. No feature used here differs between them, but the mismatch is worth keeping in view.

**Blockers**

- None. Deferred to their build-order step: GitHub repo creation and branch protection (§9), Render plan-tier selection (ADR-003), Sentry DSN and uptime monitor (§10).
