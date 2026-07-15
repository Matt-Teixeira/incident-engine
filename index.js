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

// Phases 3-5: aggregate → incidents.incidents, deterministic assess, state
// machine + auto-close. Stub until then.
const assess = async (run_log) => {
  await addLogEvent(I, run_log, "assess", det, { txt: "stub - built in Phases 3-5" }, null);
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
