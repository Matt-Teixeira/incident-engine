-- db/setup-owner-role.sql
-- One-time setup of the least-privilege role incident-engine connects as.
-- Run AFTER db/schema.sql, as a superuser, against the database that holds
-- util.app_run_logs (see markdown/DEPLOYMENT.md):
--   docker exec -i pg_db psql -U postgres -d staging -v pw='choose-a-strong-password' \
--     -f - < db/setup-owner-role.sql
--
-- Grant surface (the Least-Privilege Rule, ARCHITECTURE_PRINCIPLES.md):
--   - OWNS schema incidents (full DML/DDL there — it is this app's schema)
--   - CONNECT on the database
--   - SELECT on exactly util.app_run_logs (the source stream)
--   - INSERT through the util.incident_engine_self_log VIEW ONLY (owner:
--     postgres; pins app_name = 'incident-engine' WITH CHECK OPTION) — the
--     role has NO insert on the base table, so the self-log identity is
--     enforced by the database, not by app code
--   - SELECT on exactly stats.acquisition_history (enrichment + recovery oracle)
--   - NOTHING else: no other table/sequence in util/stats, no privilege at all
--     in alert, and a database-wide allowlist audit at the end proves it
--
-- External grants are applied FAIL-CLOSED (pattern copied from
-- /opt/apps/ops-dashboard/db/setup-readonly-role.sql, extended per the Phase 1
-- Codex review): REVOKE everything this role may have accumulated, GRANT only
-- the intended privileges, then DO blocks RAISE if any other EFFECTIVE
-- privilege remains (including via PUBLIC or inherited membership, including
-- column-only grants and sequences). Re-running this script *proves* the
-- surface instead of just adding to it. Idempotent; re-run as a superuser
-- after any DB reset or before deploying code that needs new grants.
--
-- Known, accepted residuals this script does NOT address (documented, audited
-- where possible):
--   - CONNECT/TEMP on other databases via PUBLIC: PostgreSQL has no per-role
--     deny that overrides PUBLIC; restricting this requires a cluster-wide
--     REVOKE ... FROM PUBLIC or a pg_hba.conf rule. The role holds no object
--     privileges in those databases.
--   - EXECUTE on PUBLIC-granted functions: PostgreSQL default; out of scope.
--   - public.pg_stat_statements / _info PUBLIC SELECT: extension default,
--     read-only, query text masked for unprivileged roles — explicitly
--     allowlisted in the final audit so any OTHER public-schema grant still trips.

\set ON_ERROR_STOP on

-- Require the password variable (must be set with -v pw=...).
\if :{?pw}
\else
  \echo 'ERROR: set pw first, e.g.  psql -v pw=secret -f db/setup-owner-role.sql'
  \quit
\endif

-- Create the role only if it does not already exist. psql expands :'pw' here
-- because it sits in a normal SQL string (NOT a dollar-quoted body, where
-- interpolation would not happen); \gexec then runs the generated statement.
SELECT format('CREATE ROLE incident_engine_rw LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'incident_engine_rw')
\gexec

-- Force safe role attributes + password (idempotent; safe whether or not the
-- role existed — a pre-existing role cannot keep elevated attributes).
ALTER ROLE incident_engine_rw LOGIN PASSWORD :'pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;

GRANT CONNECT ON DATABASE staging TO incident_engine_rw;

-- ---------------------------------------------------------------------------
-- OWNED SCHEMA: incidents. Ownership (not grants) is the mechanism — the app
-- owns its schema and every relation in it, so it has full DML/DDL there and
-- nowhere else. db/schema.sql creates the objects as superuser; this transfers
-- them. The loop covers tables/views only: a BIGSERIAL sequence is LINKED to
-- its table and cannot be altered directly — it follows the table's owner
-- automatically (the verify below still checks sequences ended up right).
-- ---------------------------------------------------------------------------
ALTER SCHEMA incidents OWNER TO incident_engine_rw;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'incidents'
      AND c.relkind IN ('r','p','v','m')   -- tables, partitioned tables, views, matviews
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO incident_engine_rw', r.nspname, r.relname);
  END LOOP;
END $$;

-- Verify: the schema and every relation in it are owned by incident_engine_rw.
DO $$
DECLARE
  bad text;
BEGIN
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'incidents')
     IS DISTINCT FROM 'incident_engine_rw' THEN
    RAISE EXCEPTION 'schema incidents is not owned by incident_engine_rw';
  END IF;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'incidents'
    AND c.relkind IN ('r','p','v','m','S')
    AND pg_get_userbyid(c.relowner) IS DISTINCT FROM 'incident_engine_rw';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incidents relations not owned by incident_engine_rw: %', bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SELF-LOG VIEW: the only write path into util. An auto-updatable view owned
-- by postgres, filtered to this app's rows, WITH CHECK OPTION — an INSERT
-- carrying any other app_name is rejected by the database. The app's ColumnSet
-- targets this view (utils/db/sql/pg-helpers.js), never the base table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW util.incident_engine_self_log AS
  SELECT app_name, run_id, verbose_log, warn_error_logs, inserted_at
  FROM util.app_run_logs
  WHERE app_name = 'incident-engine'
  WITH CASCADED CHECK OPTION;

ALTER VIEW util.incident_engine_self_log OWNER TO postgres;

-- ---------------------------------------------------------------------------
-- SCHEMA util: SELECT on exactly util.app_run_logs (a single grant on the
-- partitioned parent covers existing and future monthly partitions) + INSERT
-- on the self-log view. Fail closed: strip (tables AND sequences), re-grant,
-- verify.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA util FROM incident_engine_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA util FROM incident_engine_rw;
REVOKE ALL ON SCHEMA util                  FROM incident_engine_rw;

GRANT USAGE  ON SCHEMA util                    TO incident_engine_rw;
GRANT SELECT ON util.app_run_logs              TO incident_engine_rw;
GRANT INSERT ON util.incident_engine_self_log  TO incident_engine_rw;

-- Verify EFFECTIVE privileges. has_any_column_privilege is true for a
-- whole-table grant AND for a column-only grant (which has_table_privilege
-- misses); DELETE/TRUNCATE/TRIGGER are table-level only; sequences are checked
-- separately (USAGE/UPDATE would allow nextval/setval — a write). Anything
-- unexpected aborts the script (ON_ERROR_STOP is on).
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname || ':' || priv, ', ' ORDER BY c.relname, priv)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS priv
  WHERE n.nspname = 'util'
    AND c.relkind IN ('r','p','v','m','f')
    AND has_any_column_privilege('incident_engine_rw', c.oid, priv)
    AND NOT (c.relname = 'app_run_logs' AND priv = 'SELECT')
    AND NOT (c.relname = 'incident_engine_self_log' AND priv = 'INSERT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw has unexpected privileges in schema util: %', bad;
  END IF;
  SELECT string_agg(n.nspname || '.' || c.relname || ':' || priv, ', ' ORDER BY c.relname, priv)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['DELETE','TRUNCATE','TRIGGER']) AS priv
  WHERE n.nspname = 'util'
    AND c.relkind IN ('r','p','v','m','f')
    AND has_table_privilege('incident_engine_rw', c.oid, priv);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw has unexpected table privileges in schema util: %', bad;
  END IF;
  SELECT string_agg(n.nspname || '.' || c.relname || ':' || priv, ', ' ORDER BY c.relname, priv)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS priv
  WHERE n.nspname = 'util'
    AND c.relkind = 'S'
    AND has_sequence_privilege('incident_engine_rw', c.oid, priv);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw has unexpected sequence privileges in schema util: %', bad;
  END IF;
  IF has_schema_privilege('incident_engine_rw', 'util', 'CREATE') THEN
    RAISE EXCEPTION 'incident_engine_rw unexpectedly has CREATE on schema util';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SCHEMA stats: SELECT on exactly stats.acquisition_history (enrichment join +
-- the successful_acquisition recovery oracle). No writes, no sequences,
-- nothing else.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA stats FROM incident_engine_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA stats FROM incident_engine_rw;
REVOKE ALL ON SCHEMA stats                  FROM incident_engine_rw;

