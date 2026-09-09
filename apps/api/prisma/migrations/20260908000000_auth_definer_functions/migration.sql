-- Step 4, Phase 2 — the pre-auth SECURITY DEFINER surface (ADR-006 §6).
--
-- Exactly two functions, and the allowlist in test/db/helpers.ts is asserted
-- against the catalog so a third cannot appear without a reviewed edit there.
-- Every ADR-004 hardening applies to both:
--
--   * owned by meterlog_definer (which is NOLOGIN and owns nothing else),
--   * SET search_path = pg_catalog, pg_temp — with `public` out of the
--     resolution path an unqualified reference fails outright rather than
--     resolving to an attacker-planted object,
--   * therefore every reference in both bodies is schema-qualified,
--   * EXECUTE revoked from PUBLIC (the default grant) and given only to
--     meterlog_app,
--   * exact-match lookups on a narrow argument list.
--
-- Neither function performs a caller-authorization check, and neither needs to:
-- both run BEFORE any authenticated context exists. That is emphatically NOT
-- true of the membership-write functions step 5 adds — see the standing rule in
-- ADR-006 §7. The definer policy on these tables is USING (true) WITH CHECK
-- (true), so it constrains nothing; from step 5 onward the function body is the
-- only thing enforcing tenant scoping and the admin check.

