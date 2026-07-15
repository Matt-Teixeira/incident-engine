// domain/normalize.js — FROZEN GOLDEN CONTRACT (Fingerprint-Stability Rule,
// markdown/ARCHITECTURE_PRINCIPLES.md).
//
// Scrubs volatile fragments out of an error message so the same problem on
// different hosts/files/runs/times normalizes to the same text. The output
// feeds the fingerprint ONLY — classification runs on the raw text.
//
// Two stages (both frozen):
//   1. LINE FILTER — drop whole lines that are pure transfer/runtime noise.
//      Multiline command failures put the salient error AFTER a
//      variable-length progress preamble and BEFORE an identical stack tail;
//      dropping noise lines (instead of capping length) keeps the salient
//      signal and makes the row count of the progress table irrelevant.
//      (Phase 2 review finding 1: a blind 512-char prefix cap merged
//      connection_timeout with partial_transfer_timeout.) The filter is
//      deliberately conservative (re-review finding 2): curl progress rows
//      are dropped only INSIDE a block opened by curl's own two-line header,
//      and only lines shaped like JavaScript stack frames (a `:line:col` /
//      `(native)` / `<anonymous>` tail) are treated as frames — tabular or
//      indented prose diagnostics are salient signal and must survive.
//   2. PLACEHOLDER SCRUB — specific shapes (timestamps, uuids, ips) before
//      the generic hex/number rules can eat their digits.
//
// There is deliberately NO length cap: the output is only hashed.
//
// Changing ANY rule (or their order) changes every fingerprint in
// incidents.error_events. That happens only in a deliberate, logged phase
// with FP_VERSION bumped (domain/fingerprint.js) and the golden tests in
// test/normalize.test.js updated to match.
"use strict";

// curl writes its progress table with \r separators; the line split treats
// \r like \n, so each progress update is its own line.
const CURL_HEADER_1_RE = /^\s*%\s+Total\s+%\s+Received/;
const CURL_HEADER_2_RE = /^\s*Dload\s+Upload/;
// A progress data row — only meaningful INSIDE a recognized curl block; the
// same shape outside a block (e.g. "  404 10 2 files missing") is kept.
const CURL_ROW_RE = /^\s*\d{1,3}\s+[\d.]+[kMGT]?\s/;
// A JavaScript stack frame: indented "at ..." ENDING in a recognized frame
// tail — a source location (`:line:col`), `(native)`, `<anonymous>`, or the
// async-iteration form `(index N)` (live: "at async Promise.all (index 0)").
// Indented prose that merely starts with "at" (e.g. "  at least 3 files
// failed") does not match and is kept.
const STACK_FRAME_RE =
  /^\s+at\s.*(?::\d+:\d+\)?|\(native\)|<anonymous>\)?|\(index \d+\))\s*$/;

function filterNoiseLines(text) {
  const kept = [];
  let inCurlBlock = false;
  for (const line of text.split(/[\r\n]+/)) {
    if (CURL_HEADER_1_RE.test(line)) {
      inCurlBlock = true;
      continue;
    }
    if (inCurlBlock && (CURL_HEADER_2_RE.test(line) || CURL_ROW_RE.test(line))) {
      continue;
    }
    inCurlBlock = false; // first non-progress line closes the block
    if (STACK_FRAME_RE.test(line)) continue;
    kept.push(line);
  }
  return kept.join(" ");
}

const RULES = [
  // ISO-8601 timestamps (2026-07-14T17:45:53.414Z, with offset variants)
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  // syslog/ls-style datestamps ("Jul  7 12:39") — appear in note fields that
  // embed `ls -l` output (e.g. hhm_rpp_ge note.last_mod)
  [/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{1,2}:\d{2}\b/g, "<ts>"],
  // UUIDs (run_ids, job_ids quoted inside messages)
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  // IPv4, optionally with :port
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>"],
  // SME equipment ids — the ENTITY dimension, not the problem dimension; two
  // systems with the same failure must share a fingerprint
  [/\bSME\d+\b/gi, "<sme>"],
  // absolute unix paths (two or more segments)
  [/(?:\/[\w.+-]+){2,}\/?/g, "<path>"],
  // long hex runs (hashes, addresses, host keys)
  [/\b[0-9a-f]{8,}\b/gi, "<hex>"],
  // any remaining digit runs (ports, counts, deltas, exit codes, line numbers)
  [/\d+/g, "<n>"],
];

function normalize(text) {
  if (typeof text !== "string" || text === "") return "";
  let out = filterNoiseLines(text);
  for (const [re, placeholder] of RULES) {
    out = out.replace(re, placeholder);
  }
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}

module.exports = normalize;
