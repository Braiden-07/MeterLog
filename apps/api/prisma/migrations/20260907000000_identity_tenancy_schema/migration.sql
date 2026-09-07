-- Step 4, Phase 1 — identity and tenancy schema with the full RLS policy set.
-- Implements ADR-006 exactly. Every GUC reference uses the canonical
-- NULLIF(current_setting('app.<guc>', true), '')::uuid form (ADR-004 assertion 8):
-- current_setting reverts to '' rather than NULL on a reused pooled connection,
-- and ''::uuid raises 22P02 instead of filtering.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Pure identity: no tenant_id, no role. Both moved to memberships (ADR-006 §2).
CREATE TABLE public.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- Globally unique among live rows. Partial so a soft-deleted account does not
-- permanently reserve its address. citext makes it case-insensitive.
CREATE UNIQUE INDEX users_email_live_key ON public.users (email) WHERE deleted_at IS NULL;

CREATE TYPE public.membership_role AS ENUM ('admin', 'technician', 'auditor');

CREATE TABLE public.memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id)   ON DELETE RESTRICT,
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  role       public.membership_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- At most one LIVE membership per user per tenant. Partial, so a revoked user
-- can be re-invited later without colliding. This index also serves the §4
-- re-verify lookup and the self-axis reads — hence no separate (user_id) index.
CREATE UNIQUE INDEX memberships_user_tenant_live_key
  ON public.memberships (user_id, tenant_id) WHERE deleted_at IS NULL;

-- The tenant-admin axis (user management) scans by tenant.
CREATE INDEX memberships_tenant_id_idx ON public.memberships (tenant_id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.tenants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants     FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users       FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE  ROW LEVEL SECURITY;

-- --- tenants ---------------------------------------------------------------

-- The active workspace. Standard ADR-004 tenant-scoped shape.
CREATE POLICY tenants_active ON public.tenants
  FOR ALL TO meterlog_app
  USING      (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- The workspace list for /auth/me. Without this, every workspace but the active
-- one is invisible and the switcher can render ids but not names (ADR-006 §0.4).
-- FOR SELECT so a read-shaped policy cannot become a write vector.
-- The subquery is itself filtered by memberships' self axis, which is the intent;
-- it does not recurse, because no memberships policy references tenants.
CREATE POLICY tenants_workspace_list ON public.tenants
  FOR SELECT TO meterlog_app
  USING (id IN (SELECT m.tenant_id FROM public.memberships m
                WHERE m.user_id = NULLIF(current_setting('app.current_user', true), '')::uuid
                  AND m.deleted_at IS NULL));

CREATE POLICY tenants_definer ON public.tenants
  FOR ALL TO meterlog_definer USING (true) WITH CHECK (true);

-- --- users (ADR-006 §3 amendment) ------------------------------------------

CREATE POLICY users_self_read ON public.users
  FOR SELECT TO meterlog_app
  USING (id = NULLIF(current_setting('app.current_user', true), '')::uuid);

-- Acting in a tenant, read the identities of that tenant's live members, so
-- GET /users can join membership rows to email. Scoped by tenant, not by role —
-- the admin-only restriction is the RBAC guard's job.
CREATE POLICY users_tenant_members_read ON public.users
  FOR SELECT TO meterlog_app
  USING (id IN (SELECT m.user_id FROM public.memberships m
                WHERE m.tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
                  AND m.deleted_at IS NULL));

-- No app-role write policy: every users write in v1.0 goes through
-- register_tenant (definer). Invite adds one deliberately in step 5.
CREATE POLICY users_definer ON public.users
  FOR ALL TO meterlog_definer USING (true) WITH CHECK (true);

-- --- memberships -----------------------------------------------------------

-- Self axis. MUST be FOR SELECT, never FOR ALL: a FOR ALL policy with only a
-- USING clause has its WITH CHECK defaulted to the same expression, and because
-- permissive policies OR on writes, the self axis would then let any user INSERT
-- themselves a membership granting admin of ANY tenant. That was demonstrated
-- against a live database in ADR-006 §0.1. FOR SELECT carries no WITH CHECK.
--
-- Liveness (deleted_at IS NULL) is deliberately ABSENT here — see OPEN-5. A
-- SELECT policy predicate on deleted_at blocks the revoking UPDATE itself,
-- because Postgres applies the SELECT policy to the new row of an UPDATE ... WHERE.
-- Callers filter app-side; the security gate is the §4 re-verify, which does
-- enforce liveness.
CREATE POLICY memberships_self_read ON public.memberships
  FOR SELECT TO meterlog_app
  USING (user_id = NULLIF(current_setting('app.current_user', true), '')::uuid);

-- Tenant-admin axis — the only app-role write path.
CREATE POLICY memberships_tenant ON public.memberships
  FOR ALL TO meterlog_app
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY memberships_definer ON public.memberships
  FOR ALL TO meterlog_definer USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants — least privilege. Table privileges are checked BEFORE policies, so
-- these cap what any policy can reach (ADR-004 catalog assertion 6).
-- ---------------------------------------------------------------------------

-- App role: reads tenants, never writes them (registration owns creation).
GRANT SELECT ON public.tenants TO meterlog_app;

-- App role: column-limited on users. RLS is row-level and cannot hide a column,
-- so password_hash is withheld by omitting it from the grant — a tenant-admin
-- reading member identities cannot read their hashes.
GRANT SELECT (id, email, created_at, updated_at, deleted_at) ON public.users TO meterlog_app;

-- App role: memberships is the one table it writes. No DELETE — revocation is a
-- soft delete (UPDATE), so hard deletion is impossible for the runtime role.
GRANT SELECT, INSERT, UPDATE ON public.memberships TO meterlog_app;

-- Definer role: exactly what login_lookup and register_tenant need, and nothing
-- else. No UPDATE/DELETE/TRUNCATE/REFERENCES anywhere (asserted in CI).
GRANT SELECT, INSERT ON public.tenants     TO meterlog_definer;
GRANT SELECT, INSERT ON public.users       TO meterlog_definer;
GRANT SELECT, INSERT ON public.memberships TO meterlog_definer;
