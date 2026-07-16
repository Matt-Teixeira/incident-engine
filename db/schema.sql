-- db/schema.sql — the `incidents` schema this app OWNS and writes.
-- Contract: docs/incidents-schema.md (this file must match it exactly).
-- House DDL style (mirror data_acquisition/db/tables/TABLES.sql +
-- stats.acquisition_history): CREATE ... IF NOT EXISTS, BIGSERIAL PK,
-- TIMESTAMPTZ DEFAULT NOW(), BRIN on time columns, named IF NOT EXISTS
-- indexes, partial indexes WHERE col IS NOT NULL, NO table partitioning.
--
-- Apply as a superuser (ownership moves to incident_engine_rw in
-- db/setup-owner-role.sql, run right after this — see markdown/DEPLOYMENT.md):
--   docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS incidents;

-- L0: append-only flattened facts — one row per warn_error_logs event,
-- fingerprinted + classified at materialize time (Phase 2).
-- PK (run_id, event_ord) → idempotent re-materialize via ON CONFLICT DO NOTHING.
CREATE TABLE IF NOT EXISTS incidents.error_events(
    run_id UUID NOT NULL,
    event_ord INT NOT NULL,
    src_app_name VARCHAR(64),
    type VARCHAR(8),
    func VARCHAR(64),
    tag VARCHAR(32),
    err_msg TEXT,
    note_message TEXT,
    sme VARCHAR(16),
    job_id TEXT,
    system_id VARCHAR(8),
    -- the incident dimension (sme → system_id → '__global__'), stamped at
    -- materialize time by domain/entity(); the Phase 3 aggregate GROUPs on it.
    entity VARCHAR(64) NOT NULL,
    fingerprint CHAR(40),
    fp_version SMALLINT NOT NULL,
    error_category VARCHAR(64),
    error_type VARCHAR(16),
    phase VARCHAR(32),
    dt TIMESTAMPTZ,
    raw_event JSONB,
    -- clock_timestamp() (insert-statement time), NOT NOW()/transaction_timestamp
    -- (transaction-START time). This column is the CURSOR the Phase 3 aggregate
    -- watermarks on, and the aggregate window is strict (watermark, snapshot].
    -- A materialize tx that starts before an aggregate but commits after it must
    -- NOT stamp its rows with a transaction-start time that predates the
    -- aggregate's watermark — those rows would sit below the watermark and be
    -- skipped forever (Phase 3 review, high finding). clock_timestamp() is
    -- evaluated per row at INSERT time, which is always AFTER materialize
    -- acquires the shared watermark lock, so the cursor orders correctly with
    -- the lock. See jobs/aggregate/index.js. NOTE (Phase 3 re-review): this
    -- assumes a NONDECREASING clock across the lock handoff (wall clock, not a
    -- monotonic primitive); a backward clock step could silently undercount. A
    -- monotonic BIGSERIAL/batch cursor is the unconditional upgrade path.
    inserted_at TIMESTAMPTZ DEFAULT clock_timestamp(),
    CONSTRAINT pk_error_events PRIMARY KEY (run_id, event_ord)
);

CREATE INDEX IF NOT EXISTS idx_error_events_inserted_brin ON incidents.error_events USING BRIN(inserted_at);

CREATE INDEX IF NOT EXISTS idx_error_events_fingerprint_dt ON incidents.error_events(fingerprint, dt DESC);

CREATE INDEX IF NOT EXISTS idx_error_events_sme_dt ON incidents.error_events(sme, dt DESC) WHERE sme IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_error_events_system_id ON incidents.error_events(system_id) WHERE system_id IS NOT NULL;

-- L1/L2/L3/L5: one row per distinct problem × affected equipment.
-- UNIQUE (fingerprint, entity) is the upsert key (Phase 3).
CREATE TABLE IF NOT EXISTS incidents.incidents(
    id BIGSERIAL PRIMARY KEY,
    fingerprint CHAR(40) NOT NULL,
    -- 64 so a 36-char job-UUID fallback is stored losslessly
    entity VARCHAR(64) NOT NULL,
    occurrence_count BIGINT,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    apps TEXT[],
    systems TEXT[],
    sample_run_id UUID,
    sample_message TEXT,
    category VARCHAR(64),
    error_type VARCHAR(16),
    phase VARCHAR(32),
    func VARCHAR(64),
    severity VARCHAR(16),
    confidence NUMERIC(3,2),
    assessor_kind VARCHAR(16),
    assessment JSONB,
    state VARCHAR(16),
    resolved_at TIMESTAMPTZ,
    resolved_reason VARCHAR(32),
    -- action_state / action_ref are reserved for future L4 auto-remediation;
    -- never written this increment.
    action_state VARCHAR(16),
    action_ref TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_incidents_fingerprint_entity UNIQUE (fingerprint, entity)
);

