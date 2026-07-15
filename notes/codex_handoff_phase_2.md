# Codex Handoff — incident-engine Phase 2 (Materialize, L0)

A briefing for an automated reviewer (e.g. Codex) picking up this codebase to review
the phase that was just implemented. Read this first, then review the code under the
scope below. The goal is a **correctness + idempotency + fingerprint-stability** review
of the first real pipeline stage.

---

## 1. What this app is (30-second version)

`incident-engine` is a **deterministic error→incident pipeline** over the cron-driven
data-pipeline apps under `/opt/apps` (medical-imaging telemetry). Phase 1 stood up the
skeleton, the owned `incidents` schema, and the least-privilege `incident_engine_rw`
role (self-log via a check-option view; fail-closed grants with a database-wide audit).

Phase 2 adds the first real stage — **materialize (L0)**: watermark → bounded scan of
`util.app_run_logs.warn_error_logs` (json; never `verbose_log`) → flatten one row per
event → normalize/fingerprint/classify → `incidents.error_events`, idempotently
(`ON CONFLICT (run_id, event_ord) DO NOTHING`, watermark advanced in the same
transaction). Aggregation/assessment are Phases 3–5; `assess` is still a stub.

Full context: `CLAUDE.md`, `markdown/ARCHITECTURE_PRINCIPLES.md`,
`docs/incidents-schema.md`, `docs/error-taxonomy.md`, and the pre-implementation
re-evaluation `notes/phase_2_reevaluation.md`.

---

## 2. Scope of this review

Review the working tree of branch `phase-2-materialize` (diff vs.
`phase-1-app-skeleton-provision`, commit pending). Concretely:

```
domain/normalize.js               FROZEN golden contract — fingerprint input scrubbing
domain/fingerprint.js             sha1 grouping key + FP_VERSION + eventText chain
domain/classify.js                wrapper over the copied production classifier
domain/entity.js                  entity fallback + system_id derivation
utils/classify/connection_regex.js  VERBATIM copy from data_acquisition (verify: diff)
jobs/materialize/index.js         the transaction: watermark, scan, chunked insert
jobs/materialize/flatten.js       pure event→row flattening (defensive)
utils/db/queries/materialize.js   all SQL (parameterized)
index.js                          materialize stub replaced with the real job
test/normalize.test.js            GOLDEN tests (frozen literals)
test/fingerprint.test.js          frozen sha1s, stability, eventText chain
test/classify.test.js             categories, first-match-wins ordering, table intact
test/entity.test.js, test/flatten.test.js
docs/error-taxonomy.md            flags column synced to the live classifier (Step 2)
```

**Out of scope:** Phase 1 files (already reviewed: see
`notes/review_results_phase_1.md`), `markdown/`/`prompts/`/`notes/`, the `assess` stub,
and the stack/house-style choices. The classifier TABLE's patterns are production code
copied verbatim — review that the copy is faithful and the wrapper honors it, not the
regexes themselves.

---

## 3. How to run / verify it

`node` is not on the host — Docker only. Schema/role are provisioned; `.env` (gitignored)
points at `incident_engine_rw`.

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test    # 35 tests, dependency-free
docker compose run --rm app node index.js materialize      # incremental; exit 0
docker compose run --rm app node index.js materialize      # again → inserts only new rows
docker exec -i pg_db psql -U postgres -d staging -c \
  "SELECT count(*), count(DISTINCT fingerprint) FROM incidents.error_events;"
