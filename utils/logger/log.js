// utils/logger/log.js — the suite's positional-array run logger, copied from
// /opt/apps/data_acquisition/utils/logger/log.js (express-http branch dropped:
// this app is a cron-batch one-shot and always writes a per-run log file).
const enums = require("./enums");
const db = require("../db/pg-pool");
const { pg_column_sets } = require("../db/sql/pg-helpers");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { performance } = require("node:perf_hooks");

let path;
let write_stream;
let write_stream_error;
const makeAppRunLog = async () => {
  const run_id = uuidv4();

  switch (process.env.RUN_ENV) {
    case "dev":
      path = `./utils/logger/${process.env.APP_NAME}-log.${process.env.LOGGER}.${run_id}.json`;
      break;

    case "staging":
      path = `/opt/run-logs/${process.env.APP_NAME}/${process.env.APP_NAME}-log.${process.env.LOGGER}.${run_id}.json`;
      break;
    default:
      path = `/opt/run-logs/${process.env.APP_NAME}/${process.env.APP_NAME}-log.${process.env.LOGGER}.${run_id}.json`;
      break;
  }

  write_stream = fs.createWriteStream(path, {
    flags: "a",
  });
  // createWriteStream errors (missing dir, permissions) surface asynchronously;
  // capture them so writeLogEvents can fail the run instead of the error
  // escaping as an uncaught 'error' event and killing the process.
  write_stream_error = null;
  write_stream.on("error", (error) => {
    write_stream_error = error;
  });

  return {
    run_id: run_id,
    log_events: [],
    timers: new Map(),
  };
};

const addLogEvent = async (type, run_log, func, tag, note, err) => {
  const { run_id, log_events } = run_log;

  // GENERIC log_event VALUES ADDED
  let log_event = {
    run_id: run_id,
    dt: new Date().toISOString(),
    type: type,
    func: func,
    tag: tag,
    note: note,
  };

  // CONDITIONALLY APPEND ERROR OBJECT'S STACK IF IT EXISTS
  if (type === enums.type.E) {
    // err may be null or a non-Error (throw null, string rejections) — the
    // logger itself must never throw while recording a failure.
    log_event["err_msg"] =
      err?.stack ?? (err == null ? "Unknown error" : String(err));

    // CONSOLE LOG ERROR TO DEV
    if (process.env.LOGGER === "dev") {
      console.log(log_event.err_msg);
    }
  }

  log_events.push(log_event);
};

const startTimer = (run_log, label) => {
  if (!run_log?.timers) return;
  run_log.timers.set(label, performance.now());
};

const endTimer = async (run_log, label, extra_note) => {
  if (!run_log?.timers) return;
  const t0 = run_log.timers.get(label);
  if (t0 === undefined) {
    await addLogEvent(
      enums.type.W,
      run_log,
      label,
      enums.tag.det,
      { missing_start: true, ...(extra_note || null) },
      null
    );
    return;
  }
  run_log.timers.delete(label);
  const duration_ms = Math.round(performance.now() - t0);
  await addLogEvent(
    enums.type.I,
    run_log,
    label,
    enums.tag.det,
    { duration_ms, ...(extra_note || null) },
    null
  );
};

// Compute stats + buckets over timer events. Labels of the form `prefix.suffix`
// with 3+ distinct sub-labels (e.g. exec.SME01234, exec.SME05678, ...) are
// aggregated under `prefix.*`; everything else is reported as a scalar.
// When a timer event's note contains an IPv4 address string in any field, the
// event is also bucketed by /24 subnet; apps with no IPv4 in their notes will
// not see a `subnets` field in the output.
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const extractIpv4FromNote = (note) => {
  if (!note || typeof note !== "object") return null;
  for (const v of Object.values(note)) {
    if (typeof v === "string" && IPV4_RE.test(v)) return v;
  }
  return null;
};
const subnet24 = (ip) => ip.split(".").slice(0, 3).join(".");

