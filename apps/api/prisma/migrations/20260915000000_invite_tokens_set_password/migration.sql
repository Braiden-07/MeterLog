-- Step 8, first slice — OPEN-7: the invited-user set-password / invite-token flow.
--
-- This closes the dead-end recorded at step 5 phase 1: `invite_member` creates an
-- identity with a sentinel argon2 hash that authenticates against nothing, so an
-- invited person could neither log in nor register their own organisation (the
-- email is taken). ADR-006 §7 named the requirement this migration inherits —
-- pending-invite accounts are "not distinguishable from credentialled accounts by
-- any column today", so the flow must add the distinguishing signal it needs.
--
-- It is the first `users` schema change since step 4, and the first time the
-- `users` UPDATE path becomes reachable at all. Both consequences are handled
-- here rather than discovered later; see the supersession notes at the foot.
--
-- Design reference: ADR-016. References are §-form by convention
-- (PROJECT_BRIEF §5 design rule N), never `:line` — a line citation in an applied
-- migration comment cannot be corrected once the checksum is fixed.

-- ---------------------------------------------------------------------------
-- 0. Ownership membership — ACQUIRED UP FRONT, and this is the first migration
-- that genuinely needs it before its DDL rather than after.
--
-- Every prior migration CREATEs functions (the migrator owns them on creation)
-- and only then hands ownership to `meterlog_definer`. This one REPLACES two
-- functions that `meterlog_definer` ALREADY OWNS — `register_tenant` and
-- `audit_capture` — and `CREATE OR REPLACE FUNCTION` requires the executing role
-- to be the owner or a member of the owning role.
--
-- LOCALLY AND IN CI THIS IS A NO-OP, WHICH IS EXACTLY THE HAZARD. The migration
-- role there is the cluster bootstrap superuser, for which `pg_has_role` is true
-- unconditionally, so the branch is never taken and a missing grant would be
-- invisible. On Render the migration role is NOT a superuser and holds ADMIN
-- OPTION on `meterlog_definer` only by virtue of having created it in
-- 20260903000000 — so without this block the two replacements below would fail
-- there and nowhere else. That is the class ISOLATION.md §9 names as structurally
-- invisible to both environments the tests run in.
--
-- THE REVOKE AT THE FOOT IS THE LOAD-BEARING HALF, for the reason 20260914000000
-- states: RLS matches a policy's roles by MEMBERSHIP, so a migration role left
-- inside `meterlog_definer` silently acquires every `TO meterlog_definer
-- USING (true)` policy on every identity table — the FORCE-RLS bypass the
-- three-role model exists to prevent, reintroduced through role membership.
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
-- 1. users.password_set_at — the authoritative pending predicate.
--
-- THE ABSENCE OF A DEFAULT CLAUSE IS LOAD-BEARING. It is not an omission and it
-- is not style. A new `users` row gets NULL, and NULL means "pending"; that is
-- precisely what makes an `invite_member`-created identity pending BY DEFAULT,
-- with no change to `invite_member` at all. Giving this column
-- `DEFAULT now()` — the obvious "tidy" — would make every invited user look
-- credentialled the moment they are created, `list_pending_invites` would return
-- nothing, no token would ever be minted, and OPEN-7's dead-end would be back
-- with every test still green. That is a silent re-entry, so it is floored by a
-- catalog assertion on `information_schema.columns.column_default IS NULL`
-- rather than by this comment.
--
-- WHO READS IT: `set_password` (the monotonic guard) and `list_pending_invites`
-- (the pending predicate). WHO MUST NEVER READ IT: the login path. ADR-006 §7's
-- hazard (ii) is that an `if (invitePending) return early` in login is a third
-- branch costing nothing next to the two argon2-equalised ones, and is remotely
-- observable as a user-enumeration oracle. That is floored by the column grant —
-- `password_set_at` is withheld from `meterlog_app` exactly as `password_hash`
-- is — and pinned as an equality by the new column-grant assertion.
-- ---------------------------------------------------------------------------
ALTER TABLE public.users ADD COLUMN password_set_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Backfill — BLANKET now(), and blanket is forced rather than chosen.
--
-- THERE IS NO PROVENANCE PREDICATE TO KEY ON. Verified against a live database
-- before this migration was written: `register_tenant` and `invite_member` both
-- write an argon2id hash at the identical `ARGON2_OPTIONS` cost (the sentinel is
-- derived from those same parameters by construction, ADR-006 §7), both leave
-- `created_at = updated_at`, both leave `deleted_at` NULL. No column separates a
-- credentialled row from a placeholder one — which is the exact statement of the
-- requirement ADR-006 §7 left for this step. A conditional backfill would need a
-- discriminator that does not exist.
--
-- AND IT MUST NOT BE DERIVED FROM `audit_log`. That is the available-looking
-- wrong answer: `invite_member` shipped in 20260909000000 and `audit_log` in
-- 20260914000000, so no invite performed between those two migrations has an
-- audit row at all, and an empty audit query reads as "no placeholders found"
-- when it means "cannot see". Worse, and verified live: `audit_capture` logs BOTH
-- provenances as `user.created`, so even for rows it CAN see it does not
-- distinguish them. Population comes from the rows; intent comes from this
-- migration; neither comes from the trail.
--
-- DIRECTION IS now() BECAUSE THE TWO ERRORS ARE ASYMMETRIC, not because it is
-- tidier:
--   * blanket NULL presumes every pre-existing account is pending, which makes
--     every one of them mintable for a set-password token by any admin who can
--     invite their address — an unrecoverable account takeover;
--   * blanket now() presumes every pre-existing account is credentialled. Worst
--     case a genuinely-pending user cannot self-serve and needs an admin to
--     recover them out of band — an availability failure, and a recoverable one.
-- Fail closed toward the recoverable error.
--
-- THIS IS THE STANDING RULE FOR THE FIRST REAL DEPLOY, NOT A NO-OP. It touches
-- zero rows today — every database that exists is CI-fresh or local fixtures, and
-- step 10 (deploy) has not run — but it is written as the rule that governs
-- whatever rows exist when it first meets a populated database.
-- ---------------------------------------------------------------------------
UPDATE public.users SET password_set_at = now() WHERE password_set_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. register_tenant — now sets password_set_at EXPLICITLY.
--
-- The backfill above fixes history; this fixes the future, and the two are not
-- interchangeable. Without this line every founder registered after this
-- migration is born with `password_set_at` NULL — pending — and therefore
-- eligible to have a real, working password overwritten through the invite path.
--
-- NEVER RELY ON THE COLUMN DEFAULT HERE. The default is NULL and the default is
-- FOR INVITE (§1 above). Registration is the branch that must say the opposite,
-- so it says it in so many words. The two write paths into `users` now disagree
-- deliberately, and that disagreement IS the pending predicate.
--
-- Replaced wholesale rather than patched: the body is reproduced from
-- 20260908000000 apart from the one INSERT, including its atomicity note, which
-- is still load-bearing and still fragile to the same edit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_tenant(
  p_tenant_name   text,
  p_email         citext,
  p_password_hash text
)
RETURNS TABLE (tenant_id uuid, user_id uuid, membership_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- Prefixed so nothing here can collide with the OUT parameters that RETURNS
  -- TABLE declares (tenant_id, user_id, membership_id), which are also column
  -- names on public.memberships.
  v_tenant_id     uuid;
  v_user_id       uuid;
  v_membership_id uuid;
BEGIN
  -- ATOMICITY IS STRUCTURAL AND FRAGILE TO ONE EDIT: no EXCEPTION handler
  -- anywhere, so plpgsql opens no subtransaction and a failure on any INSERT
  -- unwinds all of them. A handler around a SUBSET would leave a tenant
  -- committed with no admin — unregisterable and unloggable-into. Do not add one.
  INSERT INTO public.tenants (name)
  VALUES (p_tenant_name)
  RETURNING public.tenants.id INTO v_tenant_id;

  -- password_set_at = now(): this person chose this password, just now. THE ONE
  -- CHANGE FROM 20260908000000.
  INSERT INTO public.users (email, password_hash, password_set_at)
  VALUES (p_email, p_password_hash, now())
  RETURNING public.users.id INTO v_user_id;

  -- The first admin. Role is per-tenant under ADR-006, so it lives here and not
  -- on the users row.
  INSERT INTO public.memberships (user_id, tenant_id, role)
  VALUES (v_user_id, v_tenant_id, 'admin')
  RETURNING public.memberships.id INTO v_membership_id;

  RETURN QUERY SELECT v_tenant_id, v_user_id, v_membership_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. invite_tokens — the redemption credential.
--
-- HASHED AT REST WITH SHA-256, NOT ARGON2, and that is a decision rather than a
-- shortcut. A KDF buys resistance to OFFLINE BRUTE FORCE over a low-entropy
-- secret. This secret is 244 bits from a CSPRNG, so there is no brute-force
-- surface to buy resistance against; all a KDF would add is argon2-scale latency
-- on every mint and every redemption. SHA-256 is here for the property that IS
-- needed: the server stores a value from which the token cannot be recovered, so
-- a database read — backup, replica, dump — does not yield usable credentials.
--
-- THE CONSEQUENCE IS DELIBERATE AND SHAPES THE READ ENDPOINT: the server cannot
-- re-display a token it has stored. `list_pending_invites` therefore MINTS on
-- read rather than retrieving, and supersedes the prior unconsumed token.
--
-- `tenant_id` IS CARRIED even though `user_id` would resolve the person, because
-- the invitation is into a WORKSPACE, not into the system — the same reason
-- `memberships` exists (ADR-006 §2). It is also what lets the RLS policy and
-- `list_pending_invites` scope to the acting tenant without a join, satisfying
-- PROJECT_BRIEF §5 design rule 1 with the canonical single-column expression and
-- no subquery inside a policy (the shape ADR-007 rejected).
-- ---------------------------------------------------------------------------
CREATE TABLE public.invite_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id)   ON DELETE RESTRICT,
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,

  -- ONLY THE HASH. The plaintext exists in exactly two places and neither is
  -- this table: the mint transaction's return value, and the invitee's link.
  token_hash  bytea NOT NULL,

  -- 72h TTL, computed at mint. Stored rather than derived from created_at so the
  -- lifetime is a property of the issued token, and changing the policy later
  -- cannot retroactively extend or expire tokens already in flight.
  expires_at  timestamptz NOT NULL,

  -- Single-use. NULL = live. The consume is an UPDATE of this column guarded on
  -- `consumed_at IS NULL`, which is what makes replay a zero-row result rather
  -- than a race (see set_password).
  consumed_at timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Redemption looks the token up BY HASH, so the uniqueness that matters is on
