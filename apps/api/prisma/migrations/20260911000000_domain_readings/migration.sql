-- Step 6, Phase 2 — readings: the second FK-child of assets.
--
-- Deliberately unremarkable. Every mechanism this table needs was built and proven
-- at Phase 1: the canonical tenant policy, the ADR-007 composite FK, the
-- append-only grant shape, and the fixture contract that generates isolation cases
-- from the catalog. Phase 2's job is to show those generalise to a SECOND child
-- with no special-casing — if anything here needed a new mechanism, the Phase 1
-- contract would have been wrong.

-- ---------------------------------------------------------------------------
-- readings — APPEND-ONLY, and the DANGEROUS KIND of append-only
-- ---------------------------------------------------------------------------
--
-- READ THIS BEFORE CHANGING ANY COLUMN HERE.
--
-- `asset_events` (:137) and `audit_log` (:140) are marked "append-only" in
-- PROJECT_BRIEF in so many words. **`readings` (:138) IS NOT.** It is append-only
-- only by CONSTRUCTION: :138 gives it no `updated_at` and no `deleted_at`, and
-- :146 says "append-only tables get `created_at` only" — so the property follows
-- by inference from an absence.
--
-- That inference is correct and it is exactly the wrong place to keep a
-- security-relevant property. It is the implicit-by-omission shape that produced
-- this repo's two worst bugs — `WITH CHECK` defaulting from `USING` (ADR-006 §0.1)
-- and an operator resolving through an implicit cast (ADR-004's operator
-- amendment). Both were inferable; both were silent.
--
-- **THE AUTHORITY FOR THIS TABLE BEING APPEND-ONLY IS THE DECLARATION IN
-- CLAUDE.md, NOT THE ABSENT COLUMNS**, mirrored by APPEND_ONLY_TABLES in
-- test/db/helpers.ts and bound to the grant below by catalog assertion 13.
--
-- Concretely: adding `updated_at` here "for consistency with assets" would end the
-- property, and nothing about the column list would object. What objects is
-- assertion 13, because the grant and the declaration are checked against each
-- other. Do not add one.

CREATE TABLE public.readings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  asset_id   uuid NOT NULL,

  -- UNBOUNDED numeric, deliberately: no precision or scale. The brief says
  -- "numeric" (:138) and says nothing about range, and a cumulative meter total
  -- has no natural ceiling — committing to numeric(p,s) here risks silently
  -- truncating a reading years from now, which is unrecoverable in an append-only
  -- table.
  --
  -- NO CHECK CONSTRAINT, and that is a decision rather than an omission. A
  -- non-negativity or monotonicity rule is value-domain logic, and value-domain
  -- logic is the ANOMALY-FLAGGING feature the brief schedules as stretch (:42).
  -- Encoding one rule here now would pre-empt that design with a constraint that
  -- rejects rows outright, where the feature wants to FLAG them for a human. A
  -- meter that reads lower than last month is a real event (replacement, rollover,
  -- correction) and must be recordable.
  value      numeric NOT NULL,

  -- Free text, NOT an enum, and the brief is precise about this by contrast:
  -- it marks `status (enum: ...)` (:136) and `event_type (enum)` (:137) and
  -- pointedly does NOT mark `unit`. NOT NULL because a bare number with no unit is
  -- not a reading — it is unusable data that cannot be compared or converted.
  unit       text NOT NULL,

  -- DOMAIN TIME: when the technician actually took the reading. Supplied by the
  -- caller, hence no default — a server-generated value would be a lie about the
  -- physical world, and back-dating a reading recorded after a site visit is
  -- ordinary, expected use.
  read_at    timestamptz NOT NULL,

  -- Single-column FK to users. Attribution is to the PERSON (ADR-006 §2,
  -- "Variant C"): users carry no tenant_id, and the row's own tenant_id plus the
  -- person is sufficient. Identical in shape to asset_events.created_by.
  --
  -- DELIBERATELY NOT INDEXED — the THIRD instance of this judgment, and at three
  -- it is a pattern rather than three separate omissions. See asset_events.created_by
  -- (step 6 phase 1) and the rejected memberships(user_id) index (ADR-006 §2).
  -- Nothing queries readings by actor; the unindexed-FK penalty falls on PARENT
  -- DELETES, which cannot happen here because the reference is ON DELETE RESTRICT
  -- and identity rows are soft-deleted, never removed. Add it when a query needs it.
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,

  -- SERVER TIME: when the row was inserted. Distinct from read_at above, and both
  -- exist precisely because they answer different questions — "when was the meter
  -- read" versus "when did we learn about it". The gap between them is itself
  -- meaningful data (a reading entered three days late).
  created_at timestamptz NOT NULL DEFAULT now(),

  -- ADR-007's mechanism, now on its SECOND child — which is the point of doing
  -- readings in its own phase rather than alongside asset_events.
  --
  -- readings.tenant_id is denormalized so the policy below can be the canonical
  -- single-column expression with NO subquery in a policy on a FORCE-RLS table.
  -- The cost of denormalizing is that the two halves can disagree, and RLS CANNOT
  -- SEE the disagreement: the policy compares tenant_id to the GUC and that half is
  -- correct. The row would be perfectly isolated and attached to another tenant's
  -- asset. This constraint makes that unrepresentable.
  --
  -- Rejects with 23503, NOT the 42501 a WITH CHECK rejection raises. Asserted
  -- separately in the tests — two mechanisms, two assertions.
  CONSTRAINT readings_asset_tenant_fkey
    FOREIGN KEY (asset_id, tenant_id)
    REFERENCES public.assets (id, tenant_id) ON DELETE RESTRICT
);

