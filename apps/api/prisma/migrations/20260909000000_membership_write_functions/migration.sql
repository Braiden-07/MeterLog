-- Step 5, Phase 1 — the membership-write SECURITY DEFINER surface (ADR-006 §7).
--
-- These are the first definer functions that act ON BEHALF OF AN AUTHENTICATED
-- CALLER, and they are therefore the first bound by the §7 standing rule:
--
--   Every definer write function that acts on behalf of an authenticated caller
--   MUST enforce, in its own body: (a) the caller is an admin of the active
--   tenant, and (b) the target row belongs to that tenant — because nothing
--   below it will.
--
-- `register_tenant` is exempt (pre-auth, no acting caller, creates its own
-- tenant); `login_lookup` is read-only and likewise exempt. These three are not.
--
-- WHY "nothing below it will" IS LITERALLY TRUE HERE. Under DECISION B the app
-- role holds no write privilege and no write policy on `memberships`, so the only
-- write path is this one, running under `memberships_definer` — whose policy is
-- `USING (true) WITH CHECK (true)` and therefore constrains nothing whatsoever.
-- Before B, `memberships_tenant` was `FOR ALL` and the POLICY enforced tenant
-- scoping on every write, so a buggy body still could not cross a tenant
-- boundary. That backstop is gone by design. The bodies below are all of it.
--
-- The GRANT UPDATE at the foot of this file is the moment B's grant-level
-- backstop weakens on purpose: catalog assertion 6 previously read
-- "meterlog_definer holds no UPDATE on ANY table", and the grant alone made a
-- whole class of body bug unreachable. change-role and revoke (a soft delete) are
-- both UPDATEs, so that can no longer hold. Assertion 6 is narrowed to the exact
-- new shape — UPDATE on `memberships` and nothing else — rather than relaxed.

