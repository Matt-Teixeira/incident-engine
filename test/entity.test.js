// domain/entity.js — entity fallback chain + system_id derivation.
const test = require("node:test");
const assert = require("node:assert");
const { entity, deriveSystemId } = require("../domain/entity");

test("entity fallback: sme → system_id → job_id → __global__", () => {
  assert.strictEqual(entity({ sme: "SME01429", system_id: "s", job_id: "j" }), "SME01429");
  // review finding 2: system_id ranks above job_id — job ids are per-run
  // UUIDs, which would mint one incident identity per run
  assert.strictEqual(entity({ system_id: "SME00001", job_id: "job-1" }), "SME00001");
  assert.strictEqual(entity({ job_id: "job-1" }), "job-1");
  assert.strictEqual(entity({}), "__global__");
  assert.strictEqual(entity(), "__global__");
  // empty / whitespace / non-string values fall through
  assert.strictEqual(entity({ sme: " ", system_id: "", job_id: "job-2" }), "job-2");
  assert.strictEqual(entity({ sme: 42, system_id: null, job_id: "job-3" }), "job-3");
});

test("entity holds a 36-char job UUID losslessly, caps at VARCHAR(64)", () => {
  const uuid = "47762d99-dd38-449f-9831-241af25115f6";
  assert.strictEqual(entity({ job_id: uuid }), uuid); // no truncation
  assert.strictEqual(entity({ job_id: "x".repeat(100) }).length, 64);
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
