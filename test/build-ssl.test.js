// Dependency-free unit tests for the pure env→ssl-config mapping. The
// fail-closed behavior of verify-* is the point: a configuration/mount mistake
// must abort the run, never silently downgrade to an unauthenticated TLS mode.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const buildSsl = require("../utils/db/build-ssl");

const CA_TEXT = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-ssl-"));
const caPath = path.join(tmp, "ca.crt");
fs.writeFileSync(caPath, CA_TEXT);

test("disable (and unset) → no TLS", () => {
  assert.strictEqual(buildSsl({}), false);
  assert.strictEqual(buildSsl({ PG_SSLMODE: "disable" }), false);
});

test("require → encrypted but unauthenticated (documented exception)", () => {
  assert.deepStrictEqual(buildSsl({ PG_SSLMODE: "require" }), {
    rejectUnauthorized: false,
  });
});

test("verify-full → CA + hostname verification", () => {
  const ssl = buildSsl({ PG_SSLMODE: "verify-full", PG_SSL_PATH: caPath });
  assert.strictEqual(ssl.ca, CA_TEXT);
  assert.strictEqual(ssl.rejectUnauthorized, true);
  assert.strictEqual(ssl.checkServerIdentity, undefined);
});

test("verify-ca → CA verified, hostname check disabled", () => {
  const ssl = buildSsl({ PG_SSLMODE: "verify-ca", PG_SSL_PATH: caPath });
  assert.strictEqual(ssl.ca, CA_TEXT);
  assert.strictEqual(ssl.rejectUnauthorized, true);
  assert.strictEqual(typeof ssl.checkServerIdentity, "function");
  assert.strictEqual(ssl.checkServerIdentity(), undefined);
});

test("verify-* fails closed on missing PG_SSL_PATH", () => {
  assert.throws(() => buildSsl({ PG_SSLMODE: "verify-full" }), /requires PG_SSL_PATH/);
  assert.throws(() => buildSsl({ PG_SSLMODE: "verify-ca" }), /requires PG_SSL_PATH/);
});

test("verify-* fails closed on unreadable PG_SSL_PATH", () => {
  assert.throws(
    () =>
      buildSsl({
        PG_SSLMODE: "verify-full",
        PG_SSL_PATH: path.join(tmp, "missing.crt"),
      }),
    /cannot read PG_SSL_PATH/
  );
});

test("unsupported modes abort", () => {
  assert.throws(() => buildSsl({ PG_SSLMODE: "prefer" }), /unsupported PG_SSLMODE/);
  assert.throws(() => buildSsl({ PG_SSLMODE: "bogus" }), /unsupported PG_SSLMODE/);
});