const computeRunSummary = (log_events) => {
  const durations = log_events
    .filter((e) => e?.note && typeof e.note.duration_ms === "number")
    .map((e) => ({ label: e.func, ms: e.note.duration_ms, note: e.note }));

  const labelsByPrefix = new Map();
  for (const { label } of durations) {
    const dot = label.indexOf(".");
    if (dot < 0) continue;
    const prefix = label.substring(0, dot);
    if (!labelsByPrefix.has(prefix)) labelsByPrefix.set(prefix, new Set());
    labelsByPrefix.get(prefix).add(label);
  }
  const aggregablePrefixes = new Set(
    [...labelsByPrefix]
      .filter(([, set]) => set.size >= 3)
      .map(([p]) => p)
  );

  const stats = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const q = (x) =>
      sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * x))];
    return {
      count: sorted.length,
      min_ms: sorted[0],
      p50_ms: q(0.5),
      p95_ms: q(0.95),
      max_ms: sorted[sorted.length - 1],
    };
  };
  const bucket = (arr) => {
    const b = {
      "<10s": 0,
      "10-30s": 0,
      "30-60s": 0,
      "60-90s": 0,
      ">=90s": 0,
    };
    for (const ms of arr) {
      if (ms < 10_000) b["<10s"]++;
      else if (ms < 30_000) b["10-30s"]++;
      else if (ms < 60_000) b["30-60s"]++;
      else if (ms < 90_000) b["60-90s"]++;
      else b[">=90s"]++;
    }
    return b;
  };

  const timers = {};
  const aggregated = new Map();
  for (const { label, ms } of durations) {
    const dot = label.indexOf(".");
    const prefix = dot >= 0 ? label.substring(0, dot) : null;
    if (prefix && aggregablePrefixes.has(prefix)) {
      if (!aggregated.has(prefix)) aggregated.set(prefix, []);
      aggregated.get(prefix).push(ms);
    } else {
      timers[label] = { duration_ms: ms };
    }
  }
  for (const [prefix, arr] of aggregated) {
    timers[`${prefix}.*`] = { ...stats(arr), buckets: bucket(arr) };
  }

  // Opt-in subnet aggregation: only fires when events carry an IPv4 in their note.
  const bySubnet = new Map();
  for (const { ms, note } of durations) {
    const ip = extractIpv4FromNote(note);
    if (!ip) continue;
    const key = subnet24(ip);
    if (!bySubnet.has(key)) bySubnet.set(key, []);
    bySubnet.get(key).push(ms);
  }
  const subnets = {};
  for (const [key, arr] of bySubnet) {
    if (arr.length < 2) continue; // a single system is not a "cluster"
    subnets[key] = { ...stats(arr), buckets: bucket(arr) };
  }

  const first_dt = log_events[0]?.dt;
  const last_dt = log_events[log_events.length - 1]?.dt;
  const wall_clock_ms =
    first_dt && last_dt
      ? new Date(last_dt).getTime() - new Date(first_dt).getTime()
      : null;

  const result = { wall_clock_ms, event_count: log_events.length, timers };
  if (Object.keys(subnets).length > 0) result.subnets = subnets;
  return result;
};

const addRunSummary = async (run_log) => {
  if (!run_log?.log_events) return;
  const summary = computeRunSummary(run_log.log_events);
  await addLogEvent(
    enums.type.I,
    run_log,
    "run_summary",
    enums.tag.det,
    summary,
    null
  );
};

// Returns true on success, false on failure (recorded as an in-memory ERROR
// event either way). The caller decides the exit code — a failed self-log
// must fail the run, but must not prevent the file sink from being attempted.
const dbInsertLogEvents = async (pgp, run_log) => {
  const { run_id, log_events } = run_log;

  const {
    type: { I, E },
    tag: { det, cat },
  } = enums;

  try {
    const we_logs = log_events.filter(
      ({ type }) => type === "WARN" || type === "ERROR"
    );
    const app_run_log = [
      {
        app_name: process.env.APP_NAME,
        run_id: run_id,
        verbose_log: JSON.stringify(log_events),
        warn_error_logs: JSON.stringify(we_logs),
      },
    ];

    // STORE LOGS TO PG — through the check-option view, so a wrong app_name is
    // rejected by the database, not just by convention.
    const query = pgp.helpers.insert(app_run_log, pg_column_sets.util.self_log);
    await db.none(query);

    const note = { txt: "DB INSERT SUCCESSFUL" };
    addLogEvent(I, run_log, "dbInsertLogEvents", det, note, null);
    return true;
  } catch (error) {
    addLogEvent(E, run_log, "dbInsertLogEvents", cat, null, error);
    return false;
  }
};

// Returns true on success, false on failure. Awaits the stream so both async
// stream errors and the final flush are observed instead of fire-and-forget.
const writeLogEvents = async (run_log) => {
  const { log_events } = run_log;

  try {
    // WRITE LOGS TO DISK
    if (write_stream_error) throw write_stream_error;
    await new Promise((resolve, reject) => {
      write_stream.end(JSON.stringify(log_events), (error) =>
        error ? reject(error) : resolve()
      );
    });
    if (write_stream_error) throw write_stream_error;
  } catch (error) {
    console.log(`writeLogEvents ERROR`);
    console.log(error);
    return false;
  }

  // PROVIDE BASIC DEV STATS
  if (process.env.LOGGER === "dev") {
    console.log(`\nFIRST LOG EVENT: ${JSON.stringify(log_events[0])}`);
    console.log(
      `LAST LOG EVENT: ${JSON.stringify(log_events[log_events.length - 1])}\n`
    );
    console.log(`WROTE ${log_events.length} EVENTS TO DISK`);
  }
  return true;
};

const destroyAppRunLog = async (run_log) => {
  run_log = null;
};

module.exports = [
  addLogEvent,
  writeLogEvents,
  dbInsertLogEvents,
  makeAppRunLog,
  destroyAppRunLog,
  startTimer,
  endTimer,
  addRunSummary,
];
