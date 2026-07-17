// domain/assessor/rules.js — the deterministic assessor (L3). PURE: a function
// of the dossier alone. No DB handle, no clock, no network, no process.env.
// Same dossier → same result, forever (Determinism Rule).
//
// ============================================================================
// HOW THE RULES ARE KEYED — the two decisions that shape this whole file
// ============================================================================
//
// 1. KEY ON `category`, NEVER ON THE INCIDENT'S STORED `error_type`.
//    `incidents.error_type` is '' on 253 of 504 live incidents (2026-07-16):
//    every `unknown` (classify returns error_type '') plus every oracle-
//    corroborated row (the Phase 3 aggregate corroborates `category` only and
//    does no category→type lookup). A rules table keyed on the stored
//    error_type would silently misfire on HALF the table. So the dossier carries
//    `category`, and this file looks the taxonomy facts (error_type,
//    manual_intervention, successful_acquisition) up BY CATEGORY from
//    connection_regex.js. (PHASE_LOG Phase 3 §Follow-Up flagged ~39 rows; the
//    live count is 253 — the ~39 counted only the corroborated rows and missed
//    that every `unknown` carries '' too.)
//
// 2. DERIVE FROM THE TAXONOMY TABLE, DO NOT HAND-LIST CATEGORIES.
//    Every rule below dispatches on connection_regex.js's own fields
//    (`manual_intervention`, `successful_acquisition`, `error_type`) rather than
//    on a hard-coded list of category slugs. connection_regex.js stays the single
//    source of truth: a new category added there inherits the right severity by
//    construction instead of silently falling to the default. This is why all 20
//    table categories resolve without being named individually.
//
// 3. AN ORACLE-SOURCED CATEGORY IS NOT EVIDENCE (Phase 4 review, HIGH).
//    Phase 3 fills an `unknown` category with the latest non-unknown category
//    seen for the same system_id — time- and run-uncorrelated. It is a fact about
//    the equipment's recent past, not about this problem. R0 gates on
//    `category_source` and assesses such rows as `unknown`. See R0.
//
// ============================================================================
// WHAT `type` (WARN/ERROR) DOES AND DOES NOT MEAN — read before touching it
// ============================================================================
// It is the producing app's own label, and it does NOT mean the operation
// succeeded. An earlier cut of this file capped severity on WARN, asserting "the
// run continued, so the fault was absorbed". That was never checked against the
// producers, and it is FALSE (Phase 4 review, MEDIUM finding). Evidence in
// data_acquisition:
//   * read/exec-hhm_data_grab.js:146 — a connection_error is logged as WARN, then
//     the function `return false`s on BOTH branches; the ip_reset path records
//     successful_acquisition: extracted_stderr.successful_acquisition (false for
//     connection errors). The WARN path IS the failure path — the success path is
//     the one that passes successful_acquisition: true.
//   * jobs/demo_systems/index.js:124 — "JOB HALTED" is logged WARN when
//     fileSizeAfterRsync === null (the rsync produced nothing) and the job returns.
// So repeated FAILED acquisitions can carry WARN indefinitely. WARN therefore
// costs CONFIDENCE, never severity: no branch below caps on it. The real recovery
// signal is stats.acquisition_history.successful_acquisition, which is Phase 5's
// time-correlated oracle — not available to this pure function.
// Since the round-2 M2 decision (unknown → medium for BOTH types), `type` moves
// severity NOWHERE in this file — it appears only in reasons and confidence.
//
// ============================================================================
// COVERAGE: all categories resolve (20 production + 9 engine + 2 caller-set)
// ============================================================================
// R0 provenance gate (rounds 1+2)              → 'oracle': assess as `unknown`, quiet;
//                                                 missing/invalid: medium @0.2, LOUD, never info
// R1 unknown           (caller-set)            → medium @0.3 both types (PERMANENT policy, Phase 6 developer-decided)
// R2 hanging_exec      (caller-set)            → medium (low on WARN? no — see R2)
// R3 not in the taxonomy                       → documented default (medium, low confidence)
// R4 successful_acquisition:true (4 cats)      → data acquired: info, or low if a human is flagged
// R5 manual_intervention:true   (5 cats)       → high (WARN only lowers confidence)
// R6 error_type 'connection'    (10 cats)      → transport: blast-radius split, both types
// R7 error_type 'file'          (1+1 cats)     → medium (WARN only lowers confidence;
//                                                 incl. engine input_file_missing — developer-decided)
// R7b engine types (Phase 6): 'halt' → medium; 'crash' → medium; 'quality' → medium
//                             (round-2 review: verified downstream failure — was low);
//                             'status' → info; 'config'/'credentials' ride R5 via
//                             manual_intervention
// R8 anything else in the table                → same documented default as R3
//
// R4 BEFORE R5 IS A DELIBERATE PRECEDENCE DECISION, not table order.
// `permission_denied_partial` is the ONLY category carrying BOTH
// manual_intervention:true AND successful_acquisition:true, so the two rules
// collide head-on. successful_acquisition:true means THE DATA WAS ACQUIRED —
// the pipeline lost nothing — so it must not page as `high`. But a human is
// still flagged, so it must not be `info` either. It lands at `low` with the
// manual-intervention action attached. Severity answers "how bad is this?"
// (nothing was lost), the action answers "who fixes it?" (a human).
//
// ============================================================================
// OCCURRENCE_COUNT IS DELIBERATELY NOT A SEVERITY INPUT
// ============================================================================
// The phase prompt suggested keying on it. The live data says it measures RETRY
// CHATTINESS, NOT IMPACT, so keying severity off it would rank the noisiest
// retry loop above the widest outage. Evidence (2026-07-16, rsync_io_timeout,
// occurrence_count by blast radius):
//     entity_count=1  → min 5,  avg 147, max 428
//     entity_count=59 → min 1,  avg 214, max 797
// The value 428 recurs at nearly every blast radius — it is the cron cadence
// (events per window), not a measure of how many scanners are down. There is no
// monotone relationship with entity_count, and a "singleton is a one-off blip →
// downgrade" rule would be actively wrong: entity_count=59 incidents include
// occurrence_count=1 rows (one scanner in a 59-scanner fleet outage saw one
// event), so that rule would downgrade a genuine fleet-wide incident. It stays
// in the dossier as provenance and for a future LLM impl; it does not move
// severity here. Revisit only with evidence that it tracks impact.
"use strict";

