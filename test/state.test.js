// test/state.test.js — the deterministic lifecycle transition function (Phase 5).
//
// SCOPE NOTE (the standing lesson): these tests cover the PURE function only.
// The recovery SQL, the facts assembly, the two ColumnSet write paths, and the
// job wiring have no unit coverage — every phase has shipped a wiring defect
// under a green suite. The live proof is integration/assess_parity.js's
// lifecycle invariants plus running the job and reading the rows.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  nextState,
  STATE,
  ENGINE_STATES,
  RESOLVED_REASON,
  STALE_AFTER_DAYS,
  ORACLE_SCOPED_APPS,
} = require("../domain/state");

const T0 = new Date("2026-07-16T12:00:00Z");
const minutes = (n) => new Date(T0.getTime() + n * 60 * 1000);
const days = (n) => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000);

// Baseline facts: an open data_acquisition incident, last seen "now", no
// recovery evidence. src_app defaults to the ONE oracle-scoped producer so the
// recovery tests exercise the close path; the scope tests override it.
const facts = (over = {}) => ({
  state: STATE.OPEN,
  last_seen: T0,
  resolved_last_seen: null,
  src_app: "data_acquisition",
  last_success: null,
  eval_time: T0,
  ...over,
});

test("state: initialization", async (t) => {
  await t.test("NULL state → open (the 509-row live backlog)", () => {
    assert.deepEqual(nextState(facts({ state: null })), { state: STATE.OPEN });
    assert.deepEqual(nextState(facts({ state: undefined })), { state: STATE.OPEN });
  });

  await t.test("NULL state that is immediately closeable resolves in ONE evaluation", () => {
    // The day-one backlog: 169 incidents already have recovery evidence. Init
    // is defaulting, not a separate cron cycle — they must not wait 30 minutes
    // at 'open' first.
    const res = nextState(facts({ state: null, last_success: minutes(5) }));
    assert.deepEqual(res, { state: STATE.RESOLVED, resolved_reason: RESOLVED_REASON.AUTO_RECOVERY });
  });

  await t.test("an already-open incident is NOT rewritten (no-op)", () => {
    assert.equal(nextState(facts()), null);
  });
});

test("state: auto-close on recovery", async (t) => {
  await t.test("success strictly AFTER last_seen → resolved/auto_recovery", () => {
    for (const state of [STATE.OPEN, STATE.RECURRING, STATE.ACKNOWLEDGED]) {
      const res = nextState(facts({ state, last_success: minutes(1) }));
      assert.deepEqual(
        res,
        { state: STATE.RESOLVED, resolved_reason: RESOLVED_REASON.AUTO_RECOVERY },
        `${state} must auto-close on recovery`
      );
    }
  });

  await t.test("success AT or BEFORE last_seen is not recovery", () => {
    // The ordering is strict: a success at the same instant as the last
    // failure proves nothing about which happened first.
    assert.equal(nextState(facts({ last_success: T0 })), null);
    assert.equal(nextState(facts({ last_success: minutes(-1) })), null);
  });

  await t.test("no oracle row (null last_success) → no recovery close", () => {
    // __global__ and the 188 oracle-absent entities: recovery can never fire.
    assert.equal(nextState(facts({ last_success: null })), null);
  });
});

