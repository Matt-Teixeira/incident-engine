// test/assessor-rules.test.js — the deterministic assessor (Phase 4).
//
// SCOPE NOTE (read before trusting a green run): these tests cover the PURE
// assessor only. They cannot see the dossier assembly, the write path, or the
// ASSESSOR_KIND selection against a real database — Phase 3 shipped three
// defects that unit tests structurally could not catch. The seam's selection
// logic is tested here because resolveKind() was written to be pure for exactly
// that reason; the SQL is validated by running the job (PHASE_LOG Phase 4).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assess, BLAST_RADIUS_ENTITIES, TAXONOMY, RULES_VERSION } = require("../domain/assessor/rules");
const { SEVERITIES, SEVERITY, EVENT_TYPE } = require("../domain/assessor/contract");
const { getAssessor, resolveKind, DEFAULT_KIND } = require("../domain/assessor");
const { connection_regexes } = require("../utils/classify/connection_regex");

// A minimal valid dossier; each test overrides only what it is about.
const dossier = (over = {}) => ({
  category: "unknown",
  // the provenance gate (R0) trusts ONLY an explicit 'classifier'; fixtures that
  // exercise category rules must say so, exactly as the job's dossier does.
  category_source: "classifier",
  type: "ERROR",
  entity_count: 1,
  occurrence_count: 1,
  entity: "SME00001",
  func: "someFunc",
  first_seen: "2026-07-16T00:00:00Z",
  last_seen: "2026-07-16T01:00:00Z",
  sample_message: "a message",
  ...over,
});

// The caller-set categories: not in connection_regexes (classify() returns
// 'unknown' when nothing matched; 'hanging_exec' is set on exec timeout).
const CALLER_SET = ["unknown", "hanging_exec"];
const ALL_CATEGORIES = [...Object.keys(TAXONOMY), ...CALLER_SET];

test("assessor: shape and universal invariants", async (t) => {
  await t.test("every category in the vocabulary resolves, for BOTH types", async () => {
    // Enumerated from the REAL taxonomy rather than a hand-written list — a
    // hand-written list is exactly how the phase prompt came to claim there are
    // 19 categories when connection_regex.js holds 20.
    for (const category of ALL_CATEGORIES) {
      for (const type of [EVENT_TYPE.WARN, EVENT_TYPE.ERROR]) {
        const res = await assess(dossier({ category, type }));
        assert.ok(
          SEVERITIES.includes(res.severity),
          `${category}/${type} produced a non-vocabulary severity: ${res.severity}`
        );
        assert.equal(res.category, category, `${category}/${type} did not echo its category`);
        assert.ok(res.reasons.length > 0, `${category}/${type} produced no reason`);
        assert.ok(
          typeof res.recommendedAction === "string" && res.recommendedAction.length > 0,
          `${category}/${type} produced no recommendedAction`
        );
        assert.ok(
          res.confidence > 0 && res.confidence <= 1,
          `${category}/${type} confidence out of range: ${res.confidence}`
        );
        // confidence is NUMERIC(3,2): more precision than 2dp would be rounded
        // by the DB, making the stored row differ from the pure result.
        assert.equal(
          res.confidence,
          Math.round(res.confidence * 100) / 100,
          `${category}/${type} confidence is not 2dp: ${res.confidence}`
        );
      }
    }
  });

  await t.test("the taxonomy really does hold 20 categories (22 with caller-set)", () => {
    // Pins the count the docs and prompt state, so a taxonomy change forces the
    // docs to be revisited instead of drifting silently.
    assert.equal(Object.keys(TAXONOMY).length, 20);
    assert.equal(ALL_CATEGORIES.length, 22);
  });

  await t.test("TAXONOMY mirrors connection_regex.js exactly", () => {
    // The rules dispatch on these flags, so a first-entry-wins build that
    // disagreed with the table would silently mis-severity a whole family.
    for (const entry of connection_regexes) {
      const built = TAXONOMY[entry.error_category];
      assert.ok(built, `category ${entry.error_category} missing from TAXONOMY`);
      assert.equal(built.error_type, entry.error_type, entry.error_category);
      assert.equal(built.manual_intervention, entry.manual_intervention === true, entry.error_category);
      assert.equal(
        built.successful_acquisition,
        entry.successful_acquisition === true,
        entry.error_category
      );
    }
  });

  await t.test("an AssessResult can never carry state or resolution (Phase 5 boundary)", async () => {
    for (const category of ALL_CATEGORIES) {
      const res = await assess(dossier({ category }));
      for (const forbidden of ["state", "resolved_at", "resolved_reason", "action_state", "action_ref"]) {
        assert.ok(!(forbidden in res), `${category} leaked a ${forbidden} field into the assessment`);
      }
    }
  });
});