-- ---------------------------------------------------------------------------
-- login_lookup — credential lookup for POST /auth/login.
--
-- Keyed on email alone. ADR-004's login-identity question (does the login form
-- need a tenant discriminator?) is dissolved rather than answered: under ADR-006
-- a person is not a property of a tenant, so email is globally unique and
-- identifies the human by itself.
--
-- Returns no tenant and no role. Those come from the post-auth memberships read
-- under RLS via app.current_user, which is why the definer surface did not have
-- to grow to cover them.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.login_lookup(p_email citext)
RETURNS TABLE (id uuid, password_hash text, deleted_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.password_hash, u.deleted_at
  FROM public.users u
  -- OPERATOR(public.=), not a bare `=`, and this is load-bearing rather than
  -- pedantic. citext's equality operator lives in `public`, which the pinned
  -- search_path deliberately excludes. A bare `=` therefore does NOT fail to
  -- resolve — it falls back through citext's implicit cast to text and silently
  -- binds `text = text`, which is CASE-SENSITIVE. Verified against a live
  -- database: under this function's search_path, 'a'::citext = 'A'::citext is
  -- false, and true only once `public` is on the path.
  --
  -- The consequence was a user-facing lockout, not a cosmetic wrong answer.
  -- users_email_live_key resolved its citext operator class at CREATE INDEX time
  -- (with `public` in scope), so uniqueness stayed case-insensitive while this
  -- lookup became case-sensitive. Register as Founder@acme.test, log in as
  -- founder@acme.test: no row, generic auth failure — and re-registering is
  -- refused by the index, so the account is unreachable and unrecoverable.
  --
  -- Schema-qualifying the operator is the fix, NOT adding `public` to the
  -- search_path: the whole point of the pin is that `public` is untrusted
  -- resolution space for a SECURITY DEFINER body (ADR-004).
  WHERE u.email OPERATOR(public.=) p_email
  -- ADR-006 §6 specifies "at most one row", and the schema does not guarantee it
  -- on its own: users_email_live_key is PARTIAL (WHERE deleted_at IS NULL), so
  -- one live row and any number of soft-deleted rows can share an address. Prefer
  -- the live row, then the most recent, so the result is deterministic instead of
  -- depending on heap order. deleted_at is still returned rather than filtered on,
  -- because distinguishing "no such account" from "deactivated account" is the
  -- caller's decision — the login path answers both with the same generic failure
  -- (no user enumeration), but the distinction is worth logging.
  ORDER BY (u.deleted_at IS NULL) DESC, u.created_at DESC
  LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- register_tenant — POST /auth/register. Creates an organization: three rows,
-- all or nothing (ADR-006 §5, widening ADR-004's two-row gate to three).
--
-- ATOMICITY IS STRUCTURAL, AND FRAGILE TO ONE EDIT. The function body runs
-- inside the caller's transaction, and plpgsql opens NO subtransaction unless a
-- block carries an EXCEPTION handler. With no handler anywhere here, any error
-- in any of the three INSERTs propagates and unwinds all of them together.
--
-- Adding an EXCEPTION handler around a SUBSET of these statements would break
-- that: the handler establishes a subtransaction boundary, so a failure caught
-- after the tenant INSERT could leave the tenant committed with no admin. That
-- is the specific failure ADR-004's step-4 gate names — a tenant row exists,
-- nobody can log into it, and registration cannot be retried because the tenant
-- already exists. Do not add one. If a caller needs to distinguish error causes,
-- it should read the SQLSTATE, not catch in here.
--
-- The duplicate-email case (OPEN-1: register with an existing address rejects
-- 409) is enforced by users_email_live_key raising 23505 on the second INSERT,
-- which is exactly the forced-failure path the atomicity test exercises. No
-- pre-check is done for it: a SELECT-then-INSERT would be a race, while the
-- partial unique index is the actual guarantee.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.register_tenant(
  p_tenant_name   text,
  p_email         citext,
  p_password_hash text
)
RETURNS TABLE (tenant_id uuid, user_id uuid, membership_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  -- Prefixed so nothing here can collide with the OUT parameters that RETURNS
  -- TABLE declares (tenant_id, user_id, membership_id), which are also column
  -- names on public.memberships.
  v_tenant_id     uuid;
  v_user_id       uuid;
  v_membership_id uuid;
BEGIN
  INSERT INTO public.tenants (name)
  VALUES (p_tenant_name)
  RETURNING public.tenants.id INTO v_tenant_id;

  INSERT INTO public.users (email, password_hash)
  VALUES (p_email, p_password_hash)
  RETURNING public.users.id INTO v_user_id;

  -- The first admin. Role is per-tenant under ADR-006, so it lives here and not
  -- on the users row.
  INSERT INTO public.memberships (user_id, tenant_id, role)
  VALUES (v_user_id, v_tenant_id, 'admin')
  RETURNING public.memberships.id INTO v_membership_id;

  RETURN QUERY SELECT v_tenant_id, v_user_id, v_membership_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Ownership.
--
-- Both functions must be owned by meterlog_definer — that is what makes
-- SECURITY DEFINER reach the tables through the TO meterlog_definer policies.
--
-- ALTER FUNCTION ... OWNER TO requires the executing role to be a member of the
-- target role. Locally and in CI the migration role is the cluster bootstrap
-- superuser, for which pg_has_role is true unconditionally, so this block is a
-- no-op there. On Render the migration role is NOT a superuser, and this is the
-- first migration that would have failed there — it holds ADMIN OPTION on
-- meterlog_definer by virtue of having created it in 20260903000000, which is
-- what lets it grant itself membership.
--
-- The membership is revoked immediately afterwards, and that matters rather than
-- being tidiness: RLS matches a policy's role by MEMBERSHIP, so a migration role
-- left inside meterlog_definer would silently acquire every
-- `TO meterlog_definer USING (true)` policy on every identity table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  self_granted boolean := false;
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'meterlog_definer', 'MEMBER') THEN
    EXECUTE format('GRANT meterlog_definer TO %I', current_user);
    self_granted := true;
  END IF;

  EXECUTE 'ALTER FUNCTION public.login_lookup(citext) OWNER TO meterlog_definer';
  EXECUTE 'ALTER FUNCTION public.register_tenant(text, citext, text) OWNER TO meterlog_definer';

  IF self_granted THEN
    EXECUTE format('REVOKE meterlog_definer FROM %I', current_user);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges.
--
-- REVOKE FROM PUBLIC is not optional and not defensive noise: Postgres grants
-- EXECUTE on a new function to PUBLIC by default, so without this line every
-- role in the cluster could call a SECURITY DEFINER function that reads
-- password hashes.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.login_lookup(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_tenant(text, citext, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.login_lookup(citext) TO meterlog_app;
GRANT EXECUTE ON FUNCTION public.register_tenant(text, citext, text) TO meterlog_app;
