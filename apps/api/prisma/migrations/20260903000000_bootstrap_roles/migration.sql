-- Bootstrap of the three-role structure from ADR-004.
--
-- This migration is the single versioned source of truth for role attributes,
-- schema privileges, and per-role timeouts. It is deliberately idempotent: the
-- local docker init script has already created these roles (so the DO blocks are
-- no-ops there), while on Render — where there is no init-script hook — this is
-- where they come into existence.
--
-- It does NOT set a password for meterlog_app. Passwords never enter version
-- control. Locally the init script sets one from an env var; on Render it is a
-- one-time, documented step run against the fresh database:
--
--     ALTER ROLE meterlog_app WITH LOGIN PASSWORD '<from the platform secret store>';
--
-- Note what is absent: no role here holds SUPERUSER or BYPASSRLS. Render grants
-- no superuser, and Postgres only permits granting BYPASSRLS from a role that
-- already holds it — but more importantly, neither is needed. Under FORCE ROW
-- LEVEL SECURITY even the table owner is subject to policies, so the pre-auth
-- path reaches its tables through a permissive policy scoped TO meterlog_definer
-- rather than through any bypass. Those policies arrive with the tables in
-- step 4.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- Owns the pre-auth SECURITY DEFINER functions and nothing else. NOLOGIN, so
  -- it cannot be connected as; it is only ever reached by calling them.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meterlog_definer') THEN
    CREATE ROLE meterlog_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- The runtime connection. RLS applies to it in full, with no exceptions.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meterlog_app') THEN
    CREATE ROLE meterlog_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Assert the attributes even if the roles pre-existed with different ones, so a
-- hand-edited environment converges back to the intended state rather than
-- drifting silently.
ALTER ROLE meterlog_definer NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
ALTER ROLE meterlog_app     NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN;

-- ---------------------------------------------------------------------------
-- Timeouts (ADR-004)
--
-- Server-side backstops for the per-request interactive transaction. Set on the
-- role, in migration SQL, so they apply identically in CI, locally, and on
-- Render, and cannot be lost in platform configuration.
--
-- statement_timeout sits BELOW the Prisma transaction ceiling (5s) so that a
-- runaway query is killed by Postgres with an error naming the statement, rather
-- than surfacing as an opaque transaction abort.
-- ---------------------------------------------------------------------------
ALTER ROLE meterlog_app SET statement_timeout = '4s';
ALTER ROLE meterlog_app SET idle_in_transaction_session_timeout = '10s';

-- The definer role never holds a connection of its own, but a runaway inside a
-- SECURITY DEFINER function executes with its settings, so it gets the same cap.
ALTER ROLE meterlog_definer SET statement_timeout = '4s';

-- ---------------------------------------------------------------------------
-- Schema privileges
--
-- USAGE only. No table privileges are granted here because no tables exist yet;
-- each table's grants ship in the migration that creates it. A forgotten grant
-- fails closed with "permission denied" — loud and safe — which is why explicit
-- per-table grants are preferred over ALTER DEFAULT PRIVILEGES blanket rules.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO meterlog_app;
GRANT USAGE ON SCHEMA public TO meterlog_definer;

-- Neither role may create objects in public; only the migration/owner role does.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM meterlog_app;
REVOKE CREATE ON SCHEMA public FROM meterlog_definer;
