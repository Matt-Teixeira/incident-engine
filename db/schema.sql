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
    -- Where `category` came from: 'classifier' (this incident's own events matched
    -- a pattern) or 'oracle' (they did not; this is the latest UNRELATED category
    -- for the same system_id, via stats.acquisition_history — time- and
    -- run-uncorrelated). Added Phase 4 (review, HIGH): the two are not
    -- interchangeable and storing only the category hid that. The assessor must
    -- not treat an oracle category as evidence about this problem — live, all 40
    -- oracle-sourced incidents carry a category absent from their own L0 events.
    -- NOT NULL + CHECK (review round 2, medium): the assessor's gate keys on this
    -- value, so a NULL or typo'd provenance is a WRITER BUG that must be
    -- impossible at rest — not a state the rules have to guess about. The
    -- aggregate always writes one of the two values (CATEGORY_SOURCE_EXPR), so
    -- the constraint costs nothing on the happy path.
    -- See utils/db/queries/enrichment.js.
    category_source VARCHAR(16) NOT NULL
        CONSTRAINT chk_incidents_category_source
        CHECK (category_source IN ('classifier', 'oracle')),
    error_type VARCHAR(16),
    -- WARN/ERROR — the producing app's own label, denormalized from
    -- error_events by the Phase 3 aggregate (Phase 4). LOSSLESS: type is inside
    -- the fingerprint (sha1(app|func|tag|type|normalize(text))), so one
    -- fingerprint carries exactly one type — live-verified: 0 fingerprints
    -- carry both. The assessor reads it without joining back to L0 — but since
    -- review round 2 (M2) it feeds CONFIDENCE and REASONS only, never severity
    -- (producers log real failures as WARN, so the label is not an outcome
    -- signal — see docs/error-taxonomy.md, "What type does NOT mean").
    -- NULLABLE ON PURPOSE (unlike error_events.entity, which is NOT NULL): an
    -- incident is the DURABLE rollup and error_events is the volatile layer
    -- (this app "persists its own durable rollups rather than assuming long
    -- history upstream" — Data-Contract Rule). An incident whose L0 events are
    -- someday aged out has nothing to backfill from, so SET NOT NULL would make
    -- re-applying this file fail on exactly the databases that need it most.
    -- The assessor treats a null/garbled type as ERROR (fail-safe, never
    -- silently downgrades) — domain/assessor/rules.js.
    type VARCHAR(8),
    phase VARCHAR(32),
    func VARCHAR(64),
    severity VARCHAR(16),
    confidence NUMERIC(3,2),
    assessor_kind VARCHAR(16),
    -- which RULES CONTENT produced the stored severity (domain/assessor/rules.js
    -- RULES_VERSION), mirroring the error_events.fp_version precedent.
    -- assessor_kind alone is not provenance: it stays 'rules' across every
    -- rules-table change, so a severity from a superseded threshold is otherwise
    -- indistinguishable from a current one.
    assessor_version SMALLINT,
    assessment JSONB,
    -- lifecycle (Phase 5): open / acknowledged / recurring / resolved /
    -- suppressed. ENGINE-driven transitions only (domain/state.js);
    -- acknowledged/suppressed are reserved for a future human action — the
    -- engine defines but never sets them, and never transitions OUT of
    -- suppressed. `recurring` has exactly one meaning: re-opened after a
    -- resolution (an occurrence threshold would mark ~everything instantly —
    -- see notes/phase_5_reevaluation.md).
    -- CHECK (round-2 M1 pattern: vocabulary enforced AT REST, not by reviewer
    -- vigilance). NULL passes the CHECK by SQL semantics — new rows from the
    -- aggregate carry NULL state until the state step initializes them.
    state VARCHAR(16)
        CONSTRAINT chk_incidents_state
        CHECK (state IN ('open', 'acknowledged', 'recurring', 'resolved', 'suppressed')),
    -- when the engine resolved it (DB clock, the batch's evaluation snapshot;
    -- stamped once per transition, never refreshed by re-runs)
    resolved_at TIMESTAMPTZ,
    -- 'auto_recovery' (a successful acquisition AFTER the incident's last_seen)
    -- or 'stale' (no recurrence in STALE_AFTER_DAYS). Recovery is evaluated
    -- first, so an incident eligible for both records the stronger reason.
    resolved_reason VARCHAR(32)
        CONSTRAINT chk_incidents_resolved_reason
        CHECK (resolved_reason IN ('auto_recovery', 'stale')),
    -- the incident's last_seen AT RESOLVE TIME (Phase 5). Re-open compares
    -- last_seen > resolved_last_seen — BOTH producer-clock values. Comparing
    -- last_seen against resolved_at (DB clock) instead would let a producer
    -- whose clock trails the DB advance last_seen without ever exceeding
    -- resolved_at, leaving the incident resolved WHILE FAILING — the exact
    -- masking re-open exists to prevent. Kept (not cleared) on re-open as
    -- history of the last resolution.
    resolved_last_seen TIMESTAMPTZ,
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

-- Phase 4: the assessor's two new columns on incidents.incidents.
--
--   type             — the producer's WARN/ERROR label, denormalized from L0 so
--                      the assessor can read it without joining to error_events
--                      (confidence and reasons only, never severity — round-2
--                      M2). See the CREATE above for why it is lossless and why
--                      it stays NULLABLE.
--   assessor_version — which rules content produced the stored severity
--                      (RULES_VERSION), mirroring error_events.fp_version.
--
-- Both are additive and nullable, so ADD COLUMN IF NOT EXISTS is metadata-only
-- (no table rewrite) and re-applying this file is a no-op. On a fresh install the
-- CREATE above already declared them, so the ADDs skip and the backfill below
-- matches nothing (the table is empty).
ALTER TABLE incidents.incidents ADD COLUMN IF NOT EXISTS type VARCHAR(8);
ALTER TABLE incidents.incidents ADD COLUMN IF NOT EXISTS assessor_version SMALLINT;
ALTER TABLE incidents.incidents ADD COLUMN IF NOT EXISTS category_source VARCHAR(16);

-- Phase 4 (review, HIGH finding): backfill `category_source` for incidents
-- aggregated before the column existed. Going-forward rows are written by the
-- aggregate from the enrichment join itself (CATEGORY_SOURCE_EXPR).
--
-- THE BACKFILL SIGNATURE IS ONLY VALID AT THIS INSTANT, AND ONLY HERE.
-- We cannot re-run the oracle join retroactively (it reads "the latest category
-- for this system", which has since moved on), so the backfill uses the one
-- signature that identifies an oracle category on EXISTING rows:
--   category <> 'unknown' AND error_type = ''
-- This is exact *today* because classify() returns error_type '' for exactly the
-- 'unknown' case, so a classifier-sourced category always carries a non-empty
-- error_type. It is NOT durable: populating error_type on corroborated rows is a
-- tracked Phase 3 follow-up, and landing it would make this signature match
-- nothing. That is precisely why going-forward provenance comes from the JOIN
-- (enrichment.js) and not from this predicate — this runs once per existing row
-- and then never matters again. Live at write time: 40 rows matched.
UPDATE incidents.incidents
   SET category_source = CASE
         WHEN category <> 'unknown' AND COALESCE(error_type, '') = '' THEN 'oracle'
         ELSE 'classifier'
       END
 WHERE category_source IS NULL;

-- Round-2 hardening (review, medium): after the backfill, provenance is complete,
-- so lock it — a NULL or out-of-vocabulary category_source is a writer/migration
-- bug the assessor should never have to interpret. SET NOT NULL is idempotent;
-- the CHECK is guarded because ADD CONSTRAINT has no IF NOT EXISTS. Fresh
-- installs already carry both from the CREATE above (same constraint name, so
-- the guard sees it and skips).
--
-- MIGRATION-ORDER GUARANTEE (review round 2, judgment call): the one-time
-- backfill above keys on error_type = '' — a signature that dies when the
-- tracked "populate error_type on corroborated rows" follow-up lands. That is
-- safe STRUCTURALLY, not by convention: migrations live in this single file,
-- applied top-to-bottom, so any future error_type-population section is
-- necessarily written BELOW this one and runs after provenance is complete and
-- NOT NULL. Whoever writes that section: it must not touch category_source,
-- which by then is already locked.
ALTER TABLE incidents.incidents ALTER COLUMN category_source SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incidents_category_source'
      AND conrelid = 'incidents.incidents'::regclass
  ) THEN
    ALTER TABLE incidents.incidents
      ADD CONSTRAINT chk_incidents_category_source
      CHECK (category_source IN ('classifier', 'oracle'));
  END IF;
END $$;

-- Phase 5: the re-open memento. Additive + nullable, so ADD COLUMN IF NOT
-- EXISTS is metadata-only and re-apply is a no-op. NO backfill is needed or
-- possible: no incident was ever resolved before this column existed (state was
-- NULL on every row until Phase 5's first run), so there is no historical
-- resolution to record. See the CREATE above for why this column exists
-- (producer-clock re-open comparison; review-identified skew hazard).
ALTER TABLE incidents.incidents ADD COLUMN IF NOT EXISTS resolved_last_seen TIMESTAMPTZ;

-- Phase 5: vocabulary constraints on the lifecycle columns (the round-2 M1
-- pattern — a typo'd state or reason is a writer bug that must be impossible at
-- rest, not a value the transition function has to guess about; the engine-side
-- guard is domain/state.js ENGINE_STATES + the state ColumnSets). Guarded DO
-- blocks because ADD CONSTRAINT has no IF NOT EXISTS; fresh installs already
-- carry both from the CREATE above (same names, so the guards skip).
-- NOTE for the future human surface: a new resolved_reason (e.g. a manual
-- close) or state value requires widening these constraints in a deliberate,
-- logged phase — that friction is the point.
-- Phase 5 (review, HIGH — remediation): the first cut admitted CROSS-PRODUCER
-- recovery evidence — a data_acquisition (mmb/ip_reset) success closed
-- hhm_rpp_ge/hhm_rpp_philips incidents on the same system, though the oracle
-- records data_acquisition's own outcomes only (proven: every
-- acquisition_history.run_id joins to a data_acquisition run). 30 incidents
-- were falsely resolved (and 4 of them re-opened as artificial 'recurring'
-- flaps). Reset the LIFECYCLE of every close whose evidence is inadmissible
-- under the scope rule (domain/state.js ORACLE_SCOPED_APPS): the next state
-- run re-decides them from scratch under valid rules (open, or a legitimate
-- staleness close). IDEMPOTENT: matched rows get resolved_reason=NULL, so a
-- re-apply matches nothing; the fixed engine can never re-create the state
-- this predicate matches (auto_recovery requires apps[1]='data_acquisition'
-- from then on). Assessment columns are untouched.
UPDATE incidents.incidents
   SET state = NULL,
       resolved_at = NULL,
       resolved_reason = NULL,
       resolved_last_seen = NULL
 WHERE resolved_reason = 'auto_recovery'
   AND NOT ('data_acquisition' = ANY(apps));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incidents_state'
      AND conrelid = 'incidents.incidents'::regclass
  ) THEN
    ALTER TABLE incidents.incidents
      ADD CONSTRAINT chk_incidents_state
      CHECK (state IN ('open', 'acknowledged', 'recurring', 'resolved', 'suppressed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incidents_resolved_reason'
      AND conrelid = 'incidents.incidents'::regclass
  ) THEN
    ALTER TABLE incidents.incidents
      ADD CONSTRAINT chk_incidents_resolved_reason
      CHECK (resolved_reason IN ('auto_recovery', 'stale'));
  END IF;
END $$;

-- One-time backfill of `type` for incidents aggregated BEFORE the column existed
-- (live: the 504-incident Phase 3 backlog). Going-forward rows are written by the
-- aggregate itself (utils/db/queries/incidents.js), exactly as entity() stamps
-- error_events.entity — this is the migration path only.
--
-- CORRECTNESS: the DISTINCT sub-select yields exactly one row per fingerprint
-- because type is part of the fingerprint, so this UPDATE cannot be
-- nondeterministic (a Postgres UPDATE ... FROM with multiple matching rows would
-- silently pick one). Live-verified before writing this: zero fingerprints carry
-- more than one type. The DO block below re-proves that invariant on every
-- apply rather than trusting the one-time measurement — if a future FP_VERSION
-- ever removed type from the fingerprint, this backfill would become
-- order-dependent and must fail loudly instead of quietly picking a type.
DO $$
DECLARE
  mixed int;
BEGIN
  SELECT count(*) INTO mixed FROM (
    SELECT fingerprint FROM incidents.error_events
    GROUP BY fingerprint HAVING count(DISTINCT type) > 1
  ) x;
  IF mixed > 0 THEN
    RAISE EXCEPTION 'incidents.incidents.type backfill is unsafe: % fingerprint(s) carry more than one type. type must be inside the fingerprint for this denormalization to be lossless.', mixed;
  END IF;
END $$;

UPDATE incidents.incidents i
   SET type = e.type
  FROM (SELECT DISTINCT fingerprint, type FROM incidents.error_events) e
 WHERE i.fingerprint = e.fingerprint
   AND i.type IS NULL;