test("assessor: determinism and purity", async (t) => {
  await t.test("same dossier → identical result, repeatedly", async () => {
    for (const category of ALL_CATEGORIES) {
      const d = dossier({ category, type: "ERROR", entity_count: 30 });
      const a = await assess(d);
      const b = await assess(d);
      const c = await assess({ ...d });
      assert.deepEqual(a, b);
      assert.deepEqual(a, c);
    }
  });

  await t.test("assess does not mutate the dossier it is handed", async () => {
    const d = dossier({ category: "credentials", type: "ERROR" });
    const snapshot = JSON.parse(JSON.stringify(d));
    await assess(d);
    assert.deepEqual(d, snapshot);
  });

  await t.test("result is independent of call order (no hidden accumulator)", async () => {
    const warn = dossier({ category: "rsync_io_timeout", type: "WARN" });
    const err = dossier({ category: "rsync_io_timeout", type: "ERROR", entity_count: 59 });
    const warnFirst = [await assess(warn), await assess(err)];
    const errFirst = [await assess(err), await assess(warn)];
    assert.deepEqual(warnFirst[0], errFirst[1]);
    assert.deepEqual(warnFirst[1], errFirst[0]);
  });

  await t.test("assess is async (an LLM impl needs no signature change)", () => {
    const returned = assess(dossier());
    assert.ok(returned instanceof Promise, "assess must return a Promise");
    return returned;
  });
});

test("assessor: unknown → interim medium for BOTH types (round-2 M2 decision)", async (t) => {
  // Decision history matters here — see the R1 comment in rules.js. Step 3
  // type-split this (WARN → info as "noise"); review round 2 held F2 open on it
  // because the WARN bucket contains CONFIRMED hard failures (JOB HALTED, 28k
  // events). Developer decision 2026-07-16: interim medium for both types until
  // the hard-failure messages are classified out of `unknown` (follow-up phase).
  await t.test("unknown + WARN → medium — never info, and it says why", async () => {
    const res = await assess(dossier({ category: "unknown", type: "WARN" }));
    assert.equal(res.severity, SEVERITY.MEDIUM);
    assert.equal(res.confidence, 0.3);
    assert.ok(res.reasons.includes("unclassified — needs pattern"));
    assert.ok(
      res.reasons.some((r) => r.includes("interim severity")),
      "the WARN branch must record that medium is an interim M2 decision"
    );
    assert.ok(!res.recommendedAction.startsWith("No action"));
  });

  await t.test("unknown + ERROR → medium, ~0.3 confidence, 'unclassified — needs pattern'", async () => {
    const res = await assess(dossier({ category: "unknown", type: "ERROR" }));
    assert.equal(res.severity, SEVERITY.MEDIUM);
    assert.equal(res.confidence, 0.3);
    assert.ok(res.reasons.includes("unclassified — needs pattern"));
  });

  await t.test("type moves severity NOWHERE: WARN and ERROR agree for every category", async () => {
    // The invariant the M2 decision completed: WARN may lower confidence, never
    // severity — with no exceptions left.
    for (const category of ALL_CATEGORIES) {
      for (const entity_count of [1, BLAST_RADIUS_ENTITIES, 59]) {
        const warn = await assess(dossier({ category, type: "WARN", entity_count }));
        const err = await assess(dossier({ category, type: "ERROR", entity_count }));
        assert.equal(warn.severity, err.severity, `${category} @${entity_count}: type moved severity`);
      }
    }
  });

  await t.test("unknown never escalates on blast radius", async () => {
    // An unrecognized message is not evidence of a fleet-wide fault, however
    // many entities share it.
    const wide = await assess(dossier({ category: "unknown", type: "ERROR", entity_count: 59 }));
    assert.equal(wide.severity, SEVERITY.MEDIUM);
  });
});