-- the hash. UNIQUE also means a mint collision would raise 23505 rather than
-- silently creating two rows, one of which could never be reached.
CREATE UNIQUE INDEX invite_tokens_token_hash_key ON public.invite_tokens (token_hash);

-- Supersession scans a user's live tokens on every mint. Partial, because a
-- consumed token is never a supersession target.
CREATE INDEX invite_tokens_user_live_idx
  ON public.invite_tokens (user_id, tenant_id) WHERE consumed_at IS NULL;

ALTER TABLE public.invite_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite_tokens FORCE  ROW LEVEL SECURITY;

-- THE ONLY POLICY, AND THERE IS DELIBERATELY NO APP-ROLE POLICY AND NO APP-ROLE
-- GRANT. Every read and every write goes through the two definer functions
-- below. `meterlog_app` is refused twice over — no privilege, and no applicable
-- policy — which is the DECISION B shape applied to a table that holds
-- credentials. A stolen app-role connection cannot enumerate live tokens, cannot
-- read a hash, and cannot mint one.
--
-- This is why `invite_tokens` is registered in DEFINER_ACCESSIBLE_TABLES and
-- carved out of catalog assertion 10 (which asserts definer-reachable tables are
-- app-READABLE). The carve-out is paired with a new assertion that the app role
-- holds ZERO privileges here, so "not readable" is pinned as the property rather
-- than tolerated as an exception.
CREATE POLICY invite_tokens_definer ON public.invite_tokens
  FOR ALL TO meterlog_definer USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Error contract — custom SQLSTATEs, for the reason 20260909000000 gives at
