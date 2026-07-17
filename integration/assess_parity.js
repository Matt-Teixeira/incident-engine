// integration/assess_parity.js — LIVE DB test (not discovered by `node --test`;
// run it in the app container: docker compose run --rm app node integration/assess_parity.js).
//
// WHAT IT PROVES, AND WHY IT EXISTS:
// The unit suite tests `assess(dossier)` in isolation and passes whether or not
// the job ever persists what it computes. Everything BETWEEN the pure function
// and the stored row is invisible to it — the dossier SELECT, the type /
// entity_count / provenance assembly, the ColumnSet casts, the UPDATE's row
// matching, JSONB round-tripping, NUMERIC(3,2) truncation of confidence. Phase 3
// shipped three defects in exactly that gap, and Phase 4's first live run died on
// a 42601 in the UPDATE with a green 93/93 suite.
//
// So this asserts the end-to-end identity the whole phase rests on:
//
//     for EVERY incident: stored (severity, confidence, assessment)
//                          == assess(dossier rebuilt INDEPENDENTLY of the job)
//
// ============================================================================
// THE INDEPENDENCE RULE — the point of this file, do not break it
// ============================================================================
// This test MUST NOT import the production dossier SQL. The first cut did, and
// the Phase 4 review (MEDIUM finding) showed exactly why that was worthless: a
// wrong `category`, `type`, or blast-radius expression is reproduced identically
// by both sides, so the comparison is a tautology. It reported PASS across 504
// incidents while 40 of them carried an unrelated oracle category and were being
// assessed as fleet-wide transport faults — the review's HIGH finding, which this
// test had every opportunity to catch and structurally could not.
//
// So the SQL below is written INDEPENDENTLY, and derives from the deepest facts
// available rather than from the columns the job read:
//   * entity_count      — a correlated subquery counting DISTINCT entity, not the
//                         job's `blast` CTE.
//   * type              — read back from incidents.error_events (L0), not from the
//                         denormalized incidents.type the job trusts.
//   * category_source   — cross-checked against L0: a 'classifier' category MUST
//                         appear in the incident's own events; an 'oracle' one must
//                         NOT. This is the invariant the HIGH finding violated.
// If you find yourself importing something from utils/db/queries/assess.js here,
// stop: that is the bug this file exists to detect.
//
// READ-ONLY: this test writes nothing. Run `node index.js assess` first.
"use strict";

const db = require("../utils/db/pg-pool");
const { getAssessor } = require("../domain/assessor");

