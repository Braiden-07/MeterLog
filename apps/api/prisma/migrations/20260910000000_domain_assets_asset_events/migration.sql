-- Step 6, Phase 1 — the first DOMAIN tables: assets (mutable) and asset_events
-- (append-only).
--
-- These are the first tables the generic catalog-driven isolation matrix has ever
-- had to work with: `tenants`, `users` and `memberships` are all registered as
-- bespoke-handled, because the app role cannot write any of them. `assets` and
-- `asset_events` it genuinely can, so from here the matrix stops generating zero
-- cases (ADR-004, "Catalog-driven isolation test").
--
-- BOTH WRITE-SHAPES LAND TOGETHER, DELIBERATELY. `assets` is mutable and
-- `asset_events` is append-only, and v1.0 contains more of each (`readings` and
-- `audit_log` append-only; `maintenance_records` mutable). A fixture contract
-- shaped around whichever table happened to arrive first would need rework the
-- moment the second shape appeared, so the second shape arrives now.
--
-- The canonical contract every tenant-scoped table satisfies (ADR-004):
--   * ENABLE + FORCE ROW LEVEL SECURITY                    (catalog assertion 1)
--   * at least one policy                                  (catalog assertion 3)
--   * the tenant key compared with the canonical expression, NULLIF-wrapped
--     verbatim                                             (catalog assertion 8)
--   * NO policy scoped TO meterlog_definer — assertion 5 allowlists only the
--     three identity tables, and a definer policy on a domain table is a hole in
--     the isolation boundary by construction
--   * explicit meterlog_app grants, which CAP what any policy can reach, since
--     table privileges are checked BEFORE policies

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- Specified by PROJECT_BRIEF §5 (:136).
CREATE TYPE public.asset_status AS ENUM (
  'installed',
  'active',
  'maintenance',
  'decommissioned'
);

-- NOT specified by the brief, which says only `event_type (enum)` (:137). These
-- values are derived from the status enum above rather than invented: each names
-- a transition INTO one of the four specified statuses, plus 'created' for row
-- genesis. Phase 3 wires the emissions; Phase 1 only creates the table.
--   installed             -> status 'installed'
--   activated             -> status 'active'
--   maintenance_started   -> status 'maintenance'
--   maintenance_completed -> status 'active'
--   decommissioned        -> status 'decommissioned'
--
-- THE EMISSION CONTRACT IS RECORDED IN ARCHITECTURE §9.2 — read it before wiring
-- anything. Two points that are not inferable from the values above:
--   * registering an asset emits BOTH 'created' AND 'installed', because every
--     status an asset has held must have an event that put it there, or the log
--     cannot be replayed to reconstruct status at a past time;
--   * the enum encodes TRANSITIONS, not STATES — 'activated' and
--     'maintenance_completed' both land on status 'active', so event_type is NOT
--     a function of the resulting status and a lookup table keyed on it is wrong.
CREATE TYPE public.asset_event_type AS ENUM (
  'created',
  'installed',
  'activated',
  'maintenance_started',
  'maintenance_completed',
  'decommissioned'
);

-- ---------------------------------------------------------------------------
-- assets — MUTABLE, soft-deleted
-- ---------------------------------------------------------------------------

CREATE TABLE public.assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  serial_number text NOT NULL,
  type          text NOT NULL,
  status        public.asset_status NOT NULL DEFAULT 'installed',
  location      text,
  installed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- THE PARENT HALF OF EVERY CHILD'S COMPOSITE FK (ADR-007).
--
-- `id` is already unique on its own, so this constraint adds no new uniqueness
-- whatsoever — its entire purpose is to give a child table something to point
-- (asset_id, tenant_id) at. Postgres requires a FK's referenced columns to carry
-- a unique constraint; without this, the composite FK below cannot be declared.
--
-- It is also PROJECT_BRIEF §5's own "composite (tenant_id, id) patterns" (:148),
-- so it is not an extra artifact invented for this mechanism.
--
-- CONSEQUENCE, recorded in ADR-007 and repeated here where someone will hit it:
-- an asset's tenant_id becomes effectively IMMUTABLE once it has children, since
-- changing it would violate every child row's FK. That is correct — assets do
-- not move between tenants — not a limitation to be worked around.
ALTER TABLE public.assets
  ADD CONSTRAINT assets_id_tenant_key UNIQUE (id, tenant_id);

