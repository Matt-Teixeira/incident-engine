// integration/rep_determinism.js — LIVE integration test (review low
// finding): the chosen representative must be IDENTICAL whether the incidents
// are built in one full-rebuild batch or incrementally across several windows.
// Run in the app container:
//   docker compose run --rm app node integration/rep_determinism.js
//
// It rebuilds incidents.incidents two ways over the SAME L0 data and diffs the
// representatives. It TRUNCATEs incidents.incidents (the app owns it; no live
// consumer yet) and restores a correct full aggregation + watermark at the end.
"use strict";

const db = require("../utils/db/pg-pool");
const { UPSERT_INCIDENTS_SQL } = require("../utils/db/queries/incidents");
const { ADVANCE_WATERMARK_SQL } = require("../utils/db/queries/materialize");

const AGG_KEY = "incidents.error_events";
const EPOCH = new Date(0);

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
    // restore: full aggregation + watermark to a fresh snapshot.
    await db.none("TRUNCATE incidents.incidents");
    const { s } = await db.one("SELECT clock_timestamp() AS s");
    await db.any(UPSERT_INCIDENTS_SQL, [EPOCH, s]);
    await db.none(
      "INSERT INTO incidents.pipeline_state (source_key, last_inserted_at) VALUES ($1, to_timestamp(0)) ON CONFLICT (source_key) DO NOTHING",
      [AGG_KEY]
    );
    await db.one("UPDATE incidents.pipeline_state SET last_inserted_at=to_timestamp(0) WHERE source_key=$1 RETURNING source_key", [AGG_KEY]);
    await db.one(ADVANCE_WATERMARK_SQL, [AGG_KEY, s]);
    await db.$pool.end();
  }
  console.log(failures === 0 ? "\nREP DETERMINISM: PASS" : `\nREP DETERMINISM: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
