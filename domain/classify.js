// domain/classify.js — thin deterministic wrapper over TWO ordered classifier
// layers (Phase 6):
//
//   1. the PRODUCTION table, copied verbatim from
//      /opt/apps/data_acquisition/util/tools/connection_regex.js — always
//      consulted first, never reordered, never filtered, never shadowed;
//   2. the ENGINE table (utils/classify/engine_regexes.js) — consulted ONLY
//      when the production table returns no match, so it can extend the
//      vocabulary but can never reinterpret a production decision.
//
// First match wins within each table (root-cause above symptom). 'unknown'
// only when BOTH layers miss (or there is no text). Still pure: same text →
// same result, forever. See docs/error-taxonomy.md for both vocabularies.
"use strict";

const {
  extractConnectionError,
  connection_regexes,
} = require("../utils/classify/connection_regex");
const { engine_regexes } = require("../utils/classify/engine_regexes");

const UNKNOWN = Object.freeze({
  error_category: "unknown",
  error_type: "",
  manual_intervention: false,
  successful_acquisition: false,
});

function classify(text) {
  if (typeof text !== "string" || text === "") return { ...UNKNOWN };
  // Production first — the engine layer exists only for texts production
  // does not recognize (the layering invariant; unit-enforced).
  const match =
    extractConnectionError(text, connection_regexes) ||
    extractConnectionError(text, engine_regexes);
  if (!match) return { ...UNKNOWN };
  return {
    error_category: match.error_category,
    error_type: match.error_type,
    manual_intervention: match.manual_intervention === true,
    successful_acquisition: match.successful_acquisition === true,
  };
}

// UNKNOWN is module-private: exporting it invited circular test assertions
// (deepStrictEqual against the same object proves nothing). Tests pin the
// literal field values instead.
module.exports = { classify };