GRANT USAGE  ON SCHEMA stats               TO incident_engine_rw;
GRANT SELECT ON stats.acquisition_history  TO incident_engine_rw;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname || ':' || priv, ', ' ORDER BY c.relname, priv)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS priv
  WHERE n.nspname = 'stats'
    AND c.relkind IN ('r','p','v','m','f')
    AND has_any_column_privilege('incident_engine_rw', c.oid, priv)
    AND NOT (c.relname = 'acquisition_history' AND priv = 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw has unexpected privileges in schema stats: %', bad;
  END IF;
  SELECT string_agg(n.nspname || '.' || c.relname || ':' || priv, ', ' ORDER BY c.relname, priv)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['DELETE','TRUNCATE','TRIGGER']) AS priv
  WHERE n.nspname = 'stats'
    AND c.relkind IN ('r','p','v','m','f')
    AND has_table_privilege('incident_engine_rw', c.oid, priv);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw has unexpected table privileges in schema stats: %', bad;
  END IF;
  SELECT string_agg(n.nspname || '.' || c.relname || ':' || priv, ', ' ORDER BY c.relname, priv)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS priv
  WHERE n.nspname = 'stats'
    AND c.relkind = 'S'
    AND has_sequence_privilege('incident_engine_rw', c.oid, priv);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw has unexpected sequence privileges in schema stats: %', bad;
  END IF;
  IF has_schema_privilege('incident_engine_rw', 'stats', 'CREATE') THEN
    RAISE EXCEPTION 'incident_engine_rw unexpectedly has CREATE on schema stats';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SCHEMA alert: NOTHING. This app never reads or writes alert.*; verify no
