-- Step 7, Phase 7a — the audit module: capture mechanism, immutable by grant.
--
-- ADDITIVE FORWARD MIGRATION. Nothing applied is edited. The four proven domain
-- tables, the three identity tables, the five existing definer functions and
-- every policy and grant on them are untouched; this file only ADDS a table, an
-- enum, one trigger function and six trigger attachments.
--
-- ADRs: 009 (capture), 010 (integrity), 011 (payload + redaction), 012 (scope).
--
-- ---------------------------------------------------------------------------
-- THE PREMISE, FIXED BY STEP 6 AND NOT UP FOR REVISION
-- ---------------------------------------------------------------------------
--
-- AUDIT IS MUTATION-LEVEL, NOT EVENT-DERIVED. The maintenance-edit PATCH emits
-- NO lifecycle event — correcting a description is not something that happened
-- to the physical asset — so any trail derived from `asset_events` is silent for
-- that entire class of change (ISOLATION.md section 9; ARCHITECTURE section 9.2
-- for the identical asset-metadata case). A trigger fires on the WRITE, which is
-- the one place every mutation must pass through. Closing that gap is this
-- phase's whole reason for being.
--
-- ---------------------------------------------------------------------------
-- THE TWO ADRs ARE NOT INDEPENDENT, AND THE ORDER MATTERS AT MIGRATION TIME
-- ---------------------------------------------------------------------------
--
-- ADR-010 says the app role holds SELECT on audit_log and NOTHING ELSE. That is
-- what makes forging, altering and suppressing an audit row a clean
-- `permission denied`. It is ALSO what forces ADR-009's trigger to be SECURITY
-- DEFINER: running as the invoker it would be `meterlog_app`, which holds no
-- INSERT, so capture would break on the very immutability it is meant to serve.
--
-- And because audit_log is under FORCE ROW LEVEL SECURITY, a grant alone is not
-- enough for the definer either — FORCE applies policies to the table OWNER too,
-- so the definer needs a policy admitting its INSERT. Hence the second policy
-- below, and hence `audit_log` joining DEFINER_ACCESSIBLE_TABLES in helpers.ts.

-- ---------------------------------------------------------------------------
-- The action vocabulary.
-- ---------------------------------------------------------------------------
--
-- FOURTEEN VALUES OVER THE ELEVEN NAMED MUTATION TYPES (ADR-012). The eleven are
-- ISOLATION.md section 9's enumeration — which said "ten" in prose while naming
-- eleven, a stale total corrected in this phase. The three extras:
--
--   user.created         the identity write inside invite_member / register_tenant.
--                        `users` is audited because it is the ONLY table in the
--                        schema carrying a secret, and therefore the only place
--                        ADR-011's redaction can be proven NON-VACUOUSLY.
--   asset_event.created  the asset_events row accompanying creation, transition
--                        and decommission. Exempting it for "already being a log"
--                        is the event-derived thinking ADR-009 rejects, arriving
--                        by the back door.
--   membership.updated   a TOTAL-FUNCTION FALLBACK. No membership UPDATE path
--                        today changes neither `role` nor `deleted_at`. It exists
--                        so a future third path is labelled honestly instead of
--                        being silently mislabelled `membership.role_changed` — a
--                        mislabelled audit row is worse than an ugly one.
--
-- Named rather than a free-text column so a typo is a failed INSERT rather than a
-- row that quietly never matches a filter.
CREATE TYPE public.audit_action AS ENUM (
  'user.created',
  'membership.created',
  'membership.role_changed',
  'membership.revoked',
  'membership.updated',
  'asset.created',
  'asset.updated',
  'asset.status_changed',
  'asset.decommissioned',
  'asset_event.created',
  'reading.created',
  'maintenance.created',
  'maintenance.updated',
  'maintenance.deleted'
);

