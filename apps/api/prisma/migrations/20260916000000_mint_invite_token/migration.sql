-- The admin user-management slice, backend — OPEN-14: the pending split.
--
-- `GET /users/pending` has been a STATE-CHANGING GET since step 8. It calls
-- `list_pending_invites`, which supersedes every live token and mints a
-- replacement on every read. Two things follow, and neither is cosmetic:
--
--   (i)  It breaks the condition the ADR-001 amendment attaches to
--        `SameSite=Lax`. Lax withholds the cookie from a cross-site POST but
--        still sends it on a top-level cross-site GET, so it is CSRF protection
--        only while every GET is safe in the RFC 9110 §9.2.1 sense. The recorded
--        test for a new GET is whether it would still be correct if the side
--        effect were skipped; a GET whose RESPONSE IS the state change fails it
--        outright.
--   (ii) A window-focus refetch is a denial of service against a token the admin
--        has already pasted into an email. The frontend slice makes that refetch
--        routine rather than hypothetical, which is why this is owed BEFORE the
--        admin UI rather than alongside it.
--
-- THE SPLIT. `GET /users/pending` becomes metadata-only — no token, no
-- expiry, no writes — and minting becomes an explicit
-- `POST /users/pending/:membershipId/token`, which is this function.
--
-- WHY A NINTH DEFINER FUNCTION AND NOT A NARROWED `list_pending_invites`.
-- The read half can be served by the existing function only if the app role can
-- evaluate the pending predicate, and it cannot: `users.password_set_at` is
-- withheld from `meterlog_app` by column grant so the login path cannot branch on
-- it (ADR-006 §7 hazard (ii)), and an app-role query naming that column fails
-- `permission denied`. Both halves therefore stay behind definer functions. They
-- are two functions rather than one with a flag because they now differ in kind:
-- one reads a list and writes nothing, the other writes a credential for one
-- named row. A boolean parameter deciding whether a call mints is the same defect
-- as the `?pending=true` filter ADR-016 rejected — one route, two authorization
-- stories.
--
-- BOUND BY ADR-006 §7, AND THE (b) CLAUSE IS A REAL CHECK HERE FOR THE FIRST
-- TIME ON THIS PATH. `list_pending_invites` satisfies (b) structurally: it takes
-- no parameter, so there is no caller-supplied target to validate and no
-- cross-tenant row to reject. This function takes a MEMBERSHIP ID, so (b) becomes
-- an explicit predicate — the named row must be proven to belong to the active
-- tenant before it is touched. That is the step-5 `:id`-is-a-membership-id
-- decision doing its job: the clause is a direct check on the row being written,
-- not a resolution step that has to be trusted to have scoped correctly.
--
-- THE THREE SQLSTATES ARE THIS BODY'S OWN, and that is the step-5 lesson applied
-- rather than repeated. `list_pending_invites` already took `SP003` for "not a
-- live admin" though `MB001` meant the same thing, because they come from
-- different function bodies and two layers answering identically are two layers
-- you cannot tell apart when one of them breaks. A third body gets a third set:
-- MT001 / MT002 / MT003. They map onto the same HTTP envelope as their siblings,
-- so the API contract stays uniform while the source stays legible in a log.
--
-- Design reference: ADR-006 §7, ADR-016, ADR-001 amendment. References are
-- §-form by convention (PROJECT_BRIEF §5 design rule N), never `:line` — a line
-- citation in an applied migration comment cannot be corrected once the checksum
-- is fixed.
--
-- APPEND-ONLY. This is a NEW migration. `20260915000000` is applied and
-- checksum-immutable, so nothing in it is edited; `list_pending_invites` is
-- replaced here, in a new file, by DDL that supersedes it.
--
-- ===== WHY THE READ FUNCTION IS REPLACED RATHER THAN LEFT ALONE =============
--
-- The obvious smaller change is to add `mint_invite_token` and simply stop
-- CALLING `list_pending_invites` from the read path. That would be wrong, and
-- wrong in the way this schema is least able to tolerate.
--
-- `list_pending_invites` is `EXECUTE`-able by `meterlog_app` and mints a fresh
-- token for EVERY pending invite in the active tenant on every call. An
-- uncalled definer function is not dead code — it is a live credential-minting
-- primitive reachable by anything holding the app-role connection, with no
-- route, no guard and no test in front of it. Leaving it in place would mean the
-- pending split removed the endpoint and kept the capability, which is the
-- capability the split exists to remove. The definer surface is the project's
-- highest-value review target; a function nobody calls is the worst thing to
-- find on it.
--
-- So the name survives and the body changes: `list_pending_invites` becomes the
-- metadata read it should always have been, and minting exists in exactly one
-- place. DROP + CREATE rather than CREATE OR REPLACE because the RETURN TYPE
-- changes — `token` and `expires_at` leave the signature, which is the point.
-- Both statements run inside this migration's transaction, so the function is
-- never observably absent.
--
-- THE DEFINER SURFACE THEREFORE GROWS BY ONE, NOT TWO. Eight becomes nine.

