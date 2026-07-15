// Fingerprint stability tests. The literal sha1 values are FROZEN: a change
// here means every incident grouping key changed — allowed only with a
// deliberate FP_VERSION bump (Fingerprint-Stability Rule).
const test = require("node:test");
const assert = require("node:assert");
const { FP_VERSION, eventText, fingerprint } = require("../domain/fingerprint");

test("FP_VERSION is 1 (bump only with a deliberate formula change)", () => {
  assert.strictEqual(FP_VERSION, 1);
});

test("eventText chain: err_msg → note.message → note.txt → note.skip_reason → ''", () => {
  assert.strictEqual(eventText({ err_msg: "boom", note: { message: "m", txt: "t" } }), "boom");
  assert.strictEqual(eventText({ note: { message: "m", txt: "t" } }), "m");
  assert.strictEqual(eventText({ note: { txt: "NO TUNNEL FOUND" } }), "NO TUNNEL FOUND");
  // review finding 5: skip_reason is the producer's stated reason when all
  // other text fields are empty (688 live events)
  assert.strictEqual(eventText({ note: { skip_reason: "missing host_ip" } }), "missing host_ip");
  assert.strictEqual(eventText({ note: { txt: "t", skip_reason: "s" } }), "t");
  assert.strictEqual(eventText({ note: {} }), "");
  assert.strictEqual(eventText({}), "");
  assert.strictEqual(eventText(null), "");
  // whitespace-only fields fall through
  assert.strictEqual(eventText({ err_msg: "  ", note: { message: "m" } }), "m");
  // non-string fields fall through
  assert.strictEqual(eventText({ err_msg: 42, note: { message: "m" } }), "m");
});

test("frozen: skip_reason-only event fingerprints on its stated reason", () => {
  assert.strictEqual(
    fingerprint("data_acquisition", {
      type: "WARN",
      func: "get_ge_mri_data",
      tag: "DETAILS",
      note: { skip_reason: "missing host_ip" },
    }),
    "03633ea731a16885940df1fb0560262e2a559741"
  );
});

test("frozen: noise-heavy curl failures — same cause groups, distinct causes split", () => {
  const PROG =
    "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n" +
    "                                 Dload  Upload   Total   Spent    Left  Speed\n";
  const ROW =
    "  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r";
  const STACK =
    "\n    at ChildProcess.exithandler (node:child_process:417:12)" +
    "\n    at maybeClose (node:internal/child_process:1124:16)";
  const HEAD =
    "Error: Command failed: timeout 840s ./read/sh/Siemens/siemens_80_data_grab.sh 192.168.1.229 /workspace/files/SME18032\n";
  const mk = (err_msg) =>
    fingerprint("data_acquisition", { type: "ERROR", func: "exec_data_grab", tag: "CATCH", err_msg });
  const conn3 = mk(HEAD + PROG + ROW.repeat(3) +
    "\ncurl: (28) Failed to connect to 10.108.116.183 port 443 after 10000 ms: Timeout was reached" + STACK);
  const conn5 = mk(HEAD + PROG + ROW.repeat(5) +
    "\ncurl: (28) Failed to connect to 10.99.0.7 port 80 after 10004 ms: Timeout was reached" + STACK);
  const partial = mk(HEAD + PROG + ROW.repeat(3) +
    "\ncurl: (28) Operation timed out after 20000 milliseconds with 51809 out of 2257683 bytes received" + STACK);
  assert.strictEqual(conn3, "ac10fbd754ff34fedf62f5c276f860fec798164f");
  assert.strictEqual(conn5, conn3); // progress rows / ip / port are volatile
  assert.strictEqual(partial, "f1448efde9a76524b105716ebc02d98ae5ed7715");
  assert.notStrictEqual(partial, conn3); // the live regression stays fixed
});

test("frozen fingerprints (sha1 of app|func|tag|type|normalize(text))", () => {
  // data_acquisition note.txt-only event (the ~15% case that motivated the chain)
  assert.strictEqual(
    fingerprint("data_acquisition", {
      type: "WARN",
      func: "getTunnelsByIP",
      tag: "QA FAILURE",
      note: { ip: "172.31.3.38", txt: "NO TUNNEL FOUND" },
    }),
    "54316dfff0a20cde7b2f8251f797546da05af10d"
  );
  // hhm_rpp_philips note.message event
  assert.strictEqual(
    fingerprint("hhm_rpp_philips", {
      type: "WARN",
      func: "PHILIPS_MRI_LOGCURRENT: checkFileExists",
      tag: "CATCH",
      note: { sme: "SME01406", message: "no such file or directory" },
    }),
    "eb80cc0fbc47c02fd84e3d8759a646f23b4da596"
  );
});

test("volatile details (ip/port) do NOT change the fingerprint", () => {
  const a = fingerprint("data_acquisition", {
    type: "ERROR",
    func: "x",
    tag: "CATCH",
    err_msg: "Connection to 10.0.0.1 port 22 timed out",
  });
  const b = fingerprint("data_acquisition", {
    type: "ERROR",
    func: "x",
    tag: "CATCH",
    err_msg: "Connection to 10.99.5.7 port 2222 timed out",
  });
  assert.strictEqual(a, b);
  assert.strictEqual(a, "6ad0e7441fa9825d9c88e65c0e7377d402073763");
});

test("field-boundary injection cannot collide (separator escaped)", () => {
  // pre-escape, {func:'x|CATCH', tag:''} hashed identically to {func:'x', tag:'CATCH'}
  const a = fingerprint("app", { func: "x|CATCH", tag: "", type: "ERROR", err_msg: "boom" });
  const b = fingerprint("app", { func: "x", tag: "CATCH", type: "ERROR", err_msg: "boom" });
  assert.notStrictEqual(a, b);
  // the escape char itself is escaped, so backslash variants can't collide either
  const c = fingerprint("app", { func: "x\\", tag: "CATCH", type: "ERROR", err_msg: "boom" });
  assert.notStrictEqual(c, b);
});

test("pre-computed text param is identical to the internal derivation", () => {
  const event = { func: "f", tag: "CATCH", type: "WARN", note: { txt: "NO TUNNEL FOUND" } };
  assert.strictEqual(
    fingerprint("data_acquisition", event),
    fingerprint("data_acquisition", event, eventText(event))
  );
});

test("identity fields DO change the fingerprint", () => {
  const base = { type: "ERROR", func: "x", tag: "CATCH", err_msg: "boom" };
  const fp = fingerprint("app_a", base);
  assert.notStrictEqual(fp, fingerprint("app_b", base));
  assert.notStrictEqual(fp, fingerprint("app_a", { ...base, func: "y" }));
  assert.notStrictEqual(fp, fingerprint("app_a", { ...base, tag: "CALL" }));
  assert.notStrictEqual(fp, fingerprint("app_a", { ...base, type: "WARN" }));
});

test("fingerprint is a 40-char lowercase sha1 hex", () => {
  assert.match(fingerprint("a", { type: "WARN" }), /^[0-9a-f]{40}$/);
});
