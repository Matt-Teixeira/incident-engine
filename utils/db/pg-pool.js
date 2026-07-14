// utils/db/pg-pool.js — copied from /opt/apps/data_acquisition/utils/db/pg-pool.js;
// buildSsl split into ./build-ssl.js (fail-closed verify-* modes) so it can be
// unit-tested without a database.
"use strict";

const pgp = require("pg-promise")();
const buildSsl = require("./build-ssl");

// First process.env are mapped to docker instance params
const config = {
  host: process.env.PGHOST || process.env.PG_HOST,      // Docker service name or Azure host
  port: Number(process.env.PGPORT || process.env.PG_PORT),
  database: process.env.PGDATABASE || process.env.PG_DB,
  user: process.env.PGUSER || process.env.PG_USER,
  password: process.env.PGPASSWORD || process.env.PG_PW,
  ssl: buildSsl(),
  application_name: process.env.APP_NAME || "incident-engine",
};

module.exports = pgp(config);