-- ---------------------------------------------------------------------------
-- audit_log — the fifth and final table of PROJECT_BRIEF section 5.
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULLABLE, and the reason was found in read-back rather than assumed.
  --
  -- Taken from the mutated row wherever the row has a tenant_id. `users` does NOT
  -- — ADR-006 section 2 made it pure identity — so for that one table the tenant
  -- falls back to app.current_tenant. And `register_tenant` inserts the users row
  -- BEFORE the memberships row with no tenant context set, so at that instant
  -- there is no tenant available from EITHER source.
  --
  -- A NULL-tenant row is invisible to every app-role read: the policy below
  -- compares tenant_id to the GUC and NULL matches nothing. That is correct, not
  -- a compromise. A users row is global identity, not any one tenant's audit
  -- data, and the bootstrap is still recorded in that tenant's trail by the
  -- `membership.created` row, which DOES carry a real tenant_id.
  --
  -- NO FOREIGN KEY to tenants, deliberately. audit/events never cascade-delete
  -- (PROJECT_BRIEF section 5 :149), and a RESTRICT FK here would make the audit
  -- trail able to BLOCK a future tenant deletion — an audit trail must never be
  -- able to veto the operation it is recording.
  tenant_id uuid,

  -- NULLABLE (ADR-009). register_tenant runs pre-authentication, so the trigger
  -- finds app.current_user empty and there IS NO ACTOR BY CONSTRUCTION.
  --
  -- Nullable keeps the change on the NEW table. A sentinel system-user row would
  -- mean seeding the frozen `users` table with a fake identity — a heavier touch
  -- on proven surface for no gain, and a row every user-listing read would then
  -- have to remember to filter out.
  actor_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,

  -- THE ROLE AT THE TIME OF THE ACTION — OPEN-4, answered as a property of the
  -- mechanism rather than as a retrofit. Looked up from `memberships` by the
  -- trigger, which fires DURING the mutation, so the row it reads IS the
  -- membership as it stood when the action happened. No app.current_role GUC was
  -- introduced (ADR-009 explains at length why not).
  --
  -- ****  THIS IS A DENORMALIZED SNAPSHOT. DO NOT "NORMALIZE" IT AWAY.  ****
  -- You cannot join to memberships later to recover this. The role may have
  -- changed since, or the membership may have been revoked, in which case the
  -- join returns the wrong answer or no answer at all. That it survives both is
  -- the entire point of the column.
  --
  -- NULL on the same rule as actor_user_id: no actor, no role.
  actor_role public.membership_role,

  -- PROJECT_BRIEF section 5 (:140) calls these entity_type / entity_id. Renamed
  -- because this trail is keyed by TABLE and ROW — which is what a trigger knows
  -- — rather than by an entity vocabulary the application would have to maintain
  -- in parallel and keep in step. Recorded as a deviation in ADR-011, not slipped
  -- in.
  table_name text NOT NULL,

  -- uuid, and the composite-key worry does not land. There are NO composite
  -- PRIMARY keys in this schema: ADR-007's composite key is a FOREIGN key,
  -- (asset_id, tenant_id) -> assets(id, tenant_id), backed by a supplementary
  -- UNIQUE. Every table keeps a single-column `id uuid` primary key, so no
  -- compound encoding and no text fallback is needed.
  row_id uuid NOT NULL,

  action public.audit_action NOT NULL,

  -- ONE jsonb column holding {before, after}, rather than the brief's two
  -- columns. The redaction allowlist and the changed-column diff are computed
  -- together from the same source; splitting the result across two columns
  -- creates a state where one can be redacted and the other not. Read as
  -- `payload -> 'after' ->> 'status'`.
  --
  -- UPDATE: only the columns whose values actually CHANGED, on both sides.
  -- INSERT: before is null, after is the allowlisted new row.
  payload jsonb NOT NULL,

  -- Append-only: created_at only, no updated_at, no deleted_at
  -- (PROJECT_BRIEF section 5 :146).
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every RLS-filtered read compares tenant_id (the index-foreign-keys rule, :148).
-- `id` IS IN THE INDEX AND THAT IS FINDING 7 / PERF section 2 APPLIED FROM DAY
-- ONE: step 7b paginates this table by keyset on (created_at, id), and phase 3a
-- shipped a two-column index whose row-wise cursor comparison was demoted from an
-- Index Cond to a Filter — scan-and-discard rather than seek. The new table gets
-- the measured answer rather than repeating the measurement.
CREATE INDEX audit_log_tenant_id_created_at_idx
  ON public.audit_log (tenant_id, created_at, id);

-- PROJECT_BRIEF section 5 (:148) asks for an index on (entity_type, entity_id).
-- This is that index under this table's column names — "everything that ever
-- happened to THIS row", the auditor's other question.
CREATE INDEX audit_log_table_name_row_id_idx
  ON public.audit_log (table_name, row_id);

