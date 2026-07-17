// jobs/assess/state.js — L5: apply the deterministic lifecycle to every
// incident. Runs AFTER assessment inside `node index.js assess` (see index.js).
//
// THE PURITY BOUNDARY, same shape as the assessment step: everything that
// touches the database or a clock lives HERE. domain/state.js receives plain
// facts (current state, last_seen, the re-open memento, the entity's newest
// successful acquisition, and the batch's evaluation instant) and returns a
// transition or null. It is deliberately SYNCHRONOUS — lifecycle stays
// deterministic forever, and the signature refuses an async (I/O-doing)
// implementation by construction (Determinism Rule).
//
// ONE CLOCK READING PER RUN: eval_time is a single post-connection
// clock_timestamp() snapshot (SNAPSHOT_SQL). Every staleness comparison and
// every resolved_at stamped this run uses THAT value, so the stored
// resolved_at is exactly the instant the stale/recovery decision was evaluated
// against — the parity invariants depend on this equality.
//
// IDEMPOTENCY: no watermark — transitions derive from durable facts
// (state, last_seen, resolved_last_seen, the append-only oracle), so a re-run
// recomputes the same transitions and the no-op contract holds: rows already
// in their computed state produce NO update (nextState returns null), and
// resolved_at is stamped once per transition, never refreshed.
//
// WHAT THIS STEP MUST NOT DO: set `acknowledged` or `suppressed` (reserved for
// a future human action — domain/state.js never returns them and the unit
// suite pins it), write `action_*` (reserved L4), or touch the assessor's
// columns. The two state ColumnSets (utils/db/sql/pg-helpers.js) have no such
// columns to write.
"use strict";

const db = require("../../utils/db/pg-pool");
const { pgp, pg_column_sets } = require("../../utils/db/sql/pg-helpers");
const {
  RECOVERY_SQL,
  ORACLE_PROVENANCE_AUDIT_SQL,
  SELECT_STATE_FACTS_SQL,
  UPDATE_STATE_WHERE,
} = require("../../utils/db/queries/recovery");
const { SNAPSHOT_SQL } = require("../../utils/db/queries/materialize");
const { nextState, STATE, RESOLVED_REASON } = require("../../domain/state");
const [addLogEvent, , , , , startTimer, endTimer] = require("../../utils/logger/log");
const {
  type: { W },
  tag: { det },
} = require("../../utils/logger/enums");

// Rows per UPDATE statement — mirrors the assessment step's chunking.
const BATCH_ROWS = 1000;

const applyState = async (run_log) => {
  startTimer(run_log, "state");

  const summary = await db.tx("state", async (t) => {
    // NOT locked against the aggregate, for the same reason the assessment
    // step isn't: a concurrent aggregate makes last_seen momentarily stale
    // here, which self-corrects next run — nothing is order-dependent or
    // double-countable. The normal `run`/`assess` path is sequential anyway
    // (aggregate → assess → state in one process).
    const { now_snapshot } = await t.one(SNAPSHOT_SQL);
    const recovery = await t.any(RECOVERY_SQL);
    // fail-closed alarm (review round 2): foreign/unlinked oracle rows are
    // already excluded from evidence by the semi-join — this makes them LOUD.
    const provenance_audit = await t.one(ORACLE_PROVENANCE_AUDIT_SQL);
    const lastSuccessByEntity = new Map(recovery.map((r) => [r.entity, r.last_success]));
    const rows = await t.any(SELECT_STATE_FACTS_SQL);

    const stateOnly = [];
    const resolutions = [];
    const transition_counts = { opened: 0, reopened: 0, auto_recovery: 0, stale: 0 };

    for (const row of rows) {
      const res = nextState({
        state: row.state,
        last_seen: row.last_seen,
        resolved_last_seen: row.resolved_last_seen,
        // recovery scope key (review, HIGH): the oracle only speaks for
        // data_acquisition — the gate lives in the pure function.
        src_app: row.src_app,
        last_success: lastSuccessByEntity.get(row.entity) ?? null,
        eval_time: now_snapshot,
      });
      if (!res) continue;

      // the optimistic-guard mementos (review, MEDIUM): the update applies only
      // if the row still holds the facts this decision was computed from.
      const guard = {
        prev_state: row.state,
        prev_last_seen: row.last_seen,
        prev_resolved_last_seen: row.resolved_last_seen,
      };

      if (res.state === STATE.RESOLVED) {
        transition_counts[res.resolved_reason === RESOLVED_REASON.STALE ? "stale" : "auto_recovery"]++;
        resolutions.push({
          id: row.id,
          ...guard,
          state: STATE.RESOLVED,
          resolved_at: now_snapshot,
          resolved_reason: res.resolved_reason,
          // the producer-clock memento the NEXT re-open comparison keys on —
          // captured from the row this transition was computed against.
          resolved_last_seen: row.last_seen,
          updated_at: "clock_timestamp()",
        });
      } else {
        transition_counts[res.state === STATE.RECURRING ? "reopened" : "opened"]++;
        stateOnly.push({ id: row.id, ...guard, state: res.state, updated_at: "clock_timestamp()" });
      }
    }

    let written = 0;
    for (const [chunkSource, columnSet] of [
      [stateOnly, pg_column_sets.incidents.incidents_state_only],
      [resolutions, pg_column_sets.incidents.incidents_resolution],
    ]) {
      for (let i = 0; i < chunkSource.length; i += BATCH_ROWS) {
        const chunk = chunkSource.slice(i, i + BATCH_ROWS);
        const query = pgp.helpers.update(chunk, columnSet) + UPDATE_STATE_WHERE;
        const result = await t.result(query);
        written += result.rowCount;
      }
    }

    // planned - written = rows whose facts changed between our read and the
    // guarded update (review, MEDIUM): skipped this run, re-evaluated next run
    // against their new facts. Self-correcting; surfaced, never silent.
    const planned = stateOnly.length + resolutions.length;
    return {
      eval_time: now_snapshot.toISOString(),
      incidents_evaluated: rows.length,
      incidents_written: written,
      incidents_skipped_concurrent: planned - written,
      incidents_unchanged: rows.length - planned,
      transition_counts,
      oracle_provenance_audit: provenance_audit,
    };
  });

  if (summary.oracle_provenance_audit.foreign_rows > 0 || summary.oracle_provenance_audit.unlinked_rows > 0) {
    await addLogEvent(
      W,
      run_log,
      "state",
      det,
      {
        txt: "oracle provenance anomaly: rows excluded from recovery evidence (foreign = a NEW producer writes the oracle, review ORACLE_SCOPED_APPS; unlinked = a producer is not self-logging)",
        ...summary.oracle_provenance_audit,
      },
      null
    );
  }

  if (summary.incidents_skipped_concurrent > 0) {
    await addLogEvent(
      W,
      run_log,
      "state",
      det,
      {
        txt: "state transitions skipped by the optimistic guard (row changed concurrently; re-evaluated next run)",
        count: summary.incidents_skipped_concurrent,
      },
      null
    );
  }

  await endTimer(run_log, "state", summary);
};

module.exports = applyState;
