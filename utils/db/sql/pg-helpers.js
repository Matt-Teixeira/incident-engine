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
                'fingerprint',
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
                'error_type',
                'phase',
                'func',
                'severity',
                'confidence',
                'assessor_kind',
                { name: 'assessment', cast: 'jsonb' },
                'state',
            ],
            { table: pg_tables.incidents.incidents }
        ),
    },
};

module.exports = { pg_tables, pg_column_sets };