-- length: `42501 insufficient_privilege` is what Postgres itself raises for a
-- plain table-privilege denial, so a negative keyed on it would pass just as
-- happily against a misconfigured GRANT that never reached the function body.
-- A code nothing else in the cluster can raise makes each negative unambiguously
-- attributable to the check it is meant to be testing.
--
--   SP001  INVALID_TOKEN        — unknown, forged, expired, or already consumed.
--                                 DELIBERATELY ONE CODE for all four. The token
--                                 is a bearer secret; telling a caller a token is
--                                 "expired" rather than "unknown" confirms it was
--                                 once real, which is an oracle over the token
--                                 space. Same reasoning that made MB002 one code
--                                 for "absent" and "not yours". The internal
--                                 paths stay distinguishable in TESTS by the
--                                 database state each leaves behind, not by the
--                                 code the caller sees.
--   SP002  PASSWORD_ALREADY_SET — a VALID token resolved to an account that
--                                 already has a usable password. A distinct code
--                                 is safe here precisely because reaching it
--                                 requires already holding a valid token, so it
--                                 discloses nothing the caller did not have.
--   SP003  NOT_ADMIN            — no context, or the caller is not a live admin
--                                 of the active tenant (ADR-006 §7 rule (a)).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. set_password — redemption. The SEVENTH SECURITY DEFINER function.
--
-- IT MUST BE A DEFINER FUNCTION, and not by preference: `meterlog_app` holds no
-- UPDATE on `users` at all (catalog assertion 9, DECISION B), so there is no
-- app-role path that could write a password hash. The alternative — granting the
-- app role UPDATE on `users` — would hand every authenticated request the ability
-- to rewrite any identity it can see.
--
-- IT IS EXEMPT FROM ADR-006 §7 RULE (a), and the exemption is the one
-- `register_tenant` already holds: this runs PRE-AUTHENTICATION. There is no
-- session, no `app.current_user` and no `app.current_tenant` — the caller is
-- authenticated by the token and by nothing else. Rule (a) asks whether the
-- caller is an admin of the active tenant; there is no active tenant and no
-- acting caller, so the question is undefined here exactly as it is at
-- registration. What replaces it is the token: 244 bits, single-use,
-- time-limited, hashed at rest.
--
-- THE PENDING CHECK IS NOT A LOGIN BRANCH. ADR-006 §7 hazard (ii) scopes "must
-- not branch on the pending column" to the LOGIN path, where a free early return
-- beside two argon2-equalised branches is a timing oracle. This endpoint is
-- token-authenticated and reached only by someone already holding a valid secret;
-- checking the precondition here is the monotonic guard doing its job.
--
-- BOTH-OR-NEITHER IS STRUCTURAL, NOT TRANSACTIONAL ETIQUETTE. There is no
-- EXCEPTION handler anywhere in this body, so plpgsql opens no subtransaction and
-- a RAISE at any point unwinds every statement before it. The two end-states this
-- prevents are both real and both bad:
--   * token consumed but password unset — a NEW dead-end, the exact defect
--     OPEN-7 exists to remove, re-created by the fix for it;
--   * password set but token still live — a replayable credential against an
--     account that now has a real password.
-- Adding a handler around a subset of these statements creates the first one. Do
-- not add one.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.set_password(
  p_token         text,
  p_password_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hash       bytea;
  v_user_id    uuid;
  v_expires_at timestamptz;
BEGIN
  -- The caller sends plaintext; only the hash is ever compared, because only the
  -- hash is ever stored. sha256/convert_to live in pg_catalog, so they resolve
  -- under the pinned search_path with no `public` on it — the ADR-004
  -- resolution rule applied to functions rather than operators.
  v_hash := sha256(convert_to(p_token, 'UTF8'));

  -- ---- consume, atomically ------------------------------------------------
  -- ONE STATEMENT does resolution and consumption together, and that is what
  -- makes replay safe under concurrency. A SELECT-then-UPDATE would let two
  -- concurrent redemptions both observe `consumed_at IS NULL` and both proceed;
  -- the guarded UPDATE lets exactly one win and returns zero rows to the other.
  -- Same reasoning as register_tenant declining a SELECT-then-INSERT duplicate
  -- check in favour of the unique index.
  --
  -- ZERO ROWS IS A REJECTION, NEVER A SUCCESS. It covers two of the three
  -- failure paths — unknown/forged token (no row with that hash) and replay (the
  -- row exists but consumed_at is already set) — and they are one code to the
  -- caller on purpose.
  UPDATE public.invite_tokens t
     SET consumed_at = now()
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NULL
  RETURNING t.user_id, t.expires_at
       INTO v_user_id, v_expires_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_TOKEN' USING ERRCODE = 'SP001';
  END IF;

  -- ---- expiry -------------------------------------------------------------
  -- Checked AFTER the consume rather than folded into its WHERE clause.
  --
  -- THIS IS A LEGIBILITY CHOICE, NOT A BEHAVIOURAL ONE, and the distinction is
  -- recorded because the first draft of this comment claimed otherwise and a
  -- mutation test disproved it. Folding `AND t.expires_at > now()` into the
  -- consume predicate produces an OBSERVABLY IDENTICAL function: the RAISE
  -- unwinds the consume either way, so an expired token is left unburned by both
  -- designs, with the same SQLSTATE and the same database state. The mutant
  -- passed the expiry test unchanged. Do not re-derive a security property here.
  --
  -- What the separate check buys is that the TTL is a NAMED rule a reviewer can
  -- see and grep, rather than a third conjunct sitting beside the replay guard
  -- where it reads as part of the same condition. This repo's thesis is that
  -- implicit-by-omission is where its bugs live; an explicit line costs nothing
  -- and keeps the three rejection reasons separately visible.
  --
  -- The one thing that genuinely separates expiry from forgery is the TABLE, not
  -- the function: a forged token matches no row at all, an expired one matches a
  -- row whose expires_at is in the past. That is what the tests assert.
  IF v_expires_at <= now() THEN
    RAISE EXCEPTION 'INVALID_TOKEN' USING ERRCODE = 'SP001';
  END IF;

  -- ---- the guarded monotonic set ------------------------------------------
  -- `AND password_set_at IS NULL` is the whole security property of this
  -- statement. The transition it permits is placeholder -> real, once, and no
  -- other: it can never overwrite a usable password, so possession of a valid
  -- token for an already-credentialled account is not a password reset.
  --
  -- ZERO ROWS IS A REJECTION HERE TOO. It is reachable only in a narrow race —
  -- mint, redeem by another route, then redeem this token — because minting
  -- supersedes prior live tokens. Narrow is not never, and the guard is what
  -- makes the narrow case safe rather than lucky.
  UPDATE public.users u
     SET password_hash   = p_password_hash,
         password_set_at = now()
   WHERE u.id = v_user_id
     AND u.password_set_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PASSWORD_ALREADY_SET' USING ERRCODE = 'SP002';
  END IF;

  RETURN v_user_id;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. list_pending_invites — the tenant-scoped pending read, minting on read.
--
-- THE EIGHTH DEFINER FUNCTION, and it has to be one for a reason worth stating
-- because it looks like a plain read: the pending predicate lives in
-- `users.password_set_at`, which is WITHHELD from `meterlog_app` by column grant.
-- An app-role query naming that column fails `permission denied` — which is the
-- login floor working as designed, and it means this endpoint cannot be an
-- ordinary RLS-scoped SELECT. It also writes `invite_tokens`, which the app role
-- cannot touch at all.
--
-- BOUND BY ADR-006 §7 — unlike set_password, this one acts on behalf of an
-- AUTHENTICATED CALLER, so both clauses apply and both are enforced here because
-- nothing below them will:
--   (a) the caller is a live admin of the active tenant — checked explicitly;
--   (b) the target rows belong to that tenant — STRUCTURAL, not a check: the
--       tenant comes from `app.current_tenant`, which the interceptor only sets
--       after re-verifying the caller's live membership, and never from a
--       parameter. There is no caller-supplied tenant to validate, so there is no
--       cross-tenant target to reject. An admin of A who somehow asserted B fails
--       (a) instead, because they are not a live admin of B.
--
-- MINT-ON-READ IS FORCED BY HASH-AT-REST, not chosen for convenience: the server
-- holds no plaintext to re-display. Every read issues a fresh token and
-- SUPERSEDES the prior live one for that (user, tenant), so at most one token per
-- pending invite is ever redeemable. Re-invite is this same path with no special
-- case — a still-pending user whose token expired is simply read again.
--
-- ANTI-ENUMERATION IS DONE BY ISOLATION, NOT BY OBSCURITY. The caller sees only
-- their own tenant's pending invites, so there is no cross-tenant address space
-- to walk and nothing to sign — the same principle as the audit cursor being
-- unsigned because RLS already scopes what it can address.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.list_pending_invites()
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
    RAISE EXCEPTION 'NOT_ADMIN' USING ERRCODE = 'SP003';
  END IF;

  -- (a) live admin of the active tenant. Fails closed on absent context: NULL
  -- context cannot match a row and the IF NOT EXISTS refuses.
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

  FOR v_row IN
    SELECT m.id AS membership_id, u.id AS user_id,
           u.email::text AS email, m.role::text AS role, m.created_at AS invited_at
      FROM public.memberships m
      JOIN public.users u ON u.id = m.user_id
     -- (b) structural: v_tenant came from the GUC, never from a parameter.
     WHERE m.tenant_id = v_tenant
       AND m.deleted_at IS NULL
       AND u.deleted_at IS NULL
       -- THE PENDING PREDICATE. This is the column `meterlog_app` cannot read,
       -- which is why this is a definer function.
       AND u.password_set_at IS NULL
     ORDER BY u.email
  LOOP
    -- 244 bits of CSPRNG entropy from two v4 UUIDs, hex, hyphens stripped.
    -- gen_random_uuid() is pg_catalog and is cryptographically random in PG13+,
    -- so this needs no extension — pgcrypto's gen_random_bytes would be a new
    -- dependency for no additional strength at this size.
    v_token      := replace(gen_random_uuid()::text, '-', '')
                 || replace(gen_random_uuid()::text, '-', '');
    v_expires_at := now() + interval '72 hours';

    -- SUPERSEDE FIRST. Marking prior live tokens consumed — rather than deleting
    -- them — keeps the fact that they were issued, and makes "at most one
    -- redeemable token per pending invite" true by construction rather than by
    -- the caller being careful.
    UPDATE public.invite_tokens t
       SET consumed_at = now()
     WHERE t.user_id   = v_row.user_id
       AND t.tenant_id = v_tenant
       AND t.consumed_at IS NULL;

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
  END LOOP;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. audit: the `users` UPDATE path becomes reachable for the first time.
--
-- `users` has been attached to `audit_capture` AFTER INSERT OR UPDATE since step
-- 7a, but the UPDATE half has been DEAD CODE: no role held UPDATE on `users`, so
-- only the INSERT branch ever fired. `set_password` makes it reachable, and the
-- existing branch hardcodes `v_action := 'user.created'` for every operation on
-- the table. Left alone, the first password set in this system's history would
-- write an audit row asserting that a user was CREATED, with an empty diff — an
-- audit trail discrediting itself on its first real event. Verified live before
-- this migration was written; it is not a hypothetical.
--
-- WHY `user.password_set` IS THE CORRECT AND COMPLETE LABEL FOR ANY `users`
-- UPDATE, rather than a guess about intent: the definer's UPDATE grant on `users`
-- is column-limited to exactly (password_hash, password_set_at), and no other role
-- holds UPDATE at all. So the only `users` UPDATE reachable from the application
-- is this one. That is a grant-derived guarantee, not an assumption — and it is
-- pinned by the new column-grant equality assertion, which therefore protects the
-- audit LABEL as well as the login floor. Widen that grant and the label becomes
-- a lie; the assertion is what turns that red.
--
-- THE PAYLOAD DIFF IS EMPTY, AND THAT IS CORRECT. Neither written column is on
-- the `users` allowlist — `password_hash` must never be (ADR-011: the trail would
-- become a privilege-escalation path) and `password_set_at` is excluded by
-- ADR-011's fail-closed default for a new column, which is the right default for
-- anything adjacent to a credential. `payload` is jsonb NOT NULL, so the diff
-- serialises as '{}'::jsonb, never NULL. Nothing is lost: WHO is `row_id`, WHAT
-- is the action, WHEN is `created_at`. The diff would carry no fact those three
-- do not already carry.
--
-- AND THE ROW IS INVISIBLE THROUGH GET /audit, BY DESIGN. set_password is
-- pre-session, so there is no actor and no tenant — the trigger writes NULL for
-- both, and ADR-013 pins exactly that combination as the bootstrap class: matches
-- no tenant policy, readable only by direct database access. So we audit
-- password_set and no admin will ever see it in the trail. That is consistent
-- with ADR-013 rather than broken capture, and it is stated here so a reader who
-- expects to find the event in the UI meets the reason rather than a gap.
--
-- ADD VALUE runs inside this migration's transaction, which PG12+ permits. The
-- new label cannot be USED until the transaction commits, which is satisfied
-- because the only use is inside a function body evaluated at call time.
-- ---------------------------------------------------------------------------
ALTER TYPE public.audit_action ADD VALUE 'user.password_set';

-- Replaced wholesale — plpgsql offers no way to patch one branch. The body is
-- reproduced from 20260914000000 apart from the `users` branch, comments
-- included, because every one of them is still load-bearing.
CREATE OR REPLACE FUNCTION public.audit_capture() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
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
  -- rather than leaking from the day it lands. `password_set_at` is exactly such
  -- a column and is deliberately NOT admitted.
  v_allowed := pg_catalog.string_to_array(TG_ARGV[0], ',');

  v_new_full := pg_catalog.to_jsonb(NEW);
  IF TG_OP = 'UPDATE' THEN
    v_old_full := pg_catalog.to_jsonb(OLD);
  ELSE
    v_old_full := NULL;
  END IF;

  -- ---- actor -------------------------------------------------------------
  -- NULLIF(..., '') is not decoration: on a POOLED connection a GUC set once
  -- reverts at transaction end to the EMPTY STRING, not NULL, and ''::uuid
  -- raises 22P02. Without it this trigger would abort ordinary mutations,
  -- non-deterministically, only after a connection had been reused.
  v_actor := NULLIF(current_setting('app.current_user', true), '')::uuid;

  -- ---- tenant ------------------------------------------------------------
  -- From the mutated row where the row has one; from the request context where
  -- it does not (`users` — ADR-006 §2 left it with no tenant_id). NULL for the
  -- pre-auth bootstrap, which is the only path that reaches neither — and, as of
  -- this migration, for set_password, which is pre-session for the same reason.
  v_tenant := COALESCE(
    (v_new_full ->> 'tenant_id')::uuid,
    NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );

  -- ---- role at the time of the action (OPEN-4) ----------------------------
  -- BY LOOKUP, NOT BY GUC. The trigger runs inside the mutating transaction, so
  -- this row IS the membership as it stood when the action happened.
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
  -- Detected on the ->> TEXT projections rather than on the columns: it needs no
  -- enum operator, and it is uniform across tables that do not all carry the same
  -- columns — `asset_events` and `readings` have no deleted_at at all, and a
  -- missing key projects to NULL rather than raising.
  v_soft_del := TG_OP = 'UPDATE'
            AND (v_old_full ->> 'deleted_at') IS NULL
            AND (v_new_full ->> 'deleted_at') IS NOT NULL;

  IF TG_TABLE_NAME = 'users' THEN
    -- STEP 8. Previously `v_action := 'user.created'` unconditionally, which was
    -- correct only while UPDATE was unreachable. See the header note above for
    -- why UPDATE maps to password_set exhaustively rather than by inference.
    IF TG_OP = 'INSERT' THEN
      v_action := 'user.created';
    ELSE
      v_action := 'user.password_set';
    END IF;

  ELSIF TG_TABLE_NAME = 'memberships' THEN
    IF TG_OP = 'INSERT' THEN
      v_action := 'membership.created';
    ELSIF v_soft_del THEN
      v_action := 'membership.revoked';
    ELSIF (v_new_full ->> 'role') IS DISTINCT FROM (v_old_full ->> 'role') THEN
      v_action := 'membership.role_changed';
    ELSE
      -- Unreachable today; see the enum note in 20260914000000.
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
    -- insert anyway — this says WHY, and says it at the attachment rather than at
    -- the column.
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
    -- For a password set that leaves BOTH sides '{}' — see the header note.
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
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Ownership of the two NEW functions.
--
-- `register_tenant` and `audit_capture` were replaced in place and keep the owner
-- they already had. These two were just created by the migration role and must be
-- handed over, because that is what makes SECURITY DEFINER reach the tables
-- through the `TO meterlog_definer` policies.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.set_password(text, text)     OWNER TO meterlog_definer;
ALTER FUNCTION public.list_pending_invites()       OWNER TO meterlog_definer;

-- ---------------------------------------------------------------------------
-- 9. Grants.
--
-- ===== SUPERSESSION NOTE 1 — the "No UPDATE anywhere" comments are now false ==
--
-- 20260907000000 says, at its definer grant block: "No UPDATE/DELETE/TRUNCATE/
-- REFERENCES anywhere (asserted in CI)." 20260909000000 says, at its surgical
-- grant: "What is NOT granted, and must stay ungranted: UPDATE on `users` or
-- `tenants`." BOTH ARE SUPERSEDED HERE, and both files are checksum-immutable, so
-- the correction lives in this block rather than in them (PROJECT_BRIEF §5
-- convention for applied migrations).
--
-- They are false on TWO counts, and the second is the one that matters:
--   1. UPDATE on `users` now exists — column-limited, below.
--   2. THE PARENTHETICAL WAS NOT TRUE EVEN WHEN IT WAS WRITTEN. Catalog
--      assertion 6 is built on `has_table_privilege`, which is blind to
--      column-level grants — verified live: with
--      `GRANT UPDATE (password_hash, password_set_at) ON public.users TO
--      meterlog_definer` in place, assertion 6 still returns exactly
--      ['memberships:UPDATE'] and passes. So a column-limited grant on `users`
--      was never "asserted in CI"; it was merely absent. The same blindness
--      applies to assertion 9 on the app-role side, which means the
--      `password_hash` withholding — the oldest column-grant claim in this
--      schema — has been unasserted since step 4.
--
-- THIS MIGRATION IS THE FIRST TIME THAT CLAIM BECOMES TRUE. The new column-grant
-- equality assertion reads `information_schema.column_privileges` and pins the
-- `users` column-grant set for BOTH roles as an equality, so the sentence those
-- two files assert is now actually enforced — retroactively for `password_hash`
-- as well as for `password_set_at`.
-- ---------------------------------------------------------------------------

-- The definer's UPDATE on `users`. COLUMN-LIMITED, and the limit is the point:
-- `email` and `deleted_at` stay unwritable by every role in the system, so
-- set_password cannot be turned into an identity-takeover or an account-deletion
-- primitive by a future edit to its body. Compare the step-5 grant, which is
-- table-level on `memberships` because change-role and revoke write two different
-- columns; here exactly two columns are ever written, so the grant says so.
GRANT UPDATE (password_hash, password_set_at) ON public.users TO meterlog_definer;

-- invite_tokens. SELECT+INSERT to mint, UPDATE to consume and to supersede.
-- No DELETE: a consumed token is kept, not destroyed — same append-in-spirit
-- reasoning as soft delete elsewhere, and it means "was a token ever issued for
-- this invite" stays answerable.
--
-- This one IS table-level and therefore DOES widen catalog assertion 6, which is
-- the correct and visible signal: assertion 6 moves from ['memberships:UPDATE']
-- to ['invite_tokens:UPDATE', 'memberships:UPDATE'], as an equality, never
-- relaxed to a subset.
GRANT SELECT, INSERT, UPDATE ON public.invite_tokens TO meterlog_definer;

-- NO GRANT TO meterlog_app ON public.invite_tokens. Deliberate and asserted —
-- see the policy note in §4. The app role reaches this table only by calling the
-- two functions below.

-- ---------------------------------------------------------------------------
-- 10. Execute privileges.
--
-- REVOKE FROM PUBLIC is not defensive noise: Postgres grants EXECUTE on a new
-- function to PUBLIC by default, and a function's ACL is invisible in the places
-- people look when reviewing a definer function (catalog assertion 11).
--
-- `set_password` is granted to `meterlog_app` and is callable WITHOUT a session,
-- which is correct: it is how a person who cannot yet log in obtains a password.
-- Its authorisation is the token, checked in the body.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.set_password(text, text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_pending_invites()     FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.set_password(text, text) TO meterlog_app;
GRANT EXECUTE ON FUNCTION public.list_pending_invites()   TO meterlog_app;

-- ---------------------------------------------------------------------------
-- 11. Release the definer membership acquired in §0.
--
-- ===== SUPERSESSION NOTE 2 — why this block is not optional =================
-- RLS matches a policy's roles by MEMBERSHIP. A migration role left inside
-- `meterlog_definer` silently acquires every `TO meterlog_definer USING (true)`
-- policy on every identity table — including the new `invite_tokens_definer`
-- policy, which would hand it unrestricted read of a credential table. It is
-- invisible in CI, because a superuser never takes the grant branch at all.
-- ---------------------------------------------------------------------------
DO $release$
BEGIN
  IF current_setting('meterlog.definer_self_granted', true) = 'true' THEN
    EXECUTE format('REVOKE meterlog_definer FROM %I', current_user);
  END IF;
END
$release$;
