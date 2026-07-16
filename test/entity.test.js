// domain/entity.js — entity fallback chain + system_id derivation.
const test = require("node:test");
const assert = require("node:assert");
const { entity, deriveSystemId } = require("../domain/entity");

test("entity fallback: sme → system_id → __global__", () => {
  assert.strictEqual(entity({ sme: "SME01429", system_id: "SME00002" }), "SME01429");
  assert.strictEqual(entity({ system_id: "SME00001" }), "SME00001");
  // Phase 3: no sme and no system_id → the shared __global__ bucket. job_id is
  // NOT a fallback (per-run UUID would fracture aggregation — see entity.js).
  assert.strictEqual(entity({}), "__global__");
  assert.strictEqual(entity(), "__global__");
  // job_id is ignored even when present
  assert.strictEqual(entity({ job_id: "any-job-uuid" }), "__global__");
  assert.strictEqual(entity({ sme: "SME01429", job_id: "j" }), "SME01429");
  // empty / whitespace / non-string values fall through to __global__
  assert.strictEqual(entity({ sme: " ", system_id: "" }), "__global__");
  assert.strictEqual(entity({ sme: 42, system_id: null }), "__global__");
});

test("entity caps at VARCHAR(64) as a defensive backstop", () => {
  assert.strictEqual(entity({ sme: "x".repeat(100) }).length, 64);
});

test("deriveSystemId: format-matching sme IS the system_id", () => {
  assert.strictEqual(deriveSystemId("SME01429"), "SME01429");
  assert.strictEqual(deriveSystemId("sme01429"), "SME01429"); // normalized upper
  assert.strictEqual(deriveSystemId(" SME01429 "), "SME01429"); // trimmed
  assert.strictEqual(deriveSystemId("HOSPITAL-3"), null);
  assert.strictEqual(deriveSystemId("SME1"), null);
  assert.strictEqual(deriveSystemId(""), null);
  assert.strictEqual(deriveSystemId(null), null);
  assert.strictEqual(deriveSystemId(undefined), null);
});
