// domain/assessor/contract.js — the assessor SEAM's contract: the dossier input,
// the AssessResult output, and the severity vocabulary. Types only (JSDoc) plus
// frozen enums; no logic, no I/O.
//
// WHY A CONTRACT MODULE: `assess(dossier)` is a pluggable interface
// (Determinism Rule). The rules implementation is the only one today; a future
// LLM implementation is an ADVISORY implementation of this SAME signature,
// selected by ASSESSOR_KIND. Pinning the shape here — rather than letting it be
// whatever rules.js happens to return — is what makes that swap a config change
// instead of a pipeline rework.
//
// PURITY (Determinism Rule, non-negotiable): an implementation of `assess` is a
// pure function of the dossier. No DB handle, no clock, no network, no
// process.env read INSIDE it. Same dossier in → same result out, forever. The
// dossier is assembled by the JOB (jobs/assess) and passed in; that is the only
// way facts enter the assessor.
"use strict";

/**
 * The severity vocabulary written to `incidents.incidents.severity` (VARCHAR(16)).
 *
 * Ordered most→least urgent. `critical` is DECLARED but no Phase 4 rule emits it:
 * nothing in the taxonomy distinguishes a fleet-wide transport stall (the worst
 * thing this data actually contains) from a hypothetical worse thing, and
 * inventing a critical tier the rules never reach would be decoration. It is
 * reserved for a rule with a real signal behind it (e.g. Phase 5 lifecycle, or a
 * data-loss category).
 *
 * @readonly
 * @enum {string}
 */
const SEVERITY = Object.freeze({
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info",
});

/** Every legal severity value, for validation and test enumeration. */
const SEVERITIES = Object.freeze(Object.values(SEVERITY));

/**
 * The producer's own WARN/ERROR label, carried on `incidents.incidents.type`
 * (added in Phase 4; lossless because `type` is inside the fingerprint).
 *
 * IT DOES NOT MEAN THE OPERATION SUCCEEDED. Producers log real failures as WARN:
 * data_acquisition's exec-hhm_data_grab.js logs a connection error as WARN and
 * then returns false, and "JOB HALTED" is a WARN emitted when the rsync produced
 * nothing. An earlier cut of the rules capped severity on WARN by asserting the
 * opposite; that was a Phase 4 review finding (MEDIUM), and round 2's M2 decision
 * removed the last severity split (`unknown`). WARN now costs confidence, never
 * severity — anywhere. The genuine recovery signal is
 * stats.acquisition_history.successful_acquisition — Phase 5's time-correlated
 * oracle, deliberately not reachable from this pure function.
 *
 * @readonly
 * @enum {string}
 */
const EVENT_TYPE = Object.freeze({ WARN: "WARN", ERROR: "ERROR" });

/**
 * The assessor's input. A plain, serializable object assembled by jobs/assess
 * from `incidents.incidents` (+ a fingerprint-level entity rollup). Deliberately
 * NOT a DB row object: `assess` must not be able to lazily reach back into the
 * database.
 *
 * @typedef {Object} Dossier
 * @property {string} category
 *   The incident's classifier category (`incidents.category`) — one of the 20
 *   `connection_regex.js` categories, or the caller-set `unknown` / `hanging_exec`.
 *   THE RULES KEY OFF THIS, NEVER off `error_type`: `error_type` is '' on 253 of
 *   504 live incidents (every `unknown` plus every oracle-corroborated row), so a
 *   rules table keyed on it silently misfires on half the table. The taxonomy
 *   flags and error_type are looked up BY CATEGORY from `connection_regex.js`
 *   instead (see rules.js), which keeps that file the single source of truth.
 * @property {string} category_source
 *   `'classifier'` | `'oracle'` — WHERE `category` came from, and the reason the
 *   assessor can trust it at all (Phase 4 review, HIGH finding). `'classifier'`
 *   means this incident's own events matched a pattern. `'oracle'` means they did
 *   NOT: Phase 3 filled the `unknown` with the latest non-unknown category seen
 *   for the same `system_id`, with no run or time correlation — a fact about the
 *   equipment's recent past, not about this problem. The rules assess anything
 *   that is not explicitly `'classifier'` as `unknown`; a category alone is not
 *   evidence, and storing only the category is what let "No new monitoring data
 *   found." be rated a fleet-wide `rsync_io_timeout`.
 * @property {string} type
 *   `WARN` | `ERROR` — the producing app's own label. Anything else (null, '')
 *   is treated as ERROR by the rules: fail-safe, never silently downgrade.
 * @property {number} entity_count
 *   Distinct entities sharing this incident's FINGERPRINT — the real blast
 *   radius, and the reason this field exists. The incident's own `apps[]` /
 *   `systems[]` are structurally ≤1 (src_app_name is inside the fingerprint, and
 *   the entity IS the system), so blast radius is only visible one level up, as
 *   a rollup the job computes. Live range: 1..59.
 * @property {number} occurrence_count
 *   Events rolled into this incident. Present for the contract and for a future
 *   LLM implementation; the rules DELIBERATELY DO NOT key severity off it — see
 *   the OCCURRENCE_COUNT note in rules.js for the live evidence that it measures
 *   retry chattiness, not impact.
 * @property {string} entity        The affected equipment (sme / system_id / '__global__').
 * @property {string} func          The emitting function — provenance for a human.
 * @property {(Date|string|null)} first_seen  Provenance only; rules must not derive age (that needs a clock).
 * @property {(Date|string|null)} last_seen   Provenance only; same.
 * @property {string} sample_message  A representative human-readable message.
 */

/**
 * The assessor's output. Written to `incidents.incidents`:
 * `severity`, `confidence`, and `assessment` JSONB (`{reasons, recommendedAction}`).
 * `assessor_kind` / `assessor_version` are stamped by the seam, not by the impl.
 *
 * NOTE: an AssessResult carries NO `state` and NO `resolved_*`. The assessor must
 * never set incident state or auto-close — that stays deterministic in Phase 5
 * (Determinism Rule). The shape enforces it: there is nowhere to put them.
 *
 * @typedef {Object} AssessResult
 * @property {string} severity   One of SEVERITIES.
 * @property {string} category   Echoed back (the category the rules actually resolved).
 * @property {number} confidence 0..1, rounded to 2dp — `confidence` is NUMERIC(3,2).
 * @property {string[]} reasons  Why this severity. Never empty: every branch pushes at least one.
 * @property {string} [recommendedAction] What a human should do. Maps from category.
 */

module.exports = { SEVERITY, SEVERITIES, EVENT_TYPE };