test("state: recovery SCOPE (review, HIGH — the oracle only speaks for data_acquisition)", async (t) => {
  await t.test("the scope list is exactly what the run_id-join proof supports", () => {
    assert.deepEqual([...ORACLE_SCOPED_APPS], ["data_acquisition"]);
  });

  await t.test("a GE/Philips incident NEVER closes on a data_acquisition success", () => {
    // The live regression, pinned: incident 17157 (hhm_rpp_ge, "File not
    // present") was closed by an unrelated mmb rsync success 90s later — one of
    // 30 such closes, and the source of all 4 artificial re-open flaps.
    for (const src_app of ["hhm_rpp_ge", "hhm_rpp_philips"]) {
      const res = nextState(facts({ src_app, last_success: minutes(5) }));
      assert.equal(res, null, `${src_app} must not close on out-of-scope evidence`);
    }
  });

  await t.test("out-of-scope incidents still close by STALENESS", () => {
    const res = nextState(
      facts({ src_app: "hhm_rpp_ge", last_success: minutes(5), eval_time: days(10) })
    );
    assert.deepEqual(res, { state: STATE.RESOLVED, resolved_reason: RESOLVED_REASON.STALE });
  });

  await t.test("FAIL-SAFE: missing/unknown src_app is not scoped", () => {
    for (const src_app of [null, undefined, "", "acquisition-v2", "DATA_ACQUISITION"]) {
      const res = nextState(facts({ src_app, last_success: minutes(5) }));
      assert.equal(res, null, `src_app=${JSON.stringify(src_app)} must not admit oracle evidence`);
    }
  });

  await t.test("re-open ignores scope (recurrence is the incident's own evidence)", () => {
    const res = nextState(
      facts({ state: STATE.RESOLVED, src_app: "hhm_rpp_ge", resolved_last_seen: T0, last_seen: minutes(1) })
    );
    assert.deepEqual(res, { state: STATE.RECURRING });
  });
});

test("state: auto-close on staleness", async (t) => {
  await t.test(`quiet for MORE than ${STALE_AFTER_DAYS} days → resolved/stale`, () => {
    const res = nextState(
      facts({ last_seen: T0, eval_time: new Date(days(STALE_AFTER_DAYS).getTime() + 1000) })
    );
    assert.deepEqual(res, { state: STATE.RESOLVED, resolved_reason: RESOLVED_REASON.STALE });
  });

  await t.test("the boundary is strict: exactly N days does NOT close", () => {
    assert.equal(nextState(facts({ eval_time: days(STALE_AFTER_DAYS) })), null);
  });

  await t.test("the live quiet-1-3d hump (50 incidents between recurrences) must survive", () => {
    for (const quietDays of [1, 2, 3, STALE_AFTER_DAYS - 1]) {
      assert.equal(
        nextState(facts({ eval_time: days(quietDays) })),
        null,
        `quiet ${quietDays}d must not be stale-closed`
      );
    }
  });

  await t.test("PRECEDENCE: recovery beats staleness when both apply", () => {
    // An incident quiet for 10 days on an entity that also recovered records
    // the STRONGER reason — positive evidence, not absence of failure.
    const res = nextState(
      facts({ last_success: minutes(5), eval_time: days(10) })
    );
    assert.equal(res.resolved_reason, RESOLVED_REASON.AUTO_RECOVERY);
  });

  await t.test("staleness closes acknowledged too", () => {
    const res = nextState(facts({ state: STATE.ACKNOWLEDGED, eval_time: days(10) }));
    assert.deepEqual(res, { state: STATE.RESOLVED, resolved_reason: RESOLVED_REASON.STALE });
  });

  await t.test("a missing/invalid eval_time disables staleness, never enables it", () => {
    for (const eval_time of [null, undefined, "not a date"]) {
      assert.equal(nextState(facts({ eval_time, last_seen: days(-30) })), null);
    }
  });
});

test("state: re-open", async (t) => {
  const resolvedFacts = (over = {}) =>
    facts({ state: STATE.RESOLVED, resolved_last_seen: T0, ...over });

  await t.test("recurrence after the memento → recurring (NOT plain open)", () => {
    // recurring has exactly one meaning: it came back after we closed it.
    const res = nextState(resolvedFacts({ last_seen: minutes(1) }));
    assert.deepEqual(res, { state: STATE.RECURRING });
  });

  await t.test("THE SKEW CASE: last_seen behind resolved_at but past the memento MUST re-open", () => {
    // The re-evaluation's correctness finding, pinned: resolved_at (DB clock)
    // plays NO role. A producer whose clock trails the DB emits recurrences
    // whose dt is below resolved_at forever — comparing against the
    // producer-clock memento re-opens anyway. There is no resolved_at in the
    // facts at all; this test documents that its absence is the design.
    const res = nextState(resolvedFacts({ last_seen: minutes(1) }));
    assert.deepEqual(res, { state: STATE.RECURRING });
    assert.ok(!("resolved_at" in facts()), "resolved_at must not be a transition input");
  });

  await t.test("no recurrence past the memento → stays resolved", () => {
    assert.equal(nextState(resolvedFacts({ last_seen: T0 })), null);
    assert.equal(nextState(resolvedFacts({ last_seen: minutes(-5) })), null);
  });

  await t.test("a resolved row WITHOUT a memento re-opens (unverifiable close must not mask)", () => {
    // Fail-visible, same direction as the assessor's provenance gate: a close
    // this engine cannot verify is not allowed to hide recurrences forever.
    const res = nextState(resolvedFacts({ resolved_last_seen: null }));
    assert.deepEqual(res, { state: STATE.RECURRING });
  });

  await t.test("a re-opened (recurring) incident can resolve AGAIN", () => {
    const res = nextState(facts({ state: STATE.RECURRING, last_success: minutes(2) }));
    assert.deepEqual(res, { state: STATE.RESOLVED, resolved_reason: RESOLVED_REASON.AUTO_RECOVERY });
  });

  await t.test("resolved incidents are NOT re-closed (resolved_at stamped once)", () => {
    // A resolved row with newer recovery evidence but no recurrence stays
    // exactly as it is — re-running must not refresh resolved_at/reason.
    assert.equal(nextState(resolvedFacts({ last_success: minutes(10), last_seen: T0 })), null);
  });
});

