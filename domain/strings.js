// domain/strings.js — the ONE nonEmptyString. Three private copies had already
// drifted (entity.js trimmed, fingerprint.js/flatten.js didn't), storing
// ' SME01429' in sme while system_id held 'SME01429' (adversarial review,
// Phase 2 round 3). Semantics: trims; a whitespace-only or non-string value
// is "empty" → null.
"use strict";

const nonEmptyString = (v) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

module.exports = { nonEmptyString };
