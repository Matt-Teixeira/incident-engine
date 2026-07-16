"use strict";
require("dotenv").config();

// The self-log identity is a code constant: a mismatched APP_NAME env would
// attribute this app's rows to another app (the DB-side check-option view is
// the hard stop; this fails fast on the config mistake).
const APP_NAME = "incident-engine";
if (process.env.APP_NAME && process.env.APP_NAME !== APP_NAME) {
  console.error(`APP_NAME must be "${APP_NAME}" (got "${process.env.APP_NAME}")`);
  process.exit(1);
}
process.env.APP_NAME = APP_NAME;

const pgp = require("pg-promise")();
const db = require("./utils/db/pg-pool");
const [
  addLogEvent,
  writeLogEvents,
  dbInsertLogEvents,
  makeAppRunLog,
  ,
  ,
  ,
  addRunSummary,
] = require("./utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat },
} = require("./utils/logger/enums");

// L0: watermark → bounded warn_error_logs scan → flatten/fingerprint/classify
// → incidents.error_events (see jobs/materialize).
const materialize = require("./jobs/materialize");

// L1/L2: watermark → aggregate new error_events into incidents.incidents, one
// row per (fingerprint, entity), idempotently (see jobs/aggregate). Phase 3.
const aggregate = require("./jobs/aggregate");

// L3: pure deterministic assessment of every incident → severity/confidence/
// assessment (see jobs/assess). Phase 4.
const assessIncidents = require("./jobs/assess");

// The `assess` job: aggregate (L1/L2) then assess (L3), in that order.
//
// ORDER IS LOAD-BEARING, not stylistic: the assessor's blast radius is a count
// of the entities sharing a fingerprint, so it must run AFTER the aggregate has
// inserted this batch's new incidents — otherwise a fingerprint that just went
// fleet-wide would be assessed against last run's narrower radius and only catch
// up on the following run.
//
// Auto-close / lifecycle `state` is Phase 5 and lands after this. The assessor
// deliberately does NOT set state (Determinism Rule).
const assess = async (run_log) => {
  await aggregate(run_log);
  await assessIncidents(run_log);
};

async function runJob(run_log, job) {
  let note = {
    job: job,
  };

  await addLogEvent(I, run_log, "runJob", det, note, null);

  switch (job) {
    case "materialize":
      await materialize(run_log);
      break;
    case "assess":
      await assess(run_log);
      break;
    case "run":
      // The normal cron invocation: materialize then assess in one process.
      await materialize(run_log);
      await assess(run_log);
      break;
    case "noop":
      // Lifecycle smoke: boot → log → self-log insert → write log file → exit.
      break;
    default:
      // A typo'd cron job must fail the run, not report success.
      await addLogEvent(W, run_log, "runJob", det, { txt: `unknown job: ${job}` }, null);
      throw new Error(`unknown job: ${job}`);
  }
}

const onBoot = async () => {
  console.time("App Run Time");
  let run_log;
  let failed = false;

  try {
    run_log = await makeAppRunLog();

    let note = {
      LOGGER: process.env.LOGGER,
      PG_USER: process.env.PGUSER || process.env.PG_USER,
      PG_DB: process.env.PGDATABASE || process.env.PG_DB,
    };

    await addLogEvent(I, run_log, "onBoot", cal, note, null);

    const job = process.argv[2] || "run";
    run_log.run_group = job;

    await runJob(run_log, job);
  } catch (error) {
    console.log(error);
    failed = true;
    if (run_log) await addLogEvent(E, run_log, "onBoot", cat, null, error);
  }

  // Single finalization path. Both sinks are required: a run whose self-log
  // insert or log-file write failed must exit non-zero so cron sees it, even
  // when the job itself succeeded. Each sink reports failure instead of
  // throwing, so one failing sink never blocks the other.
  if (run_log) {
    await addRunSummary(run_log);
    const db_ok = await dbInsertLogEvents(pgp, run_log);
    const file_ok = await writeLogEvents(run_log);
    if (!db_ok || !file_ok) failed = true;
  }

  // Batch one-shot: release the pool so the process exits promptly instead
  // of waiting out the idle-connection timeout.
  try {
    await db.$pool.end();
  } catch (error) {
    console.log(error);
    failed = true;
  }

  if (failed) process.exitCode = 1;
  console.log("\n********** END **********");
  console.timeEnd("App Run Time");
};

onBoot().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
