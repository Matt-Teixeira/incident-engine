// jobs/aggregate — L1/L2: roll new incidents.error_events rows up into
// incidents.incidents, one row per (fingerprint, entity), idempotently.
// Wired into `node index.js assess` (the assessor itself is Phase 4).
//
// Idempotency (the correctness core of Phase 3): the window is the STRICT
// half-open (watermark, snapshot] — NO overlap — and occurrence_count is
// additive. Exactly-once needs TWO guarantees TOGETHER (Phase 3 review, high
// finding — the lock alone does not suffice):
//   (a) This tx locks the MATERIALIZE watermark row FOR UPDATE before it
//       snapshots and advances, so no materialize tx can COMMIT between our read
//       and our advance. (A materialize that has not yet reached the lock can
//       still be in flight — see (b); the lock only excludes lock-holders.)
//   (b) error_events.inserted_at (the cursor) is stamped at INSERT time via
//       DEFAULT clock_timestamp(), not transaction-start NOW() — see
//       db/schema.sql. A materialize tx that STARTED before this aggregate but
//       is descheduled before acquiring the lock still stamps its rows AFTER it
//       finally acquires the lock (which is after we released it), so its
//       inserted_at is above our watermark and the rows are caught next window.
// CLOCK ASSUMPTION (Phase 3 re-review, medium): (b) holds only if the database
// clock is NONDECREASING across the lock handoff — clock_timestamp() is a wall
// clock, not a monotonic primitive. If the server clock steps BACKWARD in the
// sub-second window between our advance and a pre-lock materialize's insert, that
// insert could land at inserted_at <= our watermark and be skipped (a silent
// undercount, never a double-count or corruption). The whole pipeline's
// watermark design already assumes a nondecreasing clock (every snapshot). An
// UNCONDITIONAL guarantee would require a monotonic logical cursor (a BIGSERIAL /
// batch sequence stamped post-lock) instead of a timestamp — the known upgrade
// path if clock-step tolerance is ever required (PHASE_LOG Phase 3).
// Together (a)+(b) remove the producer commit-skew that an overlap lookback would
// otherwise be needed for (and which would double-count an additive counter). A
// crash rolls the whole tx back (watermark unadvanced, no partial upsert); the
// next run recounts the window from scratch as its first successful count.
"use strict";

const db = require("../../utils/db/pg-pool");
// The watermark primitives are generic (parameterized by source_key); reuse the
// exact battle-tested SQL that materialize froze in Phase 2 rather than forking
// it — ENSURE (seed missing row), LOCK (FOR UPDATE), SNAPSHOT (post-lock
// clock_timestamp), ADVANCE (GREATEST-guarded, RETURNING the stored value).
const {
  ENSURE_WATERMARK_SQL,
  LOCK_WATERMARK_SQL,
  SNAPSHOT_SQL,
  ADVANCE_WATERMARK_SQL,
} = require("../../utils/db/queries/materialize");
const { UPSERT_INCIDENTS_SQL } = require("../../utils/db/queries/incidents");
const [, , , , , startTimer, endTimer] = require("../../utils/logger/log");

// The watermark this job owns and advances: the L0 stream it consumes.
const SOURCE_KEY = "incidents.error_events";
// The materialize watermark row, locked FOR UPDATE before we snapshot so no
// materialize tx can COMMIT during our read→advance (a pre-lock materialize may
// still be running; its rows are ordered by the post-lock inserted_at stamp —
// see the header). Lock order is safe: a materialize tx locks ONLY this row; the
// aggregate locks this row THEN its own (incidents.error_events) — no process
// takes them in the opposite order, so no deadlock cycle exists.
const MATERIALIZE_SOURCE_KEY = "util.app_run_logs";

const aggregate = async (run_log) => {
  startTimer(run_log, "aggregate");

  const summary = await db.tx("aggregate", async (t) => {
    // 1) Serialize against materialize: block until any lock-HOLDING materialize
    //    commits, so no materialize commits during our read→advance below.
    await t.none(ENSURE_WATERMARK_SQL, [MATERIALIZE_SOURCE_KEY]);
    await t.one(LOCK_WATERMARK_SQL, [MATERIALIZE_SOURCE_KEY]);

    // 2) Our own watermark: ensure + lock (serializes concurrent aggregates).
    await t.none(ENSURE_WATERMARK_SQL, [SOURCE_KEY]);
    const { last_inserted_at } = await t.one(LOCK_WATERMARK_SQL, [SOURCE_KEY]);

    // 3) Fixed upper bound, taken AFTER both locks are held.
    const { now_snapshot } = await t.one(SNAPSHOT_SQL);

    // 4) Aggregate the strict window (watermark, snapshot] and upsert. RETURNING
    //    (xmax = 0) marks freshly-inserted rows so we can report inserted vs
    //    updated without a second scan.
    const upserted = await t.any(UPSERT_INCIDENTS_SQL, [last_inserted_at, now_snapshot]);
    const inserted = upserted.reduce((n, r) => n + (r.inserted ? 1 : 0), 0);

    // 5) Advance our watermark to the snapshot in the SAME transaction.
    const { last_inserted_at: watermark_stored } = await t.one(ADVANCE_WATERMARK_SQL, [
      SOURCE_KEY,
      now_snapshot,
    ]);

    return {
      watermark_before: last_inserted_at.toISOString(),
      snapshot_upper_bound: now_snapshot.toISOString(),
      // the value actually stored (GREATEST may have kept a newer watermark)
      watermark_after: watermark_stored.toISOString(),
      incidents_upserted: upserted.length,
      incidents_inserted: inserted,
      incidents_updated: upserted.length - inserted,
    };
  });

  await endTimer(run_log, "aggregate", summary);
};

module.exports = aggregate;
