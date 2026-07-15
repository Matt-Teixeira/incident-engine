// jobs/materialize/flatten.js — pure: one util.app_run_logs row → insertable
// incidents.error_events rows. Defensive by contract (REVIEW_CHECKLIST "Data
// Contract & Queries"): a malformed event is reported in `skipped`, never
// thrown — one bad event must not fail the batch.
"use strict";

const { FP_VERSION, fingerprint, eventText } = require("../../domain/fingerprint");
const { classify } = require("../../domain/classify");
const { deriveSystemId } = require("../../domain/entity");
const { nonEmptyString } = require("../../domain/strings");

// Storage caps from db/schema.sql. Truncation is STORAGE-only — the
// fingerprint always hashes the raw values, so two funcs that collide after
// truncation still get distinct fingerprints.
const cap = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);

// NUL (\u0000) is legal inside the source `json` column but rejected by
// jsonb/TEXT at INSERT time — outside this module's try/catch — where one
// poison event would roll back the whole batch INCLUDING the watermark and
// stall the pipeline permanently (adversarial review, round 3). Strip it from
// every string in the event before anything reads or stores the event.
const sanitizeNul = (value) => {
  if (typeof value === "string") return value.replace(/\u0000/g, "");
  if (Array.isArray(value)) return value.map(sanitizeNul);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[sanitizeNul(k)] = sanitizeNul(v);
    return out;
  }
  return value;
};

function flattenRun({ run_id, app_name, warn_error_logs }) {
  const rows = [];
  const skipped = [];
  let events = [];
  if (Array.isArray(warn_error_logs)) {
    events = warn_error_logs;
  } else if (warn_error_logs != null) {
    // Non-null but not an array: a contract violation worth surfacing — the
    // caller logs skipped entries as a WARN, so this is visible instead of a
    // silent watermark advance (yet still non-blocking: one poison row must
    // not stall the pipeline).
    skipped.push({
      run_id,
      event_ord: null,
      reason: `warn_error_logs is not an array (${typeof warn_error_logs})`,
    });
  }

  events.forEach((raw, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      skipped.push({ run_id, event_ord: i, reason: "event is not an object" });
      return;
    }
    try {
      const event = sanitizeNul(raw);
      const note =
        event.note && typeof event.note === "object" && !Array.isArray(event.note)
          ? event.note
          : {};
      const text = eventText(event);
      const cls = classify(text);
      const sme = nonEmptyString(note.sme);
      // Date.parse accepts strings Postgres rejects (year 0, expanded years,
      // Date#toString output), so store the round-tripped ISO instant, never
      // the raw string — a DB-side parse error would stall the whole batch.
      const dt =
        typeof event.dt === "string" && !Number.isNaN(Date.parse(event.dt))
          ? new Date(event.dt).toISOString()
          : null;

      rows.push({
        run_id,
        event_ord: i,
        src_app_name: cap(app_name, 64),
        type: cap(event.type, 8),
        func: cap(event.func, 64),
        tag: cap(event.tag, 32),
        err_msg: nonEmptyString(event.err_msg),
        note_message: nonEmptyString(note.message),
        sme: cap(sme, 16),
        job_id: nonEmptyString(note.job_id),
        // note.system_id is authoritative when present (5,270 live events
        // carry it with no sme — review finding 2); sme is the fallback.
        system_id: deriveSystemId(note.system_id) ?? deriveSystemId(sme),
        fingerprint: fingerprint(app_name, event, text),
        fp_version: FP_VERSION,
        error_category: cap(cls.error_category, 64),
        error_type: cap(cls.error_type, 16),
        phase: "", // best-effort enrichment happens in Phase 3
        dt,
        raw_event: event,
      });
    } catch (error) {
      skipped.push({
        run_id,
        event_ord: i,
        reason: String((error && error.message) || error),
      });
    }
  });

  return { rows, skipped };
}

module.exports = { flattenRun };