// Independently-written. Deliberately NOT SELECT_DOSSIERS_SQL — see above.
const EXPECTED_SQL = `
SELECT
  i.id,
  i.fingerprint,
  i.entity,
  i.category,
  i.category_source,
  i.type,
  i.occurrence_count::float8 AS occurrence_count,
  i.func,
  i.first_seen,
  i.last_seen,
  i.sample_message,
  -- stored assessment, the thing under test
  i.severity,
  i.confidence::float8 AS confidence,
  i.assessor_kind,
  i.assessor_version,
  i.assessment,
  -- INDEPENDENT blast radius: a correlated DISTINCT count, not the job's CTE.
  (SELECT count(DISTINCT x.entity)
     FROM incidents.incidents x
    WHERE x.fingerprint = i.fingerprint)::int AS expected_entity_count,
  -- INDEPENDENT type: straight from L0. If the denormalization onto incidents
  -- ever drifts (or a fingerprint goes mixed-type), this catches it.
  (SELECT count(DISTINCT e.type)
     FROM incidents.error_events e
    WHERE e.fingerprint = i.fingerprint)::int AS l0_distinct_types,
  (SELECT min(e.type)
     FROM incidents.error_events e
    WHERE e.fingerprint = i.fingerprint) AS l0_type,
  -- lifecycle (Phase 5) — the boundary moved: state is now ENGINE-WRITTEN and
  -- checked against invariants below; only action_* remain never-written.
  i.apps[1] AS src_app,
  i.state,
  i.resolved_at,
  i.resolved_reason,
  i.resolved_last_seen,
  -- INDEPENDENT recovery evidence: for an 'auto_recovery' close, the oracle is
  -- append-only, so the success that justified it must still exist — a success
  -- strictly after the producer-clock memento, AND (round 2) provably
  -- data_acquisition's own: its run must link to a data_acquisition run log.
  -- The OR arm covers honest aging: an evidence row older than the OLDEST run
  -- log cannot be expected to link (retention purged its run) — but a row
  -- YOUNGER than the retention floor with no data_acquisition link is
  -- inadmissible, exactly the foreign-producer case round 2 named.
  EXISTS (SELECT 1
            FROM stats.acquisition_history ah
           WHERE ah.system_id = i.entity
             AND ah.successful_acquisition
             AND COALESCE(ah.capture_datetime, ah.inserted_at) > i.resolved_last_seen
             AND (EXISTS (SELECT 1 FROM util.app_run_logs l
                          WHERE l.run_id = ah.run_id
                            AND l.inserted_at > now() - interval '14 days'
                            AND l.app_name = 'data_acquisition')
                  OR ah.inserted_at < (SELECT min(l2.inserted_at) FROM util.app_run_logs l2))
         ) AS recovery_evidence,
  -- PROVENANCE cross-check against L0: does the stored category actually appear
  -- in this incident's own events? Scoped to (fingerprint, entity) — the
  -- incident's FULL key — not fingerprint alone (review round 2, low): oracle
  -- corroboration is per-entity, so one fingerprint legitimately carries
  -- different categories on different entities (9 such fingerprints live). A
  -- fingerprint-only match would let entity A's classifier events vouch for
  -- entity B's oracle category — validating the wrong incident, which is the
  -- exact confusion this safeguard exists to catch.
  EXISTS (SELECT 1
            FROM incidents.error_events e
           WHERE e.fingerprint = i.fingerprint
             AND e.entity = i.entity
             AND e.error_category = i.category) AS category_in_own_l0
FROM incidents.incidents i`;

// Mirrors jobs/assess's assembly, stated independently on purpose: this test must
// fail if the JOB's assembly drifts, so it cannot import it. It is fed the
// INDEPENDENTLY computed entity_count above, not the job's.
const toDossier = (row) => ({
  category: row.category,
  category_source: row.category_source,
  type: row.type,
  entity_count: row.expected_entity_count,
  occurrence_count: row.occurrence_count,
  entity: row.entity,
  func: row.func,
  first_seen: row.first_seen,
  last_seen: row.last_seen,
  sample_message: row.sample_message,
});

const expectedAssessment = (res) => ({
  reasons: res.reasons,
  ...(res.recommendedAction ? { recommendedAction: res.recommendedAction } : {}),
});

