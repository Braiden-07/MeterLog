# PERF.md — measured performance decisions

> Index and query decisions proven with `EXPLAIN ANALYZE` against a real dataset, before and after. Required by `PROJECT_BRIEF.md` §5 (:150) and §13 (:279): _"Prove at least one index decision with `EXPLAIN ANALYZE` and note the before/after in docs."_
>
> Numbers here are from local Postgres 16 (docker), warm cache. They are for **comparing plans**, not for quoting as production latency — Render's disks and cache behaviour differ. The plan **shape** is what transfers.

---

## 1. `readings_asset_id_read_at_idx` — the asset time-series read

**Decision under test:** `CREATE INDEX readings_asset_id_read_at_idx ON public.readings (asset_id, read_at)`, named explicitly by `PROJECT_BRIEF.md` §5 (:148).

**Why this one.** `readings` is the only genuinely hot table in v1.0 — append-only, unbounded growth, one row per meter per reading interval — and the query it exists for (`GET /assets/:id/readings`, Phase 3) is the one a reviewer would actually hit. It is also the index whose absence is least obvious from a correctness test: every isolation and append-only assertion passes identically with or without it.

### Setup

- **100,000 readings** across 5 assets in one tenant, `read_at` spread over ~2 years.
- Run **as `meterlog_app` with `app.current_tenant` set** inside the per-request transaction — the real request path, so the RLS predicate is part of the plan rather than something measured around.
- `ANALYZE public.readings` before each run.

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, value, unit, read_at
  FROM public.readings
 WHERE asset_id = $1
   AND read_at BETWEEN now() - interval '30 days' AND now()
 ORDER BY read_at;
```

### Before — index dropped

```
Gather Merge (actual time=15.916..17.427 rows=842 loops=1)
  Workers Planned: 1
  Workers Launched: 1
  Buffers: shared hit=1576
  ->  Sort (actual time=4.520..4.541 rows=421 loops=2)
        Sort Key: read_at
        Sort Method: quicksort  Memory: 77kB
        ->  Parallel Seq Scan on readings (actual time=0.007..4.306 rows=421 loops=2)
              Filter: ((asset_id = $1) AND (read_at <= now())
                       AND (read_at >= (now() - '30 days'::interval))
                       AND (tenant_id = (NULLIF(current_setting('app.current_tenant'::text, true), ''::text))::uuid))
              Rows Removed by Filter: 49579
              Buffers: shared hit=1539
Planning Time: 0.918 ms
Execution Time: 18.128 ms
```

Every row in the table is read and discarded — **49,579 rows removed by filter per worker**, ~99k across both — then sorted, then merged. The work scales with the size of the whole table, not with the size of the answer.

### After — index present

```
Sort (actual time=1.362..1.392 rows=842 loops=1)
  Sort Key: read_at
  Sort Method: quicksort  Memory: 77kB
  Buffers: shared hit=81
  ->  Bitmap Heap Scan on readings (actual time=0.159..0.683 rows=842 loops=1)
        Recheck Cond: ((asset_id = $1) AND (read_at >= (now() - '30 days'::interval)) AND (read_at <= now()))
        Filter: (tenant_id = (NULLIF(current_setting('app.current_tenant'::text, true), ''::text))::uuid)
        Heap Blocks: exact=71
        ->  Bitmap Index Scan on readings_asset_id_read_at_idx (actual time=0.123..0.123 rows=842 loops=1)
              Index Cond: ((asset_id = $1) AND (read_at >= (now() - '30 days'::interval)) AND (read_at <= now()))
              Buffers: shared hit=7
Planning Time: 1.785 ms
Execution Time: 1.565 ms
```

Both predicates are served by the index as an `Index Cond` — the composite is used on **both** columns, not just its leading one — so only the 842 matching rows are touched.

### Result

|                      | without index                           | with index                                  | delta            |
| -------------------- | --------------------------------------- | ------------------------------------------- | ---------------- |
| Execution time       | 18.128 ms                               | **1.565 ms**                                | **11.6× faster** |
| Buffers (shared hit) | 1576                                    | **81**                                      | **19.5× fewer**  |
| Rows discarded       | 49,579 per worker                       | 0                                           | —                |
| Plan                 | Parallel Seq Scan → Sort → Gather Merge | Bitmap Index Scan → Bitmap Heap Scan → Sort | —                |
| Parallel workers     | 1 launched                              | 0 needed                                    | —                |

**The number that matters is not 11.6×, it is the plan shape.** The seq-scan plan's cost grows with the table; the index plan's grows with the result. At 100k rows the difference is 16 ms. At 10M — one tenant with a few hundred meters after a couple of years — the seq scan is reading two orders of magnitude more, while the index scan still returns ~842 rows in about the same time. The measured factor here understates what it prevents, and it also had to recruit a parallel worker to reach 18 ms, spending CPU across the instance to do it.

### Two things worth noting from the plans

- **The RLS predicate is visible in both**, as `Filter: (tenant_id = NULLIF(current_setting('app.current_tenant', ...)))`. This is direct evidence the measurement ran through the real tenant-scoped path (ADR-004) rather than around it — and that RLS is applied as an ordinary filter with no separate scan.
- **A `Sort` node survives in the indexed plan.** The bitmap scan does not return rows in index order, so `ORDER BY read_at` still sorts — 842 rows, 77 kB, ~0.03 ms, irrelevant here. If a Phase 3 endpoint ever needs strict ordering over a much larger window, a plain `Index Scan` (which would return sorted rows and drop the node) is available by narrowing the window or adjusting `work_mem`. Not a change worth making on this evidence; recorded so the node is not mistaken later for the index failing to work.

### Not measured

The index's **write** cost. `readings` is insert-heavy and every insert maintains this index, which is real overhead traded for the read above. It was not measured because the trade is not in question — the brief specifies this index, unindexed reads degrade without bound, and no v1.0 journey inserts readings in bulk. Revisit if CSV import (stretch, §2) lands.

---

## 2. Keyset pagination and the `id` tiebreaker — the two-column vs three-column index

**Question:** phase 3a paginates by keyset, so every query carries `id` as a tiebreaker (`ORDER BY sort_col DESC, id DESC`, cursor predicate `(sort_col, id) < (?, ?)`). The existing indexes are **two columns** — `readings (asset_id, read_at)` and `asset_events (asset_id, created_at)`. Postgres can use them and sort the tail. Should they be amended to three?

Measured, not assumed: 100,000 readings and 20,000 events across 5 assets, cursor taken from 5,000 rows deep (readings) / 500 deep (events) so this is not a first-page measurement. Run as `meterlog_app` with the tenant GUC set.

```sql
SELECT id, value, unit, read_at FROM public.readings
 WHERE asset_id = $1 AND (read_at, id) < ($2, $3)
 ORDER BY read_at DESC, id DESC LIMIT 50;
