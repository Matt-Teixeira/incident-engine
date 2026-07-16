// domain/assessor/index.js — the ASSESSOR SEAM: selects an `assess(dossier)`
// implementation by ASSESSOR_KIND and reports which one (+ its version) so the
// job can stamp provenance on every row it writes.
//
// WHY A SEAM AT ALL (Determinism Rule): the rules implementation is the only one
// today and no LLM implementation exists or is being built here. The seam exists
// so that a future LLM assessor is a config change behind the SAME async
// `assess(dossier)` signature — never a pipeline rework. Two invariants make
// that safe, and both are structural rather than conventional:
//
//   1. ADVISORY ONLY. Whatever implementation runs, its output lands in
//      severity/confidence/assessment and NOTHING ELSE. It cannot set `state`
//      or auto-close (deterministic, Phase 5) because an AssessResult has no
//      field for them — see domain/assessor/contract.js.
//   2. The default is `rules`. An unset/blank ASSESSOR_KIND yields the
//      deterministic assessor; there is no path where a missing config silently
//      selects something non-deterministic.
//
// NOTE: an LLM implementation would NOT be a drop-in for the Determinism Rule's
// purity clause (it would do network I/O inside `assess`). That is exactly why
// it is advisory-only and gated behind this seam: the pure rules impl remains
// the one that can be unit-tested and the one that runs by default.
"use strict";

const rules = require("./rules");

// kind → { assess, version }. The registry IS the allowlist: an unrecognized
// ASSESSOR_KIND cannot fall through to a default implementation, it throws.
const IMPLS = Object.freeze({
  rules: { assess: rules.assess, version: rules.RULES_VERSION },
});

const DEFAULT_KIND = "rules";

/**
 * Resolve the assessor kind from an environment object. Pure and exported so the
 * SELECTION LOGIC is unit-testable without mutating process.env — the seam is
 * the part of this phase that unit tests would otherwise never touch.
 *
 * @param {Object<string,string|undefined>} [env=process.env]
 * @returns {string} a kind that is guaranteed present in IMPLS
 * @throws {Error} on an unrecognized kind — fail fast at boot rather than
 *   silently assessing 500 incidents with the wrong implementation.
 */
const resolveKind = (env = process.env) => {
  const raw = (env.ASSESSOR_KIND || "").trim();
  if (raw === "") return DEFAULT_KIND;
  if (!IMPLS[raw]) {
    throw new Error(
      `ASSESSOR_KIND "${raw}" is not a known assessor (have: ${Object.keys(IMPLS).join(", ")})`
    );
  }
  return raw;
};

/**
 * The selected implementation and its provenance.
 *
 * Resolved PER CALL rather than cached at require time so that the kind is read
 * from the live environment and a config error surfaces as a thrown run rather
 * than a module-load crash with no run_log to record it. Selection is trivially
 * cheap (an object lookup); this is not a hot path — one call per assess job.
 *
 * @param {Object<string,string|undefined>} [env=process.env]
 * @returns {{kind: string, version: number, assess: (d: import('./contract').Dossier) => Promise<import('./contract').AssessResult>}}
 */
const getAssessor = (env = process.env) => {
  const kind = resolveKind(env);
  const impl = IMPLS[kind];
  return { kind, version: impl.version, assess: impl.assess };
};

module.exports = { getAssessor, resolveKind, DEFAULT_KIND };
