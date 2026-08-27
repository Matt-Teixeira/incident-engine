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
  // Fleet pool standard (decided 2026-08-27): a hung connect must ERROR by
  // 10s -- with no timeout, an unreachable DB hangs the run forever and the
  // empty cron .out reads as "never ran". Idle sockets close after 60s;
  // at most 15 connections per process.
  max: 15,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
  application_name: process.env.APP_NAME || "incident-engine",
};

module.exports = pgp(config);
