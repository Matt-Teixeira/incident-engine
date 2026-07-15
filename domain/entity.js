// domain/entity.js — identity helpers for the incident dimension.
//
// entity(): the "affected equipment" axis of an incident, per
// docs/incidents-schema.md: sme → system_id → job_id → '__global__'
// (consumed by the Phase 3 aggregate; built and frozen here with the rest of
// the identity domain). system_id ranks ABOVE job_id: job ids are per-run
// UUIDs, so preferring them would mint one incident identity per run instead
// of one per affected equipment (Phase 2 review finding 2).
//
// deriveSystemId(): sme and note.system_id values are the suite's system_id
// format (live-verified 2026-07-14: both match ^SME\d{5}$ and
// stats.acquisition_history.system_id uses the same format), so a
// format-matching value IS the system_id. Anything else is not derivable →
// null.
"use strict";

const { nonEmptyString } = require("./strings");

const SYSTEM_ID_RE = /^SME\d{5}$/i;
// incidents.incidents.entity VARCHAR(64) — must hold a 36-char job UUID
// losslessly when it is the final non-global fallback.
const ENTITY_MAX_LEN = 64;

function deriveSystemId(value) {
  const s = nonEmptyString(value);
  return s && SYSTEM_ID_RE.test(s) ? s.toUpperCase() : null;
}

function entity({ sme, system_id, job_id } = {}) {
  const pick =
    nonEmptyString(sme) ?? nonEmptyString(system_id) ?? nonEmptyString(job_id);
  return (pick ?? "__global__").slice(0, ENTITY_MAX_LEN);
}

module.exports = { entity, deriveSystemId };
