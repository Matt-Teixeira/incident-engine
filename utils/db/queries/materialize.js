// utils/db/queries/materialize.js — all SQL for the materialize job.
// Parameterized only; the source scan reads warn_error_logs ONLY (never
// verbose_log) and is bounded on inserted_at at both ends so the monthly
// partitions prune (Data-Contract Rule).
"use strict";

// Ensure the watermark row exists (epoch default), then lock it. The
// ensure+lock pair serializes concurrent materialize runs on the row lock, so
// two cron overlaps cannot interleave scan/advance (the ON CONFLICT inserts
// would absorb a race anyway; the lock makes it non-interleaved by
// construction).
const ENSURE_WATERMARK_SQL = `
  INSERT INTO incidents.pipeline_state (source_key, last_inserted_at)
  VALUES ($1, to_timestamp(0))
  ON CONFLICT (source_key) DO NOTHING`;

// COALESCE: the column is nullable and ENSURE only seeds a MISSING row, so a
// manually nulled watermark would otherwise crash every run on .getTime().
const LOCK_WATERMARK_SQL = `
  SELECT COALESCE(last_inserted_at, to_timestamp(0)) AS last_inserted_at
  FROM incidents.pipeline_state
  WHERE source_key = $1
  FOR UPDATE`;

// The batch's fixed upper bound, taken in a SEPARATE statement AFTER the lock
// is held. now() would be the transaction-START clock: a transaction that
// started earlier but acquired the lock second would carry an OLDER snapshot
// than the watermark committed by the transaction it waited on, and would
// move the watermark backward (Phase 2 review finding 3). clock_timestamp()
// here is guaranteed later than any snapshot committed before the lock was
// granted.
const SNAPSHOT_SQL = `SELECT clock_timestamp() AS now_snapshot`;

// $1 = watermark - overlap, $2 = now_snapshot, $3 = producing-apps allowlist.
// The <> 'incident-engine' predicate is defense in depth for the self-ingestion
// invariant (this app writes the same table via its self-log): even if the
// allowlist is ever mis-edited, the query cannot ingest this app's own errors.
// No ORDER BY: nothing depends on scan order (inserts are PK-keyed, the
// watermark is the snapshot regardless) and a sort of the wide json rows
// would cost memory for nothing.
const SCAN_SOURCE_SQL = `
  SELECT run_id, app_name, warn_error_logs
  FROM util.app_run_logs
  WHERE inserted_at > $1
    AND inserted_at <= $2
    AND app_name IN ($3:csv)
    AND app_name <> 'incident-engine'
    AND warn_error_logs IS NOT NULL`;

// GREATEST: defense in depth for the monotonic-watermark contract — even if
// an older snapshot ever reaches this statement, the watermark never
// regresses. RETURNING reports the value actually stored so the run summary
// never claims an advance that GREATEST rejected; clock_timestamp() keeps
// updated_at monotonic too (now() would be the transaction-start clock —
// re-review finding 3).
const ADVANCE_WATERMARK_SQL = `
  UPDATE incidents.pipeline_state
  SET last_inserted_at = GREATEST(last_inserted_at, $2),
      updated_at = clock_timestamp()
  WHERE source_key = $1
  RETURNING last_inserted_at`;

module.exports = {
  ENSURE_WATERMARK_SQL,
  LOCK_WATERMARK_SQL,
  SNAPSHOT_SQL,
  SCAN_SOURCE_SQL,
  ADVANCE_WATERMARK_SQL,
};