test("state: the human-reserved states", async (t) => {
  await t.test("suppressed is ENGINE-TERMINAL — no transition, whatever the evidence", () => {
    for (const over of [
      {},
      { last_success: minutes(5) },
      { eval_time: days(30) },
      { last_seen: minutes(10), resolved_last_seen: T0 },
    ]) {
      assert.equal(
        nextState(facts({ state: STATE.SUPPRESSED, ...over })),
        null,
        `suppressed must never transition (${JSON.stringify(over)})`
      );
    }
  });

  await t.test("the engine can NEVER produce acknowledged or suppressed", () => {
    // Sweep a broad fact space and assert every transition lands in
    // ENGINE_STATES — the structural promise that ack/suppress are human-only.
    const states = [null, ...Object.values(STATE)];
    const successes = [null, minutes(-10), T0, minutes(10)];
    const evals = [T0, days(3), days(10)];
    for (const state of states) {
      for (const last_success of successes) {
        for (const eval_time of evals) {
          const res = nextState(facts({ state, last_success, eval_time, resolved_last_seen: T0 }));
          if (res) {
            assert.ok(
              ENGINE_STATES.includes(res.state),
              `engine produced non-engine state ${res.state} from ${state}`
            );
          }
        }
      }
    }
  });

  await t.test("an unrecognized state string is left alone, not clobbered", () => {
    assert.equal(nextState(facts({ state: "weird_future_state", last_success: minutes(5) })), null);
  });
});

test("state: purity and determinism", async (t) => {
  await t.test("deliberately SYNCHRONOUS — an async (I/O) impl cannot slot in", () => {
    const res = nextState(facts({ state: null }));
    assert.ok(!(res instanceof Promise), "nextState must not return a Promise");
  });

  await t.test("same facts → same transition, repeatedly; input not mutated", () => {
    const f = facts({ state: null, last_success: minutes(5) });
    const snapshot = JSON.parse(JSON.stringify(f));
    const a = nextState(f);
    const b = nextState(f);
    const c = nextState({ ...f });
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    assert.deepEqual(JSON.parse(JSON.stringify(f)), snapshot);
  });

  await t.test("accepts Dates and ISO strings interchangeably", () => {
    const asDates = nextState(facts({ last_success: minutes(5) }));
    const asStrings = nextState(
      facts({
        last_seen: T0.toISOString(),
        last_success: minutes(5).toISOString(),
        eval_time: T0.toISOString(),
      })
    );
    assert.deepEqual(asDates, asStrings);
  });

  await t.test("garbage facts never throw and never close", () => {
    // Empty facts = an uninitialized row with nothing known: init to open,
    // close nothing.
    assert.deepEqual(nextState({}), { state: STATE.OPEN });
    const res = nextState({ state: STATE.OPEN, last_seen: "garbage", eval_time: days(30) });
    assert.equal(res, null, "an unparseable last_seen must disable closes, not enable them");
  });

  await t.test("a missing facts object initializes rather than throwing", () => {
    assert.deepEqual(nextState(undefined), { state: STATE.OPEN });
  });
});