```

State when this handoff was written: the initial backfill ran live — 14,814 source
rows → 184,046 events, exact 1:1 with the source window, 0 skipped, 23.5s, 141
distinct fingerprints. Re-run inserted 0; a deliberate 1-hour watermark rewind
re-flattened 1,045 events and inserted 0 (replay absorbed). Forced env failure exited
1 with the watermark unadvanced. EXPLAIN shows partition pruning
(`Subplans Removed: 6`).

---

## 4. Hard constraints the code must respect (verify these hold)

1. **`verbose_log` is never read.** The scan selects `warn_error_logs` only; grep the
   whole tree. Every source query bounds `inserted_at` on both ends (partition pruning).
2. **Write isolation:** writes go only to `incidents.error_events` +
   `incidents.pipeline_state` (plus the Phase 1 self-log view). All inserts via
   `pgp.helpers` ColumnSets — no string-built SQL with interpolated values anywhere.
3. **Idempotency:** re-running never double-counts. `ON CONFLICT (run_id, event_ord)
   DO NOTHING`; watermark advances to the transaction's fixed `now()` in the SAME
   transaction as the inserts; overlap lookback absorbs commit skew; failure rolls
   back the whole batch (watermark included) and exits 1.
4. **Fingerprint stability:** `sha1(app|func|tag|type|normalize(err_msg ||
   note.message || note.txt))`, `FP_VERSION = 1`. `normalize.js` is a frozen golden
   contract from this phase forward — the review should treat any suggestion to
   "improve" its rules as a FUTURE FP_VERSION-bump phase, not a Phase 2 fix, unless a
   rule is outright broken.
5. **Producer allowlist:** `PRODUCING_APPS` must be exactly
   `data_acquisition, hhm_rpp_ge, hhm_rpp_philips` — never `incident-engine`
   (self-log feedback loop) and not yet `acquisition-v2` (no events, shape unverified).
6. **Determinism:** domain/ modules are pure (no I/O, no clock, no env) and
   dependency-free (node builtins only — tests run in bare `node:lts` without
   node_modules).

---

## 5. Known weak spots — please scrutinize these specifically

1. **Single-transaction memory model.** The whole scan window's source rows AND all
   flattened rows are held in memory before chunked inserts (backfill: 14.8k source
   rows / 184k events worked fine). There is no paging; a retention increase or an
   event storm grows this linearly. Is the simplicity defensible for ~25k events/day
   with a cron cadence, and at what volume does it break?
2. **normalize.js rule set — review it NOW, while changing it is free.** Known
   artifacts: the `<path>` rule stops at a placeholder boundary, yielding shapes like
   `<path><sme>/gesys_crdct<n>.log`; mixed-alnum tokens normalize partially
   (`crdct<n>`); `\bSME\d+\b` also scrubs SME ids inside paths (intended). Are any of
   these actively harmful to grouping (over-merge or over-split), given the live result
   of 141 fingerprints over 184k events (5 GE / 17 Philips / 119 data_acquisition)?
   After this phase, changes cost an FP_VERSION bump.
3. **79% of events classify `unknown`.** Expected (most WARN volume is pipeline-status
   noise like "No new file data", "NO TUNNEL FOUND" — the taxonomy targets
   connection/extraction errors), and category is deliberately NOT part of the
   fingerprint. Verify the classify input chain isn't silently dropping signal that
   would have matched (e.g. events whose text lives somewhere other than
   err_msg/note.message/note.txt).
4. **Two `require("pg-promise")()` initializations** (jobs/materialize and
   pg-helpers.js) — mirrors the data_acquisition house pattern; pg-promise treats
   these as separate roots. Confirm no duplicate-pool or helper-formatting hazard
   (the pool itself is the single `utils/db/pg-pool.js` instance).
5. **Concurrent runs.** ensure+`SELECT ... FOR UPDATE` on the watermark row
   serializes materialize transactions; a second run blocks, then scans from the
   advanced watermark. Convince yourself there's no interleaving where both runs scan
   the same window and both advance (the ON CONFLICT inserts make it harmless, but the
   watermark must still be monotonic — `now()` of a blocked-then-resumed tx is its own
   tx start... verify this cannot move the watermark BACKWARD).
6. **`dt` comes from the source app's clock** (event field, nullable) while the scan
   is driven by `inserted_at` (DB clock). Indexes on `(fingerprint, dt DESC)` — any
   correctness concern for Phase 3's first_seen/last_seen if dt skews or is null?
7. **`raw_event` duplicates the event JSON** (including err stacks already in
   `err_msg`) — storage doubles per event. BRIN + append-only makes it cheap now;
   retention is a parked decision. Flag if you consider it worse than that.
8. **Storage truncation** caps (`func` 64, `tag` 32, `sme` 16) silently truncate;
   fingerprints hash raw values (tested). Any column where truncation could corrupt a
   join key (`sme`→`system_id` 8 vs 16)?

---

## 6. What is intentionally deferred (don't file these as bugs)

- **Aggregation, enrichment, assessment, state** — Phases 3–5 (`assess` is a stub;
  `phase` column is '' by design; `entity.js` is built+tested but unconsumed).
- **`hanging_exec` category** — caller-set at the source apps; this app only sees
  event text, so it can only ever classify from text.
- **acquisition-v2 onboarding** and **self-ingestion of incident-engine's own
  errors** — parked decisions (PROMPTS.md "Not decided yet").
- **error_events retention / partitioning** — BRIN + full history now; revisit on
  volume evidence.
- **Cron installation** — cadence decided after Phases 2–5 give real runtimes.

---

## 7. Output format requested

For each finding, please give:

- **Severity** (blocker / high / medium / low / nit)
- **File + line** (`path:line`)
- **What & why** — the concrete problem and how to trigger/observe it
- **Suggested fix** — minimal, matching house style

Prioritize: (1) idempotency/watermark correctness (double-count or lost-window bugs),
(2) fingerprint stability traps (anything that would silently change fingerprints
later), (3) write-isolation/partition-pruning violations, (4) flatten/classify
correctness on malformed input, then everything else. Bias toward fewer,
high-confidence findings. File results as `notes/review_results_phase_2.md`.
