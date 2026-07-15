// jobs/materialize — L0: watermark → bounded warn_error_logs scan → flatten/
// fingerprint/classify → incidents.error_events, idempotently.
//
// Idempotency (Idempotency Rule): the scan window is (watermark - overlap,
// now_snapshot]; inserts are ON CONFLICT (run_id, event_ord) DO NOTHING; the
// watermark advances to now_snapshot in the SAME transaction as the inserts.
// A failure anywhere throws → the transaction rolls back (watermark
// unadvanced) → the run exits 1 → the next run rescans and the ON CONFLICT
// absorbs the replay.
"use strict";

const db = require("../../utils/db/pg-pool");
// pgp comes from pg-helpers so insert formatting uses the same root that
// built the ColumnSets (per-root options would otherwise silently diverge).
const { pgp, pg_column_sets } = require("../../utils/db/sql/pg-helpers");
const {
  ENSURE_WATERMARK_SQL,
  LOCK_WATERMARK_SQL,
  SNAPSHOT_SQL,
  SCAN_SOURCE_SQL,
  ADVANCE_WATERMARK_SQL,
} = require("../../utils/db/queries/materialize");
const { flattenRun } = require("./flatten");
const { FP_VERSION } = require("../../domain/fingerprint");
const [addLogEvent, , , , , startTimer, endTimer] = require("../../utils/logger/log");
const {
  type: { W },
  tag: { det },
} = require("../../utils/logger/enums");

const SOURCE_KEY = "util.app_run_logs";

// Explicit allowlist — live-verified 2026-07-14 (notes/phase_2_reevaluation.md):
// the only apps emitting warn_error_logs events (~25k/day).
// NEVER add 'incident-engine': this app self-logs its own WARN/ERROR events
// into the same table, so ingesting them is a feedback loop, not a feature.
// 'acquisition-v2' writes rows but no events yet; onboarding it is an open
// decision (markdown/PROMPTS.md "Not decided yet").
const PRODUCING_APPS = ["data_acquisition", "hhm_rpp_ge", "hhm_rpp_philips"];

const envInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return n;
};

const materialize = async (run_log) => {
  // 30s default: the overlap is the only protection against a producer whose
  // INSERT→commit gap outlives it (statement-time inserted_at, commit-time
  // visibility) — a skipped row is silent and permanent once retention
  // expires. 30s of re-scanned rows is a handful; ON CONFLICT absorbs them.
  const overlap_ms = envInt("MATERIALIZE_OVERLAP_MS", 30000);
  const batch_rows = envInt("MATERIALIZE_BATCH_ROWS", 5000);
  if (batch_rows === 0) throw new Error("MATERIALIZE_BATCH_ROWS must be > 0");
  // Defense in depth alongside the SQL predicate: the scan must never ingest
  // this app's own self-log (feedback loop), even if the allowlist moves to
  // env/config someday.
  if (PRODUCING_APPS.includes(process.env.APP_NAME)) {
    throw new Error(
      `PRODUCING_APPS must never include this app (${process.env.APP_NAME}): self-ingestion feedback loop`
    );
  }

  startTimer(run_log, "materialize");

  const summary = await db.tx("materialize", async (t) => {
    await t.none(ENSURE_WATERMARK_SQL, [SOURCE_KEY]);
    const { last_inserted_at } = await t.one(LOCK_WATERMARK_SQL, [SOURCE_KEY]);
    // Snapshot AFTER the lock is held (see SNAPSHOT_SQL) so a run that waited
    // on a concurrent materialize can never carry an older bound than the
    // watermark it just observed.
    const { now_snapshot } = await t.one(SNAPSHOT_SQL);
    const scan_from = new Date(last_inserted_at.getTime() - overlap_ms);

    const src_rows = await t.any(SCAN_SOURCE_SQL, [
      scan_from,
      now_snapshot,
      PRODUCING_APPS,
    ]);

    const rows = [];
    const skipped = [];
    for (const src of src_rows) {
      const flat = flattenRun(src);
      rows.push(...flat.rows);
      skipped.push(...flat.skipped);
    }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += batch_rows) {
      const chunk = rows.slice(i, i + batch_rows);
      const query =
        pgp.helpers.insert(chunk, pg_column_sets.incidents.error_events) +
        " ON CONFLICT (run_id, event_ord) DO NOTHING";
      const result = await t.result(query);
      inserted += result.rowCount;
    }

    const { last_inserted_at: watermark_stored } = await t.one(
      ADVANCE_WATERMARK_SQL,
      [SOURCE_KEY, now_snapshot]
    );

    return {
      watermark_before: last_inserted_at.toISOString(),
      scan_from: scan_from.toISOString(),
      snapshot_upper_bound: now_snapshot.toISOString(),
      // the value actually stored (GREATEST may have kept a newer watermark)
      watermark_after: watermark_stored.toISOString(),
      src_rows: src_rows.length,
      events_flattened: rows.length,
      events_inserted: inserted,
      events_skipped: skipped.length,
      skipped_samples: skipped.slice(0, 20),
    };
  });

  if (summary.events_skipped > 0) {
    await addLogEvent(
      W,
      run_log,
      "materialize",
      det,
      {
        txt: "malformed events skipped",
        events_skipped: summary.events_skipped,
        skipped_samples: summary.skipped_samples,
      },
      null
    );
  }

  const { skipped_samples, ...counts } = summary;
  await endTimer(run_log, "materialize", { fp_version: FP_VERSION, ...counts });
};

module.exports = materialize;