-- ---------------------------------------------------------------------------
-- 0. Ownership membership — ACQUIRED UP FRONT, because this migration DROPs a
-- function that `meterlog_definer` already owns, and DROP requires ownership.
--
-- Locally and in CI the migration role is the cluster bootstrap superuser, for
-- which `pg_has_role` is true unconditionally, so this branch is never taken and
-- a missing grant would be invisible. On Render the migration role is NOT a
-- superuser and holds ADMIN OPTION on `meterlog_definer` only by having created
-- it in 20260903000000 — so without this block the DROP below would fail there
-- and nowhere else. That is the class ISOLATION.md §9 names as structurally
-- invisible to both environments the tests run in.
--
-- THE REVOKE AT THE FOOT IS THE LOAD-BEARING HALF: RLS matches a policy's roles
-- by MEMBERSHIP, so a migration role left inside `meterlog_definer` silently
-- acquires every `TO meterlog_definer USING (true)` policy on every identity
-- table — including `invite_tokens_definer`, which would hand it unrestricted
-- read of a credential table.
--
-- The flag travels between the two DO blocks in a session GUC because DO blocks
-- share no variables. `is_local => false` so it survives statement boundaries
-- within this migration's transaction.
-- ---------------------------------------------------------------------------
DO $acquire$
BEGIN
  IF NOT pg_catalog.pg_has_role(current_user, 'meterlog_definer', 'MEMBER') THEN
    EXECUTE format('GRANT meterlog_definer TO %I', current_user);
    PERFORM set_config('meterlog.definer_self_granted', 'true', false);
  ELSE
    PERFORM set_config('meterlog.definer_self_granted', 'false', false);
  END IF;
END
$acquire$;

-- ---------------------------------------------------------------------------
-- 1. list_pending_invites — now a SAFE READ.
--
-- ===== SUPERSESSION NOTE — 20260915000000 §6 is superseded here =============
--
-- That header says "MINT-ON-READ IS FORCED BY HASH-AT-REST, not chosen for
-- convenience: the server holds no plaintext to re-display. Every read issues a
-- fresh token and SUPERSEDES the prior live one." The PREMISE is still true and
-- is not disputed: tokens are SHA-256 at rest and the server genuinely cannot
-- re-display one. The CONCLUSION was wrong. "The server cannot re-display a
-- token" does not force "the read mints one"; it forces only that a token cannot
-- be part of a read AT ALL. This function stops trying to return one, and the
-- capability moves to an explicit write.
--
-- WHAT IS LOST, STATED PLAINLY: an admin can no longer see the pending list and
-- copy a link in one step. That was never a saving — it was the DoS in (ii)
-- above wearing a convenience's clothes, because the act of LOOKING destroyed the
-- link the admin had already sent. The UI now shows the list and offers a mint
-- per row, and re-minting stays one click because `mint_invite_token` supersedes.
--
-- IT REMAINS A DEFINER FUNCTION, and the reason is unchanged and worth restating
-- because "a read that writes nothing" looks like it should need no privilege:
-- the pending predicate is `users.password_set_at`, WITHHELD from `meterlog_app`
-- by column grant so the login path cannot branch on it (ADR-006 §7 hazard (ii)).
-- An app-role query naming that column fails `permission denied`. The column
-- grant is what makes this a definer function, not the writes it no longer does.
--
-- ADR-006 §7 clause (b) stays STRUCTURAL here, as it always was: no parameter, so
-- no caller-supplied target to validate. Clause (a) is checked explicitly.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.list_pending_invites();

