// utils/db/queries/recovery.js — SQL for the Phase 5 state step (L5).
// Parameterized/static only. Reads stats.acquisition_history (the recovery
// oracle) STRICTLY SELECT-only and incidents.incidents; writes nothing itself
// (the job writes through the state ColumnSets). Never verbose_log.
"use strict";

// The recovery oracle: the newest SUCCESSFUL acquisition per system, admitting
// ONLY evidence whose ORIGINATING RUN is provably data_acquisition's.
//
// - Joined to incidents on system_id = entity (the entity IS the system; the
//   original prompt's "resolvable systems[]" was a dead clause — the array is
//   structurally ≤1). '__global__' and oracle-absent entities simply get no
//   row here → no recovery evidence → only staleness can close them.
// - PROVENANCE SEMI-JOIN (review round 2, medium — the residual of round 1's
//   HIGH): the consumer-side gate (ORACLE_SCOPED_APPS) scopes which INCIDENTS
//   may accept oracle evidence, but without this join the evidence pool itself
//   accepted rows from ANY producer — "all 97k rows are data_acquisition's"
//   was measured state, not an enforced contract. If another suite app ever
//   starts writing stats.acquisition_history, its successes must not close
//   data_acquisition incidents: each row is admitted only if its run_id links
//   to a util.app_run_logs run with app_name='data_acquisition'. Fail-closed:
//   a foreign or unlinked row is simply not evidence (and the audit query
//   below makes it LOUD).
// - The 14-day bounds exist for the Data-Contract Rule (every app_run_logs
//   scan must bound inserted_at so partitions prune — EXPLAIN'd: 6 subplans
//   removed, ~8k cost once per run) and are safe by construction: log
//   retention (~7d) is the real admissibility horizon — an older success
//   cannot link ANYWAY, and any incident such a success could have closed
//   (last_seen even older) is closed by the 7-day staleness rule in the same
//   run. The worst case is the resolved_reason label (stale instead of
//   auto_recovery), never a missed close. This supersedes the earlier
//   "deliberately unbounded" design, whose rationale predates provenance
//   verification.
// - COALESCE(capture_datetime, inserted_at): capture_datetime is the
//   acquisition's OWN clock — the same producer-side domain as the event dt
//   feeding last_seen — and has 0 nulls across 97k live rows; the COALESCE
//   covers only its nominal nullability. inserted_at ALONE would be wrong: it
//   lags capture_datetime by a median ~5min but up to 76 DAYS on backfills, so
//   a months-old acquisition inserted today would read as "recovered today"
//   and close an incident on stale evidence.
// - In-flight lag: an oracle row written mid-run links only once the run's
//   self-log commits, so the very newest successes can be inadmissible for
//   minutes (measured: 0 unlinked even in the last hour). Worst case one cron
//   cycle of close delay — the conservative direction.
const RECOVERY_SQL = `
SELECT ah.system_id AS entity,
       max(COALESCE(ah.capture_datetime, ah.inserted_at)) AS last_success
FROM stats.acquisition_history ah
WHERE ah.successful_acquisition
  AND ah.inserted_at > now() - interval '14 days'
  AND EXISTS (SELECT 1 FROM util.app_run_logs l
              WHERE l.run_id = ah.run_id
                AND l.inserted_at > now() - interval '14 days'
                AND l.app_name = 'data_acquisition')
GROUP BY ah.system_id`;

// The fail-closed ALARM half (review round 2): rows the semi-join excludes are
// silently non-evidence, which is safe but quiet — this query makes the two
// anomalous shapes loud so a stale scope list cannot rot unnoticed:
//   foreign_rows   — oracle rows whose run belongs to ANOTHER app: a new
//                    producer has started writing the oracle; ORACLE_SCOPED_APPS
//                    and this join need a deliberate review.
//   unlinked_rows  — rows old enough that their run log MUST exist (past the
//                    in-flight lag) yet young enough that retention cannot have
//                    purged it (1h..2d lagged window): a producer that does not
//                    self-log, or a run_id contract break.
const ORACLE_PROVENANCE_AUDIT_SQL = `
SELECT
  (SELECT count(*)::int
     FROM stats.acquisition_history ah
     JOIN util.app_run_logs l
       ON l.run_id = ah.run_id AND l.inserted_at > now() - interval '14 days'
    WHERE ah.inserted_at > now() - interval '14 days'
      AND l.app_name <> 'data_acquisition') AS foreign_rows,
  (SELECT count(*)::int
     FROM stats.acquisition_history ah
    WHERE ah.inserted_at BETWEEN now() - interval '2 days' AND now() - interval '1 hour'
      AND NOT EXISTS (SELECT 1 FROM util.app_run_logs l
                      WHERE l.run_id = ah.run_id
                        AND l.inserted_at > now() - interval '14 days')) AS unlinked_rows`;

// The state step's per-incident facts. ALL incidents, every run (the Phase 4
// sibling-staleness lesson: transitions derive from durable facts, so a
// touched-only predicate has no correct form) — bounded by the fleet, not
// event volume (~509 rows live). The current state/resolved_* ride along for
// the no-op filter and the transition input.
const SELECT_STATE_FACTS_SQL = `
SELECT id, entity, state, last_seen, resolved_last_seen,
       -- the incident's producer (structurally single-element) — the recovery
       -- SCOPE key (review, HIGH): the oracle is data_acquisition's self-record,
       -- so its successes are only admissible for data_acquisition incidents.
       apps[1] AS src_app
FROM incidents.incidents`;

// Appended to pgp.helpers.update() built from the state ColumnSets — the
// row-matching predicate and ONLY that (the Phase 4 lesson: a SET assignment
// appended here lands after the FROM clause and is a 42601 on every run,
// invisible to node --test).
//
// OPTIMISTIC GUARD (review, MEDIUM): transitions are computed from facts read
// earlier in the transaction; matching on id alone would let a row that
// changed in between be overwritten with a decision made against its old
// facts — e.g. a human sets `suppressed` after our read and the engine
// clobbers it with `resolved`, disproving "suppressed is engine-terminal";
// or a concurrent aggregate advances last_seen and a stale-close fires on
// outdated quietness. The update therefore also matches the state, last_seen,
// and resolved_last_seen THE DECISION WAS BASED ON (IS NOT DISTINCT FROM: NULL
// = NULL must match — the backlog's state is NULL). A mismatched row is simply
// skipped (rowCount shows it) and re-evaluated next run against its new facts
// — convergence over locking, no FOR UPDATE held across JS compute.
const UPDATE_STATE_WHERE =
  ` WHERE v.id = t.id` +
  ` AND t.state IS NOT DISTINCT FROM v."prev_state"` +
  ` AND t.last_seen IS NOT DISTINCT FROM v."prev_last_seen"` +
  ` AND t.resolved_last_seen IS NOT DISTINCT FROM v."prev_resolved_last_seen"`;

module.exports = { RECOVERY_SQL, ORACLE_PROVENANCE_AUDIT_SQL, SELECT_STATE_FACTS_SQL, UPDATE_STATE_WHERE };