CREATE INDEX IF NOT EXISTS idx_incidents_state_last_seen ON incidents.incidents(state, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_severity_last_seen ON incidents.incidents(severity, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_last_seen_brin ON incidents.incidents USING BRIN(last_seen);

-- Watermarks: one row per source scan; advanced only within a batch's fixed
-- upper bound, in the same transaction as the batch's writes.
CREATE TABLE IF NOT EXISTS incidents.pipeline_state(
    source_key TEXT PRIMARY KEY,
    last_inserted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- UPGRADE SECTIONS — idempotent per-phase migrations for databases created by
-- an EARLIER version of this file. CREATE TABLE IF NOT EXISTS does nothing on
-- an existing table, so column additions/changes must also appear here.
-- Re-running this whole file is always safe: fresh installs get the final
-- shape from the CREATE statements above; existing installs converge here.
-- (Phase 2 re-review finding 1: the live ALTERs were originally applied
-- manually, leaving existing databases not reproducibly upgradeable.)
-- ============================================================================

-- Phase 2: per-row fingerprint provenance. ADD ... NOT NULL DEFAULT 1 is
-- metadata-only on PG11+ (no table scan — a plain UPDATE backfill would
-- re-scan the growing table on EVERY future re-apply of this file); DROP
-- DEFAULT then ensures new rows must state their version explicitly. On
-- re-apply: IF NOT EXISTS skips the ADD and DROP DEFAULT is a no-op.
-- PROVENANCE CAVEAT: pre-existing rows are stamped v1. Any database that
-- materialized rows with a pre-release interim formula must TRUNCATE and
-- re-materialize instead (only this repo's staging DB ever did; it was rebuilt).
-- NOTE: on upgraded databases this column lands LAST in ordinal position,
-- while fresh installs place it mid-table (after fingerprint) — names/types
-- converge, physical order does not. Never use positional operations
-- (COPY without a column list, INSERT ... SELECT *) across environments.
ALTER TABLE incidents.error_events
  ADD COLUMN IF NOT EXISTS fp_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE incidents.error_events ALTER COLUMN fp_version DROP DEFAULT;

-- Phase 2: entity must hold a 36-char job-UUID fallback losslessly. Widen only
-- (never narrow); no-op once at 64+.
-- (Phase 3 later removed job_id from the fallback, so incidents.entity now only
--  ever holds an sme/system_id/'__global__' value — all ≤16 chars. The 64 width
--  is kept as a harmless backstop; never narrow a live column.)
DO $$
DECLARE
  len int;
BEGIN
  SELECT atttypmod - 4 INTO len
  FROM pg_attribute
  WHERE attrelid = 'incidents.incidents'::regclass AND attname = 'entity';
  IF len IS NOT NULL AND len >= 0 AND len < 64 THEN
    ALTER TABLE incidents.incidents ALTER COLUMN entity TYPE VARCHAR(64);
  END IF;
END $$;

-- Phase 3: the incident dimension is now STORED on each L0 row (single source
-- of truth = domain/entity(); the aggregate GROUPs on it instead of re-deriving
-- entity in SQL). Add nullable → backfill existing rows → SET NOT NULL, so an
-- existing Phase 2 database converges. On a fresh install the CREATE above
-- already made the column NOT NULL, so ADD IF NOT EXISTS is a no-op, the
-- backfill UPDATE matches nothing, and SET NOT NULL is idempotent.
--
-- BACKFILL PARITY: this expression reproduces domain/entity() for the values
-- already STORED on error_events (sme is stored trimmed via nonEmptyString and
-- capped to 16; system_id is a validated ^SME\d{5}$ token or NULL). It is the
-- ONE-TIME migration path only — going-forward rows are stamped by entity() in
-- jobs/materialize/flatten.js. job_id is intentionally absent (Phase 3 dropped
-- it from the chain). Validation asserts column == entity() over all rows.
-- The explicit whitespace set matches JS String.trim() (used by nonEmptyString
-- inside entity()): btrim's DEFAULT set is spaces only, so a non-space
-- whitespace char left trailing by the 16-char sme cap would survive here but be
-- stripped by entity(), splitting one incident in two (re-review, low finding).
ALTER TABLE incidents.error_events ADD COLUMN IF NOT EXISTS entity VARCHAR(64);
UPDATE incidents.error_events
   SET entity = left(
         COALESCE(NULLIF(btrim(sme, E' \t\n\r\f\v'), ''),
                  NULLIF(btrim(system_id, E' \t\n\r\f\v'), ''),
                  '__global__'),
         64)
 WHERE entity IS NULL;
ALTER TABLE incidents.error_events ALTER COLUMN entity SET NOT NULL;

-- Phase 3 (review, high finding): the aggregate cursor must be stamped at INSERT
-- time (post-lock), never at transaction-start. Move the default off NOW() so a
-- late-committing materialize can no longer stamp rows below an aggregate
-- watermark advanced while it was mid-transaction. Existing rows keep their
-- historical inserted_at (already aggregated); only new inserts are affected.
ALTER TABLE incidents.error_events ALTER COLUMN inserted_at SET DEFAULT clock_timestamp();
