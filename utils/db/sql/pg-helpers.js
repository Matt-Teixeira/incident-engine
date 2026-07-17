// utils/db/sql/pg-helpers.js — pgp.helpers TableNames + ColumnSets for every
// table this app writes (house style: all writes go through these, never
// hand-rolled string SQL). Write surface: the owned `incidents` schema plus the
// single self-log INSERT into util.app_run_logs (see the Write-Isolation Rule).
const pgp = require('pg-promise')();

const pg_tables = {
    util: {
        // Read-only source stream (Phase 2 materialize scans it).
        app_run_logs: new pgp.helpers.TableName({
            table: 'app_run_logs',
            schema: 'util',
        }),
        // The ONLY util write path: a check-option view (owner: postgres) that
        // pins app_name = 'incident-engine'. The role has INSERT on this view
        // and NO insert on the base table (db/setup-owner-role.sql).
        incident_engine_self_log: new pgp.helpers.TableName({
            table: 'incident_engine_self_log',
            schema: 'util',
        }),
    },
    incidents: {
        error_events: new pgp.helpers.TableName({
            table: 'error_events',
            schema: 'incidents',
        }),
        incidents: new pgp.helpers.TableName({
            table: 'incidents',
            schema: 'incidents',
        }),
        pipeline_state: new pgp.helpers.TableName({
            table: 'pipeline_state',
            schema: 'incidents',
        }),
    },
};

