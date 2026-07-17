// test/sql-modules-load.test.js — the cheapest possible guard against a class of
// bug that has now shipped TWICE in this repo.
//
// WHY THIS EXISTS:
// The SQL lives in JS **template literals**. A markdown backtick in an explanatory
// comment inside one of those literals terminates the string and turns the module
// into a SyntaxError — and NOTHING in the unit suite catches it, because no unit
// test has any reason to require a SQL module. The pure domain tests import
// domain/*; the SQL modules are only ever loaded by the jobs, which need a
// database. So the suite goes green and the next real run dies at require() time.
//
// History:
//   * Phase 3, round-3 review: a note added backticks inside UPSERT_INCIDENTS_SQL
//     → require broke → 48/48 green → caught only by running `assess`.
//   * Phase 4, review-fix round: the SAME mistake, in the SAME file, in a comment
//     explaining the category_source refresh guard → 101/101 green → caught only
//     by running `assess`.
//
// Twice is a pattern, and "remember not to type a backtick" is not a control. This
// test simply LOADS every module that owns SQL and asserts the exports are
// non-empty strings. It needs no database (these modules build strings; they do
// not connect), runs in milliseconds, and would have failed instantly both times.
//
// If you add a module that owns SQL, add it here.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Every module whose export is (or contains) SQL text. Requiring them is the test:
// a broken template literal throws at require() time.
const SQL_MODULES = [
  "../utils/db/queries/incidents",
  "../utils/db/queries/materialize",
  "../utils/db/queries/assess",
  "../utils/db/queries/enrichment",
  "../utils/db/queries/recovery",
];

test("SQL modules load and export usable SQL", async (t) => {
  for (const path of SQL_MODULES) {
    await t.test(`${path} requires without a SyntaxError`, () => {
      // The assertion IS the require: an unbalanced template literal (a stray
      // backtick in a comment) makes this throw.
      const mod = require(path);
      assert.ok(mod && typeof mod === "object", `${path} exported nothing usable`);

      for (const [name, value] of Object.entries(mod)) {
        assert.equal(typeof value, "string", `${path}: export ${name} should be SQL text`);
        assert.ok(value.trim().length > 0, `${path}: export ${name} is empty`);
        // A terminated-early template literal usually still parses when the stray
        // backtick pairs with a later one — leaving a truncated string with JS
        // fragments spliced in. Catch that shape too rather than only SyntaxErrors.
        assert.ok(
          !value.includes("`"),
          `${path}: export ${name} contains a backtick — it is built from a template literal, so this is almost certainly a broken string`
        );
      }
    });
  }
});

test("the aggregate upsert is still structurally intact", async (t) => {
  // A stray backtick can silently TRUNCATE the SQL rather than throw. These pin
  // the statement's landmarks, so a half-eaten query fails here instead of at
  // 2am against the live database.
  const { UPSERT_INCIDENTS_SQL } = require("../utils/db/queries/incidents");

  await t.test("carries every clause the aggregate depends on", () => {
    for (const landmark of [
      "WITH batch AS",
      "INSERT INTO incidents.incidents",
      "ON CONFLICT (fingerprint, entity) DO UPDATE",
      "RETURNING (xmax = 0) AS inserted",
    ]) {
      assert.ok(UPSERT_INCIDENTS_SQL.includes(landmark), `upsert is missing: ${landmark}`);
    }
  });

  await t.test("still writes the Phase 4 columns", () => {
    // If a future edit drops these from the INSERT list, incidents get a NULL
    // type / provenance and the assessor silently falls back to unknown.
    assert.ok(UPSERT_INCIDENTS_SQL.includes("category_source"), "upsert no longer writes category_source");
    assert.match(UPSERT_INCIDENTS_SQL, /category, category_source, error_type, type, phase, func/);
  });

  await t.test("the enrichment CTE was interpolated, not left as a placeholder", () => {
    // These are ${}-interpolated from enrichment.js; a rename would leave the
    // literal text behind or produce "undefined" inside the SQL.
    assert.ok(!UPSERT_INCIDENTS_SQL.includes("${"), "an interpolation was not evaluated");
    assert.ok(!UPSERT_INCIDENTS_SQL.includes("undefined"), "an interpolation resolved to undefined");
    assert.ok(UPSERT_INCIDENTS_SQL.includes("sys_enrich AS"), "the enrichment CTE is missing");
  });
});

test("the recovery lookup admits only provenance-linked evidence", async (t) => {
  const { RECOVERY_SQL, ORACLE_PROVENANCE_AUDIT_SQL } = require("../utils/db/queries/recovery");

  await t.test("the semi-join to data_acquisition runs is present (round-2 residual)", () => {
    // Dropping this link silently reverts the oracle to accepting evidence
    // from any future producer — the exact regression round 2 named.
    assert.ok(RECOVERY_SQL.includes("l.app_name = 'data_acquisition'"), "provenance semi-join missing");
    assert.ok(RECOVERY_SQL.includes("l.run_id = ah.run_id"), "run link missing");
    // Data-Contract Rule: the app_run_logs scan must be time-bounded to prune.
    assert.ok(RECOVERY_SQL.includes("l.inserted_at >"), "app_run_logs scan is unbounded");
  });

  await t.test("the audit query watches both anomaly shapes", () => {
    assert.ok(ORACLE_PROVENANCE_AUDIT_SQL.includes("foreign_rows"));
    assert.ok(ORACLE_PROVENANCE_AUDIT_SQL.includes("unlinked_rows"));
  });
});

test("the dossier SELECT carries what the assessor needs", async (t) => {
  const { SELECT_DOSSIERS_SQL, UPDATE_ASSESSMENT_WHERE } = require("../utils/db/queries/assess");

  await t.test("selects the fields the dossier contract promises", () => {
    // The assessor cannot ask for these itself (it is pure) — if the SELECT drops
    // one, every dossier silently carries undefined and the rules fail open.
    for (const field of ["category_source", "i.type", "entity_count", "occurrence_count"]) {
      assert.ok(SELECT_DOSSIERS_SQL.includes(field), `dossier SELECT is missing: ${field}`);
    }
  });

  await t.test("the update predicate is ONLY a predicate", () => {
    // Phase 4 lesson: appending a SET assignment here produced a 42601 on every
    // run with a fully green suite. Anything to assign belongs in the ColumnSet.
    assert.match(UPDATE_ASSESSMENT_WHERE.trim(), /^WHERE /);
    assert.ok(!/\bset\b|=/i.test(UPDATE_ASSESSMENT_WHERE.replace(/v\.id = t\.id/, "")));
  });
});
