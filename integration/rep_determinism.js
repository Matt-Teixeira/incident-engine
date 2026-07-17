// integration/rep_determinism.js — LIVE integration test (Phase 3 review, low
// finding): the chosen representative must be IDENTICAL whether the incidents
// are built in one full-rebuild batch or incrementally across several windows.
// Run in the app container:
//   docker compose run --rm app node integration/rep_determinism.js
//
// NON-DESTRUCTIVE SINCE PHASE 5 — the whole comparison runs inside ONE
// transaction that is ALWAYS ROLLED BACK.
//
// History of why (the design is the point, don't "simplify" it back):
//   * Phase 3: the test TRUNCATEd incidents.incidents and restored by
//     re-aggregating — complete, because aggregation was everything the table
//     held.
//   * Phase 4: the assessment columns are the assessor's output, not the
//     aggregate's, so the restore had to re-assess too. Still possible only
//     because assessment is a PURE function of L0-derived facts. Running the
//     bare Phase 3 version silently blanked every severity — caught by
//     assess_parity, recorded as a landmine.
//   * Phase 5: lifecycle state (state / resolved_at / resolved_reason /
//     resolved_last_seen) is HISTORY-DEPENDENT — resolved_at is the moment a
//     transition fired, not derivable from L0 + the oracle after the fact. No
//     re-derivation restore can exist. So the TRUNCATE-and-restore design is
//     retired: everything now happens inside db.tx and a sentinel throw forces
//     ROLLBACK, so the table (state included) is untouched by construction, and
//     a crash mid-test rolls back automatically instead of leaving a wiped
//     table. This was a precondition of Phase 5 (PHASE_LOG Phase 4 §Follow-Up;
//     prompt_5 "rework required BEFORE the state step ships").
//
// Concurrency note: TRUNCATE inside the transaction holds ACCESS EXCLUSIVE on
// incidents.incidents until the rollback, so a cron `assess` firing mid-test
// (:25/:55) blocks for the test's duration (seconds) rather than interleaving.
// That is the safe direction — waiting, not data loss.
"use strict";

const db = require("../utils/db/pg-pool");
const { UPSERT_INCIDENTS_SQL } = require("../utils/db/queries/incidents");

const EPOCH = new Date(0);

// Thrown after the comparison to force the rollback; never surfaces.
const ROLLBACK_SENTINEL = "REP_DETERMINISM_ROLLBACK";

async function main() {
  let failures = 0;
  const lines = [];
  const check = (cond, msg) => {
    lines.push(`${cond ? "PASS" : "FAIL"}: ${msg}`);
    if (!cond) failures++;
  };

  try {
    await db.tx("rep-determinism", async (t) => {
      const snapshotReps = () =>
        t.any(
          "SELECT fingerprint, entity, sample_run_id, sample_message FROM incidents.incidents ORDER BY fingerprint, entity"
        );

      const { lo, hi } = await t.one(
        "SELECT min(inserted_at) AS lo, max(inserted_at) AS hi FROM incidents.error_events"
      );
      const mid = new Date((new Date(lo).getTime() + new Date(hi).getTime()) / 2);

      // 1) full rebuild: one window covering everything.
      await t.none("TRUNCATE incidents.incidents");
      await t.any(UPSERT_INCIDENTS_SQL, [EPOCH, hi]);
      const rebuild = await snapshotReps();

      // 2) incremental: two windows split at mid (equal-ts events can land in
      //    different batches — the exact case the Phase 3 fix must make
      //    order-independent).
      await t.none("TRUNCATE incidents.incidents");
      await t.any(UPSERT_INCIDENTS_SQL, [EPOCH, mid]);
      await t.any(UPSERT_INCIDENTS_SQL, [mid, hi]);
      const incr = await snapshotReps();

      check(
        rebuild.length === incr.length,
        `same incident count (${rebuild.length} vs ${incr.length})`
      );
      let mismatches = 0;
      const key = (r) => `${r.fingerprint}|${r.entity}`;
      const incrByKey = new Map(incr.map((r) => [key(r), r]));
      for (const r of rebuild) {
        const o = incrByKey.get(key(r));
        if (!o || o.sample_run_id !== r.sample_run_id || o.sample_message !== r.sample_message) {
          mismatches++;
          if (mismatches <= 5) {
            lines.push(
              `  DIFF ${key(r)}: rebuild run=${r.sample_run_id} msg=${JSON.stringify(r.sample_message)} | incr run=${o?.sample_run_id} msg=${JSON.stringify(o?.sample_message)}`
            );
          }
        }
      }
      check(
        mismatches === 0,
        `representatives identical across rebuild vs incremental (${mismatches} mismatches)`
      );

      // ALWAYS roll back — the comparison's writes must never commit.
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (e) {
    if (e.message !== ROLLBACK_SENTINEL) throw e;
  }

  // Prove the rollback actually restored the table: severities and states must
  // be exactly as populous as before (the rebuild inside the tx writes neither).
  const { n, unassessed } = await db.one(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE severity IS NULL)::int AS unassessed
     FROM incidents.incidents`
  );
  check(unassessed === 0, `rollback restored the table (${n} incidents, ${unassessed} unassessed)`);

  await db.$pool.end();
  for (const l of lines) console.log(l);
  console.log(failures === 0 ? "\nREP DETERMINISM: PASS" : `\nREP DETERMINISM: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await db.$pool.end();
  } catch {}
  process.exit(1);
});