test("assessor: manual_intervention is looked up by category, not hand-listed", async (t) => {
  const manualCats = Object.keys(TAXONOMY).filter(
    (c) => TAXONOMY[c].manual_intervention && !TAXONOMY[c].successful_acquisition
  );

  await t.test("every manual_intervention category → high on ERROR", async () => {
    assert.ok(manualCats.length > 0, "fixture check: taxonomy has manual_intervention categories");
    for (const category of manualCats) {
      const res = await assess(dossier({ category, type: "ERROR" }));
      assert.equal(res.severity, SEVERITY.HIGH, `${category} should be high on ERROR`);
      assert.equal(res.confidence, 0.9);
    }
  });

  await t.test("the categories the prompt named are covered by the flag lookup", async () => {
    // Pins the prompt's explicit requirement (credentials / host_key_changed →
    // high) while proving it falls out of the taxonomy lookup rather than a
    // hard-coded branch.
    for (const category of ["credentials", "host_key_changed"]) {
      assert.ok(manualCats.includes(category), `${category} must come from the flag lookup`);
      const res = await assess(dossier({ category, type: "ERROR" }));
      assert.equal(res.severity, SEVERITY.HIGH);
    }
  });

  await t.test("manual_intervention + WARN stays HIGH — WARN only costs confidence", async () => {
    // Phase 4 review (MEDIUM): an earlier cut capped this at medium on the theory
    // that WARN meant the run continued. Producers log real failures as WARN
    // (exec-hhm_data_grab.js logs a connection error as WARN then returns false),
    // so a broken credential is broken whatever the label says.
    for (const category of manualCats) {
      const res = await assess(dossier({ category, type: "WARN" }));
      assert.equal(res.severity, SEVERITY.HIGH, `${category} must stay high on WARN`);
      assert.equal(res.confidence, 0.75);
      assert.ok(
        !res.reasons.some((r) => /absorbed|run continued|not urgent/i.test(r)),
        `${category} must not claim the run recovered`
      );
    }
  });
});

test("assessor: successful_acquisition outranks manual_intervention", async (t) => {
  await t.test("permission_denied_partial (both flags) → low, not high", async () => {
    // The ONLY category carrying both flags, and the exact collision between the
    // prompt's two rules. Data was acquired → cannot be high; a human is flagged
    // → cannot be info.
    const tax = TAXONOMY.permission_denied_partial;
    assert.equal(tax.manual_intervention, true, "fixture check");
    assert.equal(tax.successful_acquisition, true, "fixture check");

    for (const type of ["ERROR", "WARN"]) {
      const res = await assess(dossier({ category: "permission_denied_partial", type }));
      assert.equal(res.severity, SEVERITY.LOW);
      assert.ok(res.reasons.some((r) => r.includes("data was acquired")));
      assert.ok(res.reasons.some((r) => r.includes("manual_intervention")));
    }
  });

  await t.test("data-acquired categories without a human flag → info", async () => {
    const benign = Object.keys(TAXONOMY).filter(
      (c) => TAXONOMY[c].successful_acquisition && !TAXONOMY[c].manual_intervention
    );
    assert.deepEqual(benign.sort(), ["file_missing_partial", "mirror_file_skipped", "rsync_partial"]);
    for (const category of benign) {
      const res = await assess(dossier({ category, type: "ERROR" }));
      assert.equal(res.severity, SEVERITY.INFO, `${category} should be info`);
    }
  });

  await t.test("the *_partial families the prompt named all land low/info", async () => {
    for (const category of ["rsync_partial", "file_missing_partial", "permission_denied_partial"]) {
      const res = await assess(dossier({ category, type: "ERROR" }));
      assert.ok([SEVERITY.LOW, SEVERITY.INFO].includes(res.severity), `${category} → ${res.severity}`);
    }
  });

  await t.test("data-acquired categories never escalate on blast radius", async () => {
    const res = await assess(dossier({ category: "rsync_partial", type: "ERROR", entity_count: 59 }));
    assert.equal(res.severity, SEVERITY.INFO);
  });
});

