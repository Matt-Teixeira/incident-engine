// jobs/assess — L3: assess every incident deterministically and write back
// severity / confidence / assessment, stamped with the assessor's provenance.
// Runs AFTER the Phase 3 aggregate inside `node index.js assess` (see index.js).
//
// THE PURITY BOUNDARY (Determinism Rule) — this file is the whole point of it:
// everything that touches the database lives HERE, and `assess(dossier)` in
// domain/assessor/ receives nothing but a plain object. The dossier is assembled
// from a SELECT, handed over, and the result written back. The assessor has no
// DB handle, no clock, and no env read inside it, so it is unit-testable by
// construction and an LLM implementation can replace it behind the same async
// signature without this file changing at all.
//
// WHAT THIS STEP MUST NOT DO: set `state` or auto-close an incident. That stays
// deterministic and lands in Phase 5. The write is confined to the assessment
// columns by the incidents_assessment ColumnSet, which has no `state` column to
// write (utils/db/sql/pg-helpers.js).
//
// IDEMPOTENCY: this step needs no watermark. `assess` is a pure function of the
// dossier, so re-running over unchanged incidents recomputes identical results
// and writes nothing (the no-op filter below). Re-runnability is a property of
// the function, not of bookkeeping — which is why there is no pipeline_state row
// for it and nothing to rewind.
"use strict";

const db = require("../../utils/db/pg-pool");
// pgp comes from pg-helpers so update formatting uses the same root that built
// the ColumnSets (per-root options would otherwise silently diverge).
const { pgp, pg_column_sets } = require("../../utils/db/sql/pg-helpers");
const { SELECT_DOSSIERS_SQL, UPDATE_ASSESSMENT_WHERE } = require("../../utils/db/queries/assess");
const { getAssessor } = require("../../domain/assessor");
const [addLogEvent, , , , , startTimer, endTimer] = require("../../utils/logger/log");
const {
  type: { W },
  tag: { det },
} = require("../../utils/logger/enums");

// Rows per UPDATE statement. Mirrors materialize's chunking so one oversized
// batch cannot build a multi-megabyte VALUES list.
const BATCH_ROWS = 1000;

/**
 * Build the plain dossier object handed to `assess`. Explicitly constructed
 * field-by-field rather than passing the DB row through: the row carries `id`
 * and the current assessment, and the assessor must not see them — it would let
 * a future rule accidentally depend on its own previous output (a feedback loop
 * that would make results order-dependent instead of pure).
 *
 * @param {Object} row a SELECT_DOSSIERS_SQL row
 * @returns {import('../../domain/assessor/contract').Dossier}
 */
const toDossier = (row) => ({
  category: row.category,
  // provenance travels WITH the category: the assessor cannot judge whether a
  // category is evidence without knowing where it came from (review, HIGH).
  category_source: row.category_source,
  type: row.type,
  entity_count: row.entity_count,
  occurrence_count: row.occurrence_count,
  entity: row.entity,
  func: row.func,
  first_seen: row.first_seen,
  last_seen: row.last_seen,
  sample_message: row.sample_message,
});

/**
 * The `assessment` JSONB payload: the assessor's rationale, and ONLY that.
 * severity/confidence are first-class columns (indexed, queryable), so they are
 * not duplicated in here.
 */
const assessmentOf = (res) => ({
  reasons: res.reasons,
  ...(res.recommendedAction ? { recommendedAction: res.recommendedAction } : {}),
});

/**
 * Has the assessment actually changed? Guards against rewriting all ~500 rows
 * (and bumping updated_at) on every cron run when nothing moved.
 *
 * `assessment` is compared as canonical JSON. That is sound because both sides
 * are built by us with a fixed key order: the stored value came from this same
 * serialization, and `reasons` is an ORDERED array whose order is deterministic
 * per branch. It is not a general-purpose deep-equal and does not need to be.
 */