CREATE FUNCTION public.list_pending_invites()
RETURNS TABLE (
  membership_id uuid,
  user_id       uuid,
  email         text,
  role          text,
  invited_at    timestamptz
  -- `token` and `expires_at` are GONE from this signature, and their absence is
  -- the entire migration. A live credential is no longer among the things this
  -- function can return, so no future edit to a caller can start returning one.
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_actor  uuid;
  v_tenant uuid;
BEGIN
  -- NULLIF(..., '') — on a POOLED connection a GUC set once reverts to the EMPTY
  -- STRING, not NULL, at transaction end, and ''::uuid raises 22P02 instead of
  -- failing closed (ADR-004 assertion 8).
  v_actor  := NULLIF(current_setting('app.current_user', true), '')::uuid;
  v_tenant := NULLIF(current_setting('app.current_tenant', true), '')::uuid;

  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'SP003';
  END IF;

  -- (a) live admin of the active tenant. The SQLSTATE is unchanged from
  -- 20260915000000: it is the same function, refusing for the same reason, and
  -- the service already maps SP003 onto the shared 403 envelope.
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.user_id   OPERATOR(pg_catalog.=) v_actor
      AND m.tenant_id OPERATOR(pg_catalog.=) v_tenant
      AND m.role      OPERATOR(pg_catalog.=) 'admin'::public.membership_role
      AND m.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'SP003';
  END IF;

  -- A PLAIN QUERY, NO LOOP AND NO WRITES. The `FOR ... LOOP` the previous body
  -- carried existed only to mint per row; with nothing to write per row there is
  -- nothing to iterate.
  RETURN QUERY
    SELECT m.id, u.id, u.email::text, m.role::text, m.created_at
      FROM public.memberships m
      JOIN public.users u ON u.id = m.user_id
     -- (b) structural: v_tenant came from the GUC, never from a parameter.
     WHERE m.tenant_id = v_tenant
       AND m.deleted_at IS NULL
       AND u.deleted_at IS NULL
       -- THE PENDING PREDICATE — the column `meterlog_app` cannot read, and the
       -- sole remaining reason this is a definer function.
       AND u.password_set_at IS NULL
     ORDER BY u.email;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. mint_invite_token — one token, for one named pending membership.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.mint_invite_token(p_membership_id uuid)
RETURNS TABLE (
  membership_id uuid,
  user_id       uuid,
  email         text,
  role          text,
  invited_at    timestamptz,
  token         text,
  expires_at    timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
-- Without a pinned search_path a SECURITY DEFINER function is itself a
-- privilege-escalation vector: the caller chooses which schema's `memberships`
-- the body resolves to. Catalog assertion 4 pins this for every definer
-- function, so omitting it reds there rather than in a bespoke test.
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- v_-prefixed so nothing collides with the OUT parameters RETURNS TABLE
  -- declares, several of which are also column names on the tables read below.
  v_actor      uuid;
  v_tenant     uuid;
  v_row        record;
  v_token      text;
  v_expires_at timestamptz;
BEGIN
  -- NULLIF(..., '') is not decoration: on a POOLED connection a GUC that has been
  -- set once reverts to the EMPTY STRING, not NULL, at transaction end, and
  -- ''::uuid raises 22P02 instead of failing closed. Reproduces only after
  -- connection reuse (ADR-004 assertion 8).
  v_actor  := NULLIF(current_setting('app.current_user', true), '')::uuid;
  v_tenant := NULLIF(current_setting('app.current_tenant', true), '')::uuid;

  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'MT001';
  END IF;

  -- ---- (a) the caller is a LIVE ADMIN of the ACTIVE tenant ------------------
  -- Fails closed on absent context: a NULL cannot match a row and the
  -- IF NOT EXISTS refuses. Checked FIRST, before the target is looked up, so a
  -- non-admin's refusal is identical whether or not the id they named exists —
  -- otherwise the ordering itself would be a membership-id oracle.
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.user_id   OPERATOR(pg_catalog.=) v_actor
      AND m.tenant_id OPERATOR(pg_catalog.=) v_tenant
      AND m.role      OPERATOR(pg_catalog.=) 'admin'::public.membership_role
      AND m.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'MT001';
  END IF;

  -- ---- (b) the TARGET ROW belongs to the active tenant ----------------------
  -- The real clause-(b) check. `v_tenant` comes from the GUC, which the
  -- interceptor only sets after re-verifying the caller's live membership, and
  -- never from a parameter — so the tenant cannot be chosen, only the membership
  -- id can, and this predicate is what refuses a foreign one.
  --
  -- ONE CODE FOR "DOES NOT EXIST" AND "BELONGS TO ANOTHER TENANT", deliberately:
  -- the MB002 reasoning, restated for a new body. Distinguishing them would turn
  -- this endpoint into a probe for membership ids in tenants the caller cannot
  -- see. A revoked membership is also MT002 — it is not a live target, and a
  -- revoked person must not be handed a way back in.
  SELECT m.id AS membership_id, u.id AS user_id,
         u.email::text AS email, m.role::text AS role, m.created_at AS invited_at,
         (u.password_set_at IS NULL) AS is_pending
    INTO v_row
    FROM public.memberships m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.id        = p_membership_id
     AND m.tenant_id = v_tenant
     AND m.deleted_at IS NULL
     AND u.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBERSHIP_NOT_FOUND' USING ERRCODE = 'MT002';
  END IF;

  -- ---- the PENDING predicate -----------------------------------------------
  -- `users.password_set_at` is the column `meterlog_app` cannot read, which is
  -- why this is a definer function at all rather than an ordinary RLS-scoped
  -- statement.
  --
  -- A DISTINCT CODE FROM MT002, AND THAT IS SAFE HERE. Elsewhere in this schema
  -- "not found" absorbs "exists but you may not" to avoid an oracle; here the
  -- caller is a live admin of the tenant the row belongs to, and co-member
  -- visibility (ADR-006 §3) already shows them that member and their pending
  -- state through `GET /users` and `GET /users/pending`. MT003 therefore tells
  -- them nothing they could not already read, and telling them the truth — "that
  -- person already has a password, there is nothing to mint" — is the difference
  -- between a usable admin UI and a mysterious 404.
  --
  -- THE REFUSAL IS THE SECURITY PROPERTY, not a usability nicety: the invite path
  -- is not a password-reset path (ADR-016). Minting for a credentialled account
  -- would hand a tenant admin a live redemption credential for an identity that
  -- is global (ADR-006 §2) and exists in tenants they cannot see. `set_password`
  -- carries its own monotonic guard as the floor beneath this, and both are kept:
  -- neither layer may be relaxed on the strength of the other.
  IF NOT v_row.is_pending THEN
    RAISE EXCEPTION 'NOT_PENDING' USING ERRCODE = 'MT003';
  END IF;

  -- ---- mint ----------------------------------------------------------------
  -- 244 bits of CSPRNG entropy from two v4 UUIDs, hex, hyphens stripped.
  -- gen_random_uuid() is pg_catalog and is cryptographically random in PG13+, so
  -- this needs no extension — pgcrypto's gen_random_bytes would be a new
  -- dependency for no additional strength at this size. Identical construction to
  -- `list_pending_invites`, deliberately: one token format in the system, so
  -- `set_password` has one thing to redeem.
  v_token      := replace(gen_random_uuid()::text, '-', '')
               || replace(gen_random_uuid()::text, '-', '');
  v_expires_at := now() + interval '72 hours';

  -- SUPERSEDE FIRST. Marking prior live tokens consumed — rather than deleting
  -- them — keeps the fact that they were issued, and makes "at most one
  -- redeemable token per pending invite" true BY CONSTRUCTION rather than by the
  -- caller being careful. It is scoped to (user, tenant), so an invite into a
  -- different workspace for the same person is untouched: the invitation is into
  -- a WORKSPACE, not into the system.
  --
  -- THIS IS WHAT MAKES RE-MINTING SAFE TO EXPOSE AS A BUTTON. An admin who has
  -- lost the link presses it again and the old link dies in the same statement,
  -- so a leaked-but-unused link cannot be redeemed after a re-issue.
  UPDATE public.invite_tokens t
     SET consumed_at = now()
   WHERE t.user_id   = v_row.user_id
     AND t.tenant_id = v_tenant
     AND t.consumed_at IS NULL;

  -- ONLY THE HASH IS STORED. The plaintext exists in exactly two places and
  -- neither is this table: this function's return value, and the invitee's link.
  INSERT INTO public.invite_tokens (user_id, tenant_id, token_hash, expires_at)
  VALUES (v_row.user_id, v_tenant, sha256(convert_to(v_token, 'UTF8')), v_expires_at);

  membership_id := v_row.membership_id;
  user_id       := v_row.user_id;
  email         := v_row.email;
  role          := v_row.role;
  invited_at    := v_row.invited_at;
  token         := v_token;
  expires_at    := v_expires_at;
  RETURN NEXT;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Ownership of BOTH functions.
--
-- Both are newly created by this migration — the replaced read function as much
-- as the new one, because DROP + CREATE makes the migration role its owner
-- again — so both must be handed over. Ownership is what makes SECURITY DEFINER
-- reach the tables at all: the grants these bodies rely on are held by
-- `meterlog_definer`, not by the migration role and not by `meterlog_app`.
--
-- The membership needed for this was acquired in §0 and is released in §5.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.list_pending_invites()    OWNER TO meterlog_definer;
ALTER FUNCTION public.mint_invite_token(uuid)   OWNER TO meterlog_definer;

-- ---------------------------------------------------------------------------
-- 4. Execute privileges.
--
-- BOTH NEED RE-GRANTING, and the read function's is the one that would be easy
-- to miss: DROP destroys a function's ACL along with the function, so the
-- 20260915000000 grant does not survive into the replacement. Without the line
-- below, `list_pending_invites` would exist, be correct, and be uncallable by the
-- app role — a 42501 on the pending list, in production only.
--
-- NO NEW TABLE GRANTS. `mint_invite_token` writes `invite_tokens`, and
-- `meterlog_definer` already holds SELECT, INSERT, UPDATE there from
-- 20260915000000 — exactly the three verbs used above. Catalog assertion 6 pins
-- the definer grant set as an EQUALITY, so this migration deliberately leaves it
-- unchanged: a ninth definer function that needed a wider grant would be a
-- reviewable event, and this one does not.
--
-- REVOKE FROM PUBLIC is not defensive noise: Postgres grants EXECUTE on a new
-- function to PUBLIC by default, and a function's ACL is invisible in the places
-- people look when reviewing a definer function (catalog assertion 11).
--
-- Granted to `meterlog_app`, which is the whole point of the two-layer design:
-- the app role CAN call these with no guard in front of them, so the bodies' own
-- checks are the ones that cannot be bypassed, and they are proven by direct call
-- in test/db/mint-invite-token.spec.ts and test/db/set-password.spec.ts.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.list_pending_invites()  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mint_invite_token(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.list_pending_invites()  TO meterlog_app;
GRANT EXECUTE ON FUNCTION public.mint_invite_token(uuid) TO meterlog_app;

-- ---------------------------------------------------------------------------
-- 5. Release the definer membership acquired in §0.
--
-- Not optional, and not tidiness — see the note at §0. A migration role left
-- inside `meterlog_definer` acquires every definer policy on every identity
-- table, which is the FORCE-RLS bypass the three-role model exists to prevent,
-- reintroduced through role membership. Invisible in CI, where a superuser never
-- takes the grant branch at all.
-- ---------------------------------------------------------------------------
DO $release$
BEGIN
  IF current_setting('meterlog.definer_self_granted', true) = 'true' THEN
    EXECUTE format('REVOKE meterlog_definer FROM %I', current_user);
  END IF;
END
$release$;
