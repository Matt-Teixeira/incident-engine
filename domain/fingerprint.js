// domain/fingerprint.js — the incident grouping key (Fingerprint-Stability
// Rule): sha1(src_app_name | func | tag | type | normalize(TEXT)).
//
// TEXT fallback chain: err_msg → note.message → note.txt → note.skip_reason
// → '' — live-verified 2026-07-14 (see docs/error-taxonomy.md): the first
// three are nearly complementary per app (hhm_rpp_ge is 100% note.message;
// note.txt is data_acquisition-only, ~15% of its events); note.skip_reason is
// the producer's stated reason on 688 data_acquisition events that carry no
// other text (Phase 2 review finding 5).
//
// FP_VERSION stamps the formula. Any change to this file or to
// domain/normalize.js bumps it in a deliberate, logged phase — old rows keep
// their fingerprints; the version constant is how a mixed table is detected.
"use strict";

const crypto = require("node:crypto");
const normalize = require("./normalize");
const { nonEmptyString } = require("./strings");

const FP_VERSION = 1;

// The human text of a warn/error event, per the documented fallback chain.
function eventText(event) {
  if (event === null || typeof event !== "object") return "";
  const note = event.note && typeof event.note === "object" ? event.note : {};
  return (
    nonEmptyString(event.err_msg) ??
    nonEmptyString(note.message) ??
    nonEmptyString(note.txt) ??
    nonEmptyString(note.skip_reason) ??
    ""
  );
}

const part = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

// '|' separates the canonical fields; escape it (and the escape char itself)
// inside field values so a field-boundary shift can never collide — without
// this, {func:'x|CATCH', tag:''} and {func:'x', tag:'CATCH'} hash identically
// (adversarial review, round 3; fixable only pre-freeze).
const esc = (v) => part(v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

// `text` may be passed pre-computed (flatten extracts it once for classify);
// it MUST equal eventText(event) — the default keeps 2-arg calls identical.
function fingerprint(src_app_name, event, text = eventText(event)) {
  const canonical = [
    esc(src_app_name),
    esc(event?.func),
    esc(event?.tag),
    esc(event?.type),
    esc(normalize(text)),
  ].join("|");
  return crypto.createHash("sha1").update(canonical, "utf8").digest("hex");
}

module.exports = { FP_VERSION, eventText, fingerprint };