test("assessor: transport blast-radius escalation", async (t) => {
  const transportCats = Object.keys(TAXONOMY).filter(
    (c) =>
      TAXONOMY[c].error_type === "connection" &&
      !TAXONOMY[c].manual_intervention &&
      !TAXONOMY[c].successful_acquisition
  );

  await t.test("all 10 connection-family categories escalate (not just the prompt's four)", () => {
    assert.equal(transportCats.length, 10);
    // The prompt named only these four; the other six are the same kind of fault
    // and would have fallen to the default under a hand-listed rule.
    for (const named of ["host_unreachable", "connection_timeout", "connection_reset", "rsync_io_timeout"]) {
      assert.ok(transportCats.includes(named));
    }
    for (const omitted of ["max_retries", "session_timeout", "rsync_protocol_error", "http2_cancel"]) {
      assert.ok(transportCats.includes(omitted), `${omitted} must resolve via the transport rule`);
    }
  });

  await t.test(`ERROR at exactly the ${BLAST_RADIUS_ENTITIES}-entity boundary → high`, async () => {
    for (const category of transportCats) {
      const res = await assess(dossier({ category, type: "ERROR", entity_count: BLAST_RADIUS_ENTITIES }));
      assert.equal(res.severity, SEVERITY.HIGH, `${category} at the threshold should be high`);
    }
  });

  await t.test(`ERROR one BELOW the boundary → medium`, async () => {
    for (const category of transportCats) {
      const res = await assess(
        dossier({ category, type: "ERROR", entity_count: BLAST_RADIUS_ENTITIES - 1 })
      );
      assert.equal(res.severity, SEVERITY.MEDIUM, `${category} below the threshold should be medium`);
    }
  });

  await t.test("the boundary is inclusive and monotone across the live 1..59 range", async () => {
    const seen = [];
    for (let n = 1; n <= 59; n++) {
      const res = await assess(dossier({ category: "rsync_io_timeout", type: "ERROR", entity_count: n }));
      seen.push(res.severity);
    }
    // medium below, high from the threshold on — never oscillating.
    for (let n = 1; n <= 59; n++) {
      const expected = n >= BLAST_RADIUS_ENTITIES ? SEVERITY.HIGH : SEVERITY.MEDIUM;
      assert.equal(seen[n - 1], expected, `entity_count=${n}`);
    }
  });

  await t.test("WARN transport escalates exactly like ERROR — only confidence differs", async () => {
    // Phase 4 review (MEDIUM): the old WARN cap rested on "WARN ⇒ the fault was
    // absorbed", which the producer code refutes. WARN now costs confidence only.
    for (const category of transportCats) {
      for (const entity_count of [1, BLAST_RADIUS_ENTITIES - 1, BLAST_RADIUS_ENTITIES, 59]) {
        const warn = await assess(dossier({ category, type: "WARN", entity_count }));
        const err = await assess(dossier({ category, type: "ERROR", entity_count }));
        assert.equal(warn.severity, err.severity, `${category} @${entity_count}: WARN must not cap severity`);
        assert.ok(warn.confidence < err.confidence, `${category}: WARN should lower confidence`);
      }
    }
  });

  await t.test("no branch anywhere claims WARN means the run recovered", async () => {
    // The false claim that caused the MEDIUM finding. Pinned across the whole
    // vocabulary so it cannot creep back into a reason string.
    for (const category of ALL_CATEGORIES) {
      const res = await assess(dossier({ category, type: "WARN", entity_count: 30 }));
      for (const reason of res.reasons) {
        assert.ok(
          !/absorbed|run continued|fault was absorbed|survived/i.test(reason),
          `${category}/WARN asserts recovery: "${reason}"`
        );
      }
    }
  });
});

test("assessor: file-family and documented defaults", async (t) => {
  await t.test("rsync_source_missing (file, no flags) → medium on BOTH types", async () => {
    // Review (MEDIUM): expected data is missing either way; the producer's label
    // does not change that, so it costs confidence rather than severity.
    const err = await assess(dossier({ category: "rsync_source_missing", type: "ERROR" }));
    assert.equal(err.severity, SEVERITY.MEDIUM);
    assert.equal(err.confidence, 0.7);
    const warn = await assess(dossier({ category: "rsync_source_missing", type: "WARN" }));
    assert.equal(warn.severity, SEVERITY.MEDIUM);
    assert.equal(warn.confidence, 0.6);
  });

  await t.test("hanging_exec resolves explicitly, not via the default", async () => {
    const err = await assess(dossier({ category: "hanging_exec", type: "ERROR" }));
    assert.equal(err.severity, SEVERITY.MEDIUM);
    assert.equal(err.confidence, 0.5);
    assert.ok(err.reasons.some((r) => r.includes("exec timeout")));
    // Review (MEDIUM): a command that blew its timeout did not complete, whatever
    // the producer labeled it — WARN lowers confidence, not severity.
    const warn = await assess(dossier({ category: "hanging_exec", type: "WARN" }));
    assert.equal(warn.severity, SEVERITY.MEDIUM);
    assert.equal(warn.confidence, 0.4);
  });

  await t.test("a category outside the taxonomy → medium, low confidence, names itself", async () => {
    const res = await assess(dossier({ category: "some_future_category", type: "ERROR" }));
    assert.equal(res.severity, SEVERITY.MEDIUM);
    assert.equal(res.confidence, 0.2);
    assert.ok(res.reasons.some((r) => r.includes("some_future_category")));
    // Must not hide (info) and must not cry wolf (high).
    assert.notEqual(res.severity, SEVERITY.INFO);
    assert.notEqual(res.severity, SEVERITY.HIGH);
  });
});