const { connection_regexes } = require("../../utils/classify/connection_regex");
const { engine_regexes } = require("../../utils/classify/engine_regexes");
const { SEVERITY, EVENT_TYPE } = require("./contract");

// The rules content version, stamped per row as `assessor_version` (mirrors the
// FP_VERSION precedent). BUMP THIS WHENEVER A RULE, THRESHOLD, OR ACTION STRING
// CHANGES: it is the provenance that says which rules produced a stored
// severity. Without it, a severity from a superseded rules table is
// indistinguishable from a current one — `assessor_kind` stays 'rules' either
// way. (jobs/assess re-assesses every incident every run, so this is provenance
// rather than the re-assess trigger — see that file's SCOPE note.)
// v2 (Phase 6): engine classifier layer — new categories with producer-evidence
// severities; interim-M2 reason retired for the permanent residual-unknown
// policy. The bump makes every stored assessment re-stamp exactly once.
const RULES_VERSION = 2;

// Blast-radius escalation threshold: distinct entities sharing one fingerprint.
//
// JUSTIFIED FROM LIVE DATA (2026-07-16), and chosen as a PRINCIPLE rather than
// reverse-engineered to hit a target count: the live fleet is 221 distinct
// entities, so 22 is ">= ~10% of the fleet is affected by one identical
// problem" — fleet-wide, not one flaky scanner. Live entities-per-fingerprint
// runs 1..59 (43 of 82 fingerprints are single-entity; the wide tail is
// 22/27/40/42/42/46/59).
//
// HONEST NOTE ON WHAT THIS COSTS: no threshold yields a small `high` queue,
// because the data genuinely contains a few very wide fingerprints. At 22, ~150
// incident rows land at high — but those are only ~4 DISTINCT fingerprints, i.e.
// ~4 real problems, one row per affected scanner. That is the (fingerprint,
// entity) grain being honest, not the firehose returning: 59 scanners that
// cannot rsync IS 59 high incidents, and any operator view groups by
// fingerprint. Thresholds of 10 and 40 were measured too (183 / 119 high rows);
// the count is dominated by the widest fingerprints at every threshold, so the
// choice was made on the fleet-fraction principle instead of the count.
const BLAST_RADIUS_ENTITIES = 22;

