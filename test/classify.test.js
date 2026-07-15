// domain/classify.js — verifies the wrapper reproduces the copied production
// table's first-match-wins semantics (docs/error-taxonomy.md), including the
// two ordering rationales documented in connection_regex.js itself.
const test = require("node:test");
const assert = require("node:assert");
const { classify } = require("../domain/classify");

// The literal unknown result — deliberately NOT imported from the module so a
// typo in the module's fallback values cannot self-verify.
const UNKNOWN_LITERAL = {
  error_category: "unknown",
  error_type: "",
  manual_intervention: false,
  successful_acquisition: false,
};
const {
  connection_regexes,
} = require("../utils/classify/connection_regex");

test("known signals map to their categories", () => {
  assert.strictEqual(classify("Connection timed out").error_category, "connection_timeout");
  assert.strictEqual(classify("error: max-retries exceeded").error_category, "max_retries");
  assert.strictEqual(
    classify("ssh: connect to host 10.0.0.1 port 22: No route to host").error_category,
    "host_unreachable"
  );
  assert.strictEqual(
    classify("curl: (28) Failed to connect to 10.1.2.3 port 443 after 30000 ms: Timeout was reached")
      .error_category,
    "connection_timeout"
  );
  assert.strictEqual(classify("mget: Access failed: 550 the.zip").error_category, "file_missing_partial");
  const cred = classify("Permission denied (publickey,password)");
  assert.strictEqual(cred.error_category, "credentials");
  assert.strictEqual(cred.error_type, "credentials");
  assert.strictEqual(cred.manual_intervention, true);
});

test("ordering: root-cause auth signal beats downstream rsync symptom", () => {
  // When SSH auth fails, rsync also reports "connection unexpectedly closed"
  // in the same stderr — the auth signal must win (documented in the table).
  const text =
    "Permission denied (publickey).\nrsync: connection unexpectedly closed (0 bytes received so far)";
  assert.strictEqual(classify(text).error_category, "credentials");
});

test("ordering: session_timeout beats the auto-accepted-host-key warning", () => {
  const text =
    "Warning: Permanently added '10.0.0.5' (ED25519) to the list of known hosts.\n" +
    "Timeout, server 10.0.0.5 not responding";
  assert.strictEqual(classify(text).error_category, "session_timeout");
});

test("ordering: specific partial-transfer curl-28 beats generic curl-28", () => {
  const text = "curl: (28) Operation timed out after 30000 milliseconds with 512 bytes received";
  assert.strictEqual(classify(text).error_category, "partial_transfer_timeout");
});

test("successful_acquisition flag surfaces on partial categories", () => {
  const partial = classify("rsync error: some files/attrs were not transferred (see previous errors)");
  assert.strictEqual(partial.error_category, "rsync_partial");
  assert.strictEqual(partial.successful_acquisition, true);
});

test("no match / no text → unknown (literal values pinned)", () => {
  assert.deepStrictEqual(classify("something entirely novel"), UNKNOWN_LITERAL);
  assert.deepStrictEqual(classify(""), UNKNOWN_LITERAL);
  assert.deepStrictEqual(classify(null), UNKNOWN_LITERAL);
});

test("copied table is intact: 26 ordered entries, none with /g flags", () => {
  assert.strictEqual(connection_regexes.length, 26);
  for (const entry of connection_regexes) {
    assert.strictEqual(entry.re.global, false, `${entry.error_category} must not use /g`);
    assert.ok(entry.error_category, "every entry carries an error_category");
    assert.ok(entry.error_type, "every entry carries an error_type");
  }
});
