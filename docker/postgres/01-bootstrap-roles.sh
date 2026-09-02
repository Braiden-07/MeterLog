#!/bin/sh
# Local-only role bootstrap. Runs once, when the Postgres data volume is empty.
#
# Scope note (ADR-004): this script creates the two named roles and gives the app
# role a LOGIN password. It deliberately does NOT create grants or policies —
# those are versioned in Prisma migration SQL so that local and Render get
# byte-identical privilege rules. The migration re-creates these roles
# idempotently, so it is a no-op here and does the real work on Render, where
# there is no init-script hook.
#
# The password lives in an env var, never in the repo.
set -eu

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --set app_password="${METERLOG_APP_PASSWORD:?METERLOG_APP_PASSWORD must be set}" <<'SQL'
DO $$
BEGIN
  -- Owns the pre-auth SECURITY DEFINER functions and nothing else.
  -- NOLOGIN: it can never be connected as directly, only reached through them.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meterlog_definer') THEN
    CREATE ROLE meterlog_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;

  -- The runtime connection. RLS applies to it in full.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meterlog_app') THEN
    CREATE ROLE meterlog_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

ALTER ROLE meterlog_app WITH PASSWORD :'app_password';
SQL

echo "meterlog: bootstrapped roles meterlog_definer (NOLOGIN) and meterlog_app (LOGIN)"