// Caller-set categories — NOT in connection_regexes (docs/error-taxonomy.md):
// classify() returns 'unknown' when no pattern matched, and 'hanging_exec' is
// set by a caller on exec timeout. They have no taxonomy entry, hence no flags.
const UNKNOWN = "unknown";
const HANGING_EXEC = "hanging_exec";

/**
 * category → the taxonomy facts, built ONCE from connection_regex.js at require
 * time. A category can appear on several entries (e.g. `connection_timeout` has
 * four regex shapes); their flags are identical (live-verified: zero categories
 * carry inconsistent error_type / manual_intervention / successful_acquisition
 * across entries), so first-entry-wins is well-defined. Built rather than
 * hand-copied so the taxonomy cannot drift away from the rules.
 *
 * @returns {Object<string, {error_type: string, manual_intervention: boolean, successful_acquisition: boolean}>}
 */
const buildTaxonomy = (entries) => {
  const table = Object.create(null);
  for (const entry of entries) {
    if (table[entry.error_category]) continue;
    table[entry.error_category] = Object.freeze({
      error_type: entry.error_type,
      manual_intervention: entry.manual_intervention === true,
      successful_acquisition: entry.successful_acquisition === true,
    });
  }
  return table;
};

// Production categories FIRST, engine second — on a (never-intended, unit-
// forbidden) slug collision the production entry wins, mirroring the runtime
// layering. Both vocabularies dispatch through the same rules below.
const PRODUCTION_TAXONOMY = Object.freeze(buildTaxonomy(connection_regexes));
const ENGINE_TAXONOMY = Object.freeze(buildTaxonomy(engine_regexes));
const TAXONOMY = Object.freeze(
  Object.assign(Object.create(null), ENGINE_TAXONOMY, PRODUCTION_TAXONOMY)
);

// category → what a human should actually do. Maps from category (per the
// prompt). Keyed by category so a corroborated/typeless row still gets the right
// action. A category with no entry here falls back to a generic action rather
// than emitting `undefined`.
const ACTIONS = Object.freeze({
  // manual-intervention families — retrying cannot clear these
  credentials: "Update the stored credentials for this host, then re-run.",
  host_key_changed:
    "Verify the host's key fingerprint against the real host (reinstall vs. MITM), then update known_hosts.",
  host_key_new:
    "Verify the auto-accepted host key fingerprint against the real host — the container's ssh accepted it silently.",
  key_exchange: "Enable a key-exchange algorithm this host supports, or update the host's SSH config.",
  file_missing: "Confirm the expected file exists on the host and the path pattern still matches.",
  permission_denied_partial:
    "Grant read access to the skipped files on the host — the rest of the pull succeeded.",
  // data-acquired families — informational, no action needed
  file_missing_partial: "No action — data was acquired; some requested files were not present on the host.",
  mirror_file_skipped:
    "No action — data was acquired; some files were skipped, most likely host-side file locks.",
  rsync_partial: "No action — data was acquired; some files/attrs were not transferred.",
  // data-missing, no human flagged
  rsync_source_missing:
    "Check the upstream pull that should have produced this file — the local step found nothing to send.",
  // transport families — retry-eligible
  host_unreachable: "Check the network route to this host (no route — likely down or re-addressed).",
  connection_refused: "Confirm the service is listening on the expected port on this host.",
  connection_timeout: "Check host reachability and link stability — retry-eligible.",
  session_timeout: "Check host stability — it accepted the connection then went silent mid-session.",
  max_retries: "Check host reachability — the pipeline exhausted its retries.",
  connection_reset: "Check link stability — the peer dropped the connection mid-transfer.",
  http2_cancel: "Check the remote HTTP/2 endpoint — the stream did not close cleanly.",
  partial_transfer_timeout: "Check link stability — the remote accepted then stalled mid-stream.",
  rsync_io_timeout: "Check host reachability and link stability — rsync stalled after its handshake.",
  rsync_protocol_error: "Check link stability — the rsync data stream was disrupted mid-transfer.",
  // engine-layer categories (Phase 6) — actions cite the producer evidence
  tunnel_not_found:
    "Add or fix the IPsec tunnel row for this system's IP — auto-reset cannot remediate it until then.",
  config_missing:
    "Fill the missing field (host_ip / credentials_group / acquisition_script) on the system row — no acquisition until fixed.",
  credential_decrypt_error:
    "Re-encrypt or fix the stored credential row — decryption fails, so acquisition cannot authenticate.",
  job_halted: "Investigate why the job produced nothing (the rsync yielded no file).",
  input_file_missing:
    "Check the upstream pull for this system — the expected input file never arrived, so post-processing produced nothing.",
  unhandled_type_error:
    "File a producer bug: an unhandled TypeError in the parser — needs a developer fix, not an operator action.",
  datetime_parse_null:
    "Fix the producer(s): records are stored with a null host_datetime, and a null in the record selected for the alert.offline_hhm_conn upsert breaks it (quoted 'null' rejected by timestamptz) across the Philips/GE/Siemens post-processors — skip/null-handle invalid timestamps or select a VALID one (note CV/eventlog selects the first record, the rest the last); also fix the parser pattern.",
  no_new_data: "No action — nothing new to process; the normal state between acquisitions.",
  counter_reset_reread: "No action — the producer detected the rotation and re-read the whole file.",
  // caller-set
  [UNKNOWN]: "Add an engine_regexes.js pattern (or a producer-evidence verdict) for this message, then re-assess.",
  [HANGING_EXEC]: "Investigate the hung command on this host; confirm the exec timeout is appropriate.",
});