-- ---------------------------------------------------------------------------
-- Error contract: custom SQLSTATEs, and the reason they are custom.
--
--   MB001  NOT_ADMIN             — no context, or the caller is not a live admin
--                                  of the active tenant.
--   MB002  MEMBERSHIP_NOT_FOUND  — the target membership is absent, revoked, or
--                                  belongs to a different tenant. Deliberately one
--                                  code: "exists but is not yours" must not be
--                                  distinguishable from "does not exist".
--   MB003  LAST_ADMIN            — the change would leave the tenant with zero
--                                  live admins.
--
-- The obvious choice for MB001 is the standard `42501 insufficient_privilege`,
-- and it is the WRONG choice, for a reason this repo has been bitten by before:
-- Postgres raises 42501 itself for a plain table-privilege denial. A test
-- asserting 42501 would then pass just as happily against a misconfigured GRANT
-- that never reached the function body at all — a green negative proving nothing,
-- the same vacuity shape as a rolled-back wrapper hiding a non-atomic function.
-- The same argument rules out `P0002` (plpgsql raises it for SELECT ... INTO
-- STRICT) and `23514` (a real CHECK constraint). A code nothing else in the
-- cluster can raise makes each negative unambiguously attributable to the body
-- check it is meant to be testing.
--
-- The app layer keys on SQLSTATE, never on message text — the Phase 2 lesson from
-- the 409 that was keyed on a constraint name inside an error string.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- invite_member — POST /users (step 5 Phase 2). ADR-006 §7 invite semantics.
--
-- Existing live `users` row for the email → attach a new membership to that
-- person (the multi-org mechanism, OPEN-1). No live row → create the identity and
-- the membership together, atomically.
--
-- (b) IS STRUCTURAL HERE, NOT A CHECK. The new membership's tenant_id is taken
-- from `app.current_tenant` — the GUC the interceptor only ever sets after
-- re-verifying the caller's live membership — and never from a parameter. There
-- is no caller-supplied tenant to validate, so there is no cross-tenant target to
-- reject: an admin of A who somehow set the active tenant to B fails (a) instead,
-- because they are not a live admin of B. The negative is real either way; it just
-- lands on the admin check.
--
-- THE PASSWORD HASH IS A PARAMETER, AND THAT IS A DELIBERATE SEAM. argon2 cannot
-- be computed in SQL, so the sentinel hash for the new-identity branch is derived
-- app-side from ARGON2_OPTIONS — the single source of hashing cost (ADR-001) — and
-- passed in. It is emphatically NOT a literal baked into this migration: a
-- hardcoded hash is exactly the drift vector killed at the step-4 gate, where the
-- login timing-equalisation hash and the production hash agreed only by accident
-- of library default. Tune the cost, forget the literal, and the sentinel silently
-- stops matching production.
--
-- The parameter is used ONLY on the create branch. It can never overwrite an
-- existing person's credential — otherwise "invite" would be a password reset for
-- any email in the system, executable by any tenant admin.
--
-- Matching is on LIVE users only. `users_email_live_key` is partial, so a
-- soft-deleted row may share the address; attaching a membership to a deleted
-- identity would produce a member who cannot log in. The partial index is the
-- actual guarantee, so the lookup matches its shape.
--
-- No pre-check for "already a member": `memberships_user_tenant_live_key` raises
-- 23505, and a SELECT-then-INSERT would be a race. Same reasoning as
-- register_tenant's duplicate-email path.
--
-- ATOMICITY IS STRUCTURAL, as in register_tenant: no EXCEPTION handler anywhere,
-- so plpgsql opens no subtransaction and a failure on the membership INSERT
-- unwinds the users INSERT with it. Adding a handler around a subset of these
-- statements would strand an identity with no membership. Do not add one.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.invite_member(
  p_email                  citext,
  p_role                   public.membership_role,
  p_new_user_password_hash text
)
RETURNS TABLE (membership_id uuid, user_id uuid, user_created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- v_-prefixed so nothing collides with the OUT parameters RETURNS TABLE
  -- declares, which are also column names on public.memberships.
  v_actor         uuid;
  v_tenant        uuid;
  v_user_id       uuid;
  v_membership_id uuid;
  v_user_created  boolean := false;
BEGIN
  -- The acting identity comes from the request GUCs, never from an argument.
  -- NULLIF(..., '') is not decoration: on a POOLED connection a GUC that has been
  -- set once reverts to the EMPTY STRING, not NULL, at transaction end. Without
  -- the guard this is ''::uuid → 22P02 → a 500 instead of a clean refusal, and it
  -- reproduces only after connection reuse.
  v_actor  := NULLIF(current_setting('app.current_user', true), '')::uuid;
  v_tenant := NULLIF(current_setting('app.current_tenant', true), '')::uuid;

  -- (a) Caller is a live admin of the active tenant. Fails closed on absent
  -- context: NULL context cannot match a row, and the IF NOT EXISTS refuses.
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'MB001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.user_id   OPERATOR(pg_catalog.=) v_actor
      AND m.tenant_id OPERATOR(pg_catalog.=) v_tenant
      AND m.role      OPERATOR(pg_catalog.=) 'admin'::public.membership_role
      AND m.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'MB001';
  END IF;

  -- OPERATOR(public.=), not a bare `=`. citext's equality operator lives in
  -- `public`, which this function's pinned search_path deliberately excludes. A
  -- bare `=` does not fail to resolve — it falls back through citext's implicit
  -- cast to text and silently binds CASE-SENSITIVE `text = text`. That is the
  -- ADR-004 operator amendment, and the defect it caused was an unrecoverable
  -- account lockout, not a wrong answer. Here it would be subtler still: a
  -- case-different existing address would miss, the create branch would fire, and
  -- users_email_live_key (which IS case-insensitive) would refuse it — an invite
  -- that cannot succeed for a person who is already in the system.
  SELECT u.id
    INTO v_user_id
  FROM public.users u
  WHERE u.email OPERATOR(public.=) p_email
    AND u.deleted_at IS NULL;

  IF v_user_id IS NULL THEN
    INSERT INTO public.users (email, password_hash)
    VALUES (p_email, p_new_user_password_hash)
    RETURNING public.users.id INTO v_user_id;
    v_user_created := true;
  END IF;

  INSERT INTO public.memberships (user_id, tenant_id, role)
  VALUES (v_user_id, v_tenant, p_role)
  RETURNING public.memberships.id INTO v_membership_id;

  RETURN QUERY SELECT v_membership_id, v_user_id, v_user_created;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- change_member_role — PATCH /users/:id, where :id is a MEMBERSHIP id.
--
-- Membership id rather than user id, decided at the step-5 gate: it makes §7's
-- clause (b) a direct check on the row actually being written, rather than a
-- resolution step that has to be trusted to have scoped correctly.
--
-- THE LAST-ADMIN GUARD (Decision 1, option A — recorded as an ADR-006 §7
-- amendment). Refuse a change that would leave the tenant with zero live admins;
-- permit "hand over then leave" while another admin remains.
--
-- The guard is a SELF-check, and that is a structural result rather than a
-- simplification. Clause (a) requires the caller be a live admin of this tenant,
-- and memberships_user_tenant_live_key allows at most one live membership per
-- (user, tenant). So if the target is an admin membership OTHER than the caller's
-- own, the caller's own admin membership is a second live admin by construction,
-- and the tenant cannot be zeroed. Demoting or revoking someone else can never be
-- the last-admin case. "Last admin" and "self-action on one's own admin
-- membership" are the same condition; there is no cross-user lockout to defend
-- against.
--
-- LOCK ORDER IS LOAD-BEARING, AND SO IS THE LOCK ITSELF.
--
-- Transactions run at READ COMMITTED (no isolationLevel is set on the per-request
-- interactive transaction). A bare `count(*)` of live admins would therefore be a
-- snapshot read: two admins concurrently demoting themselves each read count = 2,
-- each conclude another admin remains, and the tenant lands on zero. The count
-- must be taken over rows this transaction has LOCKED, so the second transaction
-- blocks and — under READ COMMITTED's re-evaluation of the qual against the
-- committed row version — no longer sees the first as an admin.
--
-- The admin set is locked BEFORE the target row, and ORDER BY id. Both halves
-- matter. Locking the target first deadlocks the symmetric case outright: two
-- admins self-demoting would each hold their own row and then reach for the
-- other's, and Postgres would resolve it with 40P01 rather than with this
-- function's own refusal. Locking the set first, in a deterministic order, makes
-- one transaction wait instead of both failing. The set is locked on every call,
-- not only the self-action path, because whether it is a self-action is not known
-- until the target has been read — and reading it first is the ordering that
-- deadlocks.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.change_member_role(
  p_membership_id uuid,
  p_role          public.membership_role
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_actor       uuid;
  v_tenant      uuid;
  v_target_user uuid;
  v_target_role public.membership_role;
  v_live_admins integer;
BEGIN
  v_actor  := NULLIF(current_setting('app.current_user', true), '')::uuid;
  v_tenant := NULLIF(current_setting('app.current_tenant', true), '')::uuid;

  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'MB001';
  END IF;

  -- (a) caller is a live admin of the active tenant.
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.user_id   OPERATOR(pg_catalog.=) v_actor
      AND m.tenant_id OPERATOR(pg_catalog.=) v_tenant
      AND m.role      OPERATOR(pg_catalog.=) 'admin'::public.membership_role
      AND m.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'MB001';
  END IF;

  -- Lock the tenant's live admin set first, deterministically ordered. See the
  -- header: this ordering is what turns a symmetric deadlock into a clean wait.
  PERFORM 1
  FROM public.memberships m
  WHERE m.tenant_id OPERATOR(pg_catalog.=) v_tenant
    AND m.role      OPERATOR(pg_catalog.=) 'admin'::public.membership_role
    AND m.deleted_at IS NULL
  ORDER BY m.id
  FOR UPDATE;
  GET DIAGNOSTICS v_live_admins = ROW_COUNT;

  -- (b) the target row belongs to the active tenant. Scoped in the WHERE clause,
  -- so a membership id from another tenant resolves to nothing and is refused with
  -- the same code as one that does not exist.
  SELECT m.user_id, m.role
    INTO v_target_user, v_target_role
  FROM public.memberships m
  WHERE m.id        OPERATOR(pg_catalog.=) p_membership_id
    AND m.tenant_id OPERATOR(pg_catalog.=) v_tenant
    AND m.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE = 'MB002';
  END IF;

  IF v_target_user OPERATOR(pg_catalog.=) v_actor
     AND v_target_role OPERATOR(pg_catalog.=) 'admin'::public.membership_role
     AND p_role OPERATOR(pg_catalog.<>) 'admin'::public.membership_role
     AND v_live_admins <= 1
  THEN
    RAISE EXCEPTION 'LAST_ADMIN' USING ERRCODE = 'MB003';
  END IF;

  UPDATE public.memberships
     SET role = p_role,
         updated_at = pg_catalog.now()
   WHERE public.memberships.id OPERATOR(pg_catalog.=) p_membership_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- revoke_member — DELETE /users/:id. A SOFT delete (`deleted_at`), per the §5
-- design rules and ADR-006 §2: memberships are never hard-deleted, and the partial
-- unique index is what lets a revoked person be re-invited later.
--
-- Same lock discipline and the same last-admin guard as change_member_role. For a
-- self-target the role check is redundant — clause (a) already established the
-- caller is a live admin, and one live membership per (user, tenant) means the
-- caller's own row IS that admin membership — but it is written out rather than
-- assumed, because the guard's correctness should be readable without
-- reconstructing the index argument.
--
-- OPEN-5 INTERACTION, and it resolves in this function's favour. The `memberships`
-- row policies deliberately carry no liveness predicate, because a
-- `deleted_at IS NULL` term would make the revoking UPDATE invisible to its own
-- SELECT policy and block it. That reasoning applies to the app-role policies; this
-- UPDATE runs under `memberships_definer`, which is USING (true) WITH CHECK (true)
-- and so admits both the old and the new row version regardless. The revoking write
-- is unblocked here for a stronger reason than OPEN-5's, and the residual OPEN-5
-- accepted is unchanged by this function.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.revoke_member(p_membership_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_actor       uuid;
  v_tenant      uuid;
  v_target_user uuid;
  v_target_role public.membership_role;
  v_live_admins integer;
BEGIN
  v_actor  := NULLIF(current_setting('app.current_user', true), '')::uuid;
  v_tenant := NULLIF(current_setting('app.current_tenant', true), '')::uuid;

  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'MB001';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.user_id   OPERATOR(pg_catalog.=) v_actor
      AND m.tenant_id OPERATOR(pg_catalog.=) v_tenant
      AND m.role      OPERATOR(pg_catalog.=) 'admin'::public.membership_role
      AND m.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'MB001';
  END IF;

  PERFORM 1
  FROM public.memberships m
  WHERE m.tenant_id OPERATOR(pg_catalog.=) v_tenant
    AND m.role      OPERATOR(pg_catalog.=) 'admin'::public.membership_role
    AND m.deleted_at IS NULL
  ORDER BY m.id
  FOR UPDATE;
  GET DIAGNOSTICS v_live_admins = ROW_COUNT;

  SELECT m.user_id, m.role
    INTO v_target_user, v_target_role
  FROM public.memberships m
  WHERE m.id        OPERATOR(pg_catalog.=) p_membership_id
    AND m.tenant_id OPERATOR(pg_catalog.=) v_tenant
    AND m.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE = 'MB002';
  END IF;

  IF v_target_user OPERATOR(pg_catalog.=) v_actor
     AND v_target_role OPERATOR(pg_catalog.=) 'admin'::public.membership_role
     AND v_live_admins <= 1
  THEN
    RAISE EXCEPTION 'LAST_ADMIN' USING ERRCODE = 'MB003';
  END IF;

  UPDATE public.memberships
     SET deleted_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE public.memberships.id OPERATOR(pg_catalog.=) p_membership_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Ownership. Same pattern, and the same hazard, as 20260908000000.
--
-- ALTER FUNCTION ... OWNER TO needs membership in the target role. Locally and in
-- CI the migration role is the bootstrap superuser and this is a no-op; on Render
-- it is not, and the migration role holds ADMIN OPTION by having created the role.
-- The membership is revoked again immediately: RLS matches policy roles by
-- MEMBERSHIP, so a migration role left inside meterlog_definer silently acquires
-- every `TO meterlog_definer USING (true)` policy on every identity table.
-- ---------------------------------------------------------------------------
DO $own$
DECLARE
  self_granted boolean := false;
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'meterlog_definer', 'MEMBER') THEN
    EXECUTE format('GRANT meterlog_definer TO %I', current_user);
    self_granted := true;
  END IF;

  EXECUTE 'ALTER FUNCTION public.invite_member(citext, public.membership_role, text) OWNER TO meterlog_definer';
  EXECUTE 'ALTER FUNCTION public.change_member_role(uuid, public.membership_role) OWNER TO meterlog_definer';
  EXECUTE 'ALTER FUNCTION public.revoke_member(uuid) OWNER TO meterlog_definer';

  IF self_granted THEN
    EXECUTE format('REVOKE meterlog_definer FROM %I', current_user);
  END IF;
END
$own$;

-- ---------------------------------------------------------------------------
-- The surgical grant. UPDATE on `memberships` ONLY.
--
-- change-role writes `role`; revoke writes `deleted_at` (a soft delete is an
-- UPDATE). Neither is possible under the step-4 grants, which were SELECT, INSERT.
--
-- What is NOT granted, and must stay ungranted: UPDATE on `users` or `tenants` (no
-- definer function edits an identity or an organisation — invite only ever INSERTs
-- a users row), and DELETE / TRUNCATE / REFERENCES on anything at all. Catalog
-- assertion 6 asserts that exact shape, as an equality rather than a relaxation, so
-- the next grant that widens this fails CI.
-- ---------------------------------------------------------------------------
GRANT UPDATE ON public.memberships TO meterlog_definer;

-- ---------------------------------------------------------------------------
-- Execute privileges. REVOKE FROM PUBLIC is not defensive noise: Postgres grants
-- EXECUTE on a new function to PUBLIC by default, and these three write
-- memberships as a role that bypasses every app-role policy.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.invite_member(citext, public.membership_role, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.change_member_role(uuid, public.membership_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_member(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.invite_member(citext, public.membership_role, text) TO meterlog_app;
GRANT EXECUTE ON FUNCTION public.change_member_role(uuid, public.membership_role) TO meterlog_app;
GRANT EXECUTE ON FUNCTION public.revoke_member(uuid) TO meterlog_app;
