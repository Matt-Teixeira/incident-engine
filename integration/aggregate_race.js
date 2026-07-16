// integration/aggregate_race.js — LIVE integration test for the Phase 3
// exactly-once race (review high finding). NOT part of the bare `node --test`
// suite (that runs dependency-free with no DB); run it in the app container:
//
//   docker compose run --rm app node integration/aggregate_race.js
//
// It deterministically reproduces the interleaving Codex described:
//   1. a materialize-like tx STARTS (fixing its transaction_timestamp = T0) but
//      does not yet acquire the shared watermark lock;
//   2. an aggregate acquires the lock, snapshots (Ta > T0), and advances its
//      watermark to Ta;
//   3. the materialize-like tx resumes, acquires the lock, and inserts + commits.
//
// It inserts TWO synthetic rows in step 3: one stamped by the real DEFAULT
// (clock_timestamp(), the fix) and one stamped with transaction_timestamp()
// (what the old DEFAULT NOW() did). After a second aggregate:
//   - the clock_timestamp() row (inserted_at > Ta) MUST be aggregated;
//   - the transaction_timestamp() row (inserted_at = T0 < Ta) MUST be skipped.
// That isolates the timestamp source — not the lock — as what makes the additive
// count exactly-once.
"use strict";

const db = require("../utils/db/pg-pool");
const {
  ENSURE_WATERMARK_SQL,
  LOCK_WATERMARK_SQL,
  SNAPSHOT_SQL,
  ADVANCE_WATERMARK_SQL,
} = require("../utils/db/queries/materialize");
const { UPSERT_INCIDENTS_SQL } = require("../utils/db/queries/incidents");

const AGG_KEY = "incidents.error_events";
const MAT_KEY = "util.app_run_logs";
const ENTITY = "__race_test__";
const RUN_ID = "dead0000-0000-4000-8000-000000000001";
const FP_GOOD = "race_good".padEnd(40, "0");
const FP_BUG = "race_bug".padEnd(40, "0");

// Mirrors the jobs/aggregate core on an explicit connection so we can interleave.
async function runAggregate(conn) {
  await conn.none("BEGIN");
  await conn.none(ENSURE_WATERMARK_SQL, [MAT_KEY]);
  await conn.one(LOCK_WATERMARK_SQL, [MAT_KEY]);
  await conn.none(ENSURE_WATERMARK_SQL, [AGG_KEY]);
  const { last_inserted_at } = await conn.one(LOCK_WATERMARK_SQL, [AGG_KEY]);
  const { now_snapshot } = await conn.one(SNAPSHOT_SQL);
  await conn.any(UPSERT_INCIDENTS_SQL, [last_inserted_at, now_snapshot]);
  await conn.one(ADVANCE_WATERMARK_SQL, [AGG_KEY, now_snapshot]);
  await conn.none("COMMIT");
  return now_snapshot;
}

const eeCols =
  "(run_id, event_ord, src_app_name, type, func, tag, err_msg, sme, job_id, system_id, entity, fingerprint, fp_version, error_category, error_type, phase, dt)";

async function cleanup() {
  await db.none("DELETE FROM incidents.error_events WHERE entity = $1", [ENTITY]);
  await db.none("DELETE FROM incidents.incidents WHERE entity = $1", [ENTITY]);
}

async function main() {
  await cleanup(); // idempotent: clear any leftovers from a prior run
  const connM = await db.connect();
  const connA = await db.connect();
  let failures = 0;
  const check = (cond, msg) => {
    console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
    if (!cond) failures++;
  };

  try {
    // 1) materialize-like tx STARTS (T0 fixed), holds no lock yet. A short
    //    sleep guarantees T0 is clearly before the aggregate snapshot.
    await connM.none("BEGIN");
    // transaction_timestamp() is fixed at tx start; pg_sleep guarantees T0 is
    // clearly before the aggregate snapshot taken next.
    const { t0 } = await connM.one("SELECT transaction_timestamp() AS t0, pg_sleep(0.2)");

    // 2) aggregate acquires the lock first, advances its watermark to Ta.
    const ta = await runAggregate(connA);
    check(new Date(t0) < new Date(ta), `T0 (${t0.toISOString?.() ?? t0}) < Ta (snapshot)`);

    // 3) materialize resumes: acquires the shared lock, inserts, commits.
    await connM.one(LOCK_WATERMARK_SQL, [MAT_KEY]);
    // good row: real DEFAULT clock_timestamp() → inserted_at = now (> Ta)
    await connM.none(
      `INSERT INTO incidents.error_events ${eeCols} VALUES
       ($1, 0, 'race_test', 'WARN', 'raceFunc', 'DETAILS', 'race good', NULL, NULL, NULL, $2, $3, 1, 'unknown', NULL, '', now())`,
      [RUN_ID, ENTITY, FP_GOOD]
    );
    // bug-sim row: inserted_at forced to transaction_timestamp() (= T0 < Ta),
    // exactly what the old DEFAULT NOW() produced. inserted_at added INSIDE the
    // column list (eeCols ends with "dt)").
    const eeColsWithIns = eeCols.replace(/\)$/, ", inserted_at)");
    await connM.none(
      `INSERT INTO incidents.error_events ${eeColsWithIns} VALUES
       ($1, 1, 'race_test', 'WARN', 'raceFunc', 'DETAILS', 'race bug', NULL, NULL, NULL, $2, $3, 1, 'unknown', NULL, '', now(), transaction_timestamp())`,
      [RUN_ID, ENTITY, FP_BUG]
    );
    await connM.none("COMMIT");

    // 4) second aggregate: window (Ta, Ta2].
    await runAggregate(connA);

    // 5) assertions
    const good = await db.oneOrNone(
      "SELECT occurrence_count FROM incidents.incidents WHERE fingerprint=$1 AND entity=$2",
      [FP_GOOD, ENTITY]
    );
    const bug = await db.oneOrNone(
      "SELECT occurrence_count FROM incidents.incidents WHERE fingerprint=$1 AND entity=$2",
      [FP_BUG, ENTITY]
    );
    check(good !== null && Number(good.occurrence_count) === 1,
      "clock_timestamp() row (committed after the aggregate watermark) IS aggregated — the fix");
    check(bug === null,
      "transaction_timestamp() row (old NOW() default, below the watermark) IS skipped — the bug, absent the fix");
  } finally {
    if (connM) { try { await connM.none("ROLLBACK"); } catch (_) {} connM.done(); }
    if (connA) connA.done();
    await cleanup();
    await db.$pool.end();
  }

  console.log(failures === 0 ? "\nRACE TEST: PASS" : `\nRACE TEST: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
