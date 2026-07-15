// jobs/materialize/flatten.js — pure flattening: shape, defensiveness,
// event_ord indexing, null semantics, storage truncation.
const test = require("node:test");
const assert = require("node:assert");
const { flattenRun } = require("../jobs/materialize/flatten");

const RUN_ID = "11111111-2222-3333-4444-555555555555";

test("flattens a well-formed event with all derived fields", () => {
  const event = {
    dt: "2026-07-14T17:45:10.326Z",
    tag: "CATCH",
    func: "GE_CT_CV_MRI: getFileData",
    type: "ERROR",
    err_msg: "Connection to 172.31.3.38 port 22 timed out",
    note: { sme: "SME01429", job_id: "job-1", message: "fallback msg" },
  };
  const { rows, skipped } = flattenRun({
    run_id: RUN_ID,
    app_name: "hhm_rpp_ge",
    warn_error_logs: [event],
  });
  assert.strictEqual(skipped.length, 0);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.run_id, RUN_ID);
  assert.strictEqual(r.event_ord, 0);
  assert.strictEqual(r.src_app_name, "hhm_rpp_ge");
  assert.strictEqual(r.type, "ERROR");
  assert.strictEqual(r.func, "GE_CT_CV_MRI: getFileData");
  assert.strictEqual(r.tag, "CATCH");
  assert.strictEqual(r.err_msg, "Connection to 172.31.3.38 port 22 timed out");
  assert.strictEqual(r.note_message, "fallback msg");
  assert.strictEqual(r.sme, "SME01429");
  assert.strictEqual(r.job_id, "job-1");
  assert.strictEqual(r.system_id, "SME01429");
  assert.match(r.fingerprint, /^[0-9a-f]{40}$/);
  assert.strictEqual(r.fp_version, 1);
  assert.strictEqual(r.error_category, "connection_timeout");
  assert.strictEqual(r.error_type, "connection");
  assert.strictEqual(r.phase, "");
  assert.strictEqual(r.dt, "2026-07-14T17:45:10.326Z");
  assert.deepStrictEqual(r.raw_event, event);
});

test("event_ord is the array index, preserved across malformed gaps", () => {
  const good = { type: "WARN", func: "f", tag: "DETAILS", note: { txt: "x" } };
  const { rows, skipped } = flattenRun({
    run_id: RUN_ID,
    app_name: "data_acquisition",
    warn_error_logs: [good, "not-an-object", null, good],
  });
  assert.deepStrictEqual(rows.map((r) => r.event_ord), [0, 3]);
  assert.deepStrictEqual(skipped.map((s) => s.event_ord), [1, 2]);
});

test("missing optional fields become null (partial-index semantics)", () => {
  const { rows } = flattenRun({
    run_id: RUN_ID,
    app_name: "data_acquisition",
    warn_error_logs: [{ type: "WARN", func: "f", tag: "DETAILS", note: {} }],
  });
  const r = rows[0];
  assert.strictEqual(r.err_msg, null);
  assert.strictEqual(r.note_message, null);
  assert.strictEqual(r.sme, null);
  assert.strictEqual(r.job_id, null);
  assert.strictEqual(r.system_id, null);
  assert.strictEqual(r.dt, null);
  assert.strictEqual(r.error_category, "unknown"); // no text → unknown
});

test("invalid dt and non-object note are tolerated", () => {
  const { rows, skipped } = flattenRun({
    run_id: RUN_ID,
    app_name: "data_acquisition",
    warn_error_logs: [
      { type: "WARN", func: "f", tag: "DETAILS", dt: "not-a-date", note: "not-an-object" },
    ],
  });
  assert.strictEqual(skipped.length, 0);
  assert.strictEqual(rows[0].dt, null);
  assert.strictEqual(rows[0].sme, null);
});

