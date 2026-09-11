-- Step 6, Phase 4 (6b) — maintenance_records: the fourth and final v1.0 domain
-- child, and the FIRST table whose shape is not a copy of an existing one.
--
-- ADDITIVE FORWARD MIGRATION. Nothing applied is edited; the proven three-table
-- surface (assets + asset_events + readings) is untouched.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE NEEDED AN ADR (ADR-008)
-- ---------------------------------------------------------------------------
--
-- Every other domain table fits a profile already proven:
--
--   assets          parent, lifecycle-mutable, soft-deleted   SELECT, INSERT, UPDATE
--   asset_events    append-only child                         SELECT, INSERT
--   readings        append-only child                         SELECT, INSERT
--   maintenance_records   MUTABLE child                       SELECT, INSERT, UPDATE
--
-- The grant profile matches `assets`, but the MEANING of UPDATE does not, and that
-- is the distinction worth stating. On `assets`, `PATCH` edits metadata and
-- `status` is a STATE TRANSITION that must emit an event (ARCHITECTURE §9.2) —
-- there is no general field edit. Here there is: a technician corrects a
-- description or a date, and nothing about the asset's lifecycle changed.
--
-- **This is the first domain table where UPDATE means "edit a field" rather than
-- "advance a state machine", and therefore the first where the UPDATE policy's
-- WITH CHECK has real work to do** — a general UPDATE could otherwise rewrite
-- tenant_id and move a row between tenants.
--
-- SOFT DELETE FOR v1.0, AND THE DECISION IS PROVEN BY A MISSING GRANT. The app
-- role gets SELECT, INSERT, UPDATE and **no DELETE**, so an attempted hard delete
-- returns `permission denied for table maintenance_records`. Hard delete / purge is
-- DEFERRED to after step 7 (OPEN-9), not refused: a destructive operation must not
-- predate the audit trail that makes it accountable, because a purged row with no
-- audit_log entry leaves zero trace of itself, of who purged it, or of what it
-- said. When hard delete lands, it lands behind audit.

CREATE TABLE public.maintenance_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NEVER client-supplied: derived from app.current_tenant by the policy's
  -- WITH CHECK. Immutable after creation — see the policy note below.
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,

  -- Immutable after creation: a maintenance record is NOT REPARENTABLE. It
  -- documents work done on one physical asset, and moving it to another would
  -- rewrite two histories at once. A mis-filed record is soft-deleted and
  -- re-created. Enforced by its absence from the update DTO.
  asset_id     uuid NOT NULL,

  -- PROJECT_BRIEF §5 (:139) specifies exactly: description, performed_at,
  -- created_by, created_at, updated_at. Those are the columns here.
  --
  -- DELIBERATELY ABSENT: `cost` and a `type`/`category`. Both are plausible and
  -- neither is in the brief. The same discipline was applied to `readings`, where
  -- :138's column list was followed exactly rather than extended with fields that
  -- "obviously belong" — an unreviewed column is a schema commitment, and a
  -- `numeric` cost in particular carries a currency question the brief never
  -- raises. Surfaced at the gate rather than added quietly.
  description  text NOT NULL,

  -- DOMAIN TIME: when the work was actually performed. Caller-supplied, no
  -- default — the same rule as `readings.read_at` and `assets.installed_at`. A
  -- server-generated value would be a lie about the physical world, and recording
  -- last week's service visit today is ordinary.
  performed_at timestamptz NOT NULL,

  -- Attribution to the PERSON (ADR-006 §2 "Variant C"): users carry no tenant_id,
  -- and the row's own tenant_id plus the person is sufficient.
  --
  -- DELIBERATELY NOT INDEXED — the fourth instance of this judgment, and at four
  -- it is plainly a pattern. See readings.created_by, asset_events.created_by and
  -- the rejected memberships(user_id) index (ADR-006 §2): nothing queries
  -- maintenance by actor, and the unindexed-FK penalty falls on PARENT DELETES,
  -- which cannot happen (ON DELETE RESTRICT plus soft-deleted identity rows).
  created_by   uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,

  -- SERVER TIME, distinct from performed_at. The gap between them is meaningful.
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- SOFT DELETE (ADR-008). An addition to the brief's column list, recorded as
  -- such: §5 (:139) gives this table no deleted_at, and §5's soft-delete rule
  -- (:147) names only tenants, users and assets. Taken literally a record created
  -- in error could never be removed by any means. One nullable column that keeps
  -- every row is the smaller deviation than a destructive capability the brief
  -- also does not grant.
  --
  -- CRITICAL: deleted_at appears in NO POLICY PREDICATE below. That is the OPEN-5
  -- resolution, reused rather than re-litigated — a liveness predicate in a
  -- SELECT-applicable policy blocks the very UPDATE that performs the soft delete,
  -- because Postgres applies the SELECT policy to the NEW ROW of an
  -- `UPDATE ... WHERE`. Liveness is an application-layer `WHERE deleted_at IS NULL`.
  deleted_at   timestamptz,

  -- ADR-007's composite FK, now on its THIRD child. tenant_id is denormalized so
  -- the policy stays the canonical single-column expression with no subquery in a
  -- policy on a FORCE-RLS table; this constraint is what stops the two halves
  -- disagreeing, which RLS cannot see (the policy compares tenant_id to the GUC,
  -- and in a mismatched row that half is correct).
  --
  -- Rejects with 23503, distinct from the 42501 an RLS refusal raises.
  CONSTRAINT maintenance_records_asset_tenant_fkey
    FOREIGN KEY (asset_id, tenant_id)
    REFERENCES public.assets (id, tenant_id) ON DELETE RESTRICT
);

