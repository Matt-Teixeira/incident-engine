// GOLDEN TESTS for domain/normalize.js — the frozen fingerprint-input
// contract (Fingerprint-Stability Rule). If any assertion here fails, the
// fingerprint formula changed: either revert the change, or bump FP_VERSION
// in domain/fingerprint.js and update these goldens in a deliberate, logged
// phase. Never "fix" a golden casually.
const test = require("node:test");
const assert = require("node:assert");
const normalize = require("../domain/normalize");

const GOLDENS = [
  // ip + numbers
  [
    "Connection to 172.31.3.38 port 22 timed out",
    "connection to <ip> port <n> timed out",
  ],
  // path + sme + mixed-alnum filename (real hhm_rpp_ge shape)
  [
    'rsync: [sender] link_stat "/opt/resources/acqu_files/SME01429/gesys_CRDCT01.log" failed: No such file or directory (2)',
    'rsync: [sender] link_stat "<path><sme>/gesys_crdct<n>.log" failed: no such file or directory (<n>)',
  ],
  // plain counter
  ["No new file data. Delta: 0", "no new file data. delta: <n>"],
  // ISO timestamp + curl exit code + durations/sizes
  [
    "2026-07-14T17:45:53.414Z curl: (28) Operation timed out after 30000 milliseconds with 512 bytes received",
    "<ts> curl: (<n>) operation timed out after <n> milliseconds with <n> bytes received",
  ],
  // embedded `ls -l` output (hhm_rpp_ge note.last_mod)
  [
    "-rw-rw-r--+ 1 svc docker 4374436 Jul  7 12:39 /opt/resources/acqu_files/SME01429/gesys_CRDCT01.log",
    "-rw-rw-r--+ <n> svc docker <n> <ts> <path><sme>/gesys_crdct<n>.log",
  ],
  // uuid before hex before number
  [
    "job 47762d99-dd38-449f-9831-241af25115f6 deadbeef01 failed",
    "job <uuid> <hex> failed",
  ],
];

test("normalize golden contract (frozen)", () => {
  for (const [input, expected] of GOLDENS) {
    assert.strictEqual(normalize(input), expected, `input: ${input}`);
  }
});

// -- Noise-line filtering (Phase 2 review finding 1: a blind 512-char prefix
// cap merged connection_timeout and partial_transfer_timeout events whose
// salient curl line sits after a variable-length progress preamble). --
const PROG_HEADER =
  "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n" +
  "                                 Dload  Upload   Total   Spent    Left  Speed\n";
const PROG_ROW =
  "  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r";
const STACK_TAIL =
  "\n    at ChildProcess.exithandler (node:child_process:417:12)" +
  "\n    at ChildProcess.emit (node:events:509:28)" +
  "\n    at maybeClose (node:internal/child_process:1124:16)";
const CMD_HEAD =
  "Error: Command failed: timeout 840s ./read/sh/Siemens/siemens_80_data_grab.sh 192.168.1.229 /workspace/files/SME18032\n";

test("noise stripping keeps the salient curl line (frozen goldens)", () => {
  const conn =
    CMD_HEAD + PROG_HEADER + PROG_ROW.repeat(3) +
    "\ncurl: (28) Failed to connect to 10.108.116.183 port 443 after 10000 ms: Timeout was reached" +
    STACK_TAIL;
  const partial =
    CMD_HEAD + PROG_HEADER + PROG_ROW.repeat(3) +
    "\ncurl: (28) Operation timed out after 20000 milliseconds with 51809 out of 2257683 bytes received" +
    STACK_TAIL;
  assert.strictEqual(
    normalize(conn),
    "error: command failed: timeout <n>s .<path> <ip> <path><sme> curl: (<n>) failed to connect to <ip> port <n> after <n> ms: timeout was reached"
  );
  assert.strictEqual(
    normalize(partial),
    "error: command failed: timeout <n>s .<path> <ip> <path><sme> curl: (<n>) operation timed out after <n> milliseconds with <n> out of <n> bytes received"
  );
  // the live regression: these two MUST stay distinct
  assert.notStrictEqual(normalize(conn), normalize(partial));
});

test("preservation: tabular/indented/sentinel diagnostics survive (re-review finding 2)", () => {
  // a progress-row-shaped line OUTSIDE a curl block is salient signal
  assert.strictEqual(
    normalize("Error summary:\n  404 10 2 files missing"),
    "error summary: <n> <n> <n> files missing"
  );
  // indented prose starting with "at" is not a stack frame
  assert.strictEqual(
    normalize("Error summary:\n    at least 3 files failed"),
    "error summary: at least <n> files failed"
  );
  // --:--:-- outside a curl block is content, not noise
  assert.strictEqual(
    normalize("Time parser failed on --:--:-- sentinel"),
    "time parser failed on --:--:-- sentinel"
  );
  // real stack frames still drop (all live tail forms); the Error head stays
  assert.strictEqual(
    normalize(
      "Error: boom\n    at Foo.bar (/app/x.js:12:34)\n    at async Promise.all (index 0)\n    at <anonymous>"
    ),
    "error: boom"
  );
});

test("progress-row count and volatile details do not change the output", () => {
  const mk = (rows, ip) =>
    CMD_HEAD + PROG_HEADER + PROG_ROW.repeat(rows) +
    `\ncurl: (28) Failed to connect to ${ip} port 443 after 10004 ms: Timeout was reached` +
    STACK_TAIL;
  assert.strictEqual(normalize(mk(3, "10.108.116.183")), normalize(mk(7, "10.99.0.7")));
});

test("normalize collapses whitespace, lowercases, trims", () => {
  assert.strictEqual(normalize("  A   B\n\tC  "), "a b c");
});

test("normalize is idempotent on its own output", () => {
  for (const [input] of GOLDENS) {
    const once = normalize(input);
    assert.strictEqual(normalize(once), once);
  }
});

test("normalize does NOT truncate (the output is only hashed)", () => {
  // finding 1: any prefix cap can merge distinct failures whose salient
  // signal sits past the boundary — there is deliberately no cap.
  assert.strictEqual(normalize("x".repeat(5000)).length, 5000);
});

test("normalize handles empty / non-string input", () => {
  assert.strictEqual(normalize(""), "");
  assert.strictEqual(normalize(null), "");
  assert.strictEqual(normalize(undefined), "");
  assert.strictEqual(normalize(42), "");
});