const GENERIC_ACTION = "Investigate this category and add an assessor rule for it.";

// The invalid-provenance branch's remediation (round-3 review, low): the gap is
// in the DATA, not in the rules table, so GENERIC_ACTION ("add an assessor
// rule") would misdirect an operator. The remedy is repairing the row / the
// missing constraint.
const PROVENANCE_REPAIR_ACTION =
  "Repair this incident's category_source and re-apply db/schema.sql (its NOT NULL/CHECK constraint is missing on this database), then re-run assess.";

// confidence is NUMERIC(3,2) in the schema: 0..1 with 2dp. A value with more
// precision would be rounded by the DB, making the stored row differ from what
// the pure function returned — round here so JS and SQL agree exactly.
const round2 = (n) => Math.round(n * 100) / 100;

const result = (severity, category, confidence, reasons, recommendedAction) => {
  const out = {
    severity,
    category,
    confidence: round2(confidence),
    reasons,
  };
  if (recommendedAction) out.recommendedAction = recommendedAction;
  return out;
};

const actionFor = (category) => ACTIONS[category] || GENERIC_ACTION;

/**
 * Deterministically assess one incident.
 *
 * ASYNC FROM DAY ONE (Determinism Rule): the rules need no await, but a future
 * LLM implementation of this same signature does — declaring it async now means
 * that swap is a config change, not a signature change rippling through the job.
 *
 * @param {import('./contract').Dossier} dossier
 * @returns {Promise<import('./contract').AssessResult>}
 */
