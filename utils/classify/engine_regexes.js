// utils/classify/engine_regexes.js — the ENGINE-OWNED classifier layer (Phase 6).
//
// WHAT THIS IS, AND WHAT IT MUST NEVER BECOME:
// connection_regex.js (this directory) is a VERBATIM MIRROR of data_acquisition's
// production classifier — never edited, so it stays re-syncable and the taxonomy
// doc's "source of truth" claim stays true. THIS file is the engine's own
// vocabulary: it is consulted ONLY when the production table returns no match
// (see domain/classify.js), so it can EXTEND the taxonomy but can never shadow
// or reinterpret a production decision. Entries proven useful here are the
// future upstreaming proposal to data_acquisition (tracked open decision).
//
// Every entry follows the production table's exact shape and its rules: no /g
// flags (stateful .test() poison — see connection_regex.js header), first match
// wins, root-cause signals above downstream symptoms. Category slugs must not
// collide with the production table's (unit-enforced), and every entry's
// verdict below cites the PRODUCER CODE that justifies it — the F2 standard:
// what the producer DOES after emitting the message, never what the label says.
//
// error_type vocabulary used here (dispatched on by domain/assessor/rules.js):
//   config      — a per-system configuration/infrastructure row is missing or
//                 broken; a human must fix data, not code (manual_intervention)
//   credentials — stored credential material is unusable (manual_intervention)
//   halt        — the producer stopped without producing; a hard run failure
//   file        — expected input data absent (the PRODUCTION 'file' semantics,
//                 deliberately reused so the assessor's existing file-family
//                 rule applies unchanged)
//   crash       — an unhandled exception; a code defect needing a developer
//   quality     — a handled data-quality anomaly; the producer continues
//   status      — a normal between-acquisition state; nothing to do
"use strict";