-- Serves "what has this person done", the third audit query. Partial because the
-- system rows have no actor and there is no query that wants them by actor.
CREATE INDEX audit_log_actor_user_id_idx
  ON public.audit_log (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE  ROW LEVEL SECURITY;

-- The canonical tenant-scoped policy, and FOR SELECT deliberately — not FOR ALL.
--
-- FOR SELECT carries no WITH CHECK, so there is no permissive policy applicable
-- to INSERT/UPDATE/DELETE for the app role at all. That is belt to the grant's
-- braces: the write is refused twice over, independently, exactly as DECISION B
-- arranged for `memberships`. The grant is what produces the `permission denied`
-- the tests quote, because table privileges are checked BEFORE policies.
CREATE POLICY audit_log_tenant ON public.audit_log
  FOR SELECT TO meterlog_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- The definer's write path. REQUIRED, not optional: FORCE ROW LEVEL SECURITY
-- applies policies to the owner as well, so without this the SECURITY DEFINER
-- trigger cannot insert and every audited mutation in the system starts failing.
--
-- FOR INSERT only — the definer can append and can do nothing else. Note this is
-- narrower than the definer policies on tenants/users/memberships, which are
-- FOR ALL: there is no update or delete path to admit here, so none is written.
-- `WITH CHECK (true)` is the whole policy because least privilege comes from the
-- GRANT below (ADR-004), which withholds UPDATE and DELETE.
CREATE POLICY audit_log_definer_write ON public.audit_log
  FOR INSERT TO meterlog_definer
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- THE GRANT THAT IS THE DECISION (ADR-010).
-- ---------------------------------------------------------------------------
--
-- SELECT AND NOTHING ELSE. Not INSERT, not UPDATE, not DELETE. "The audit trail
-- is immutable" is true exactly as long as these privileges are absent, so it is
-- encoded as their absence rather than promised in prose — the same construction
-- as ADR-008's missing DELETE on maintenance_records, and the same one catalog
-- assertion 13 binds for the append-only tables.
--
-- Forging, altering or suppressing an audit row through the application is
-- therefore `permission denied for table audit_log` (42501), quoted verbatim in
-- ISOLATION.md and asserted with the row-level-security message EXCLUDED, since
-- 42501 cannot on its own distinguish a missing grant from a policy refusal.
GRANT SELECT ON public.audit_log TO meterlog_app;

-- The only write privilege on this table in the entire cluster, held by a role
-- that CANNOT LOG IN (ADR-004) and acts only through the allowlisted SECURITY
-- DEFINER functions. INSERT alone — no UPDATE, no DELETE — so a bug in the
-- trigger body attempting either is unreachable, the property catalog assertion
-- 6 used to provide for memberships before step 5 narrowed it.
GRANT INSERT ON public.audit_log TO meterlog_definer;

-- ---------------------------------------------------------------------------
-- audit_capture() — the trigger function.
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER, owned by meterlog_definer, search_path pinned per ADR-004.
-- The sixth entry in the definer allowlist; EXPECTED_DEFINER_FUNCTIONS in
-- helpers.ts is extended in this same PR, because catalog assertion 4 asserts
-- that list against the live catalog and fails loudly otherwise. That is the
-- system working.
--
-- OPERATOR DISCIPLINE (ADR-004's operator amendment — the citext lockout). The
-- pin removes `public` from resolution, and while an unqualified FUNCTION or
-- TABLE reference then fails loudly, an OPERATOR does not: it falls through the
-- operands' implicit casts and binds a different, plausible, wrong operator with
-- no diagnostic anywhere. This body is written so the question does not arise:
-- every operator it uses (-> , ->> , = , IS DISTINCT FROM , = ANY) is over
-- `jsonb`, `text` or `uuid`, all of which live in pg_catalog. It performs NO
-- citext comparison and NO enum comparison — role and action are ASSIGNED, and
-- status/role change detection is done on the ->> text projections rather than on
-- the enum values themselves, precisely to keep it that way.
--
-- ONE FUNCTION, SIX ATTACHMENTS. The per-table redaction allowlist arrives as the
-- trigger's ARGUMENT rather than being hard-coded here, which puts it in
-- pg_trigger.tgargs — visible in the catalog, and therefore assertable without
-- depending on any fixture having exercised the path (ADR-011).
CREATE FUNCTION public.audit_capture() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_allowed    text[];
  v_new_full   jsonb;
  v_old_full   jsonb;
  v_after      jsonb;
  v_before     jsonb;
  v_actor      uuid;
  v_role       public.membership_role;
  v_tenant     uuid;
  v_action     public.audit_action;
  v_soft_del   boolean;
BEGIN
  -- TG_ARGV[0] is the allowlist: the ONLY columns of this table that may reach
  -- the payload. Allowlist, not denylist (ADR-011) — a column added to `users`
  -- tomorrow is excluded until somebody deliberately admits it in migration SQL,
  -- rather than leaking from the day it lands.
  v_allowed := pg_catalog.string_to_array(TG_ARGV[0], ',');

  v_new_full := pg_catalog.to_jsonb(NEW);
  IF TG_OP = 'UPDATE' THEN
    v_old_full := pg_catalog.to_jsonb(OLD);
  ELSE
    v_old_full := NULL;
  END IF;

  -- ---- actor -------------------------------------------------------------
  -- Already set by the request interceptor, inside the transaction, for every
  -- authenticated request. No new plumbing (ADR-009).
  --
  -- NULLIF(..., '') is not decoration and ADR-004 explains why: on a POOLED
  -- connection a GUC that has been set once reverts at transaction end to the
  -- EMPTY STRING, not to NULL, and ''::uuid raises 22P02. Without it this
  -- trigger would abort ordinary mutations, non-deterministically, only after a
  -- connection had been reused.
  v_actor := NULLIF(current_setting('app.current_user', true), '')::uuid;

  -- ---- tenant ------------------------------------------------------------
  -- From the mutated row where the row has one; from the request context where
  -- it does not (`users` — ADR-006 section 2 left it with no tenant_id). NULL for
  -- the pre-auth bootstrap, which is the only path that reaches neither.
  v_tenant := COALESCE(
    (v_new_full ->> 'tenant_id')::uuid,
    NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );

  -- ---- role at the time of the action (OPEN-4) ----------------------------
  -- BY LOOKUP, NOT BY GUC. The trigger runs inside the mutating transaction, so
  -- this row IS the membership as it stood when the action happened. Whatever
  -- happens to it afterwards — a role change, a revoke — the snapshot written
  -- below does not move.
  --
  -- Liveness is filtered here and not in a policy: OPEN-5's rule, reused.
  IF v_actor IS NOT NULL AND v_tenant IS NOT NULL THEN
    SELECT m.role
      INTO v_role
      FROM public.memberships m
     WHERE m.user_id = v_actor
       AND m.tenant_id = v_tenant
       AND m.deleted_at IS NULL
     LIMIT 1;
  END IF;

  -- ---- classify ----------------------------------------------------------
  -- Detected on the ->> TEXT projections rather than on the columns, for two
  -- reasons: it needs no enum operator (see the operator note above), and it is
  -- uniform across tables that do not all carry the same columns —
  -- `asset_events` and `readings` have no deleted_at at all, and a missing key
  -- projects to NULL rather than raising.
  v_soft_del := TG_OP = 'UPDATE'
            AND (v_old_full ->> 'deleted_at') IS NULL
            AND (v_new_full ->> 'deleted_at') IS NOT NULL;

  IF TG_TABLE_NAME = 'users' THEN
    v_action := 'user.created';

  ELSIF TG_TABLE_NAME = 'memberships' THEN
    IF TG_OP = 'INSERT' THEN
      v_action := 'membership.created';
    ELSIF v_soft_del THEN
      v_action := 'membership.revoked';
    ELSIF (v_new_full ->> 'role') IS DISTINCT FROM (v_old_full ->> 'role') THEN
      v_action := 'membership.role_changed';
    ELSE
      -- Unreachable today; see the enum note at the top of this file.
      v_action := 'membership.updated';
    END IF;

  ELSIF TG_TABLE_NAME = 'assets' THEN
    IF TG_OP = 'INSERT' THEN
      v_action := 'asset.created';
    ELSIF v_soft_del THEN
      -- Decommission IS the soft delete: `assets_decommissioned_iff_deleted`
      -- makes status='decommissioned' and deleted_at biconditional, so this
      -- branch must come BEFORE the status check or a decommission would be
      -- recorded as an ordinary status change.
      v_action := 'asset.decommissioned';
    ELSIF (v_new_full ->> 'status') IS DISTINCT FROM (v_old_full ->> 'status') THEN
      v_action := 'asset.status_changed';
    ELSE
      v_action := 'asset.updated';
    END IF;

  ELSIF TG_TABLE_NAME = 'asset_events' THEN
    v_action := 'asset_event.created';

  ELSIF TG_TABLE_NAME = 'readings' THEN
    v_action := 'reading.created';

  ELSIF TG_TABLE_NAME = 'maintenance_records' THEN
    IF TG_OP = 'INSERT' THEN
      v_action := 'maintenance.created';
    ELSIF v_soft_del THEN
      v_action := 'maintenance.deleted';
    ELSE
      v_action := 'maintenance.updated';
    END IF;

  ELSE
    -- FAIL LOUD AND FAIL CLOSED. A table attached to this trigger with no
    -- classification would otherwise get a NULL action and a failed NOT NULL
    -- insert anyway — this says WHY, and it says it at the attachment rather
    -- than at the column. Reaching it means someone added an attachment without
    -- adding its actions to the enum above.
    RAISE EXCEPTION
      'audit_capture: no action mapping for table %. Add its actions to public.audit_action and a branch here before attaching the trigger.',
      TG_TABLE_NAME
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ---- payload, through the allowlist -------------------------------------
  IF TG_OP = 'INSERT' THEN
    -- Fact-of-change: the new row, allowlisted.
    SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      INTO v_after
      FROM jsonb_each(v_new_full) AS e
     WHERE e.key = ANY (v_allowed);

    v_before := 'null'::jsonb;
  ELSE
    -- Changed-column diff: only the allowlisted columns whose value actually
    -- moved. A column withheld by the allowlist is absent from BOTH sides, so a
    -- redacted column cannot even be inferred from a "something changed here".
    SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      INTO v_after
      FROM jsonb_each(v_new_full) AS e
     WHERE e.key = ANY (v_allowed)
       AND (v_old_full -> e.key) IS DISTINCT FROM e.value;

    SELECT COALESCE(jsonb_object_agg(e.key, COALESCE(v_old_full -> e.key, 'null'::jsonb)), '{}'::jsonb)
      INTO v_before
      FROM jsonb_each(v_after) AS e;
  END IF;

  INSERT INTO public.audit_log
    (tenant_id, actor_user_id, actor_role, table_name, row_id, action, payload)
  VALUES
    (v_tenant,
     v_actor,
     v_role,
     TG_TABLE_NAME,
     (v_new_full ->> 'id')::uuid,
     v_action,
     jsonb_build_object('before', v_before, 'after', v_after));

  -- AFTER trigger: the return value is ignored. NULL is the conventional marker
  -- for "this trigger does not influence the row".
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Ownership. Same pattern, and the SAME HAZARD, as 20260908000000 and
-- 20260909000000 — copied deliberately rather than simplified.
--
-- ALTER FUNCTION ... OWNER TO needs membership in the target role. Locally and in
-- CI the migration role is the cluster bootstrap superuser, for which
-- pg_has_role is true unconditionally, so the grant is a no-op there; on Render
-- it is NOT a superuser, and it holds ADMIN OPTION on meterlog_definer only by
-- virtue of having created it in 20260903000000.
--
-- **THE MEMBERSHIP IS REVOKED AGAIN, AND THAT IS THE LOAD-BEARING HALF.** RLS
-- matches a policy's roles by MEMBERSHIP, so a migration role left inside
-- meterlog_definer silently acquires every `TO meterlog_definer USING (true)`
-- policy on every identity table — the FORCE-RLS bypass the three-role model
-- exists to prevent, reintroduced through role membership. It is invisible in
-- CI, because a superuser never takes the grant branch in the first place.
--
-- This block is also why `audit_log` needed its own definer policy above: the
-- trigger runs AS meterlog_definer, and the same membership rule is what makes
-- that policy apply to it.
-- ---------------------------------------------------------------------------
DO $ownership$
DECLARE
  self_granted boolean := false;
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'meterlog_definer', 'MEMBER') THEN
    EXECUTE format('GRANT meterlog_definer TO %I', current_user);
    self_granted := true;
  END IF;

  EXECUTE 'ALTER FUNCTION public.audit_capture() OWNER TO meterlog_definer';

  IF self_granted THEN
    EXECUTE format('REVOKE meterlog_definer FROM %I', current_user);
  END IF;
END
$ownership$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, and a
-- function's ACL is invisible in the places people look when reviewing a definer
-- function. Catalog assertion 11 asserts this is revoked.
--
-- NO CORRESPONDING GRANT TO meterlog_app, and that is deliberate rather than an
-- oversight: a trigger function is never called by name. Postgres checks EXECUTE
-- at CREATE TRIGGER time, not at fire time, so the app role needs nothing here
-- and granting it would be a privilege that buys nothing while making catalog
-- assertion 12 satisfiable by an empty gesture. Assertion 12 is narrowed instead,
-- and paired with a new assertion 16 that a trigger-returning definer function
-- must actually be ATTACHED — so "excluded from 12" cannot become a way to hide
-- an unreachable definer function.
REVOKE EXECUTE ON FUNCTION public.audit_capture() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The attachments — six tables, eleven named mutation types (ADR-012).
-- ---------------------------------------------------------------------------
--
-- AFTER, not BEFORE (ADR-009): a BEFORE trigger can be followed by another BEFORE
-- trigger that changes the row, so the audited value would not be the stored one.
--
-- INSERT OR UPDATE, with NO DELETE branch, and that is a property of the schema
-- rather than an omission. v1.0 has no hard delete anywhere — every FK is
-- ON DELETE RESTRICT, `users`/`memberships`/`assets`/`maintenance_records` are
-- soft-deleted and `asset_events`/`readings` are append-only — so a removal is an
-- UPDATE of deleted_at and the trigger always has a NEW row. WHEN HARD DELETE
-- LANDS (OPEN-9) THIS IS THE FIRST THING IT MUST REVISIT.
--
-- The second argument of each is the REDACTION ALLOWLIST (ADR-011). It lives here
-- rather than in the function body so it is readable from pg_trigger.tgargs, and
-- so `password_hash` can be asserted absent from every allowlist in the database
-- by one catalog query that no fixture has to reach.

-- users — THE ONE THAT MATTERS. `password_hash` is NOT in this list.
--
-- It is withheld from the app role by a COLUMN-level grant on public.users, so
-- the app role genuinely cannot read it today. `to_jsonb(NEW)` inside a SECURITY
-- DEFINER trigger reads it regardless — the tuple is in memory, no privilege is
-- consulted — and would write it into a table the app role CAN read. Without this
-- allowlist the audit trail becomes a privilege-escalation path, and it looks
-- like a feature while it does it.
CREATE TRIGGER users_audit
  AFTER INSERT OR UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id,email,created_at,updated_at,deleted_at');

CREATE TRIGGER memberships_audit
  AFTER INSERT OR UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id,user_id,tenant_id,role,created_at,updated_at,deleted_at');

CREATE TRIGGER assets_audit
  AFTER INSERT OR UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id,tenant_id,serial_number,type,status,location,installed_at,created_at,updated_at,deleted_at');

CREATE TRIGGER asset_events_audit
  AFTER INSERT OR UPDATE ON public.asset_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id,tenant_id,asset_id,event_type,payload,created_by,created_at');

CREATE TRIGGER readings_audit
  AFTER INSERT OR UPDATE ON public.readings
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id,tenant_id,asset_id,value,unit,read_at,created_by,created_at');

CREATE TRIGGER maintenance_records_audit
  AFTER INSERT OR UPDATE ON public.maintenance_records
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('id,tenant_id,asset_id,description,performed_at,created_by,created_at,updated_at,deleted_at');

-- NOT ATTACHED TO `tenants`, and that is a decision rather than an absence
-- (ADR-012). No named mutation writes it, and v1.0 exposes no endpoint that
-- mutates a tenant — the only INSERT is register_tenant's, whose bootstrap is
-- already recorded by the user.created and membership.created rows it writes in
-- the same transaction. The day a tenant-rename or tenant-soft-delete endpoint is
-- proposed, this is revisited BEFORE that endpoint ships.
--
-- NOT ATTACHED TO `audit_log` itself: nothing can write it but this trigger, and
-- a trigger on the audit table would recurse.