const main = async () => {
  const { kind, version, assess } = getAssessor();
  const rows = await db.any(EXPECTED_SQL);

  const failures = [];
  const severity_counts = {};
  const source_counts = {};

  for (const row of rows) {
    const res = await assess(toDossier(row));
    severity_counts[res.severity] = (severity_counts[res.severity] || 0) + 1;
    source_counts[row.category_source || "(null)"] =
      (source_counts[row.category_source || "(null)"] || 0) + 1;

    // ---- the dossier's own inputs must be sound ----------------------------
    if (row.type === null) failures.push(`id=${row.id}: NULL type (backfill gap)`);
    if (row.l0_distinct_types > 1) {
      failures.push(`id=${row.id}: fingerprint carries ${row.l0_distinct_types} types — the type denormalization is NOT lossless`);
    }
    if (row.l0_type !== null && row.type !== row.l0_type) {
      failures.push(`id=${row.id}: stored type ${row.type} != L0 type ${row.l0_type}`);
    }
    if (row.category_source !== "classifier" && row.category_source !== "oracle") {
      // Impossible at rest since round 2 (NOT NULL + CHECK) — seeing one means
      // the constraint is missing on this database.
      failures.push(
        `id=${row.id}: category_source=${JSON.stringify(row.category_source)} — outside the vocabulary; the DB CHECK constraint is missing`
      );
    }
    // The HIGH finding's invariant, asserted from L0 rather than trusted:
    if (row.category_source === "classifier" && row.category !== "unknown" && !row.category_in_own_l0) {
      failures.push(`id=${row.id}: category '${row.category}' is marked 'classifier' but appears in NONE of its own L0 events`);
    }
    if (row.category_source === "oracle" && row.category_in_own_l0) {
      failures.push(`id=${row.id}: category '${row.category}' is marked 'oracle' but DOES appear in its own L0 events`);
    }
    // An oracle category must never drive severity: the assessor must resolve it
    // as unknown. This is the HIGH finding, pinned.
    if (row.category_source === "oracle" && res.category !== "unknown") {
      failures.push(`id=${row.id}: oracle-sourced category '${row.category}' was assessed as '${res.category}', not unknown`);
    }

    // ---- lifecycle invariants (Phase 5) -----------------------------------
    // TIMING CAVEAT: these hold at JOB-REST (the state step runs last in the
    // assess job). Don't run this test concurrently with a cron tick — the
    // window between an aggregate advancing last_seen and the same job's state
    // step re-evaluating is a legitimate transient.
    const engineStates = ["open", "recurring", "resolved"];
    if (row.state == null) {
      failures.push(`id=${row.id}: state NULL — backlog initialization missed it`);
    } else if (!engineStates.includes(row.state)) {
      // acknowledged/suppressed are legal VOCABULARY but nothing can set them
      // yet — seeing one means something other than the engine wrote state.
      failures.push(`id=${row.id}: state '${row.state}' — not engine-writable, and no human surface exists yet`);
    }
    if (row.state === "open") {
      if (row.resolved_at !== null || row.resolved_reason !== null || row.resolved_last_seen !== null) {
        failures.push(`id=${row.id}: open but carries resolved_* (re-open lands on recurring, never open)`);
      }
    }
    if (row.state === "resolved") {
      if (row.resolved_at === null || row.resolved_reason === null || row.resolved_last_seen === null) {
        failures.push(`id=${row.id}: resolved but resolved_* incomplete`);
      } else {
        if (!["auto_recovery", "stale"].includes(row.resolved_reason)) {
          failures.push(`id=${row.id}: resolved_reason '${row.resolved_reason}' outside the vocabulary`);
        }
        if (new Date(row.last_seen).getTime() > new Date(row.resolved_last_seen).getTime()) {
          failures.push(`id=${row.id}: resolved but last_seen > resolved_last_seen — recurrence not re-opened`);
        }
        if (row.resolved_reason === "auto_recovery" && !row.recovery_evidence) {
          failures.push(`id=${row.id}: auto_recovery close with NO oracle success after the memento`);
        }
        // SCOPE provenance (review round 1, HIGH): the oracle is
        // data_acquisition's self-record — an auto_recovery close on any other
        // producer's incident is founded on inadmissible evidence, whatever
        // the timestamps say. This is the check that would have caught the 30
        // cross-producer closes.
        if (row.resolved_reason === "auto_recovery" && row.src_app !== "data_acquisition") {
          failures.push(
            `id=${row.id}: auto_recovery on a ${row.src_app} incident — out-of-scope oracle evidence (the round-1 HIGH regression)`
          );
        }
        if (
          row.resolved_reason === "stale" &&
          new Date(row.resolved_at).getTime() - new Date(row.resolved_last_seen).getTime() <=
            7 * 24 * 60 * 60 * 1000
        ) {
          failures.push(`id=${row.id}: 'stale' close but resolved_at - resolved_last_seen <= 7 days`);
        }
      }
    }
    if (row.state === "recurring") {
      if (row.resolved_reason === "auto_recovery" && row.src_app !== "data_acquisition") {
        failures.push(
          `id=${row.id}: recurring atop an out-of-scope auto_recovery close — an artificial flap (round-1 HIGH)`
        );
      }
      // recurring means exactly: re-opened after a resolution — its history
      // must exist and the recurrence must postdate the memento.
      if (row.resolved_at === null || row.resolved_last_seen === null) {
        failures.push(`id=${row.id}: recurring without a prior resolution's history`);
      } else if (new Date(row.last_seen).getTime() <= new Date(row.resolved_last_seen).getTime()) {
        failures.push(`id=${row.id}: recurring but last_seen <= resolved_last_seen — nothing recurred`);
      }
    }

    // ---- stored == recomputed ---------------------------------------------
    if (row.severity === null || row.assessment === null) {
      failures.push(`id=${row.id}: never assessed (severity=${row.severity})`);
      continue;
    }
    if (row.severity !== res.severity) {
      failures.push(`id=${row.id} (${row.category}/${row.type}): stored severity ${row.severity} != recomputed ${res.severity}`);
    }
    // confidence is NUMERIC(3,2); if the pure function ever returned >2dp the DB
    // would silently round and this fails.
    if (row.confidence !== res.confidence) {
      failures.push(`id=${row.id}: stored confidence ${row.confidence} != recomputed ${res.confidence}`);
    }
    if (row.assessor_kind !== kind || row.assessor_version !== version) {
      failures.push(`id=${row.id}: stale provenance ${row.assessor_kind}/v${row.assessor_version} != ${kind}/v${version}`);
    }
    if (JSON.stringify(row.assessment) !== JSON.stringify(expectedAssessment(res))) {
      failures.push(`id=${row.id}: stored assessment JSON != recomputed`);
    }
  }

  // The Determinism Rule's boundary, as of Phase 5: `action_*` (reserved L4) is
  // never written by anything; state IS engine-written now, so it is checked
  // against the lifecycle invariants per row below, not against NULL.
  const leaks = await db.one(
    `SELECT count(*)::int AS n FROM incidents.incidents
      WHERE action_state IS NOT NULL OR action_ref IS NOT NULL`
  );
  // Round 2's fail-closed assertion: the moment ANY oracle row belongs to a
  // producer other than data_acquisition, the scope contract needs deliberate
  // review — fail here rather than silently excluding forever.
  const foreign = await db.one(
    `SELECT count(*)::int AS n
       FROM stats.acquisition_history ah
       JOIN util.app_run_logs l
         ON l.run_id = ah.run_id AND l.inserted_at > now() - interval '14 days'
      WHERE ah.inserted_at > now() - interval '14 days'
        AND l.app_name <> 'data_acquisition'`
  );
  if (foreign.n > 0) {
    failures.push(
      `${foreign.n} oracle row(s) from a NON-data_acquisition producer — ORACLE_SCOPED_APPS and the recovery semi-join need deliberate review`
    );
  }
  if (leaks.n > 0) {
    failures.push(`${leaks.n} incident(s) carry action_* — reserved for L4, never written`);
  }

  console.log("assessor:", kind, "v" + version);
  console.log("incidents checked:", rows.length);
  console.log("severity distribution:", JSON.stringify(severity_counts));
  console.log("category provenance:  ", JSON.stringify(source_counts));
  const state_counts = {};
  for (const row of rows) state_counts[row.state ?? "(null)"] = (state_counts[row.state ?? "(null)"] || 0) + 1;
  console.log("state distribution:   ", JSON.stringify(state_counts));
  console.log("action_* leaks:", leaks.n);

  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} mismatch(es):`);
    for (const f of failures.slice(0, 20)) console.error("  -", f);
    if (failures.length > 20) console.error(`  ... and ${failures.length - 20} more`);
    process.exitCode = 1;
  } else {
    console.log(
      "\nPASS — every stored assessment equals assess() over an INDEPENDENTLY rebuilt dossier" +
        " (parity, determinism, provenance vs L0, type vs L0, Phase 5 boundary)."
    );
  }

  await db.$pool.end();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