const engine_regexes = [
  // -- needs-a-human root causes first (mirror the production ordering principle) --
  {
    connection_error: false,
    extraction_error: true,
    error_type: "config",
    // data_acquisition/utils/vpn/get-tunnels-by-ip.js:30-37 — an IP needing a
    // tunnel reset has no row in the IPsec tunnel table → `continue`: the
    // failing system CANNOT be auto-remediated until a human adds/fixes the
    // tunnel row. (The reset flow only receives IPs of systems already failing.)
    error_category: "tunnel_not_found",
    message: "failing system's IP has no tunnel record - auto-reset impossible until the tunnel table is fixed",
    manual_intervention: true,
    successful_acquisition: false,
    re: /^NO TUNNEL FOUND$/,
  },
  {
    connection_error: false,
    extraction_error: true,
    error_type: "config",
    // data_acquisition/jobs/hhm/_shared.js:130-152 — the system row lacks
    // host_ip / credentials_group / acquisition_script → `continue`, NO
    // acquisition attempted; the producer's own comment: "skipped for missing
    // config. Name the missing field so ops can fix the row."
    error_category: "config_missing",
    message: "system row is missing required config - no acquisition until ops fixes the row",
    manual_intervention: true,
    successful_acquisition: false,
    re: /^missing (host_ip|credentials_group|acquisition_script)\b/,
  },
  {
    connection_error: false,
    extraction_error: true,
    error_type: "config",
    // data_acquisition/jobs/mmb/index.js:37-45 — the mmb job's config array
    // lacks sme / mmbScript / pgTable / machineRegexTags → log WARN and
    // `return` BEFORE any acquisition is attempted. Despite the "JOB HALTED"
    // label this is an invalid-config GATE, not a mid-run halt: the remedy is
    // fixing the system's config row, not investigating a failed run (round-1
    // review, medium). Must stay ORDERED ABOVE the generic ^JOB HALTED entry.
    error_category: "config_missing",
    message: "system row is missing required config - no acquisition until ops fixes the row",
    manual_intervention: true,
    successful_acquisition: false,
    re: /^JOB HALTED -> NON-CONFORMANT config$/,
  },
  {
    connection_error: false,
    extraction_error: true,
    error_type: "credentials",
    // data_acquisition/jobs/hhm/_configs.js:24-25 → util/encrypt/decrypt.js —
    // decrypt_string() on the stored AES-GCM credential blob throws: the stored
    // ciphertext/key is unusable, so acquisition for those systems cannot
    // authenticate until a human re-encrypts/fixes the credential row.
    error_category: "credential_decrypt_error",
    message: "stored credential fails to decrypt - re-encrypt or fix the credential row",
    manual_intervention: true,
    successful_acquisition: false,
    re: /Invalid authentication tag length/,
  },
  // -- hard run failure --
  {
    connection_error: false,
    extraction_error: true,
    error_type: "halt",
    // data_acquisition/jobs/demo_systems/index.js:119-127 and
    // jobs/mmb/index.js:74-82 — fileSizeAfterRsync === null → log WARN "JOB
    // HALTED" → return: the job stopped without acquiring anything. The
    // Phase 4/5 review evidence (F2): the WARN label notwithstanding, this IS
    // a failed run. (The "-> NON-CONFORMANT config" variant is NOT this — it
    // is a pre-acquisition config gate, matched by the entry above.)
    error_category: "job_halted",
    message: "job halted without acquiring - the run produced nothing",
    manual_intervention: false,
    successful_acquisition: false,
    re: /^JOB HALTED/,
  },
  // -- expected input data absent (production 'file' semantics, reused) --
  {
    connection_error: false,
    extraction_error: true,
    error_type: "file",
    // The missing-input family across both post-processors — the upstream-
    // acquired file is absent so the run yields NOTHING for that system:
    //   hhm_rpp_ge/acquisition/GE_CT_CV_MRI.js:86-95   ("File not present" → return)
    //   hhm_rpp_ge/acquisition/GE_CT_CV_MRI.js:139-144 (current_file_size null →
    //     throw "File not found in directory: <path>" → logged E; round-1 review)
    //   hhm_rpp_ge/tooling/gzip_file.js:21-32 +
    //   hhm_rpp_philips/util/gzip_file.js:21-32        ("File Not Present" → return)
    //   hhm_rpp_philips/data_acquisition/Philips_MRI_Logcurrent.js:111-129
    //                                                  ("no such file or directory" → return false)
    //   the unguarded ERROR variant: fs stat/scan throwing ENOENT into a CATCH
    //     (e.g. phil_mri_logcurrent) — same root cause, surfaced as exception.
    // DELIBERATELY NOT MATCHED (round-1 review, medium): the bare WARN text
    // "File not found" — two producers emit that exact text with DIFFERENT
    // truth values: .../CV/lod_eventlog.js:66-75 is a genuine existsSync miss,
    // but .../MRI/insert_jsonb_data.js:91-102 relabels `file_data === undefined`,
    // which Philips_MRI_Monitor.js's catch blocks return on ANY fs/exec error
    // (no error.code check) — possibly permissions or I/O, not a missing file.
    // A text-only classifier cannot preserve truth there → stays `unknown`
    // (residual medium) until the producer distinguishes the cases.
    // Developer-decided severity (2026-07-17): medium — a scanner whose
    // telemetry is not flowing is a real per-system actionable gap.
    error_category: "input_file_missing",
    message: "expected input file absent - that system's post-processing produced nothing; check the upstream pull",
    manual_intervention: false,
    successful_acquisition: false,
    re: /^File [Nn]ot [Pp]resent$|^File not found in directory: |^no such file or directory$|ENOENT: no such file or directory, (stat|scan|open|read)/,
  },
  // -- unhandled code defect --
  {
    connection_error: false,
    extraction_error: true,
    error_type: "crash",
    // hhm_rpp_philips .../PHILIPS_MRI_LOGCURRENT: getFileData and kin —
    // TypeError on null/undefined reaches a CATCH block: a parser code defect
    // on unexpected input. Needs a developer, not an operator.
    error_category: "unhandled_type_error",
    message: "unhandled TypeError in the producer - a parser code defect on unexpected input",
    manual_intervention: false,
    successful_acquisition: false,
    re: /TypeError: Cannot read properties of (null|undefined)/,
  },
  // -- handled data-quality anomaly --
  {
    connection_error: false,
    extraction_error: true,
    error_type: "quality",
    // A matched log line's datetime parses to null; the record is STILL
    // APPENDED with host_datetime = null and the parser continues (round-1
    // review corrected an earlier "skipped" claim).
    // ROUND-2 REVIEW (medium — supersedes round 1's low): the anomaly is NOT
    // absorbed. The post-processor feeds a SELECTED record's host_datetime into
    // the offline-health upsert (build_upsert_str → alert.offline_hhm_conn:
    // '${null}' becomes the quoted string 'null', which PostgreSQL rejects for
    // timestamptz), so that system's offline-health row goes stale when the
    // selected record is a null one.
    // ROUND-3 REVIEW (generalized + count corrected): this EXACT text has 8
    // emitters, and 7 of the 8 share the upsert failure mode CROSS-VENDOR.
    // Full table (emitter → upsert site / selected record):
    //   hhm_rpp_philips MRI/logcurrent.js:124   → :195-201  (last record)
    //                   CT/eal_parser.js:114     → :181-187  (last record)
    //                   CV/eventlog.js:166        → :221-224  (FIRST record — mappedData[0])
    //                   CV/lod_eventlog.js:190    → (NO upsert — the lone exception)
    //   hhm_rpp_ge      MRI/gesys_parser.js:114  → :169-175  (last record)
    //                   CT/gesys_parser.js:138    → :207-213  (last record)
    //                   CV/sysError_parser.js:128 → :189-194  (last record)
    //   hhm_rpp_siemens win_10/siemens_cv.js:134 → :170-176  (last record)
    //   (GE + Siemens build_upsert_str quote '${recent_host_datetime}'
    //    identically to Philips util/upsertHostDatatime.js; CV/eventlog differs
    //    only in WHICH record it selects — a null in it breaks the upsert just
    //    the same.) CV/lod_eventlog persists the null but makes no upsert call.
    // The category is not source-aware (identical text, error_category not in
    // the fingerprint), so the assessor rates it a deliberately CONSERVATIVE
    // medium across all matches — see the R7b quality branch. Producer fix
    // (skip/null-handle or a VALID timestamp) is a tracked cross-app follow-up
    // covering ALL EIGHT emitters.
    error_category: "datetime_parse_null",
    message: "a log line's datetime parsed to null - record stored with null host_datetime, parsing continued",
    manual_intervention: false,
    successful_acquisition: false,
    re: /^datetime object null$/,
  },
  // -- normal between-acquisition states last --
  {
    connection_error: false,
    extraction_error: true,
    error_type: "status",
    // hhm_rpp_ge/acquisition/GE_CT_CV_MRI.js:262-274 ("No new file data" →
    // file_data = null, nothing to process), rmmu_history.js:66 /
    // rmmu_short_cryogenic.js:53 ("No new files detected" — same shape). The
    // normal state between acquisitions.
    // DELIBERATELY NOT MATCHED (round-1 review, HIGH): "No new monitoring data
    // found." (.../MRI/insert_jsonb_data.js:134-141) fires whenever jsonData
    // stayed empty — and every path that leaves it empty is a `continue`:
    // file absent, stale redis cache, or `undefined` from a catch-all read
    // error. It is emitted after failed inputs as well as quiet ones, so it is
    // NOT proof of normal inactivity → stays `unknown` (residual medium) until
    // the producer distinguishes "all unchanged" from failed reads.
    error_category: "no_new_data",
    message: "nothing new to process - normal between-acquisition state",
    manual_intervention: false,
    successful_acquisition: false,
    re: /^No new (file data\. Delta: -?\d+|files detected)$/,
  },
  {
    connection_error: false,
    extraction_error: true,
    error_type: "status",
    // hhm_rpp_ge/acquisition/GE_CT_CV_MRI.js:236-247 — the tracked file SHRANK
    // (equipment rotated/rewrote its log); the producer SELF-HEALS by reading
    // the entire file and processing continues.
    error_category: "counter_reset_reread",
    message: "tracked file shrank (log rotated) - producer re-read the whole file and continued",
    manual_intervention: false,
    successful_acquisition: false,
    re: /^Delta is negative value: .*Reading entire file\./,
  },
];

module.exports = { engine_regexes };
