// domain/entity.js — identity helpers for the incident dimension.
//
// entity(): the "affected equipment" axis of an incident, per
// docs/incidents-schema.md: sme → system_id → '__global__'. This is the single
// source of truth for the entity value; the Phase 3 aggregate groups on the
// entity STORED on each error_events row (populated here at materialize time),
// never re-deriving it in SQL.
//
// job_id is deliberately NOT in the chain. It is a per-run UUID: using it as an
// entity mints one incident identity PER RUN instead of one per affected
// equipment, and never aggregates across runs. Live evidence (Phase 3 Step 2):
// with job_id in the chain the 186k L0 rows produced 38,578 (fingerprint,
// entity) pairs — ~38,084 of them singleton incidents keyed on job UUIDs, from
// just 4 distinct fingerprints; without it, 498 sane incidents. An event with
// no sme and no system_id therefore falls to the shared '__global__' bucket for
// its fingerprint (one incident per distinct problem when equipment is unknown).
// (Phase 2 had demoted job_id below system_id for the same reason; Phase 3, its
// first consumer, removes it entirely — PHASE_LOG Phase 3.)
//
// deriveSystemId(): sme and note.system_id values are the suite's system_id
// format (live-verified 2026-07-14: both match ^SME\d{5}$ and
// stats.acquisition_history.system_id uses the same format), so a
// format-matching value IS the system_id. Anything else is not derivable →
// null.
"use strict";

const { nonEmptyString } = require("./strings");

const SYSTEM_ID_RE = /^SME\d{5}$/i;
// incidents.incidents.entity / incidents.error_events.entity are VARCHAR(64).
// sme (≤16) and system_id (≤8) both fit; the cap is a defensive backstop that
// keeps this in lockstep with the column width.
const ENTITY_MAX_LEN = 64;

function deriveSystemId(value) {
  const s = nonEmptyString(value);
  return s && SYSTEM_ID_RE.test(s) ? s.toUpperCase() : null;
}

function entity({ sme, system_id } = {}) {
  const pick = nonEmptyString(sme) ?? nonEmptyString(system_id);
  return (pick ?? "__global__").slice(0, ENTITY_MAX_LEN);
}

module.exports = { entity, deriveSystemId };