const assess = async (dossier) => {
  const d = dossier || {};

  // ---- R0: PROVENANCE GATE (Phase 4 review, HIGH finding) ------------------
  // A category sourced from the recovery oracle is NOT evidence about this
  // incident. Phase 3 fills an `unknown` category with "the latest non-unknown
  // error_category seen for this system_id" — with no run or time correlation.
  // It is a fact about the EQUIPMENT'S RECENT PAST, not about this problem.
  //
  // Keying severity on it produced exactly the nonsense you would predict. Live,
  // all 40 oracle-sourced incidents carried a category absent from their own L0
  // events: "No new monitoring data found." → rsync_io_timeout, "missing host_ip"
  // → rsync_io_timeout, "File not present" → host_unreachable, and four
  // "No new file data" incidents rated as `credentials`.
  //
  // The classifier's honest answer for these events is `unknown` — no pattern
  // matched — so that is what they are assessed as. The discarded oracle category
  // is surfaced in the reasons rather than silently dropped: it is a real hint for
  // a human, just not a basis for severity.
  //
  // THE GATE SPLITS THREE WAYS (hardened in review round 2, medium finding).
  // Round 1 treated everything-not-'classifier' as oracle ⇒ unknown. That
  // conflated two very different states and let the second one fail QUIET: a
  // stored credentials/WARN row with a NULL or typo'd provenance would resolve
  // unknown+WARN → info ("no action") — a KNOWN failure buried at the lowest
  // severity by a bookkeeping bug, while the assessment claimed the category
  // "came from the oracle" when the actual cause was a broken writer or a
  // migration gap. Not conservative in severity terms, and a lie in the reasons.
  //
  //   'classifier'      → trust the category (this incident's own events matched)
  //   'oracle'          → KNOWN, DOCUMENTED source that is not evidence about
  //                       this incident ⇒ assess as unknown, quietly, naming the
  //                       discarded category (round 1, HIGH)
  //   anything else     → a WRITER OR MIGRATION GAP, not an assessed fact ⇒
  //                       medium @ 0.2, LOUD, regardless of WARN/ERROR — never
  //                       info, and 0.2 trips the job's taxonomy-gap WARN log
  //
  // The DB makes the third state impossible at rest (category_source is NOT NULL
  // + CHECK-constrained — db/schema.sql, round 2), so this branch is the pure
  // function's own defense for a dossier that arrives broken anyway. The job does
  // NOT fail outright on it: one bad row must not block assessment of the other
  // 500, and the constraint is the hard stop that keeps it from persisting.
  const src = d.category_source;
  const storedCategory = typeof d.category === "string" && d.category !== "" ? d.category : UNKNOWN;
  if (src !== "classifier" && src !== "oracle") {
    return result(
      SEVERITY.MEDIUM,
      UNKNOWN,
      0.2,
      [
        `category provenance is missing or invalid (category_source=${JSON.stringify(src === undefined ? null : src)}) — a writer or migration gap, not an assessed fact`,
        storedCategory !== UNKNOWN
          ? `stored category '${storedCategory}' cannot be attributed to this incident's events or to the oracle, so it is not evidence`
          : "no attributable category",
        "assessed at medium regardless of WARN/ERROR — a bookkeeping gap must never bury a real failure at info",
      ],
      PROVENANCE_REPAIR_ACTION
    );
  }
  const trustedCategory = src === "classifier";
  const category = trustedCategory ? storedCategory : UNKNOWN;
  // Only meaningful when the gate rejected a real category — used for the reason.
  const discardedCategory = !trustedCategory && storedCategory !== UNKNOWN ? storedCategory : null;

  // Anything that is not literally 'WARN' is treated as ERROR. Fail-safe: a
  // missing/garbled type must not let a real failure be scored as absorbed
  // noise. (Live: type is NOT NULL on every incident after the Phase 4
  // backfill, so this is a guard, not a live path.)
  const isWarn = d.type === EVENT_TYPE.WARN;

  // Blast radius floor of 1: an incident always affects at least its own entity.
  const entityCount =
    Number.isFinite(d.entity_count) && d.entity_count >= 1 ? Math.floor(d.entity_count) : 1;

  const blastReason =
    entityCount === 1
      ? "blast radius: 1 entity — this fingerprint affects only this equipment"
      : `blast radius: ${entityCount} entities share this fingerprint`;

  // ---- R1: unknown (caller-set; no taxonomy entry) -------------------------
  // The single biggest bucket, and the rule with the longest decision history —
  // read it before "improving" this branch:
  //   * Step 3 (developer-approved): type-split — WARN → info as "pipeline-status
  //     noise", ERROR → medium. Premise: WARN meant the run continued.
  //   * Review round 1 (F2): that premise is FALSE — producers log real failures
  //     as WARN. The recovery claims were removed from the reasons, but the
  //     info/medium split itself survived as a product decision.
  //   * Review round 2 (M2): held F2 open on exactly that survival — the WARN
  //     bucket contains CONFIRMED hard failures ("JOB HALTED": rsync produced
  //     nothing, job returned, 28k events; "NO TUNNEL FOUND": 13k), and info +
  //     "No action" buries them. Developer decision (2026-07-16): INTERIM MEDIUM
  //     for both types. The durable fix is to CLASSIFY the known hard-failure
  //     messages so they leave `unknown` entirely — a follow-up phase, because
  //     it edits connection_regex.js, which data_acquisition owns
  //     (`error_category` is not in the fingerprint, so FP_VERSION is
  //     unaffected). When that lands, this bucket shrinks and the medium queue
  //     deflates with it.
  // Type therefore no longer moves severity ANYWHERE in this file — for an
  // unrecognized message we have no outcome signal in either direction, so both
  // labels get the same conservative medium at low confidence.
  if (category === UNKNOWN) {
    // Surface a category the provenance gate rejected, so the assessment records
    // WHY this is unknown despite the row carrying a category.
    const provenance = discardedCategory
      ? [
          `stored category '${discardedCategory}' came from the recovery oracle, not from this incident's own events — it is the latest unrelated category for this equipment and is time-uncorrelated, so it is not evidence about this problem`,
        ]
      : [];
    return result(
      SEVERITY.MEDIUM,
      category,
      0.3,
      [
        "unclassified — needs a pattern or a producer-evidence verdict",
        "no classifier pattern matched this message (production mirror and engine layer both missed)",
        ...provenance,
        isWarn
          ? "producer labeled this WARN rather than ERROR — which says nothing about whether the acquisition succeeded"
          : "producer labeled this ERROR",
        "permanent policy (Phase 6, developer-decided): an unrecognized message is conservatively medium, both types, until classified",
      ],
      actionFor(UNKNOWN)
    );
  }

  // ---- R2: hanging_exec (caller-set; no taxonomy entry) --------------------
  // An exec that never returned. Not a live category (0 incidents), but it is
  // part of the documented vocabulary, so it resolves explicitly rather than
  // landing in the default.
  if (category === HANGING_EXEC) {
    // Not capped on WARN either (review, MEDIUM): a command that blew its exec
    // timeout did not complete, whatever the producer labeled it.
    return result(
      SEVERITY.MEDIUM,
      category,
      isWarn ? 0.4 : 0.5,
      [
        "command exceeded its exec timeout — the step never completed",
        isWarn
          ? "producer labeled this WARN rather than ERROR — which says nothing about whether the acquisition succeeded"
          : "producer labeled this ERROR",
      ],
      actionFor(HANGING_EXEC)
    );
  }

  const entry = TAXONOMY[category];

  // ---- R3: category not in the taxonomy ------------------------------------
  // A category the classifier can no longer produce (renamed/removed entry) or a
  // value from outside the vocabulary. Reachable in one real way: an incident
  // whose `category` was oracle-corroborated to a value that later left
  // connection_regex.js. Resolve to medium with LOW confidence and say so —
  // never drop it to info (that would hide it) and never raise it to high (we
  // have no evidence).
  if (!entry) {
    return result(
      SEVERITY.MEDIUM,
      category,
      0.2,
      [
        `category '${category}' has no entry in the classifier taxonomy — no rule applies`,
        "defaulted to medium pending a rule; severity is not evidence-based here",
      ],
      GENERIC_ACTION
    );
  }

  // ---- R4: data WAS acquired (successful_acquisition) ----------------------
  // Runs BEFORE the manual-intervention rule — see the precedence note in the
  // header. The pipeline lost nothing, so this can never be `high`.
  if (entry.successful_acquisition) {
    return entry.manual_intervention
      ? result(
          SEVERITY.LOW,
          category,
          0.8,
          [
            "data was acquired — this is a partial pull, not a failure",
            "taxonomy flags manual_intervention: a human must act, but nothing was lost",
          ],
          actionFor(category)
        )
      : result(
          SEVERITY.INFO,
          category,
          0.8,
          [
            "data was acquired — this is a partial pull, not a failure",
            "taxonomy flags no manual_intervention: no human action required",
          ],
          actionFor(category)
        );
  }

  // ---- R5: a human must act (manual_intervention) --------------------------
  // Looked up BY CATEGORY from connection_regex.js rather than hand-listed, so
  // the classifier table stays the single source of truth (live: credentials,
  // file_missing, host_key_changed, host_key_new, key_exchange —
  // permission_denied_partial is caught by R4 above).
  //
  // NOT capped on WARN (Phase 4 review, MEDIUM finding). An earlier cut rated
  // manual_intervention+WARN as medium on the theory that "WARN means the run
  // continued". That theory is false — see the WARN note above R6. A broken
  // credential is broken whatever the producer labeled it, so the label only
  // costs confidence (0.75 vs 0.9), never severity.
  if (entry.manual_intervention) {
    return result(
      SEVERITY.HIGH,
      category,
      isWarn ? 0.75 : 0.9,
      [
        "taxonomy flags manual_intervention — retrying cannot clear this; it will keep failing until a human acts",
        isWarn
          ? "producer labeled this WARN rather than ERROR — which says nothing about whether the acquisition succeeded"
          : "producer labeled this ERROR",
      ],
      actionFor(category)
    );
  }

  // ---- R6: transport faults (taxonomy error_type 'connection') -------------
  // Derived from the taxonomy's own error_type rather than the prompt's
  // hand-listed four (host_unreachable / connection_timeout / connection_reset /
  // rsync_io_timeout) — that list omitted rsync_io_timeout's siblings
  // (max_retries, session_timeout, connection_refused, rsync_protocol_error,
  // partial_transfer_timeout, http2_cancel), which are the same kind of fault
  // and would otherwise fall to the default. All 10 resolve here.
  //
  // These are retry-eligible by nature (manual_intervention:false), so severity
  // is about REACH, not about the fault kind: one stalled scanner is routine;
  // the same fingerprint on 22+ scanners is an outage.
  if (entry.error_type === "connection") {
    const typeReason = isWarn
      ? "producer labeled this WARN rather than ERROR — which says nothing about whether the acquisition succeeded"
      : "producer labeled this ERROR";
    // Confidence, not severity, carries the WARN uncertainty (review, MEDIUM).
    const conf = isWarn ? 0.6 : 0.8;
    return entityCount >= BLAST_RADIUS_ENTITIES
      ? result(
          SEVERITY.HIGH,
          category,
          conf,
          [
            "transient transport fault (taxonomy error_type=connection) — retry-eligible",
            typeReason,
            `${blastReason} — at or above the ${BLAST_RADIUS_ENTITIES}-entity threshold (~10% of the fleet): fleet-wide, not one host`,
          ],
          actionFor(category)
        )
      : result(
          SEVERITY.MEDIUM,
          category,
          conf,
          [
            "transient transport fault (taxonomy error_type=connection) — retry-eligible",
            typeReason,
            `${blastReason} — below the ${BLAST_RADIUS_ENTITIES}-entity threshold: localized to this equipment`,
          ],
          actionFor(category)
        );
  }

  // ---- R7: expected data missing (taxonomy error_type 'file', no flags) ----
  // File-family categories that neither acquired data nor flag a human (live:
  // rsync_source_missing only). Data we expected is absent and retrying the
  // local step cannot conjure it — but the taxonomy does not claim a human is
  // required, so it sits at medium rather than high.
  if (entry.error_type === "file") {
    return result(
      SEVERITY.MEDIUM,
      category,
      isWarn ? 0.6 : 0.7,
      [
        "expected data missing (taxonomy error_type=file), no successful acquisition flagged",
        isWarn
          ? "producer labeled this WARN rather than ERROR — which says nothing about whether the acquisition succeeded"
          : "producer labeled this ERROR — the step failed to find data it expected",
      ],
      actionFor(category)
    );
  }

  // ---- R7b: engine-layer error_types (Phase 6) -----------------------------
  // Each type's severity is the family's PRODUCER-EVIDENCE verdict (quoted at
  // the entry in engine_regexes.js), not its WARN/ERROR label. `type` still
  // moves severity nowhere; it shades confidence only.

  // A hard run failure: the producer stopped without producing (JOB HALTED —
  // the Phase 4/5 review's own evidence family).
  if (entry.error_type === "halt") {
    return result(
      SEVERITY.MEDIUM,
      category,
      isWarn ? 0.8 : 0.85,
      [
        "the producer halted without acquiring — the run produced nothing (producer evidence at the engine_regexes.js entry)",
        isWarn
          ? "producer labeled this WARN rather than ERROR — which says nothing about whether the acquisition succeeded"
          : "producer labeled this ERROR",
        blastReason,
      ],
      actionFor(category)
    );
  }

  // An unhandled exception in the producer: a code defect needing a developer.
  if (entry.error_type === "crash") {
    return result(
      SEVERITY.MEDIUM,
      category,
      isWarn ? 0.6 : 0.7,
      [
        "unhandled exception in the producer — a code defect on unexpected input; needs a developer, not an operator",
        blastReason,
      ],
      actionFor(category)
    );
  }

  // A data-quality anomaly with a VERIFIED downstream failure mode (review
  // round 2 → medium, generalized round 3): the producer KEEPS the record with
  // a null host_datetime, and the post-processors that emit this message feed a
  // SELECTED record's host_datetime into the alert.offline_hhm_conn upsert via
  // build_upsert_str (a quoted '${host_datetime}' → the string 'null' →
  // PostgreSQL rejects it for timestamptz), so the offline-health row goes
  // stale for that system when the selected record is a null one. Round-3
  // review verified the count CROSS-VENDOR: of the 8 emitters of "datetime
  // object null", 7 share the identical upsert (the exact 8-row table is at the
  // engine_regexes.js datetime_parse_null entry). The one exception (Philips
  // CV/lod_eventlog) persists the null but has no upsert. The SELECTED record
  // is the LAST for six paths but the FIRST for Philips CV/eventlog
  // (mappedData[0]) — either way a null in it breaks the upsert.
  // The category is not source-aware (identical text, error_category not in the
  // fingerprint), so the verdict is deliberately CONSERVATIVE-MEDIUM across all
  // matches rather than claiming every one breaks the upsert.
  if (entry.error_type === "quality") {
    return result(
      SEVERITY.MEDIUM,
      category,
      0.7,
      [
        "data-quality anomaly with a verified downstream failure mode — the producer keeps the record with a null host_datetime; across the Philips/GE/Siemens post-processors that feed a selected record into the alert.offline_hhm_conn upsert (7 of 8 emitters of this message), a null in the selected record sends a quoted 'null' to a timestamptz and the offline-health row goes stale for that system",
      ],
      actionFor(category)
    );
  }

  // The normal between-acquisition state: nothing new to process / self-healed.
  if (entry.error_type === "status") {
    return result(
      SEVERITY.INFO,
      category,
      0.9,
      [
        "normal between-acquisition state — the producer had nothing new to process (or self-healed and continued)",
      ],
      actionFor(category)
    );
  }

  // NOTE: engine error_type 'config' needs no branch — those entries carry
  // manual_intervention: true and resolve through R5 (a human must fix the
  // row); 'credentials' likewise; engine 'file' entries resolve through R7
  // (the production file-family semantics, deliberately reused —
  // input_file_missing's medium is the developer-decided verdict).

  // ---- R8: in the taxonomy, but no rule matched ----------------------------
  // THE PRINCIPLED DEFAULT. Unreachable for today's 20 categories (R4–R7 cover
  // every combination the table currently contains). It exists for a FUTURE
  // taxonomy entry with an error_type this file has never seen (e.g. a new
  // 'dicom' or 'auth' type): such a category resolves to medium with low
  // confidence and a reason that names itself, so it surfaces in review instead
  // of silently inheriting someone else's severity. Deliberately not info (would
  // hide it) and not high (no evidence).
  return result(
    SEVERITY.MEDIUM,
    category,
    0.2,
    [
      `no assessor rule covers category '${category}' (taxonomy error_type=${entry.error_type})`,
      "defaulted to medium pending a rule; severity is not evidence-based here",
    ],
    GENERIC_ACTION
  );
};

module.exports = {
  assess,
  RULES_VERSION,
  BLAST_RADIUS_ENTITIES,
  // exported for tests: lets the suite enumerate the REAL taxonomy and assert
  // every category resolves, instead of re-listing categories a test could get
  // wrong the same way the prompt did.
  TAXONOMY,
};