-- Like `readings`, this is a LEAF: no UNIQUE (id, tenant_id), because nothing is a
-- child of a maintenance record. That composite exists on `assets` solely as the
-- parent half of a child's FK.

-- Every RLS-filtered read compares tenant_id (the index-foreign-keys rule, :148).
CREATE INDEX maintenance_records_tenant_id_idx
  ON public.maintenance_records (tenant_id);

-- Serves `GET /assets/:id/maintenance`-shaped reads in time order, and gives the
-- composite FK's ON DELETE RESTRICT check an index on its leading column — so
-- there is no separate asset_id index (write cost for nothing, ADR-006 §2).
--
-- `id` IS IN THE INDEX, AND THAT IS FINDING 7 APPLIED FROM DAY ONE. The list
-- endpoint paginates by keyset on (performed_at, id), and phase 3a shipped a
-- two-column index whose row-wise cursor comparison was demoted to a Filter —
-- scan-and-discard rather than seek (PERF.md §2). The third column makes the
-- cursor predicate an Index Cond. The new table gets the measured answer rather
-- than repeating the measurement.
CREATE INDEX maintenance_records_asset_id_performed_at_idx
  ON public.maintenance_records (asset_id, performed_at, id);

ALTER TABLE public.maintenance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_records FORCE  ROW LEVEL SECURITY;

-- The canonical tenant-scoped policy, byte-identical in shape to the other three.
--
-- WITH CHECK WRITTEN OUT IN FULL, and here it carries weight the append-only
-- children's never did: they have no UPDATE path at all, so their WITH CHECK
-- governs only INSERT. This table has a general UPDATE, so WITH CHECK is what
-- refuses an attempt to move a row to another tenant — TENANT IMMUTABILITY, proven
-- as a negative rather than assumed.
--
-- No role term (DECISION B): the admin/technician/auditor distinctions are
-- enforced at the endpoint. No deleted_at predicate (OPEN-5, above).
CREATE POLICY maintenance_records_tenant ON public.maintenance_records
  FOR ALL TO meterlog_app
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- EXACTLY SELECT, INSERT, UPDATE — and pointedly NO DELETE (ADR-008).
--
-- UPDATE covers both halves of this table's mutability: editing a field, and
-- writing deleted_at to perform the soft delete. The absence of DELETE is what
-- makes "soft delete only" a property of the database rather than a convention in
-- the service, and catalog assertion 14 asserts this exact set as an EQUALITY, so
-- `GRANT DELETE ON public.maintenance_records TO meterlog_app` turns CI red
-- instead of silently making v1.0 destructive.
GRANT SELECT, INSERT, UPDATE ON public.maintenance_records TO meterlog_app;

-- No grant and no policy for meterlog_definer: the pre-auth surface is the five
-- allowlisted functions, and nothing about maintenance belongs in it (assertion 5).
