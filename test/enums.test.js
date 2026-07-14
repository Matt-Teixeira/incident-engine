// Phase 1 has no domain logic yet; this smokes the only pure, dependency-free
// helper so `node --test` runs green end-to-end (FLOW.md Step 6). Domain tests
// (normalize/fingerprint/classify/assess) arrive with their phases.
const test = require("node:test");
const assert = require("node:assert");
const enums = require("../utils/logger/enums");

test("logger enums expose the suite's log-event vocabulary", () => {
  assert.deepStrictEqual(enums.type, { I: "INFO", W: "WARN", E: "ERROR" });
  assert.strictEqual(enums.tag.cal, "CALL");
  assert.strictEqual(enums.tag.det, "DETAILS");
  assert.strictEqual(enums.tag.cat, "CATCH");
  assert.strictEqual(enums.tag.seq, "SEQUENCE HALTED");
  assert.strictEqual(enums.tag.qaf, "QA FAILURE");
});