-- NOTE WHAT IS ABSENT: readings has NO `UNIQUE (id, tenant_id)`.
--
-- That composite unique on `assets` is the PARENT HALF of a child's composite FK —
-- it exists only so that asset_events and readings have something to reference.
-- readings is a LEAF: nothing in v1.0 is a child of a reading. Adding one here
-- would be cargo-culting the assets pattern, paying an index's write cost on the
-- hottest-inserting table in the schema to enable a relationship that does not
-- exist. If something ever becomes a child of readings, it gets added then.

-- Every RLS-filtered read compares tenant_id (the index-foreign-keys rule, :148).
CREATE INDEX readings_tenant_id_idx ON public.readings (tenant_id);

-- PROJECT_BRIEF §5 (:148) names this index explicitly: "readings.(asset_id,
-- read_at)". It serves GET /assets/:id/readings in time order (Phase 3), and its
-- leading column gives the composite FK above an index for the ON DELETE RESTRICT
-- check — so there is deliberately no separate index on asset_id alone, which
-- would be write cost for nothing (the rejected memberships(user_id) reasoning,
-- ADR-006 §2).
--
-- Its effect is measured, not assumed — see docs/PERF.md for the EXPLAIN ANALYZE
-- before/after (PROJECT_BRIEF :150).
CREATE INDEX readings_asset_id_read_at_idx ON public.readings (asset_id, read_at);

ALTER TABLE public.readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.readings FORCE  ROW LEVEL SECURITY;

-- The canonical tenant-scoped policy, byte-identical in shape to assets and
-- asset_events. WITH CHECK written out in full rather than defaulted from USING:
-- Postgres would default it, but the implicit coupling means any future narrowing
-- of USING would silently narrow write permission too (ADR-004).
--
-- No role term anywhere (DECISION B). No deleted_at predicate — readings has no
-- soft delete, and a policy predicate over a mutable column is the OPEN-5 shape.
CREATE POLICY readings_tenant ON public.readings
  FOR ALL TO meterlog_app
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- EXACTLY SELECT, INSERT — this is what makes the append-only property real,
-- rather than a convention about which columns exist. Catalog assertion 13
-- asserts this exact set against the CLAUDE.md declaration, so
-- `GRANT UPDATE ON public.readings TO meterlog_app` turns CI red.
GRANT SELECT, INSERT ON public.readings TO meterlog_app;

-- No grant and no policy for meterlog_definer: the pre-auth surface is the five
-- allowlisted functions, and nothing about readings belongs in it (assertion 5).