const pg_column_sets = {
    util: {
        // Self-log only — through the check-option view, so the DB rejects any
        // app_name other than 'incident-engine'.
        self_log: new pgp.helpers.ColumnSet(
            ['app_name', 'run_id', 'verbose_log', 'warn_error_logs'],
            { table: pg_tables.util.incident_engine_self_log }
        ),
    },
    incidents: {
        // L0 flattened facts; PK (run_id, event_ord) drives ON CONFLICT DO NOTHING
        // (Phase 2 materialize).
        error_events: new pgp.helpers.ColumnSet(
            [
                'run_id',
                'event_ord',
                'src_app_name',
                'type',
                'func',
                'tag',
                'err_msg',
                'note_message',
                'sme',
                'job_id',
                'system_id',
                'entity',
                'fingerprint',
                'fp_version',
                'error_category',
                'error_type',
                'phase',
                'dt',
                { name: 'raw_event', cast: 'jsonb' },
            ],
            { table: pg_tables.incidents.error_events }
        ),
        // Insert columns for the (fingerprint, entity) upsert (Phase 3 aggregate);
        // id / resolved_* / action_* / created_at / updated_at are set by defaults
        // or by later lifecycle stages, not on insert.
        //
        // CURRENTLY UNUSED (noted Phase 4): the Phase 3 aggregate is a set-based
        // INSERT ... SELECT ... GROUP BY ... ON CONFLICT that never round-trips
        // rows through JS, so it does not format against this ColumnSet — see the
        // house-style note in utils/db/queries/incidents.js. It is kept as the
        // declared write surface for this table and must stay accurate (`type` was
        // added here in Phase 4 alongside the column), but nothing enforces that
        // today. Left in place rather than removed: deleting a Phase 3 artifact is
        // outside this phase, and a future row-at-a-time writer wants it. Flagged
        // in notes/codex_handoff_phase_4.md.
        incidents: new pgp.helpers.ColumnSet(
            [
                'fingerprint',
                'entity',
                'occurrence_count',
                'first_seen',
                'last_seen',
                'apps',
                'systems',
                'sample_run_id',
                'sample_message',
                'category',
                'category_source',
                'error_type',
                'type',
                'phase',
                'func',
                'severity',
                'confidence',
                'assessor_kind',
                'assessor_version',
                { name: 'assessment', cast: 'jsonb' },
                'state',
            ],
            { table: pg_tables.incidents.incidents }
        ),
        // The Phase 4 assessor's write surface: EXACTLY the assessment columns,
        // nothing else. This is the enforcement point for two rules at once —
        //   * Write-Isolation: the only columns this app's assessor may touch.
        //   * Determinism: `state` / `resolved_*` are ABSENT on purpose. The
        //     assessor must never set incident state or auto-close (Phase 5 owns
        //     that), and a ColumnSet that has no such column cannot write one
        //     even if a future edit to the job tried to.
        // `id` is cnd (condition-only): it identifies the row in the generated
        // `WHERE v.id = t.id` and is never itself assigned. Every column carries an
        // explicit cast because a multi-row helpers.update() builds an untyped
        // VALUES list — without casts Postgres cannot infer numeric/smallint/jsonb.
        incidents_assessment: new pgp.helpers.ColumnSet(
            [
                { name: 'id', cnd: true, cast: 'bigint' },
                { name: 'severity', cast: 'varchar' },
                { name: 'confidence', cast: 'numeric' },
                { name: 'assessor_kind', cast: 'varchar' },
                { name: 'assessor_version', cast: 'smallint' },
                { name: 'assessment', cast: 'jsonb' },
                // updated_at must be part of the ColumnSet, NOT appended to the
                // generated statement: helpers.update() emits
                // `SET ... FROM (VALUES ...) AS v(...)`, so anything appended
                // lands AFTER the FROM clause, where a SET assignment is a
                // syntax error. mod '^' injects the value as raw SQL, so the row
                // supplies the literal string 'clock_timestamp()' and Postgres
                // evaluates it per row. Raw mod is safe here precisely because
                // the value is a fixed constant this module controls — never
                // input. clock_timestamp() (statement time) matches the
                // aggregate's upsert; now() would be transaction-start time.
                { name: 'updated_at', mod: '^', cast: 'timestamptz' },
            ],
            { table: pg_tables.incidents.incidents }
        ),
        // The Phase 5 state step's TWO write surfaces — split on purpose:
        //
        //   incidents_state_only    — initialization (NULL → open) and re-open
        //                             (resolved → recurring). Carries NO
        //                             resolved_* column, so a re-open CANNOT
        //                             clear the last resolution's history even
        //                             if the job code regressed (the prompt
        //                             requires resolved_* kept on re-open).
        //   incidents_resolution    — the resolve transition: state +
        //                             resolved_at/resolved_reason/
        //                             resolved_last_seen together, atomically.
        //
        // Neither carries `severity`/`assessment` (the assessor's surface) nor
        // `action_*` (reserved L4) nor `acknowledged`/`suppressed`-only fields —
        // and the state VALUES the engine may write are additionally pinned by
        // domain/state.js ENGINE_STATES + the unit suite. Same enforcement
        // pattern as incidents_assessment above: the ColumnSet is the guard,
        // not reviewer vigilance.
        // Both state ColumnSets carry prev_* CONDITION columns (cnd: never SET,
        // only matched in the WHERE): the optimistic guard from the Phase 5
        // review (medium) — the update applies only if the row still holds the
        // state/last_seen/resolved_last_seen the transition was computed from.
        // A concurrently-changed row (future human sets suppressed; an
        // overlapping aggregate advances last_seen) is skipped, surfaced in the
        // run summary, and re-evaluated next run against its new facts.
        incidents_state_only: new pgp.helpers.ColumnSet(
            [
                { name: 'id', cnd: true, cast: 'bigint' },
                { name: 'prev_state', cnd: true, cast: 'varchar' },
                { name: 'prev_last_seen', cnd: true, cast: 'timestamptz' },
                { name: 'prev_resolved_last_seen', cnd: true, cast: 'timestamptz' },
                { name: 'state', cast: 'varchar' },
                { name: 'updated_at', mod: '^', cast: 'timestamptz' },
            ],
            { table: pg_tables.incidents.incidents }
        ),
        incidents_resolution: new pgp.helpers.ColumnSet(
            [
                { name: 'id', cnd: true, cast: 'bigint' },
                { name: 'prev_state', cnd: true, cast: 'varchar' },
                { name: 'prev_last_seen', cnd: true, cast: 'timestamptz' },
                { name: 'prev_resolved_last_seen', cnd: true, cast: 'timestamptz' },
                { name: 'state', cast: 'varchar' },
                // the batch's evaluation snapshot (one clock reading per run,
                // passed as a value) — NOT per-row clock_timestamp(), so
                // resolved_at equals the eval_time the staleness comparison
                // used and the parity invariant (resolved_at - resolved_last_seen
                // > STALE_AFTER_DAYS for 'stale' rows) holds exactly.
                { name: 'resolved_at', cast: 'timestamptz' },
                { name: 'resolved_reason', cast: 'varchar' },
                { name: 'resolved_last_seen', cast: 'timestamptz' },
                { name: 'updated_at', mod: '^', cast: 'timestamptz' },
            ],
            { table: pg_tables.incidents.incidents }
        ),
    },
};

// pgp is exported so consumers formatting SQL against these ColumnSets
// (pgp.helpers.insert) use the SAME pg-promise root that built them — a
// per-root option (capSQL, type parsers) set here then applies everywhere.
module.exports = { pgp, pg_tables, pg_column_sets };