test("assessor: fail-safe input handling", async (t) => {
  await t.test("a missing/garbled type is treated as ERROR, never downgraded", async () => {
    // Fail-safe: a null type must not let a real failure be scored as absorbed
    // WARN noise.
    for (const type of [null, undefined, "", "warn", "Warn", "INFO", 7]) {
      const res = await assess(dossier({ category: "rsync_io_timeout", type, entity_count: 59 }));
      assert.equal(res.severity, SEVERITY.HIGH, `type=${JSON.stringify(type)} must behave as ERROR`);
    }
  });

  await t.test("a missing/absurd entity_count floors at 1 (never escalates)", async () => {
    for (const entity_count of [null, undefined, 0, -5, NaN, "22"]) {
      const res = await assess(dossier({ category: "rsync_io_timeout", type: "ERROR", entity_count }));
      assert.equal(
        res.severity,
        SEVERITY.MEDIUM,
        `entity_count=${JSON.stringify(entity_count)} must not escalate`
      );
    }
  });

  await t.test("a missing category is assessed as unknown, not crashed on", async () => {
    for (const category of [null, undefined, ""]) {
      const res = await assess(dossier({ category, type: "WARN" }));
      assert.equal(res.severity, SEVERITY.MEDIUM);
      assert.equal(res.category, "unknown");
    }
  });

  await t.test("an empty dossier does not throw", async () => {
    const res = await assess({});
    assert.ok(SEVERITIES.includes(res.severity));
  });

  await t.test("a fractional entity_count floors rather than straddling the boundary", async () => {
    const res = await assess(
      dossier({ category: "rsync_io_timeout", type: "ERROR", entity_count: 21.9 })
    );
    assert.equal(res.severity, SEVERITY.MEDIUM);
  });
});

test("assessor seam: ASSESSOR_KIND selection", async (t) => {
  await t.test("defaults to the deterministic rules impl", () => {
    assert.equal(resolveKind({}), DEFAULT_KIND);
    assert.equal(resolveKind({ ASSESSOR_KIND: "" }), "rules");
    assert.equal(resolveKind({ ASSESSOR_KIND: "  " }), "rules");
    assert.equal(resolveKind({ ASSESSOR_KIND: " rules " }), "rules");
  });

  await t.test("an unknown kind throws instead of silently defaulting", () => {
    // A typo'd ASSESSOR_KIND must fail the run, not quietly assess the whole
    // table with an implementation the operator did not ask for.
    assert.throws(() => resolveKind({ ASSESSOR_KIND: "llm" }), /not a known assessor/);
    assert.throws(() => resolveKind({ ASSESSOR_KIND: "rulez" }), /not a known assessor/);
  });

  await t.test("getAssessor returns the impl plus its provenance", async () => {
    const { kind, version, assess: fn } = getAssessor({});
    assert.equal(kind, "rules");
    assert.equal(version, RULES_VERSION);
    const res = await fn(dossier({ category: "credentials", type: "ERROR" }));
    assert.equal(res.severity, SEVERITY.HIGH);
  });

  await t.test("there is NO llm implementation registered (Phase 4 non-goal)", () => {
    assert.throws(() => getAssessor({ ASSESSOR_KIND: "llm" }), /not a known assessor/);
  });
});

