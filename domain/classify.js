// domain/classify.js — thin deterministic wrapper over the production
// classifier copied verbatim from
// /opt/apps/data_acquisition/util/tools/connection_regex.js (see
// docs/error-taxonomy.md). First match wins — the table's ordering places
// root-cause signals above downstream symptoms; this wrapper must never
// reorder or filter it. No match (or no text) → 'unknown'.
"use strict";

const {
  extractConnectionError,
  connection_regexes,
} = require("../utils/classify/connection_regex");

const UNKNOWN = Object.freeze({
  error_category: "unknown",
  error_type: "",
  manual_intervention: false,
  successful_acquisition: false,
});

function classify(text) {
  if (typeof text !== "string" || text === "") return { ...UNKNOWN };
  const match = extractConnectionError(text, connection_regexes);
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