const unchanged = (row, res, kind, version) =>
  row.severity === res.severity &&
  row.confidence === res.confidence &&
  row.assessor_kind === kind &&
  row.assessor_version === version &&
  JSON.stringify(row.assessment) === JSON.stringify(assessmentOf(res));

const assessIncidents = async (run_log) => {
  startTimer(run_log, "assess");

  // Resolve the implementation ONCE per run, outside the row loop: every row in
  // a run must be stamped with the same kind/version, and a mid-run env change
  // producing a half-'rules'/half-something-else table would be indefensible.
  // Throws on an unknown ASSESSOR_KIND — fail the run rather than assess the
  // whole table with a silently-defaulted implementation.
  const { kind, version, assess } = getAssessor();

  const summary = await db.tx("assess", async (t) => {
    // NOT locked against the aggregate, deliberately. A concurrent aggregate
    // could insert a new incident between this SELECT and the UPDATE, making a
    // fingerprint's entity_count momentarily stale here. That is self-correcting:
    // the next run assesses every incident again and converges. Taking the
    // materialize/aggregate watermark lock would couple a pure recompute to the
    // ingest path for no correctness gain — unlike the aggregate's additive
    // counter, nothing here is order-dependent or double-countable.
    const rows = await t.any(SELECT_DOSSIERS_SQL);

    // Impossible at rest since round 2 (category_source is NOT NULL + CHECK),
    // so any non-zero count here means the constraint is missing on this
    // database — surface it as its own WARN, not just a low-confidence blur.
    const invalid_provenance = rows.filter(
      (r) => r.category_source !== "classifier" && r.category_source !== "oracle"
    ).length;

    const updates = [];
    const severity_counts = {};
    const unresolved = [];

    for (const row of rows) {
      const res = await assess(toDossier(row));

      severity_counts[res.severity] = (severity_counts[res.severity] || 0) + 1;

      // A low-confidence result means the rules had no real evidence — the
      // documented defaults (R3/R8) and 'unknown'. Surfaced in the run summary so
      // a taxonomy gap shows up in the logs instead of hiding behind a severity.
      if (res.confidence <= 0.2) unresolved.push(res.category);

      if (unchanged(row, res, kind, version)) continue;

      updates.push({
        id: row.id,
        severity: res.severity,
        confidence: res.confidence,
        assessor_kind: kind,
        assessor_version: version,
        assessment: assessmentOf(res),
        // raw SQL by design (mod '^' in the ColumnSet) — evaluated per row by
        // Postgres, never by this process's clock. A JS `new Date()` here would
        // smuggle the app's clock into a DB timestamp.
        updated_at: "clock_timestamp()",
      });
    }

    let written = 0;
    for (let i = 0; i < updates.length; i += BATCH_ROWS) {
      const chunk = updates.slice(i, i + BATCH_ROWS);
      const query =
        pgp.helpers.update(chunk, pg_column_sets.incidents.incidents_assessment) +
        UPDATE_ASSESSMENT_WHERE;
      const result = await t.result(query);
      written += result.rowCount;
    }

    return {
      assessor_kind: kind,
      assessor_version: version,
      incidents_assessed: rows.length,
      incidents_written: written,
      incidents_unchanged: rows.length - updates.length,
      invalid_provenance,
      severity_counts,
      unresolved_categories: [...new Set(unresolved)],
    };
  });

  if (summary.invalid_provenance > 0) {
    await addLogEvent(
      W,
      run_log,
      "assess",
      det,
      {
        txt: "incidents with missing/invalid category_source — the DB CHECK constraint is missing on this database (re-apply db/schema.sql)",
        count: summary.invalid_provenance,
      },
      null
    );
  }

  if (summary.unresolved_categories.length > 0) {
    await addLogEvent(
      W,
      run_log,
      "assess",
      det,
      {
        txt: "categories assessed with no confident rule (taxonomy gap)",
        categories: summary.unresolved_categories,
      },
      null
    );
  }

  await endTimer(run_log, "assess", summary);
};

module.exports = assessIncidents;
