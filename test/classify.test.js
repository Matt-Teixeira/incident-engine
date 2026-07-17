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
  extractConnectionError,
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

// ============================================================================
// Phase 6: the ENGINE LAYER (engine_regexes.js) — layering + no-collision +
// one classification test per family (texts are the producers' real messages).
// ============================================================================
const { engine_regexes } = require("../utils/classify/engine_regexes");

test("classify layering: production first, engine only on miss, unknown when both miss", async (t) => {
  await t.test("a production-covered text classifies EXACTLY as before the layer existed", () => {
    // The layering invariant: the engine table can extend, never reinterpret.
    const res = classify("Connection timed out");
    assert.equal(res.error_category, "connection_timeout");
    const res2 = classify("rsync error: timeout in data send/receive");
    assert.equal(res2.error_category, "rsync_io_timeout");
  });

  await t.test("NO engine pattern matches any production-covered sample text", () => {
    // The durable no-collision sweep: one real sample per production pattern.
    // If an engine regex ever matches one of these, the layer has started
    // reinterpreting production vocabulary — the exact thing it must never do.
    const productionSamples = [
      "Connection timed out",
      "error: max-retries exceeded",
      "Connection to 10.0.0.1 port 22 timed out",
      "Timeout, server 10.0.0.1 not responding",
      "curl: (28) Operation timed out after 5000 milliseconds with 10 out of 20 bytes received",
      "curl: (28) Operation timed out",
      "curl: (56) Recv failure: Connection reset by peer",
      "curl: (92) HTTP/2 stream 5 was not closed cleanly",
      "ssh: connect to host 10.0.0.1 port 22: No route to host",
      "rsync: connect to host 10.0.0.1 port 873: Connection refused",
      "remote host identification has changed",
      "Warning: Permanently added '10.0.0.1' (ED25519) to the list of known hosts",
      "Unable to negotiate with 10.0.0.1 port 22: no matching key exchange method found",
      "Login failed",
      "Permission denied (publickey,password)",
      "rsync: connection unexpectedly closed (0 bytes received so far)",
      "rsync error: timeout in data send/receive (code 30)",
      "error in rsync protocol data stream (code 12)",
      "mget: Access failed: Permission denied",
      "mget: Access failed: No such file",
      "mget: Access failed: 550 The system cannot find the file specified.",
      "mget: *.zip: no files found",
      "mirror: Logging.zip: open failed",
      "rsync: [sender] link_stat \"/data/x\" failed: No such file or directory (2)",
      "rsync error: some files/attrs were not transferred (see previous errors) (code 23)",
      "scp: No match",
    ];
    for (const text of productionSamples) {
      const prod = extractConnectionError(text, connection_regexes);
      assert.ok(prod, `sample no longer matches production (fixture rot): ${text}`);
      const eng = extractConnectionError(text, engine_regexes);
      assert.equal(eng, null, `engine pattern also matches production text: "${text}" → ${eng?.error_category}`);
    }
  });

  await t.test("a text neither table knows stays unknown", () => {
    const res = classify("Error: Command failed: ./jobs/mmb/read/sh/rsync_mmb.sh SME1 args");
    assert.equal(res.error_category, "unknown");
  });

  await t.test("engine entries obey the production table's hygiene rules", () => {
    for (const entry of engine_regexes) {
      assert.ok(!entry.re.flags.includes("g"), `${entry.error_category}: /g flag is stateful .test() poison`);
      assert.equal(typeof entry.error_type, "string");
      assert.equal(typeof entry.manual_intervention, "boolean");
      assert.equal(typeof entry.successful_acquisition, "boolean");
    }
  });
});

test("classify: each engine family's real producer text lands on its category", async (t) => {
  const cases = [
    ["NO TUNNEL FOUND", "tunnel_not_found"],
    ["missing host_ip", "config_missing"],
    ["missing credentials_group", "config_missing"],
    ["missing acquisition_script", "config_missing"],
    ["TypeError: Invalid authentication tag length", "credential_decrypt_error"],
    ["JOB HALTED", "job_halted"],
    // round-1 review (medium): the NON-CONFORMANT variant is a pre-acquisition
    // config gate (mmb/index.js:37-45), NOT a mid-run halt — and its entry must
    // stay ordered above ^JOB HALTED for this case to pass (first match wins).
    ["JOB HALTED -> NON-CONFORMANT config", "config_missing"],
    ["File not present", "input_file_missing"],
    ["File Not Present", "input_file_missing"],
    // round-1 review (medium): GE's explicit thrown message (GE_CT_CV_MRI.js:139-144)
    ["File not found in directory: /opt/resources/acqu_files/SME1/x.log", "input_file_missing"],
    ["no such file or directory", "input_file_missing"],
    ["Error: ENOENT: no such file or directory, stat '/opt/resources/acqu_files/SME1/x.log'", "input_file_missing"],
    ["Error: ENOENT: no such file or directory, scan '/opt/resources/x'", "input_file_missing"],
    ["TypeError: Cannot read properties of null (reading 'toString')", "unhandled_type_error"],
    ["TypeError: Cannot read properties of undefined (reading 'groups')", "unhandled_type_error"],
    ["datetime object null", "datetime_parse_null"],
    ["No new file data. Delta: 0", "no_new_data"],
    ["No new files detected", "no_new_data"],
    ["Delta is negative value: -5043494. Reading entire file.", "counter_reset_reread"],
  ];
  for (const [text, category] of cases) {
    await t.test(`"${text.slice(0, 44)}" → ${category}`, () => {
      const res = classify(text);
      assert.equal(res.error_category, category);
    });
  }

  await t.test("the inconclusive family deliberately stays unknown", () => {
    // Generic execFile wrapper text — root cause unreadable from the message;
    // the prompt's rule: inconclusive families are NOT guessed.
    assert.equal(classify("Error: Command failed: ./jobs/mmb/read/sh/rsync_mmb.sh SME00123").error_category, "unknown");
  });

  await t.test("round-1 review: ambiguous producer texts deliberately stay unknown", () => {
    // "No new monitoring data found." (insert_jsonb_data.js:134-141, HIGH):
    // fires whenever jsonData stayed empty — including after absent files and
    // catch-all read errors — so it is not proof of normal inactivity.
    assert.equal(classify("No new monitoring data found.").error_category, "unknown");
    // Bare "File not found" (medium): lod_eventlog.js emits it on a genuine
    // existsSync miss, but insert_jsonb_data.js:91-102 relabels ANY caught
    // read/exec error the same way (no error.code check). Same text, two truth
    // values → a text-only classifier must not guess.
    assert.equal(classify("File not found").error_category, "unknown");
  });
});
