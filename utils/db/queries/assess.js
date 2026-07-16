// utils/db/queries/assess.js — SQL for the Phase 4 assessment step (L3).
// Parameterized/static only. Reads and writes incidents.incidents ONLY: the
// assessor touches no other table, and stats.acquisition_history is not consulted
// here at all (Phase 3's aggregate already corroborated `category`; the
// time-correlated recovery oracle is Phase 5). Never verbose_log.
"use strict";

// Assemble one dossier row per incident, plus the fingerprint-level blast radius.
//
// WHY THIS SELECTS EVERY INCIDENT — a deliberate deviation from the phase prompt
// ("select incidents touched this run OR with severity IS NULL"), because that
// predicate is SUBTLY WRONG and would ship a permanent staleness bug:
//
//   `entity_count` is a property of the FINGERPRINT, not of the incident row.
//   When a fingerprint gains its 22nd entity, that new incident is the only row
//   "touched" — but the blast radius of its 21 SIBLINGS just crossed
//   BLAST_RADIUS_ENTITIES too, and every one of them should re-assess from
//   medium to high. A touched-only predicate leaves all 21 at medium forever,
//   because nothing will ever touch them again. The severity of a row depends on
//   facts outside that row, so a row-local predicate cannot be correct.
//
// The same applies to a rules-table change: `touched OR severity IS NULL` never
// re-assesses an already-assessed backlog, so a threshold edit would silently
// apply to new incidents only.
//
// So the step assesses ALL incidents every run and writes back only the rows whose
// result actually CHANGED (see jobs/assess/index.js). This is affordable by
// construction rather than by luck: `incidents` is the L2 rollup — one row per
// distinct problem × affected equipment — so it is bounded by the fleet
// (504 rows over 228k L0 events live, 82 fingerprints), NOT by event volume. The
// cost is one seq scan + one grouped count + N pure function calls per cron run,
// and it makes every dependency (blast radius, rules version, corroborated
// category) converge on the next run with no re-assess bookkeeping to get wrong.
// If `incidents` ever grew to a scale where this hurts, the fix is a bounded
// candidate set (touched fingerprints ∪ their siblings ∪ stale assessor_version)
// — not the row-local predicate the prompt proposed.
//
// The existing severity/confidence/assessor_*/assessment are selected so the job
// can skip no-op writes: an unchanged assessment must not bump `updated_at` and
// churn the table on every 30-minute cron run.
const SELECT_DOSSIERS_SQL = `
WITH blast AS (
  -- the REAL blast radius: distinct entities sharing a fingerprint. It is one
  -- level ABOVE the incident row, which is exactly why the incident's own
  -- apps[]/systems[] cannot express it (src_app_name is inside the fingerprint,
  -- and the entity IS the system, so both arrays are structurally <= 1 — live
  -- verified). Counting rows is counting entities: UNIQUE (fingerprint, entity)
  -- makes one row per entity, so no DISTINCT is needed.
  SELECT fingerprint, count(*)::int AS entity_count
  FROM incidents.incidents
  GROUP BY fingerprint
)
SELECT
  i.id,
  i.fingerprint,
  i.entity,
  i.category,
  -- 'classifier' | 'oracle' — WHERE the category came from (Phase 4 review, HIGH
  -- finding). The assessor refuses to treat an oracle category as evidence about
  -- this incident: it is the latest UNRELATED category for the same system_id,
  -- time- and run-uncorrelated. Live, all 40 oracle-sourced incidents carry a
  -- category that appears nowhere in their own L0 events. Written by the
  -- aggregate from the enrichment join (utils/db/queries/enrichment.js).
  i.category_source,
  i.type,
  -- occurrence_count is BIGINT: node-postgres hands BIGINT back as a STRING to
  -- avoid silent precision loss, so it is cast here to a float8 that JS reads as
  -- a real number. Safe: these are event counts (live max ~13k), nowhere near
  -- float8's 2^53 exact-integer range. Without this the dossier would carry
  -- "428" (a string) where the contract promises a number.
  i.occurrence_count::float8 AS occurrence_count,
  b.entity_count,
  i.func,
  i.first_seen,
  i.last_seen,
  i.sample_message,
  -- current assessment, for the no-op-write comparison
  i.severity,
  i.confidence::float8 AS confidence,
  i.assessor_kind,
  i.assessor_version,
  i.assessment
FROM incidents.incidents i
JOIN blast b USING (fingerprint)`;

// Appended to a pgp.helpers.update() built from the incidents_assessment
// ColumnSet (house style: writes go through ColumnSets, never hand-rolled string
// SQL). helpers.update() emits `UPDATE ... AS t SET ... FROM (VALUES ...) AS v`
// and leaves the row-matching predicate to the caller — this is it, and it is
// the ONLY thing that may be appended.
//
// LESSON (Phase 4, caught by running the job — unit tests never load this file):
// `updated_at` was originally appended here as `, updated_at = clock_timestamp()
// WHERE ...`, which put a SET assignment AFTER the FROM clause — a 42601 syntax
// error on every run, with a green 93/93 test suite. Columns to assign belong in
// the ColumnSet (see utils/db/sql/pg-helpers.js); this string may only ever carry
// the row-matching predicate.
const UPDATE_ASSESSMENT_WHERE = ` WHERE v.id = t.id`;

module.exports = { SELECT_DOSSIERS_SQL, UPDATE_ASSESSMENT_WHERE };
