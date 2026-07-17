// domain/state.js — the deterministic lifecycle transition function (L5).
// PURE: a function of the facts it is handed. No DB handle, NO CLOCK (the job
// supplies the evaluation time — this function never calls now()/Date.now()),
// no network, no process.env. Same facts → same transition, forever
// (Determinism Rule).
//
// DELIBERATELY SYNCHRONOUS — the inverse of assess()'s deliberate async.
// assess() is async so a future ADVISORY LLM implementation can slot in behind
// the same signature. State is the opposite case: the Determinism Rule says
// lifecycle and auto-close stay deterministic FOREVER — no advisory
// implementation may ever drive them — and a sync signature is that promise
// made structural. If someone tries to bolt an async (I/O-doing) impl in here,
// the signature itself objects.
//
// ============================================================================
// THE TRANSITION TABLE (see notes/phase_5_reevaluation.md for the evidence)
// ============================================================================
//
//   current state       │ condition (evaluated in this order)      │ next
//   ────────────────────┼──────────────────────────────────────────┼──────────
//   suppressed          │ always                                   │ (none) — ENGINE-TERMINAL
//   (unrecognized)      │ always                                   │ (none) — never clobber a value we don't understand
//   resolved            │ last_seen > resolved_last_seen           │ recurring (re-open)
//                       │ resolved_last_seen missing               │ recurring (unverifiable close must not mask — fail visible)
//                       │ otherwise                                │ (none)
//   NULL / open /       │ recovery: last_success > last_seen       │ resolved, 'auto_recovery'
//   recurring /         │ stale: eval_time - last_seen > 7 days    │ resolved, 'stale'
//   acknowledged        │ NULL only: otherwise                     │ open (backlog/new-row init)
//                       │ open/recurring/acknowledged otherwise    │ (none)
//
// Notes on the shape:
// - `recurring` is entered ONLY by re-open. The original prompt's occurrence
//   threshold would have marked ~all 504 incidents recurring instantly
//   (303/504 span the entire L0 history) — a state everything has
//   distinguishes nothing. Re-open is scarce and doubles as the flap signal.
// - Re-open compares last_seen > resolved_last_seen — BOTH producer-clock
//   values. Never against resolved_at (DB clock): a producer whose clock
//   trails the DB could advance last_seen forever without exceeding
//   resolved_at, leaving the incident resolved WHILE FAILING.
// - Recovery before staleness: an incident eligible for both records the
//   stronger reason (positive evidence beats absence of failure).
// - A NULL state that is immediately closeable resolves in ONE evaluation
//   (init-to-open and close are composed, not two cron cycles): the backlog
//   initialization is just defaulting, not a separate transition.
// - `acknowledged` is auto-closeable (ack = "a human saw it", not "keep it
//   open"); the engine never SETS acknowledged or suppressed.
// - Ordinary recurrence while open/recurring changes nothing here — the
//   aggregate already advances occurrence_count/last_seen.
"use strict";

// The lifecycle vocabulary written to incidents.incidents.state (VARCHAR(16)).
const STATE = Object.freeze({
  OPEN: "open",
  ACKNOWLEDGED: "acknowledged",
  RECURRING: "recurring",
  RESOLVED: "resolved",
  SUPPRESSED: "suppressed",
});

// The states the ENGINE may write. acknowledged/suppressed are reserved for a
// future human/dashboard action — asserting engine writes against this list is
// the enforcement, alongside the state ColumnSets in pg-helpers.
const ENGINE_STATES = Object.freeze([STATE.OPEN, STATE.RECURRING, STATE.RESOLVED]);

const RESOLVED_REASON = Object.freeze({
  AUTO_RECOVERY: "auto_recovery",
  STALE: "stale",
});

// No recurrence in this many days ⇒ resolved/'stale'. Justified from live data
// (2026-07-16, re-measured at implementation): the quiet-recency distribution
// runs active 406 / quiet-1-3d 50 / quiet-3-7d 40 / quiet->7d 13 — incidents
// in the 1-3d hump are merely BETWEEN recurrences and must not close, so the
// threshold sits above it, at the source-retention horizon (~7 days). This is
// what lets the ~40% of incidents the recovery oracle cannot see (__global__ +
// oracle-absent entities) ever resolve. Strictly greater-than; DB-vs-producer
// clock skew (minutes) is immaterial at this scale.
const STALE_AFTER_DAYS = 7;
const STALE_AFTER_MS = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

// RECOVERY SCOPE (Phase 5 review, HIGH finding): the oracle records
// data_acquisition's OWN acquisition outcomes and nothing else — proven by
// joining acquisition_history.run_id to util.app_run_logs: every one of the
// five streams (mmb, ip_reset, althea_env, philips, hhm — data_acquisition's
// internal job names) belongs to data_acquisition runs. A successful mmb rsync
// of system X says NOTHING about whether hhm_rpp_ge's separate file-read
// workflow on X recovered — but the first cut closed on it anyway: live, 30
// GE/Philips incidents were auto-closed by unrelated data_acquisition
// successes, and the 4 "natural re-opens" were artifacts of those false
// closes flapping. Recovery evidence is therefore only admissible when the
// incident's OWN producer is one whose outcomes the oracle records. Everything
// else closes by staleness alone until a producer-specific oracle exists.
// Fail-safe: a missing/unknown src_app is NOT scoped — no oracle close on
// unattributable provenance (the R0 direction, again).
const ORACLE_SCOPED_APPS = Object.freeze(["data_acquisition"]);

