// integration/rep_determinism.js — LIVE integration test (review low
// finding): the chosen representative must be IDENTICAL whether the incidents
// are built in one full-rebuild batch or incrementally across several windows.
// Run in the app container:
//   docker compose run --rm app node integration/rep_determinism.js
//
// It rebuilds incidents.incidents two ways over the SAME L0 data and diffs the
// representatives. It TRUNCATEs incidents.incidents (the app owns it; no live
// consumer yet) and restores a correct full aggregation + watermark at the end.
//
// ⚠ DESTRUCTIVE — READ BEFORE RUNNING (updated Phase 4):
// The TRUNCATE destroys everything on incidents.incidents that is NOT re-derived
// by the aggregate. In Phase 3 that was nothing (aggregation was all the table
// held), so this test was self-restoring. Phase 4 added the ASSESSMENT columns
// (severity / confidence / assessment / assessor_kind / assessor_version), which
// the aggregate does NOT write — so the restore below leaves every incident
// UNASSESSED. This is not data loss (the assessor is a pure function of the
// dossier, so `node index.js assess` rebuilds all of it exactly), but a bare run
// of this test silently blanks the severity of every incident until the next
// cron `run` at :25/:55.
//
// The finally block therefore re-assesses as part of the restore. Phase 5 will
// add lifecycle state (state / resolved_*) that is NOT a pure function of L0 —
// once that exists, this TRUNCATE becomes genuinely lossy and this test must be
// reworked (snapshot-and-restore, or a scratch table) rather than patched again.
"use strict";

const db = require("../utils/db/pg-pool");
const { UPSERT_INCIDENTS_SQL } = require("../utils/db/queries/incidents");
const { ADVANCE_WATERMARK_SQL } = require("../utils/db/queries/materialize");
// Phase 4: the restore must re-assess, or this test leaves every incident with a
// NULL severity. Driving the REAL job (rather than reimplementing it here) is the
// point — a restore that drifts from the shipping assessor would be worse than none.
const assessIncidents = require("../jobs/assess");

const AGG_KEY = "incidents.error_events";
const EPOCH = new Date(0);

// A run_log the logger primitives accept but that goes nowhere: startTimer/
// endTimer no-op without `timers`, and addLogEvent only needs `run_id` +
// `log_events`. Nothing is flushed (no writeLogEvents/dbInsertLogEvents call), so
// this test still writes no log file and no self-log row.
const silentRunLog = () => ({ run_id: null, log_events: [], timers: new Map() });

const snapshotReps = () =>
  db.any(
    "SELECT fingerprint, entity, sample_run_id, sample_message FROM incidents.incidents ORDER BY fingerprint, entity"
  );

async function main() {
  let failures = 0;
  const check = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
    if (!cond) failures++;
  };
  try {
    const { lo, hi } = await db.one(
      "SELECT min(inserted_at) AS lo, max(inserted_at) AS hi FROM incidents.error_events"
    );
    const mid = new Date((new Date(lo).getTime() + new Date(hi).getTime()) / 2);

    // 1) full rebuild: one window covering everything.
    await db.none("TRUNCATE incidents.incidents");
    await db.any(UPSERT_INCIDENTS_SQL, [EPOCH, hi]);
    const rebuild = await snapshotReps();

    // 2) incremental: two windows split at mid (equal-ts events can now land in
    //    different batches — the exact case the fix must make order-independent).
    await db.none("TRUNCATE incidents.incidents");
    await db.any(UPSERT_INCIDENTS_SQL, [EPOCH, mid]);
    await db.any(UPSERT_INCIDENTS_SQL, [mid, hi]);
    const incr = await snapshotReps();

    check(rebuild.length === incr.length, `same incident count (${rebuild.length} vs ${incr.length})`);
    let mismatches = 0;
    const key = (r) => `${r.fingerprint}|${r.entity}`;
    const incrByKey = new Map(incr.map((r) => [key(r), r]));
    for (const r of rebuild) {
      const o = incrByKey.get(key(r));
      if (!o || o.sample_run_id !== r.sample_run_id || o.sample_message !== r.sample_message) {
        mismatches++;
        if (mismatches <= 5) {
          console.log(`  DIFF ${key(r)}: rebuild run=${r.sample_run_id} msg=${JSON.stringify(r.sample_message)} | incr run=${o?.sample_run_id} msg=${JSON.stringify(o?.sample_message)}`);
        }
      }
    }
    check(mismatches === 0, `representatives identical across rebuild vs incremental (${mismatches} mismatches)`);
  } finally {
    // restore: full aggregation + watermark to a fresh snapshot, THEN re-assess.
    await db.none("TRUNCATE incidents.incidents");
    const { s } = await db.one("SELECT clock_timestamp() AS s");
    await db.any(UPSERT_INCIDENTS_SQL, [EPOCH, s]);
    await db.none(
      "INSERT INTO incidents.pipeline_state (source_key, last_inserted_at) VALUES ($1, to_timestamp(0)) ON CONFLICT (source_key) DO NOTHING",
      [AGG_KEY]
    );
    await db.one("UPDATE incidents.pipeline_state SET last_inserted_at=to_timestamp(0) WHERE source_key=$1 RETURNING source_key", [AGG_KEY]);
    await db.one(ADVANCE_WATERMARK_SQL, [AGG_KEY, s]);
    // Phase 4: the aggregate restores everything it DERIVES, but the assessment
    // columns are the assessor's output and would otherwise stay NULL until the
    // next cron `run`. Re-assessing here makes the test's restore complete again,
    // as it was in Phase 3. Safe to call unconditionally: assess is a pure
    // function of the dossier, so this reproduces the exact prior state.
    await assessIncidents(silentRunLog());
    await db.$pool.end();
  }
  console.log(failures === 0 ? "\nREP DETERMINISM: PASS" : `\nREP DETERMINISM: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