-- effective privilege exists at all (a PUBLIC grant would trip this by design).
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA alert FROM incident_engine_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA alert FROM incident_engine_rw;
REVOKE ALL ON SCHEMA alert                  FROM incident_engine_rw;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname || ':' || priv, ', ' ORDER BY c.relname, priv)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS priv
  WHERE n.nspname = 'alert'
    AND c.relkind IN ('r','p','v','m','f')
    AND has_any_column_privilege('incident_engine_rw', c.oid, priv);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw has unexpected privileges in schema alert: %', bad;
  END IF;
  SELECT string_agg(n.nspname || '.' || c.relname || ':' || priv, ', ' ORDER BY c.relname, priv)
    INTO bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['DELETE','TRUNCATE','TRIGGER','USAGE','SELECT','UPDATE']) AS priv
  WHERE n.nspname = 'alert'
    AND ((c.relkind IN ('r','p','v','m','f') AND priv IN ('DELETE','TRUNCATE','TRIGGER')
          AND has_table_privilege('incident_engine_rw', c.oid, priv))
      OR (c.relkind = 'S' AND priv IN ('USAGE','SELECT','UPDATE')
          AND has_sequence_privilege('incident_engine_rw', c.oid, priv)));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw has unexpected table/sequence privileges in schema alert: %', bad;
  END IF;
  IF has_schema_privilege('incident_engine_rw', 'alert', 'USAGE')
     OR has_schema_privilege('incident_engine_rw', 'alert', 'CREATE') THEN
    RAISE EXCEPTION 'incident_engine_rw unexpectedly has USAGE/CREATE on schema alert';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- DATABASE-WIDE ALLOWLIST AUDIT (fail-closed). The per-schema blocks above are
-- targeted and readable; this block proves the WHOLE surface in this database:
-- every effective table/view/column/sequence privilege the role holds in ANY
-- non-system schema — including via PUBLIC — must be on the allowlist below,
-- or the script aborts. This is what turns "we granted little" into "the role
-- can reach nothing else".
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  WITH rels AS (
    SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
      AND n.nspname NOT LIKE 'pg\_temp%'
  ),
  effective AS (
    -- column-capable privileges (true for whole-table grants too; catches
    -- column-only grants that has_table_privilege misses)
    SELECT r.nspname, r.relname, priv
    FROM rels r
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS priv
    WHERE r.relkind IN ('r','p','v','m','f')
      AND has_any_column_privilege('incident_engine_rw', r.oid, priv)
    UNION ALL
    -- table-level-only privileges
    SELECT r.nspname, r.relname, priv
    FROM rels r
    CROSS JOIN unnest(ARRAY['DELETE','TRUNCATE','TRIGGER']) AS priv
    WHERE r.relkind IN ('r','p','v','m','f')
      AND has_table_privilege('incident_engine_rw', r.oid, priv)
    UNION ALL
    -- sequences: USAGE/UPDATE permit nextval/setval — a write outside incidents
    SELECT r.nspname, r.relname, priv
    FROM rels r
    CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS priv
    WHERE r.relkind = 'S'
      AND has_sequence_privilege('incident_engine_rw', r.oid, priv)
  )
  SELECT string_agg(e.nspname || '.' || e.relname || ':' || e.priv, ', '
                    ORDER BY e.nspname, e.relname, e.priv)
    INTO bad
  FROM effective e
  WHERE NOT (
       e.nspname = 'incidents'                                                -- owned schema: full access intended
    OR (e.nspname, e.relname, e.priv) = ('util', 'app_run_logs', 'SELECT')
    OR (e.nspname, e.relname, e.priv) = ('util', 'incident_engine_self_log', 'INSERT')
    OR (e.nspname, e.relname, e.priv) = ('stats', 'acquisition_history', 'SELECT')
    -- extension defaults granted to PUBLIC (read-only; query text masked for
    -- unprivileged roles). Allowlisted explicitly so any OTHER public-schema
    -- grant still trips the audit.
    OR (e.nspname, e.relname, e.priv) = ('public', 'pg_stat_statements', 'SELECT')
    OR (e.nspname, e.relname, e.priv) = ('public', 'pg_stat_statements_info', 'SELECT')
  );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'incident_engine_rw holds privileges outside the allowlist: %', bad;
  END IF;
END $$;

-- Sanity (manual, see markdown/DEPLOYMENT.md):
--   SET ROLE incident_engine_rw;
--   SELECT count(*) FROM util.app_run_logs WHERE inserted_at > now() - interval '1 hour';  -- OK
--   SELECT count(*) FROM stats.acquisition_history LIMIT 1;                                -- OK
--   INSERT INTO util.incident_engine_self_log(app_name, run_id, verbose_log, warn_error_logs)
--     VALUES ('incident-engine', gen_random_uuid(), '[]', '[]');                           -- OK (self-log)
--   INSERT INTO util.incident_engine_self_log(app_name, run_id, verbose_log, warn_error_logs)
--     VALUES ('data_acquisition', gen_random_uuid(), '[]', '[]');  -- expect: check option violation
--   INSERT INTO util.app_run_logs(app_name, run_id) VALUES ('x', gen_random_uuid());
--                                                           -- expect: permission denied
--   UPDATE util.app_run_logs SET app_name = app_name;      -- expect: permission denied
--   INSERT INTO stats.acquisition_history DEFAULT VALUES;  -- expect: permission denied
--   SELECT count(*) FROM alert.offline_hhm_conn;           -- expect: permission denied
--   CREATE TABLE incidents._probe(x int); DROP TABLE incidents._probe;  -- OK (owned schema)