// Milliseconds since epoch, or null for anything that isn't a real instant.
// Facts arrive from nullable DB columns as Date objects (pg) or ISO strings
// (tests); an invalid input must disable the comparison that needs it rather
// than coerce to NaN (NaN comparisons are silently false — a close/re-open
// decision must never hinge on that accident).
const toMs = (v) => {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Deterministically compute the next lifecycle transition for one incident.
 *
 * @param {Object} facts assembled by the JOB (jobs/assess/state.js) — never by
 *   this function reaching anywhere:
 * @param {(string|null)} facts.state               current incidents.state (NULL on the un-initialized backlog)
 * @param {(Date|string|null)} facts.last_seen      producer-clock: when the problem last occurred
 * @param {(Date|string|null)} facts.resolved_last_seen  producer-clock memento captured at resolve time
 * @param {(string|null)} facts.src_app            the incident's producing app (apps[1] —
 *   structurally single-element). Recovery evidence is admissible ONLY when this app is in
 *   ORACLE_SCOPED_APPS (review, HIGH: the oracle is data_acquisition's self-record; a
 *   cross-producer success proves nothing about this incident's workflow)
 * @param {(Date|string|null)} facts.last_success   producer-clock: the entity's newest successful
 *   acquisition (max COALESCE(capture_datetime, inserted_at) from the oracle); null when the
 *   oracle has never recorded this entity (or it is '__global__')
 * @param {(Date|string)} facts.eval_time           the batch's evaluation instant, supplied by the job
 *   (a post-snapshot DB clock_timestamp() — the ONE clock reading, taken once per run)
 * @returns {({state: string, resolved_reason?: string}|null)} the transition to
 *   apply, or null for no change. For state='resolved' the JOB stamps
 *   resolved_at = eval_time and resolved_last_seen = the incident's last_seen;
 *   for re-open the resolved_* columns are deliberately KEPT (history of the
 *   last resolution — the state field says it is back).
 */
const nextState = (facts) => {
  const f = facts || {};
  const current = f.state == null ? null : f.state;

  // Engine-terminal: a human's statement, never overridden by the engine.
  if (current === STATE.SUPPRESSED) return null;

  // An unrecognized state string is not ours to interpret — leave it alone
  // (conservative: never clobber a value we don't understand; it will surface
  // in the run summary's state counts, not be silently rewritten).
  if (
    current !== null &&
    current !== STATE.OPEN &&
    current !== STATE.ACKNOWLEDGED &&
    current !== STATE.RECURRING &&
    current !== STATE.RESOLVED
  ) {
    return null;
  }

  const lastSeen = toMs(f.last_seen);

  if (current === STATE.RESOLVED) {
    const memento = toMs(f.resolved_last_seen);
    // A resolved row without its memento is a close this engine cannot verify
    // (predates Phase 5, or a foreign write). Fail VISIBLE: re-open rather
    // than let an unverifiable close mask a recurrence forever — the same
    // direction as the assessor's provenance gate.
    if (memento === null) return { state: STATE.RECURRING };
    if (lastSeen !== null && lastSeen > memento) return { state: STATE.RECURRING };
    return null;
  }

  // current ∈ {null, open, acknowledged, recurring} — the closeable states.
  // Recovery first (stronger reason), then staleness. Both need a valid
  // last_seen; without one there is no ordering evidence and no close.
  if (lastSeen !== null) {
    // Recovery: only for producers the oracle actually speaks for (see
    // ORACLE_SCOPED_APPS above). Out-of-scope incidents fall through to
    // staleness — never to a cross-producer close.
    const oracleScoped = ORACLE_SCOPED_APPS.includes(f.src_app);
    const lastSuccess = oracleScoped ? toMs(f.last_success) : null;
    if (lastSuccess !== null && lastSuccess > lastSeen) {
      return { state: STATE.RESOLVED, resolved_reason: RESOLVED_REASON.AUTO_RECOVERY };
    }
    const evalTime = toMs(f.eval_time);
    // A missing/invalid eval_time disables staleness only — never a stale
    // close on an unknowable clock.
    if (evalTime !== null && evalTime - lastSeen > STALE_AFTER_MS) {
      return { state: STATE.RESOLVED, resolved_reason: RESOLVED_REASON.STALE };
    }
  }

  // Initialization is just defaulting: only a NULL state needs a write.
  if (current === null) return { state: STATE.OPEN };
  return null;
};

module.exports = { nextState, STATE, ENGINE_STATES, RESOLVED_REASON, STALE_AFTER_DAYS, ORACLE_SCOPED_APPS };