```

### readings

|                     | 2-col `(asset_id, read_at)`                | 3-col `(asset_id, read_at, id)`                 |
| ------------------- | ------------------------------------------ | ----------------------------------------------- |
| Plan                | **Incremental Sort** → Index Scan Backward | Index Scan Backward, **no sort node**           |
| Cursor predicate    | `Filter:` `ROW(read_at, id) < ROW(...)`    | **`Index Cond:`** `ROW(read_at, id) < ROW(...)` |
| Index Cond          | `read_at <= $2` only                       | both columns                                    |
| Rows scanned for 50 | 52                                         | 50                                              |
| Buffers             | 60                                         | 50                                              |
| Execution           | 0.354 ms                                   | **0.186 ms**                                    |

### asset_events

|                     | 2-col                                      | 3-col                                 |
| ------------------- | ------------------------------------------ | ------------------------------------- |
| Plan                | **Incremental Sort** → Index Scan Backward | Index Scan Backward, **no sort node** |
| Cursor predicate    | `Filter:`                                  | **`Index Cond:`**                     |
| Rows scanned for 50 | 51                                         | 50                                    |
| Buffers             | 29                                         | 28                                    |
| Execution           | 0.145 ms                                   | **0.094 ms**                          |

### What the numbers actually say

**The timing delta is not the argument.** Both are sub-millisecond; `Incremental Sort` with a presorted leading key is cheap, and at this data size the 2-col index is perfectly serviceable. Quoting "1.9× faster" would overstate it.

**The structural difference is the argument.** With two columns the row-wise cursor comparison is demoted to a **`Filter`** — Postgres seeks on `read_at <= cursor` and then _scans and discards_ rows that fail the full tuple comparison. With three columns it becomes an **`Index Cond`**: the cursor position is sought directly.

That distinction is invisible at 52-rows-scanned-for-50 and becomes the whole cost when timestamps tie. **For `asset_events` ties are guaranteed by design**, not incidental: ARCHITECTURE §9.2 has registration emit `created` and `installed` in one transaction, so every asset's genesis is two rows sharing a `created_at`. Any bulk operation — an import, a batch reading upload — produces runs of identical timestamps too. With _n_ rows sharing the cursor's timestamp, the 2-col plan reads and discards up to _n_ of them on every page; the 3-col plan seeks past them.

### Cost

Index size, measured on 100k rows of the same shape:

|                                 | size    |
| ------------------------------- | ------- |
| 2-col `(asset_id, read_at)`     | 3984 kB |
| 3-col `(asset_id, read_at, id)` | 5768 kB |

**+45%**, and `readings` is the most insert-heavy table in the schema, so this is real write amplification on the hot path.

### Recommendation — **amend both, replacing not stacking** (awaiting approval)

The three-column index still leads with `asset_id`, so it continues to support the ADR-007 composite FK's `ON DELETE RESTRICT` check, and it still serves the `(asset_id, sort_col)` range prefix that §1 measured. The two-column index is therefore **redundant once the three-column one exists** — a third index alongside would be write cost for nothing, the same judgment that rejected a `memberships(user_id)` index (ADR-006 §2).

If approved this is a new migration (the phase 1 and 2 migrations are frozen and merged), dropping each two-column index and creating its three-column replacement.

**Not amended in phase 3a.** This touches merged indexes and is the author's call. Nothing is blocked by deferring it: the 2-col indexes produce **correct** results — `Incremental Sort` yields the same total order — so this is purely a performance decision, reversible in either direction.

---

## Method note

The dataset and both plans were produced by a throwaway harness run once against local Postgres and **deliberately not committed** — it is a measurement, not a test. Committing it would add ~5 s and a 100k-row insert to every CI run to re-prove a decision that is already recorded here. Re-run it by seeding `readings` and running the query above with and without the index.
