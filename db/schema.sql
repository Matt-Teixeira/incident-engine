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
    fingerprint CHAR(40),
    error_category VARCHAR(64),
    error_type VARCHAR(16),
    phase VARCHAR(32),
    dt TIMESTAMPTZ,
    raw_event JSONB,
    inserted_at TIMESTAMPTZ DEFAULT NOW(),
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
    entity VARCHAR(32) NOT NULL,
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
-- now() upper bound, in the same transaction as the batch's writes.
CREATE TABLE IF NOT EXISTS incidents.pipeline_state(
    source_key TEXT PRIMARY KEY,
    last_inserted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
