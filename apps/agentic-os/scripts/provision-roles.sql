-- provision-roles.sql
-- Creates the two database roles for apps/agentic-os. Idempotent. One transaction.
-- Run as the owner (claude) in database continuous_claude, through provision-roles.ps1.
--
-- psql variables the caller must set (no secrets live in this file):
--   app_pw      password for agentic_os_app
--   indexer_pw  password for agentic_os_indexer
-- Optional:
--   finish      COMMIT or ROLLBACK. Default ROLLBACK, so a bare run never writes.
--
-- Re-running resets both passwords. That is why the wrapper refuses -Apply when
-- .env.local already exists.

\if :{?finish}
\else
  \set finish ROLLBACK
\endif

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentic_os_app') THEN
    CREATE ROLE agentic_os_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 10;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentic_os_indexer') THEN
    CREATE ROLE agentic_os_indexer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3;
  END IF;
END $$;

-- Converge attributes when a role already exists (CREATE above is skipped then).
ALTER ROLE agentic_os_app     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 10;
ALTER ROLE agentic_os_indexer NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3;

ALTER ROLE agentic_os_app     PASSWORD :'app_pw';
ALTER ROLE agentic_os_indexer PASSWORD :'indexer_pw';

-- Good neighbour on a shared database (mirrors src/db/index.ts).
ALTER ROLE agentic_os_app     SET statement_timeout = '10s';
ALTER ROLE agentic_os_app     SET lock_timeout = '5s';
ALTER ROLE agentic_os_app     SET default_transaction_read_only = on;
ALTER ROLE agentic_os_indexer SET statement_timeout = '30s';
ALTER ROLE agentic_os_indexer SET lock_timeout = '5s';

GRANT CONNECT ON DATABASE continuous_claude TO agentic_os_app, agentic_os_indexer;
GRANT USAGE ON SCHEMA agentic_os TO agentic_os_app, agentic_os_indexer;
GRANT USAGE ON SCHEMA public     TO agentic_os_app, agentic_os_indexer;

-- App: SELECT only, on exactly the tables it reads.
GRANT SELECT ON ALL TABLES IN SCHEMA agentic_os TO agentic_os_app;
GRANT SELECT ON public.sessions, public.file_claims, public.archival_memory TO agentic_os_app;

-- Indexer: DML on agentic_os; SELECT on sessions (the seeder reads it).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agentic_os TO agentic_os_indexer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agentic_os TO agentic_os_indexer;
GRANT SELECT ON public.sessions TO agentic_os_indexer;
-- Drizzle's migration history is not indexer data.
REVOKE INSERT, UPDATE, DELETE ON agentic_os.__migrations FROM agentic_os_indexer;

-- Tables a future migration adds stay readable by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE claude IN SCHEMA agentic_os GRANT SELECT ON TABLES TO agentic_os_app;
ALTER DEFAULT PRIVILEGES FOR ROLE claude IN SCHEMA agentic_os GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentic_os_indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE claude IN SCHEMA agentic_os GRANT USAGE, SELECT ON SEQUENCES TO agentic_os_indexer;

-- Effective result, printed before the transaction ends. No secrets in this output.
\echo == role_table_grants (agentic_os*, public + agentic_os schemas) ==
SELECT grantee, table_schema, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE grantee IN ('agentic_os_app', 'agentic_os_indexer')
 GROUP BY grantee, table_schema, table_name
 ORDER BY grantee, table_schema, table_name;

\echo == role settings (pg_db_role_setting) ==
SELECT r.rolname, s.setconfig
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole
 WHERE r.rolname IN ('agentic_os_app', 'agentic_os_indexer')
 ORDER BY r.rolname;

\echo == has_table_privilege as agentic_os_app (both must be false) ==
SELECT has_table_privilege('agentic_os_app', 'public.sessions', 'INSERT')   AS insert_public_sessions,
       has_table_privilege('agentic_os_app', 'agentic_os.lane', 'INSERT')   AS insert_agentic_os_lane;

-- Enforce the proof: a wrong result aborts (ON_ERROR_STOP), so nothing commits.
DO $$
BEGIN
  IF has_table_privilege('agentic_os_app', 'public.sessions', 'INSERT')
     OR has_table_privilege('agentic_os_app', 'agentic_os.lane', 'INSERT') THEN
    RAISE EXCEPTION 'agentic_os_app can write: aborting';
  END IF;
  IF NOT (has_table_privilege('agentic_os_app', 'public.sessions', 'SELECT')
      AND has_table_privilege('agentic_os_app', 'public.file_claims', 'SELECT')
      AND has_table_privilege('agentic_os_app', 'public.archival_memory', 'SELECT')
      AND has_table_privilege('agentic_os_app', 'agentic_os.lane', 'SELECT')) THEN
    RAISE EXCEPTION 'agentic_os_app cannot read what it needs: aborting';
  END IF;
END $$;

\echo == transaction ends with :finish ==
:finish;