test("storage truncation caps func/tag but fingerprint hashes raw values", () => {
  const longFunc = "f".repeat(100);
  const a = flattenRun({
    run_id: RUN_ID,
    app_name: "data_acquisition",
    warn_error_logs: [{ type: "WARN", func: longFunc, tag: "DETAILS", note: { txt: "x" } }],
  }).rows[0];
  const b = flattenRun({
    run_id: RUN_ID,
    app_name: "data_acquisition",
    warn_error_logs: [{ type: "WARN", func: longFunc + "-different", tag: "DETAILS", note: { txt: "x" } }],
  }).rows[0];
  assert.strictEqual(a.func.length, 64);
  assert.strictEqual(b.func.length, 64);
  assert.strictEqual(a.func, b.func); // same stored value...
  assert.notStrictEqual(a.fingerprint, b.fingerprint); // ...distinct fingerprints
});

test("null warn_error_logs yields nothing (scan filters these anyway)", () => {
  const out = flattenRun({ run_id: RUN_ID, app_name: "x", warn_error_logs: null });
  assert.deepStrictEqual(out, { rows: [], skipped: [] });
});

test("sme is stored trimmed, matching the derived system_id (round-3 finding)", () => {
  const { rows } = flattenRun({
    run_id: RUN_ID,
    app_name: "hhm_rpp_ge",
    warn_error_logs: [{ type: "WARN", func: "f", tag: "DETAILS", note: { sme: " SME01429 " } }],
  });
  assert.strictEqual(rows[0].sme, "SME01429");
  assert.strictEqual(rows[0].system_id, "SME01429");
});

test("NUL bytes are stripped everywhere before insert (poison-event guard)", () => {
  const { rows, skipped } = flattenRun({
    run_id: RUN_ID,
    app_name: "data_acquisition",
    warn_error_logs: [
      {
        type: "ERROR",
        func: "f",
        tag: "CATCH",
        err_msg: "boom\u0000tail",
        note: { message: "m\u0000", sme: "SME01429" },
      },
    ],
  });
  assert.strictEqual(skipped.length, 0);
  const r = rows[0];
  assert.strictEqual(r.err_msg, "boomtail");
  assert.strictEqual(r.note_message, "m");
  assert.ok(!JSON.stringify(r.raw_event).includes("\\u0000"));
});

test("dt is stored as the round-tripped ISO instant, never the raw string", () => {
  const mk = (dt) =>
    flattenRun({
      run_id: RUN_ID,
      app_name: "data_acquisition",
      warn_error_logs: [{ type: "WARN", func: "f", tag: "DETAILS", dt, note: {} }],
    }).rows[0].dt;
  // Date#toString form: Date.parse accepts it, Postgres does not — must be ISO'd
  const jsForm = new Date("2026-07-14T15:00:00.000Z").toString();
  assert.strictEqual(mk(jsForm), "2026-07-14T15:00:00.000Z");
  // already-ISO input round-trips unchanged
  assert.strictEqual(mk("2026-07-14T17:45:10.326Z"), "2026-07-14T17:45:10.326Z");
});

test("non-null, non-array payload surfaces a skipped diagnostic (finding 6)", () => {
  const out = flattenRun({
    run_id: RUN_ID,
    app_name: "x",
    warn_error_logs: { not: "an array" },
  });
  assert.strictEqual(out.rows.length, 0);
  assert.strictEqual(out.skipped.length, 1);
  assert.strictEqual(out.skipped[0].event_ord, null);
  assert.match(out.skipped[0].reason, /not an array/);
});

test("note.system_id is authoritative; sme derivation is the fallback (finding 2)", () => {
  const mk = (note) =>
    flattenRun({
      run_id: RUN_ID,
      app_name: "data_acquisition",
      warn_error_logs: [{ type: "WARN", func: "f", tag: "DETAILS", note }],
    }).rows[0];
  assert.strictEqual(mk({ system_id: "SME01074" }).system_id, "SME01074");
  assert.strictEqual(mk({ system_id: "sme01074" }).system_id, "SME01074"); // normalized
  assert.strictEqual(mk({ system_id: "SME01074", sme: "SME99999" }).system_id, "SME01074");
  assert.strictEqual(mk({ sme: "SME99999" }).system_id, "SME99999");
  assert.strictEqual(mk({ system_id: "not-a-system" }).system_id, null);
});
