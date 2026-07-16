// utils/db/queries/enrichment.js — the best-effort enrichment against the
// read-only oracle stats.acquisition_history (Phase 3). SELECT-only; the
// aggregate never writes this table (Write-Isolation Rule).
//
// SCOPE (deliberately narrow — Phase 3 Step 2 live findings):
//   - The source run_id does NOT correlate with acquisition_history.run_id:
//     0 of 124,361 error_events rows matched on (system_id, run_id). So the
//     documented run_id join key is unusable; we join on system_id ONLY.
//   - system_id coverage is partial (~111/217 distinct systems), so this is a
//     LEFT join — most entities do not enrich, and that is expected.
//   - incidents has no modality/manufacturer columns, and phase is a per-run
//     fact we cannot correlate without run_id, so Phase 3 enriches NOTHING
//     structurally — it only CORROBORATES `category` when the deterministic
//     classifier returned 'unknown'. classify stays primary; enrichment is
//     advisory and never overwrites a confident category or writes a NULL over
//     a value (Determinism Rule).
//   - Only `category` is corroborated. `error_type` is NOT: the oracle carries
//     no type column, and a corroborated `category` is in the ORACLE's
//     vocabulary (e.g. 'rsync_io_timeout'), which is NOT our classifier's
//     taxonomy, so no reliable category→type map exists. A corroborated incident
//     therefore keeps error_type = '' (the 'unknown' classify's value) — read as
//     "category known via the oracle, type undetermined", NOT a stale/wrong
//     pairing (re-review, low finding). `phase` is likewise left '' (not
//     corroborated). Both stay the deterministic classifier's output.
//
// Richer, time-correlated use of this oracle (the recovery/auto-close signal)
// is Phase 5, not here.
"use strict";

// Most-recent non-'unknown' error_category per system, restricted to the
// systems present in this batch's representative events (`rep`). DISTINCT ON +
// ORDER BY inserted_at DESC = "the latest thing we deterministically knew about
// this equipment's acquisitions". Advisory only.
const SYS_ENRICH_CTE = `
  sys_enrich AS (
    SELECT DISTINCT ON (system_id) system_id, error_category AS enr_category
    FROM stats.acquisition_history
    WHERE error_category IS NOT NULL
      AND error_category <> 'unknown'
      AND system_id IN (SELECT system_id FROM rep WHERE system_id IS NOT NULL)
    ORDER BY system_id, inserted_at DESC
  )`;

// Corroborate ONLY when classify said 'unknown'; otherwise the deterministic
// category stands. COALESCE keeps classify's 'unknown' when the oracle has
// nothing (never writes NULL).
const FINAL_CATEGORY_EXPR = `
    CASE
      WHEN rep.error_category = 'unknown'
        THEN COALESCE(se.enr_category, rep.error_category)
      ELSE rep.error_category
    END`;

module.exports = { SYS_ENRICH_CTE, FINAL_CATEGORY_EXPR };