-- Every RLS-filtered read compares tenant_id; assets_id_tenant_key leads with
-- `id` and so does not serve that. Also the brief's "index foreign keys" (:148).
--
-- NOT made redundant by assets_tenant_serial_live_key below, which also leads with
-- tenant_id: that one is PARTIAL (`WHERE deleted_at IS NULL`), so it cannot serve
-- a query that must see soft-deleted rows — including the RLS policy check on the
-- UPDATE that PERFORMS a soft delete, and any admin view of decommissioned assets.
-- This index covers tenant_id across ALL rows; keep both.
CREATE INDEX assets_tenant_id_idx ON public.assets (tenant_id);

-- PROJECT_BRIEF §5 (:148) — "index assets.serial_number", decided at the Phase 1
-- gate as UNIQUE PER TENANT AMONG LIVE ROWS.
--
-- Directly follows the `memberships_user_tenant_live_key` precedent (ADR-006 §2),
-- because the case is the precise analogue: a serial number that has been
-- decommissioned must not permanently reserve itself, exactly as a revoked
-- membership must not block re-invitation. Partial on `deleted_at IS NULL` is what
-- makes re-registration after decommissioning possible.
--
-- THIS INDEX ALSO SERVES EVERY SERIAL LOOKUP, so there is deliberately no separate
-- plain index on `serial_number`. Every lookup is tenant-scoped in practice — RLS
-- guarantees a query can only ever see one tenant's rows — so `(tenant_id,
-- serial_number)` is hit on its leading column by the tenant predicate and on both
-- by a serial search. A second index would be write cost for nothing, the same
-- reasoning that rejected a `memberships(user_id)` index in ADR-006 §2.
--
-- HONEST LIMITATION: `WHERE deleted_at IS NULL` means this index does NOT serve
-- lookups of DECOMMISSIONED assets by serial. That matches the brief's default
-- query shape — "queries filter out soft-deleted rows by default" (:147) — so the
-- common path is covered. If "what happened to serial X" across decommissioned
-- assets ever becomes a real journey, that is a separate index decision, not a
-- reason to widen this one and lose the re-registration property.
--
-- WHY NOW RATHER THAN LATER, which is the whole reason this was worth deciding at
-- the gate: a unique index can only be created if the existing data already
-- satisfies it. Today the table is empty and the statement cannot fail. After
-- step 10 the same change is a reconcile-live-duplicates migration that can fail
-- against production data at an inconvenient hour. The cost is flat now and rises
-- monotonically from here.
CREATE UNIQUE INDEX assets_tenant_serial_live_key
  ON public.assets (tenant_id, serial_number) WHERE deleted_at IS NULL;

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets FORCE  ROW LEVEL SECURITY;

-- The canonical tenant-scoped policy.
--
-- WITH CHECK IS WRITTEN OUT IN FULL, AND THAT IS NOT REDUNDANT STYLING. Postgres
-- defaults a FOR ALL policy's WITH CHECK to its USING expression, so omitting it
-- works today and silently narrows write permission alongside any future
-- narrowing of USING. Worse, the inverse mistake — USING with no WITH CHECK on a
-- policy that ISN'T FOR ALL — leaves reads isolated while writes are not, which
-- is the exact defect the matrix's INSERT case exists to catch and which
-- ADR-006 §0.1 records as a live privilege escalation. Both halves are stated.
--
-- No role term appears anywhere in this policy, deliberately (DECISION B). The
-- admin/technician/auditor distinctions from ARCHITECTURE §9.1 are enforced at
-- the endpoint in Phase 3. Role logic stays out of RLS.
--
-- deleted_at is likewise ABSENT from the policy, and for the OPEN-5 reason: a
-- predicate on deleted_at blocks the very UPDATE that performs the soft delete,
-- because Postgres applies the SELECT policy to the new row of an UPDATE.
-- Soft-delete filtering is the application's job; isolation is this policy's.
CREATE POLICY assets_tenant ON public.assets
  FOR ALL TO meterlog_app
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- SELECT, INSERT, UPDATE — and pointedly NO DELETE. Assets are soft-deleted
-- (PROJECT_BRIEF §5 :147), which is an UPDATE setting deleted_at. Withholding
-- DELETE at the grant means a hard delete is impossible for the runtime role
-- rather than merely discouraged by convention.
GRANT SELECT, INSERT, UPDATE ON public.assets TO meterlog_app;

-- ---------------------------------------------------------------------------
-- asset_events — APPEND-ONLY
-- ---------------------------------------------------------------------------

CREATE TABLE public.asset_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  asset_id   uuid NOT NULL,
  event_type public.asset_event_type NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Deliberately NOT indexed, a departure from the brief's "index foreign keys"
  -- (:148): nothing queries events by actor, and the unindexed-FK penalty falls on
  -- PARENT DELETES, which cannot happen here — the reference is ON DELETE RESTRICT
  -- and identity rows are soft-deleted, never removed. Same judgment as the
  -- rejected memberships(user_id) index (ADR-006 §2); write cost for nothing.
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- THE COMPOSITE FK (ADR-007) — the whole reason asset_events lands in Phase 1
  -- rather than waiting for readings.
  --
  -- assets.tenant_id is denormalized onto every child so that each child's RLS
  -- policy can be the canonical single-column expression, with NO subquery in a
  -- policy on a FORCE-RLS table — the shape that produced the OPEN-5 deadlock,
  -- the FOR ALL write vectors, and the citext lockout.
  --
  -- The cost of denormalizing is that the two halves can disagree, and RLS CANNOT
  -- SEE THAT: the policy only ever compares tenant_id to the GUC, and that half is
  -- correct in a mismatched row. The row is perfectly isolated and attached to the
  -- wrong asset. This constraint makes that state unrepresentable.
  --
  -- Declarative and always-on: it holds against the app role, the migration role,
  -- any future SECURITY DEFINER function, and psql. A trigger would be procedural
  -- code in the write path needing its own reachability proof; a CHECK cannot
  -- reference another table at all.
  --
  -- It fails with 23503 (foreign_key_violation), NOT the 42501 that a WITH CHECK
  -- rejection raises. The tests assert those two SQLSTATEs separately — one
  -- assertion covering both would let either mechanism break while staying green.
  CONSTRAINT asset_events_asset_tenant_fkey
    FOREIGN KEY (asset_id, tenant_id)
    REFERENCES public.assets (id, tenant_id) ON DELETE RESTRICT
);

-- No updated_at and no deleted_at: append-only tables get created_at only
-- (PROJECT_BRIEF §5 :146). The property itself is DECLARED in CLAUDE.md and
-- mirrored by APPEND_ONLY_TABLES in test/db/helpers.ts — never inferred from
-- these columns being absent, which is how it would quietly stop being true.

CREATE INDEX asset_events_tenant_id_idx ON public.asset_events (tenant_id);

-- Serves GET /assets/:id/events in chronological order (Phase 3), and gives the
-- ON DELETE RESTRICT check on the composite FK an index to use on its leading
-- column rather than a sequential scan of the whole table.
CREATE INDEX asset_events_asset_id_created_at_idx
  ON public.asset_events (asset_id, created_at);

ALTER TABLE public.asset_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_events FORCE  ROW LEVEL SECURITY;

-- Same canonical policy as assets. Append-onlyness is NOT expressed here — it is
-- enforced by the grant below, asserted structurally by catalog assertion 13
-- (declaration <-> grant), and asserted behaviourally by the isolation matrix's
-- appWrites capability. Three places, one declaration.
CREATE POLICY asset_events_tenant ON public.asset_events
  FOR ALL TO meterlog_app
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- EXACTLY SELECT, INSERT. This is what makes asset_events append-only, and
-- catalog assertion 13 asserts this exact set against the declaration in
-- APPEND_ONLY_TABLES — so `GRANT UPDATE ON public.asset_events TO meterlog_app`
-- turns CI red instead of silently widening the table's write surface.
GRANT SELECT, INSERT ON public.asset_events TO meterlog_app;

-- No grants to meterlog_definer on either table, and no policy TO meterlog_definer.
-- The pre-auth surface is permanently just login_lookup, register_tenant and the
-- three membership-write functions; nothing about the domain tables belongs in it.