test("assessor: category provenance gate (review, HIGH finding)", async (t) => {
  // Phase 3 fills an `unknown` category with the latest non-unknown category for
  // the same system_id — time- and run-uncorrelated. Live, all 40 oracle-sourced
  // incidents carried a category absent from their own L0 events, and the first
  // cut of these rules duly rated "No new monitoring data found." as a fleet-wide
  // rsync_io_timeout and four "No new file data" incidents as `credentials`.

  await t.test("an oracle-sourced category is assessed as unknown, not as itself", async () => {
    for (const category of ["rsync_io_timeout", "credentials", "host_unreachable", "host_key_changed"]) {
      const res = await assess(
        dossier({ category, category_source: "oracle", type: "ERROR", entity_count: 59 })
      );
      assert.equal(res.category, "unknown", `${category} from the oracle must resolve as unknown`);
      // and therefore must NOT inherit that category's severity
      assert.notEqual(res.severity, SEVERITY.HIGH, `${category} from the oracle must not be high`);
    }
  });

  await t.test("the exact live regressions the HIGH finding found", async () => {
    // Both resolve as unknown (oracle gate) → interim medium (M2 decision). The
    // point pinned here is that neither inherits its ORACLE category's severity:
    // no blast-radius high, no credentials high.
    const noise = await assess(
      dossier({ category: "rsync_io_timeout", category_source: "oracle", type: "WARN", entity_count: 42 })
    );
    assert.equal(noise.category, "unknown");
    assert.equal(noise.severity, SEVERITY.MEDIUM);

    const creds = await assess(
      dossier({ category: "credentials", category_source: "oracle", type: "WARN" })
    );
    assert.equal(creds.category, "unknown");
    assert.equal(creds.severity, SEVERITY.MEDIUM);
  });

  await t.test("the discarded oracle category is surfaced, not silently dropped", async () => {
    const res = await assess(dossier({ category: "rsync_io_timeout", category_source: "oracle", type: "ERROR" }));
    assert.ok(
      res.reasons.some((r) => r.includes("rsync_io_timeout") && r.includes("oracle")),
      "the assessment must record which category was rejected and why"
    );
  });

  await t.test("a classifier-sourced category is trusted normally", async () => {
    const res = await assess(
      dossier({ category: "credentials", category_source: "classifier", type: "ERROR" })
    );
    assert.equal(res.severity, SEVERITY.HIGH);
    assert.equal(res.category, "credentials");
  });

  await t.test("FAIL-LOUD: missing/invalid provenance → medium, never info (round 2)", async () => {
    // Round 1 treated these as oracle ⇒ unknown, which failed QUIET: a stored
    // credentials/WARN row with a NULL provenance landed at info ("no action") —
    // a known failure buried by a bookkeeping bug, with reasons falsely blaming
    // the oracle. Round 2: a writer/migration gap is its own state — medium,
    // 0.2 confidence (trips the job's WARN log), type-independent.
    for (const category_source of [null, undefined, "", "ORACLE", "classifer" /* typo */]) {
      for (const type of ["WARN", "ERROR"]) {
        const res = await assess(dossier({ category: "credentials", category_source, type }));
        assert.equal(
          res.category,
          "unknown",
          `category_source=${JSON.stringify(category_source)} must not be trusted`
        );
        assert.equal(
          res.severity,
          SEVERITY.MEDIUM,
          `category_source=${JSON.stringify(category_source)}/${type} must be medium — the reviewer's quiet-fail case was credentials/WARN → info`
        );
        assert.equal(res.confidence, 0.2);
        assert.ok(
          res.reasons.some((r) => /provenance is missing or invalid/.test(r)),
          "must name the gap, not blame the oracle"
        );
        assert.ok(
          !res.reasons.some((r) => r.includes("came from the recovery oracle")),
          "must not claim an oracle source it cannot know"
        );
        // round-3 review (low): the remediation must point at the DATA gap, not
        // at the rules table — "add an assessor rule" would misdirect operators.
        assert.ok(
          res.recommendedAction.includes("category_source"),
          "action must direct the operator to repair provenance, not to add a rule"
        );
      }
    }
  });

  await t.test("provenance cannot rescue a genuinely unknown category", async () => {
    const res = await assess(dossier({ category: "unknown", category_source: "classifier", type: "WARN" }));
    assert.equal(res.severity, SEVERITY.MEDIUM);
    // no oracle reason, because nothing was discarded
    assert.ok(!res.reasons.some((r) => r.includes("oracle")));
  });
});
