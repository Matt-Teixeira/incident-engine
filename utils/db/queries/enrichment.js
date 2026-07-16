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
//   - Only `category` is corroborated. `error_type` is NOT: the oracle carries no
//     type column, and the aggregate has no category→type lookup in SQL, so a
//     corroborated incident keeps error_type = '' (the 'unknown' classify's
//     value) — read as "category known via the oracle, type not looked up".
//     `phase` is likewise left '' (not corroborated).
//     VOCABULARY (verified 2026-07-16): the oracle's error_category values ARE
//     our classifier's vocabulary — stats.acquisition_history is written by
//     data_acquisition using the same connection_regex.js this app copied
//     verbatim, and its 9 distinct live values are a subset of our 20 (+
//     'unknown'). ("19" here and in the Phase 3 record was a miscount of the
//     table, corrected in Phase 4 Step 2 — the classifier holds 20 distinct
//     error_category values. See docs/error-taxonomy.md.)
//     So a corroborated category IS a valid classifier category, and
//     deriving its error_type from the classifier table is POSSIBLE — it is
//     simply not done here. (An earlier comment claimed the vocabularies differ
//     and that derivation was impossible; that was wrong. Populating error_type
//     for corroborated rows is a tracked follow-up — see PHASE_LOG Phase 3.)
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

// PROVENANCE of the category FINAL_CATEGORY_EXPR just chose: 'classifier' (this
// incident's own events matched a pattern) or 'oracle' (they did not, and this is
// the latest unrelated category seen for the same system_id).
//
// WHY THIS EXISTS (Phase 4 review, HIGH finding): the two sources are NOT
// interchangeable, and storing only the category made that invisible. An oracle
// category is TIME- AND RUN-UNCORRELATED — it is "the last non-unknown thing we
// knew about this equipment", not a statement about THIS problem. Live, all 40
// oracle-sourced incidents carry a category that appears NOWHERE in their own L0
// events: "No new monitoring data found." was stamped `rsync_io_timeout`,
// "missing host_ip" likewise, "File not present" became `host_unreachable`. The
// Phase 4 assessor keyed severity on `category` and duly rated them as transport
// faults and credential failures. "Advisory only" was documented here from the
// start; nothing enforced it, so the first consumer consumed it as fact.
//
// This expression is the enforcement point: the assessor reads the provenance and
// refuses to treat an oracle category as evidence (domain/assessor/rules.js).
//
// DERIVED FROM THE JOIN, NOT FROM error_type: the interim detector the review
// suggested (`category <> 'unknown' AND error_type = ''`) is exact today only
// because classify returns error_type '' for exactly the unknown case — and
// populating error_type on corroborated rows is an ALREADY-TRACKED Phase 3
// follow-up. The day someone lands it, that detector silently stops matching and
// the HIGH bug returns with no test failing. Keying on the join that actually
// made the decision cannot rot that way.
const CATEGORY_SOURCE_EXPR = `
    CASE
      WHEN rep.error_category = 'unknown' AND se.enr_category IS NOT NULL
        THEN 'oracle'
      ELSE 'classifier'
    END`;

module.exports = { SYS_ENRICH_CTE, FINAL_CATEGORY_EXPR, CATEGORY_SOURCE_EXPR };
