// utils/db/build-ssl.js — pure mapping: env → pg `ssl` config. Split out of
// pg-pool.js (which creates the pool at require time) so it is unit-testable
// without a database.
//
//   disable      → no TLS (trusted local network only)
//   require      → encrypted, server NOT authenticated — an explicit,
//                  documented trust-boundary exception, not the default
//   verify-ca    → CA-verified chain; hostname NOT checked
//   verify-full  → CA-verified chain + hostname (the deployment default)
//
// verify-* fail CLOSED: a missing/unreadable CA aborts the run instead of
// silently downgrading to an unauthenticated connection. Unknown modes abort.
"use strict";

const fs = require("fs");
const path = require("path");

function buildSsl(env = process.env) {
  const mode = (env.PG_SSLMODE || "disable").toLowerCase();

  if (mode === "disable") return false;

  if (mode === "require") {
    return { rejectUnauthorized: false };
  }

  if (mode === "verify-ca" || mode === "verify-full") {
    const caPath = env.PG_SSL_PATH;
    if (!caPath) {
      throw new Error(`[pg] PG_SSLMODE=${mode} requires PG_SSL_PATH to be set`);
    }
    const resolved = path.isAbsolute(caPath)
      ? caPath
      : path.resolve(process.cwd(), caPath);
    let ca;
    try {
      ca = fs.readFileSync(resolved, "utf8");
    } catch (error) {
      throw new Error(
        `[pg] PG_SSLMODE=${mode}: cannot read PG_SSL_PATH ${resolved}: ${error.message}`
      );
    }
    const ssl = { ca, rejectUnauthorized: true };
    if (mode === "verify-ca") {
      // Authenticate the CA chain but skip hostname verification.
      ssl.checkServerIdentity = () => undefined;
    }
    return ssl;
  }

  throw new Error(`[pg] unsupported PG_SSLMODE: ${mode}`);
}

module.exports = buildSsl;
