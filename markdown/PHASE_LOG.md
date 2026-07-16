# Phase Log

Durable memory of what's been done and why. Newest entry at the top. Add an entry (from
`PHASE_TEMPLATE.md`) after each phase is implemented, validated, and ready to commit.

---

# Phase 3 — Aggregate Incidents (L1/L2)

Date:
2026-07-15

Status:
Completed

Prompt:
`prompts/prompt_3_aggregate_incidents.txt`

Git Commit:
Pending

Review Artifacts:

- Codex handoff (round 1): `notes/codex_handoff_phase_3.md`
- Review results (round 1): `notes/review_results_phase_3.md` (1 high, 1 medium,
  2 low — all fixed and re-validated live)
- Codex handoff (fix round, delta): `notes/codex_handoff_phase_3_fixes.md`
- Review results (round 2, re-review): `notes/review_results_phase_3.md` (§round 2 —
  1 medium clock-assumption + stale comments, 1 low whitespace-trim; both addressed;
  F2/F3 confirmed closed)
- Review results (round 3, independent self-review): `notes/review_results_phase_3.md`
  (§round 3 — no high/medium; 4 low; #1 backfill-trim + #3 corroborated-type-doc fixed,
  #2 noted, #4 left; a backtick-in-template-literal bug introduced by the #2 note was
  caught by RUNNING the job and fixed)

## Goals

- Roll new `incidents.error_events` rows up into `incidents.incidents`, one row per
  `(fingerprint, entity)`, via a watermarked, idempotent
  `INSERT … SELECT … GROUP BY … ON CONFLICT (fingerprint, entity) DO UPDATE` upsert:
  additive `occurrence_count`, `first_seen`/`last_seen` (LEAST/GREATEST), `apps[]`/
  `systems[]` unions, a representative event, category/error_type/func, and best-effort
  enrichment.
- No assessor / severity / state / auto-close (Phases 4–5); `action_*` never written.

## Built

- `domain/entity.js` — **dropped `job_id`** from the entity fallback (`sme → system_id →
  __global__`). `entity()` is the single source of truth; `test/entity.test.js` updated.
- `jobs/materialize/flatten.js` + `utils/db/sql/pg-helpers.js` — each L0 row now carries a
  stored `entity` (stamped by `entity()`), computed from the same `system_id` value that is
  persisted (no drift). The aggregate GROUPs on this column, never re-deriving entity in SQL.
- `db/schema.sql` — `error_events.entity VARCHAR(64) NOT NULL` in CREATE + a Phase 3 UPGRADE
  section (add nullable → one-time SQL backfill mirroring `entity()` → SET NOT NULL). Also
  moved `error_events.inserted_at` to `DEFAULT clock_timestamp()` (was `NOW()`) — the
  aggregate cursor must be stamped at insert-time/post-lock, not transaction-start (review
  F1). Fresh and upgraded installs converge; re-apply is idempotent.
- `utils/db/queries/incidents.js` — the aggregate upsert (set-based, static, parameterized
  `$1/$2` window). Strict window `(watermark, snapshot]`, **no overlap**; additive
  `occurrence_count`; array-union apps/systems; `DISTINCT ON` representative on the total
  order `ts, run_id, event_ord`; representative-derived fields refreshed on the
  `(last_seen, sample_run_id)` total order so rebuild == incremental (review F3); `msg`
  reconstructs `eventText` with `btrim` + `jsonb_typeof='string'` guards (review F4);
  `RETURNING (xmax = 0)` to report inserted vs. updated.
- `utils/db/queries/enrichment.js` — `stats.acquisition_history` corroboration, **system_id
  only**, category-when-`unknown` only (advisory; never overwrites a confident category or
  writes NULL).
- `jobs/aggregate/index.js` — the transaction: lock the materialize watermark row
  `FOR UPDATE`, ensure+lock own watermark, post-lock `clock_timestamp()` snapshot, upsert,
  `GREATEST`-guarded advance — all one tx. Exactly-once rests on BOTH this lock AND the
  post-lock `inserted_at` cursor stamp (review F1); overlap-free additive count. Reuses the
  generic watermark SQL from Phase 2.
- `index.js` — `assess` now calls `aggregate` (was a stub); the deterministic assessor lands
  here in Phase 4.
- Docs: `docs/incidents-schema.md` (entity column + dropped job_id + enrichment reality +
  sample_message wording + `inserted_at` cursor note), `markdown/PROMPTS.md` status.
- Tests: 49 unit (dependency-free, bare `node:lts`) + 2 live DB integration tests under
  `integration/` (`aggregate_race.js`, `rep_determinism.js` — run in the app container, not
  discovered by `node --test`).

## Schema Facts Confirmed (live DB)

- `incidents.incidents` columns/types match the contract; **no** `modality`/`manufacturer`
  columns exist (the prompt's enrichment list overshot the schema).
- `error_events.dt` is **never null** across the 186k rows (`dt_null = 0`); all `fp_version=1`.
- **Entity grain:** with `job_id` in the fallback, the L0 rows produced **38,578**
  `(fingerprint, entity)` pairs — ~38,084 singleton incidents keyed on per-run job UUIDs,
  from just **4** `(app, func, fingerprint)` combos (all `unknown`). Dropping `job_id` →
  **498** pairs. This answered the prompt's "sane bucket sizes?" review question with data.
- **Enrichment reality:** the source `run_id` does **not** correlate with
  `stats.acquisition_history.run_id` — **0 of 124,361** rows matched on `(system_id, run_id)`.
  On `system_id` alone, **111 of 217** distinct systems match. So the join is system_id-only
  and LEFT.
- Source retention still covered the full L0 window at implementation time (src_min
  2026-07-07 14:58), but the entity migration was done **non-destructively** (add column +
  in-place backfill), not by rebuild.
- Backfill parity: stored `entity` == `entity()` expression for **all** 186k rows
  (0 mismatches); 0 nulls after `SET NOT NULL`.

## Important Decisions

### Drop `job_id` from the entity fallback (contract change)

Decision: `entity()` is now `sme → system_id → '__global__'`; `job_id` is stored on L0 for
provenance but is never an entity key.

Reason: `job_id` is a per-run UUID. As an entity it mints one incident identity **per run**,
never aggregates across runs, and turns the incidents table back into the firehose the app
exists to collapse (live: 4 fingerprints → ~38k singleton incidents). Phase 2 had already
demoted `job_id` below `system_id` for this reason; Phase 3, its first consumer, removes it.

Tradeoff: an event with no `sme`/`system_id` now shares the `__global__` bucket for its
fingerprint (one incident per distinct problem when equipment is unknown) instead of a
per-run bucket. Developer-approved before implementation.

### Exactly-once via serialize-vs-materialize + post-lock cursor + zero overlap

Decision: the aggregate takes **no** overlap lookback; the window is the strict
`(watermark, snapshot]`. Exactly-once rests on TWO guarantees together (the second was
added in the round-1 high fix — the lock alone is insufficient):
(a) the aggregate locks the materialize watermark row `FOR UPDATE` before snapshotting, so
no materialize tx *commits* between the read and the advance; and (b) `error_events.inserted_at`
— the cursor — is `DEFAULT clock_timestamp()` (insert-time, post-lock), so a materialize tx
that *started* before the aggregate but commits after it still stamps its rows above the
aggregate's watermark and is caught next window.

Reason: `occurrence_count` is additive, and an additive counter double-counts any row that
falls in two windows — exactly what an overlap lookback causes (trace: a row at
`inserted_at=98` re-scanned by a later `(95,200]` window is added twice). A clock-based
overlap cannot distinguish "already counted" from "newly visible after commit-skew", so the
only exactly-once options are per-row dedup state or removing the skew. The lock+post-lock-cursor
removes the skew, letting the additive count be exactly-once by construction. Materialize's
job code is unchanged (the aggregate simply also locks the row materialize already holds; the
cursor fix is a column default). Proven by `integration/aggregate_race.js`.

Tradeoff: `assess` and `materialize` cannot run concurrently (acceptable — both are
sub-second/second-scale internal jobs; the normal `run` path is sequential anyway). A
deliberate watermark **rewind** after a committed batch is **not** idempotent for an additive
counter — treated as out-of-scope operator action (recovery = truncate + reset + re-aggregate).
CLOCK CAVEAT (re-review R1): "exactly-once" holds under a **nondecreasing database clock** —
the timestamp cursor is a wall clock; a backward step could silently undercount. This matches
the assumption the rest of the pipeline's watermarks already make; the unconditional fix is a
monotonic post-lock cursor (upgrade path, not built).

### Enrichment scoped to system_id-only, category-when-unknown

Decision: LEFT JOIN `stats.acquisition_history` on `system_id` only; use it solely to
corroborate `category` when classify returned `unknown`. No `phase`/`modality`/`manufacturer`.

Reason: `run_id` never joins (0/124,361), so per-run correlation is impossible; `incidents`
has no modality/manufacturer columns; a per-run `phase` from an uncorrelated run is
misleading. Developer-approved. Time-correlated oracle use (auto-close) is Phase 5.

Tradeoff: corroboration is coarse (latest non-`unknown` category for the system, time-
uncorrelated). Advisory only; classify stays primary; 39/498 incidents corroborated live.

### `first_seen`/`last_seen` from `COALESCE(dt, inserted_at)`

Decision: lifecycle timestamps derive from the event's own `dt`, falling back to L0
`inserted_at` only for null-`dt` rows (currently none).

Reason: `dt` is the semantically correct "when the problem occurred"; `inserted_at` is
materialization time (a poor proxy after a backfill), used only so a null-`dt` row still
contributes a real instant instead of being dropped. Source-clock skew is the producer's
truth, not corrected here (noted for Phase 5 auto-close timing).

## Architecture Notes

- Write-isolation / least-privilege: writes are `incidents.incidents` +
  `incidents.pipeline_state` only; `stats.acquisition_history` SELECT-only in the enrichment
  CTE. No new grant — the role owns `incidents` (covers the new `error_events.entity` column
  and all `incidents` writes); proven by the live `assess`/`run` smokes as `incident_engine_rw`.
- Idempotency / watermark: second `pipeline_state` row `incidents.error_events`, mirroring
  materialize's ensure→lock→post-lock-snapshot→GREATEST-advance, same tx. **Zero overlap**;
  exactly-once via the materialize-row serialization lock (see decision). Proven live: first
  aggregate `sum(occurrence_count)` == L0 total (delta 0); re-run unchanged; incremental
  `run` counted ~17k new events exactly once (delta stays 0).
- Classifier / fingerprint stability: untouched. `FP_VERSION` stays 1; `normalize.js`/
  `fingerprint.js` not modified. `category` on an incident may differ from its events only
  when enrichment corroborated an `unknown` (advisory), never via a fingerprint change.
- Determinism: aggregate is pure SQL over stored facts; enrichment advisory; no LLM. The
  assessor (Phase 4) is still absent — `state`/`severity`/`assessment` unwritten.
- Data-contract: reads `error_events` (this app's own L0) + `stats.acquisition_history`
  (SELECT); never `verbose_log`. EXPLAIN: steady-state narrow window uses BRIN
  (`idx_error_events_inserted_brin`, cost ~1.8k); full backfill window seq-scans (correct —
  whole table); enrichment uses `idx_acq_hist_err_cat_inserted`; conflict arbiter is
  `uq_incidents_fingerprint_entity`.
- Deployment: no new deploy surface (same batch one-shot). Superuser step this phase:
  re-apply `db/schema.sql` (adds + backfills `error_events.entity`) **before** running the
  new `assess`. Cron cadence **decided + installed after this phase** (2026-07-16): a single
  `run` line at `25,55` — see `markdown/DEPLOYMENT.md` "Cadence".

## Validation

Commands run:

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test                       # 48/48 pass
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql          # entity add+backfill+NOT NULL (UPDATE 186131)
docker compose run --rm app node index.js assess                               # first aggregate, exit 0
docker compose run --rm app node index.js assess                               # re-run: no double-count
docker compose run --rm app node index.js run                                  # materialize → assess incremental
# EXPLAIN of the upsert (full + narrow window) as postgres
```

Results:

- Passed: 48/48 unit tests. Backfill parity 0 mismatches / 0 nulls. First aggregate = 498
  incidents, `sum(occurrence_count)` = 186,131 = L0 total (**exactly-once delta 0**). Re-run
  (empty window) = unchanged (498 / 186,131). Incremental `run` materialized ~17,465 new
  events and aggregated them → 503 incidents, `sum` = 203,596 = new L0 total (**delta still
  0**). `state`/`severity` NULL on all rows (Phase 4 boundary). Enrichment corroborated
  39/498 `unknown` incidents. EXPLAIN: BRIN for steady-state, correct conflict arbiter.
- Failed: none.
- Not run initially, ADDED in the fix round: the concurrent-race integration test
  (`integration/aggregate_race.js`, deterministic two-connection interleaving — the
  round-1 high finding's proof) and the representative rebuild-vs-incremental determinism
  test (`integration/rep_determinism.js`). Still not run: a watermark-rewind
  demonstration (would corrupt the additive count — documented as out-of-scope operator
  action); crash-mid-batch is covered by transactional rollback (reasoned, not fault-injected).

Manual / smoke tests:

- Formerly-fractured job_id fingerprints are now single `__global__` incidents with high
  counts (runJob 23,163; getTunnelsByIP 10,698; gzip_n_save 13,533 / 9,369; phil_cv_eventlog
  2,776) — the aggregation win, visible directly.
- Representative messages are human-readable ("JOB HALTED", "NO TUNNEL FOUND", "File Not
  Present"), not the normalized hash input.

## Review Notes

Source:

- `notes/review_results_phase_3.md` (Codex, from `notes/codex_handoff_phase_3.md`).

Critical issues:

- Codex verdict was "needs fixes before commit": (1) **high** — the shared watermark
  lock did NOT eliminate commit skew. `error_events.inserted_at DEFAULT NOW()` is
  transaction-START time; a materialize tx can fix its `NOW()` before acquiring the
  lock, be descheduled, and commit AFTER an aggregate advanced its watermark, leaving
  its rows below the strict `inserted_at > watermark` window — skipped forever. The
  lock serialized commits but not the cursor value. (2) **medium** — flatten derived
  `entity` from the UNcapped sme while storing sme capped to 16, so a >16-char sme got
  a 64-char entity on new rows but a 16-char entity from the backfill → split incident.
  (3) **low** — the representative tie-break was deterministic only within a batch (the
  `>=` refresh resolved equal-ts events by batch arrival order → rebuild ≠ incremental).
  (4) **low** — the SQL `msg` reconstruction didn't match `eventText`: it only rejected
  literal `''`, so a whitespace-only `note.txt` suppressed a valid `skip_reason` and
  padding survived.

Accepted fixes (all four findings; detail in `notes/review_results_phase_3.md`):

- **F1**: `error_events.inserted_at` now `DEFAULT clock_timestamp()` (insert-time,
  post-lock), so the cursor orders with the lock — a late-committing materialize stamps
  its rows AFTER any watermark the aggregate set while it waited, and they're caught
  next window. Exactly-once now explicitly requires BOTH the lock AND the post-lock
  stamp (comments in `incidents.js`/`aggregate/index.js` corrected; the old "lock alone
  suffices" claim was the bug). New `integration/aggregate_race.js` reproduces the
  interleaving and proves the `clock_timestamp()` row is caught while a
  `transaction_timestamp()` (old-default) row in the same commit is skipped → PASS.
- **F2**: `flatten.js` derives stored `sme` and `entity()` from one `cap(sme,16)` value;
  long-sme parity unit test added.
- **F3**: `rep` sort key aligned to `ts DESC, run_id DESC, event_ord DESC` and the ON
  CONFLICT refresh guarded by the `(last_seen, sample_run_id)` total order → order-
  independent. New `integration/rep_determinism.js`: rebuild vs. 2-window
  incremental → 0 mismatches.
- **F4**: `msg` `btrim`s each candidate and guards `raw_event` extraction with
  `jsonb_typeof(...) = 'string'`, matching `nonEmptyString`.

Confirmed clean by the reviewer (left as-is): watermark-rewind policy (reasonable —
`GREATEST` guards ordinary retries; rewind is explicit operator recovery), deadlock-free
lock order, write-isolation + grants, parameterized/injection-safe static SQL.

Re-review (round 2, `notes/review_results_phase_3.md` §round 2): confirmed F2/F3 closed;
raised 1 medium + 1 low against the F1/F4 fixes — both addressed:

- **R1 (medium)** — exactly-once still assumed `clock_timestamp()` is nondecreasing across
  the lock handoff (a wall clock, not a monotonic primitive); a backward clock step in the
  sub-second window between the aggregate's advance and a pre-lock materialize's insert
  could silently UNDERcount (never double-count/corrupt). Also stale comments claimed "no
  materialize tx can be in flight" (pre-lock tx's can be). Resolution (Codex-sanctioned):
  **explicitly documented the guarantee as "exactly-once under a nondecreasing clock"** and
  corrected the comments (the lock excludes *committing* tx's; guarantee (b), the post-lock
  stamp, orders a pre-lock tx's rows) in `jobs/aggregate/index.js`,
  `utils/db/queries/incidents.js`, `db/schema.sql`. The whole pipeline already assumes a
  nondecreasing clock, so a monotonic cursor for the aggregate alone would be inconsistent;
  the unconditional fix (post-lock `BIGSERIAL`/batch-sequence cursor) is recorded as the
  upgrade path, not built (proportionate to the residual; a pipeline-wide decision).
- **R2 (low)** — `btrim` default trims spaces only; JS `String.trim()` also strips tab/
  newline/etc. Fixed: `msg` now `btrim(x, E' \t\n\r\f\v')` on every candidate. Verified
  live (a `"\t\n"` `note.txt` now correctly falls through to `skip_reason`). Exotic Unicode
  whitespace remains uncovered (never in these ASCII messages); persisting `eventText` on L0
  is the exact-parity upgrade, noted in the query comment.

Round 3 (independent self-review, `notes/review_results_phase_3.md` §round 3): high-recall
8-angle pass; **no high/medium** findings (exactly-once core, representative-guard invariant,
enrichment 1:1 join, and consistent ms-truncation all verified). 4 low; developer applied:

- **#1 (low)** — the entity backfill's `btrim` (spaces only) diverged from `entity()`'s JS
  `.trim()` at the 16-char sme cap boundary (the R2 whitespace gap, not applied to the
  backfill). Fixed: `btrim(sme, E' \t\n\r\f\v')` / `btrim(system_id, …)`; re-verified 0
  entity mismatches over all 203,596 live rows.
- **#3 (low)** — an oracle-corroborated `category` left `error_type=''` (34+ live incidents).
  Documented (not a stale pairing): only `category` is corroborated, from the oracle's
  vocabulary; `error_type`/`phase` stay the deterministic classifier's output; `''` = type
  undetermined. `enrichment.js` + aggregate INSERT + `docs/incidents-schema.md` updated.
- **#2 (low)** — noted in code that the newest-wins `category` refresh could regress a
  confident category to `unknown` if a fingerprint ever became mixed-category (empirically
  never; single-category live). **#4** (msg computed per batch row) left as-is.

Process note: the #2 note initially used markdown backticks inside the SQL **template
literal**, breaking `require` — invisible to `node --test` (which never loads `incidents.js`),
caught only by RUNNING `assess`. Fixed and re-validated by running the job (assess exit 0,
both integration tests PASS, delta 0), not just the unit suite.

Deferred findings:

- None as bugs. Two upgrade paths recorded (not scheduled): the monotonic-cursor exactly-once
  hardening (R1) and persisting `eventText` on L0 for exact sample-message parity (R2).
  Enrichment coarseness, `apps[]` single-app structure, and `dt`/null-`dt` skew remain the
  intentionally-deferred Phase-5 items already recorded above.

Re-validation after fixes (all green):

- 49/49 unit tests (long-sme parity added). Schema re-applied (default →
  `clock_timestamp()`). `aggregate_race.js` PASS (T0 < Ta; clock row caught, tx-start
  row skipped). `rep_determinism.js` PASS (498/498, 0 mismatches). Real `assess` exit 0.
  Final: `error_events` 203,596 (0 null entity, 0 test leftovers); `incidents` 503 =
  `count(distinct (fingerprint, entity))`; `sum(occurrence_count)` 203,596 →
  **exactly-once delta 0**; watermark caught up.

## Problems Encountered

- The prompt's enrichment premise (join on `run_id`; fill `phase`/`modality`/`manufacturer`)
  did not survive Step 2: `run_id` never joins the oracle and those columns don't exist on
  `incidents`. Resolution: scoped enrichment to system_id-only category corroboration and
  documented the reality in `docs/incidents-schema.md` and the prompt is superseded by this
  entry. Developer-approved before implementation.
- The prompt's "cross-app blast radius" review question rests on a false premise: `src_app_name`
  is part of the fingerprint, so one fingerprint is single-app and `apps[]` is structurally
  length-1. Resolution: documented; `apps[]` kept per contract/future-proofing.

## Follow-Up Tasks

- Codex review of this phase (handoff ready); iterate on findings; then commit Phases 0–3.
- Phase 4 (`prompt_4_deterministic_assessor.txt`): pure `assess(dossier)` → severity/state/
  reasons over the aggregated incidents; wire after `aggregate` in the `assess` job.
- Phase 5: watch the source-clock skew / null-`dt` interaction when the recovery oracle
  drives auto-close timing (this entry's timestamp decision).
- Optional hardening (re-review, if/when clock-step tolerance is wanted): replace the
  timestamp aggregate cursor with a monotonic post-lock `BIGSERIAL`/batch sequence — ideally
  pipeline-wide (materialize's watermark makes the same clock assumption), so it's a
  deliberate cross-cutting phase, not an aggregate-only patch.
- Optional (re-review, exact sample-message parity): persist the computed `eventText` on
  `error_events` and read it directly instead of reconstructing `msg` in SQL.
- **Cron cadence: DECIDED + installed 2026-07-16** (post-commit) — one `run` line at
  `25,55`; rationale + the exact line in `markdown/DEPLOYMENT.md` "Cadence". Verified by
  running the exact cron command string from a foreign cwd (exit 0); a full-day incremental
  run then held the exactly-once invariant (228,490 L0 rows → 504 incidents, delta 0).
- Open decisions unchanged: acquisition-v2 onboarding, self-ingestion, retention.

## Commit Readiness

- Requirements implemented: yes (aggregate half of `assess`, per the prompt + approved Step-2
  design changes).
- Write-isolation / least-privilege rules hold: yes (no new grant; writes confined; proven
  live as `incident_engine_rw`).
- Jobs idempotent (watermark + ON CONFLICT): yes — exactly-once proven live (delta 0 on first,
  re-run, and incremental runs) AND under the concurrent materialize/aggregate race after the
  round-1 high fix (post-lock `clock_timestamp()` cursor; `aggregate_race.js` PASS).
- Assessment deterministic (no LLM in critical path): n/a (assessor is Phase 4); aggregate is
  pure SQL; enrichment advisory.
- Source queries read warn_error_logs only, partition-pruned: n/a for the source table this
  phase (reads own L0 + oracle); BRIN confirmed on the L0 window scan.
- Schema assumptions confirmed live: yes (see Schema Facts).
- Review findings addressed or deferred: yes — three rounds
  (`notes/review_results_phase_3.md`): round 1 (Codex) 1 high + 1 medium + 2 low, all fixed;
  round 2 (Codex re-review) 1 medium + 1 low, both addressed; round 3 (independent
  self-review) no high/medium, 4 low — 2 fixed, 1 noted, 1 left. Two upgrade paths recorded
  (monotonic cursor; persisted `eventText`), neither scheduled.
- Validation recorded: yes.
- Ready to commit: yes — developer confirmed after round 3.

---

# Phase 2 — Materialize (L0)

Date:
2026-07-14

Status:
Completed (pending external review + commit)

Prompt:
`prompts/prompt_2_materialize.txt` (as revised by `notes/phase_2_reevaluation.md`)

Git Commit:
Pending

Review Artifacts:

- Codex handoff (round 1): `notes/codex_handoff_phase_2.md`
- Review results (round 1): `notes/review_results_phase_2.md` (2 high, 3 medium,
  1 low — all fixed, L0 rebuilt)
- Codex handoff (round 2, fix delta): `notes/codex_handoff_phase_2_fixes.md`
- Review results (round 2): `notes/review_results_phase_2_fixes.md` (1 high, 1 medium,
  2 low — all fixed; original findings confirmed closed)
- Review results (round 3, internal adversarial multi-agent pass over the freeze
  surface): `notes/review_results_phase_2_round3.md` (17 confirmed / 5 plausible /
  4 refuted; 10 reported + nits, all fixed — incl. two live-probed poison-event
  stalls (NUL bytes, JS-vs-PG timestamp parsing) and the pre-freeze fingerprint
  separator escape; L0 rebuilt at exact parity, 82 buckets unchanged, 47/47 tests)

## Goals

- Flatten `util.app_run_logs.warn_error_logs` into `incidents.error_events` — one row
  per event, fingerprinted and classified at materialize time — incrementally and
  idempotently (watermark + `ON CONFLICT`), reading `warn_error_logs` only.
- Freeze the identity domain: `normalize.js` golden contract, `FP_VERSION=1`
  fingerprint, classifier copied verbatim from production, entity fallback.

## Built

- `domain/normalize.js` — frozen golden contract: noise-line filter (stateful curl
  progress block, JS-stack-frame-shaped lines only), then ts/uuid/ip/sme/path/hex/
  number → placeholders, whitespace-collapse, lowercase. NO length cap (output is
  only hashed). Golden-tested, incl. preservation goldens for tabular/indented prose.
- `domain/fingerprint.js` — `sha1(app|func|tag|type|normalize(TEXT))`, `FP_VERSION=1`
  persisted per row (`error_events.fp_version`); `eventText` implements the
  live-verified chain `err_msg → note.message → note.txt → note.skip_reason → ''`.
- `domain/classify.js` — thin wrapper over `utils/classify/connection_regex.js`
  (verbatim copy from data_acquisition, 26 ordered entries, diff-verified);
  first-match-wins; `unknown` fallback.
- `domain/entity.js` — `entity()` (`sme → system_id → job_id → __global__`, 64-cap so
  a job-UUID fallback is lossless; consumed in Phase 3) + `deriveSystemId()`
  (`^SME\d{5}$` ⇒ the value IS the system_id; applied to `note.system_id` first,
  then `note.sme`).
- `jobs/materialize/` — single transaction: ensure+lock watermark row (`FOR UPDATE`
  serializes concurrent runs), post-lock `clock_timestamp()` snapshot (monotonic
  under concurrency; advance guarded by `GREATEST` + `RETURNING` the stored value),
  bounded scan over the explicit
  `PRODUCING_APPS` allowlist, pure `flatten.js` (defensive: malformed events → skipped
  + WARN, never a crash), chunked `pgp.helpers` inserts with
  `ON CONFLICT (run_id, event_ord) DO NOTHING`, watermark advanced to the snapshot in
  the same transaction. Env: `MATERIALIZE_OVERLAP_MS` (default 5000),
  `MATERIALIZE_BATCH_ROWS` (default 5000), validated fail-fast.
- `utils/db/queries/materialize.js` — all SQL, parameterized.
- `index.js` — materialize stub replaced with the real job; `assess` still stubbed.
- Tests: 42 (normalize goldens incl. noise + preservation cases, frozen fingerprints,
  classify ordering + table-intact, entity, flatten) — all dependency-free, run in
  bare `node:lts`.
- `db/schema.sql` — now carries idempotent per-phase UPGRADE sections (Phase 2:
  `fp_version` add→backfill→NOT NULL; `entity` widen to 64), so an existing Phase 1
  database is reproducibly upgradeable by re-applying the one tracked file; tested on
  a scratch Phase 1 database, on re-apply, on fresh install, and on live.
- `docs/error-taxonomy.md` — flags column synced to the live classifier (5 rows were
  missing `manual_intervention`; Step 2 doc-drift fix).

## Schema Facts Confirmed (live DB)

- `acquisition-v2` still emits zero `warn_error_logs` events (3-day window) —
  allowlist decision stands.
- Event fields: `dt`/`type` 100% present; `type ∈ {WARN, ERROR}`; max `func` 41 chars,
  max `tag` 10, max `sme` 8; `note` never null (25,210-event day sample).
- `sme` matches `^SME\d{5}$` and `stats.acquisition_history.system_id` uses the same
  format ⇒ format-matching sme IS the system_id. Only 69/175 distinct event smes
  appear in `stats.acquisition_history` — the recovery oracle will not cover every
  entity (noted for Phase 5).
- Live classifier flags differ from the taxonomy doc snapshot — doc updated (see Built).

## Important Decisions

### Single-transaction batch (no paging)

Decision: scan → flatten → insert → advance happens in one transaction holding the
window's rows in memory.

Reason: the crash-consistency story is trivial (any failure rolls back watermark and
all inserts together), and the worst case observed — full 7-day retention backfill —
is 14.8k source rows / 184k events / 23.5s. Volume is ~25k events/day thereafter.

Tradeoff: memory grows with the window; flagged to the reviewer with the break-even
question. Paging (per-page transactions with per-page watermarks) is the known escape
hatch if volume demands it.

### note.txt in the fingerprint text chain

Decision: implemented the re-evaluated chain `err_msg || note.message || note.txt`.

Reason: without it, ~15% of data_acquisition events (note.txt-only, e.g.
"NO TUNNEL FOUND") would fingerprint on func/tag alone. Live result: those 10,573
events group under one fingerprint by their text.

Tradeoff: none now (`FP_VERSION` still 1; nothing was materialized before this phase).

## Architecture Notes

- Write-isolation / least-privilege impact: writes are `incidents.error_events` +
  `incidents.pipeline_state` only, through the Phase 1 role. No new grants needed.
- Idempotency / watermark impact: proven live — re-run inserts 0; a deliberate 1-hour
  watermark rewind re-flattened 1,045 events and inserted 0; PK-distinct = total.
  Forced failure (bad env) exits 1 with the watermark unadvanced.
- Classifier / fingerprint stability impact: **`normalize.js` + `fingerprint.js` are
  frozen as of this phase** (`FP_VERSION=1`, golden tests with literal sha1s). Any
  future change is a deliberate FP_VERSION-bump phase.
- Determinism impact: all domain modules pure + dependency-free; no LLM.
- Data-contract impact: scan reads `warn_error_logs` only, bounded on `inserted_at`
  both ends; EXPLAIN confirms partition pruning (`Subplans Removed: 6`). Explicit
  `PRODUCING_APPS` allowlist excludes `incident-engine` (self-log feedback loop) and
  `acquisition-v2` (parked).
- Deployment impact: none (same batch one-shot; no schema/role change; cron still not
  installed — cadence remains an open decision).

## Validation

Commands run:

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test        # 35/35 pass
docker compose run --rm app node index.js materialize          # backfill, exit 0
docker compose run --rm app node index.js materialize          # re-run, inserts 0
# watermark rewound 1h (superuser) → re-run → 1,045 re-flattened, 0 inserted
docker compose run --rm -e MATERIALIZE_OVERLAP_MS=abc app node index.js materialize  # exit 1
docker compose run --rm app node index.js run                  # cron path, exit 0
# EXPLAIN scan as incident_engine_rw → partition pruning confirmed
```

Results:

- Passed (pre-review): backfill 14,814 source rows → 184,046 events, exactly 1:1 with
  the source window count, 0 skipped, 23.5s; idempotency (re-run + rewind replay)
  proven; failure path exits 1 with watermark unadvanced (closes the Phase 1
  deferral); partition pruning confirmed; 35/35 unit tests.
- Passed (post-review rebuild): L0 truncated + watermark reset + re-backfilled under
  the corrected formula in 22s — 185,090 events, exact source parity; 0
  mixed-category fingerprints; 82 distinct fingerprints; all rows `fp_version=1`;
  5,285 `note.system_id` events captured; 690 skip_reason events fingerprinted on
  their stated reason; watermark-regression proof (future watermark not moved
  backward, catch-up resumes); 41/41 unit tests (6 new).
- Passed (round-2 fixes): schema upgrade tested on scratch Phase 1 DB / re-apply /
  fresh / live; noise-filter rewrite proven fingerprint-preserving (0 diffs over all
  1,808 distinct multiline corpus texts; rebuild checksum byte-identical to the
  round-1 corpus); watermark summary reports the stored value under GREATEST
  rejection; 42/42 unit tests (preservation goldens added).
- Failed: none (one test-authoring miscount fixed: classifier table has 26 entries,
  not 27).
- Not run: none outstanding.

Sanity:

- 184,046 events → 141 distinct fingerprints (~1,305 events/fp; GE 5, Philips 17,
  data_acquisition 119 — proportional to each app's error variety).
- GE (no err_msg) groups sanely by note.message ("No new file data. Delta: 0" →
  14,401 events, one fingerprint).
- `unknown` = 79% of events — expected: most WARN volume is pipeline-status noise;
  the taxonomy targets connection/extraction errors; severity handling is Phase 4's
  job. Category is not part of the fingerprint, so a future taxonomy improvement
  never re-buckets history.

## Review Notes

Source:

- `notes/review_results_phase_2.md` (Codex, from `notes/codex_handoff_phase_2.md`).

Critical issues:

- Codex verdict was "needs fixes before commit": (1) **high** — the 512-char
  normalization cap merged distinct failures (live evidence: two fingerprints each
  mixing `connection_timeout` with `partial_transfer_timeout`; the salient curl line
  sits past a variable-length progress preamble); (2) **high** — `note.system_id`
  (5,270 live events) was dropped and the entity order preferred per-run job UUIDs
  over equipment identity, and the 32-char entity cap truncated 36-char UUIDs;
  (3) **medium** — a blocked concurrent transaction's `now()` (transaction-start
  clock) could move the watermark backward; (4) **medium** — `FP_VERSION` wasn't
  persisted per row; (5) **medium** — 688 live events carry text only in
  `note.skip_reason`, which the chain discarded; (6) **low** — a non-null non-array
  `warn_error_logs` advanced silently.

Accepted fixes (all six findings):

- **F1**: `normalize.js` now line-filters noise BEFORE scrubbing (curl progress
  header/rows — both `--:--:--` and completed-time forms — and Node stack frames) and
  has NO length cap (output is only hashed). New frozen goldens prove: same failure
  with different progress-row counts/IPs/ports → same fingerprint;
  connection-timeout vs partial-transfer → distinct. Rebuilt live: **0 fingerprints
  with mixed categories** (was 2); the noise removal also merged previously
  over-split buckets — 141 → **82 fingerprints** over 185k events.
- **F2**: flatten stores validated `note.system_id` (authoritative) with sme-derivation
  as fallback — all 5,285 such live events now carry `system_id`; entity order is now
  `sme → system_id → job_id → __global__`; `entity` widened to VARCHAR(64) (holds a
  36-char job UUID losslessly). Contract docs + prompt_3 updated.
- **F3**: the batch snapshot is taken via `clock_timestamp()` in a separate statement
  AFTER the watermark row lock is held (a lock-waiting transaction can no longer carry
  an older bound), plus `GREATEST(last_inserted_at, $2)` defense in the advance.
  Proven live: watermark set 1 hour in the future → run exits 0 and the watermark did
  not regress; normal catch-up advances correctly afterward.
- **F4**: `error_events.fp_version SMALLINT NOT NULL` added (schema.sql + live ALTER +
  ColumnSet + flatten); all 185,090 rebuilt rows carry `fp_version = 1`.
- **F5**: `eventText` chain extended to `err_msg → note.message → note.txt →
  note.skip_reason → ''`; the 690 skip_reason-only events now fingerprint on the
  producer's stated reason (2 fingerprints, one per func). Docs synced (taxonomy,
  principles, incidents-schema).
- **F6**: a non-null non-array payload now emits a `skipped` diagnostic
  (`event_ord: null`) surfaced in the run's WARN log — visible but non-blocking; the
  test that locked in the silent behavior now requires the diagnostic.

Rebuild decision: **`FP_VERSION` stays 1.** Version-1 rows existed only as an
uncommitted backfill on this branch, nothing had consumed them, and source retention
still covered the whole window — so L0 was truncated and rebuilt from source under the
corrected formula (185,090 events, exact source parity re-verified) instead of
shipping a version-2 migration for data that was never accepted.

Re-review round 2 (`notes/review_results_phase_2_fixes.md`): confirmed findings
1/3/5/6 closed and 2/4 partially closed pending a tracked upgrade path; raised 1 high,
1 medium, 2 low — all fixed:

- **RF1 (high)** — the live `fp_version`/`entity` ALTERs weren't reproducible from the
  repo (schema.sql only had them inside `CREATE TABLE IF NOT EXISTS`). Fixed:
  `db/schema.sql` now ends with **idempotent per-phase UPGRADE sections** (fp_version
  add → backfill v1 → SET NOT NULL, no default left behind; entity widen-only to 64
  via a typmod-guarded DO block). Tested on all four paths: scratch Phase 1 database
  upgraded (backfill verified), re-apply idempotent, fresh install, live converge.
  DEPLOYMENT.md documents the "re-apply schema.sql on upgrade; never manual ALTERs"
  rule. This fully closes original findings 2 and 4.
- **RF2 (medium)** — the noise filter was over-broad (global `--:--:--`, global
  numeric-columns rule, prose-eating `^\s+at\s`). Fixed: curl progress rows are now
  dropped only inside a block opened by curl's own two-line header (stateful), and
  only lines shaped like real JS stack frames (`:line:col` / `(native)` /
  `<anonymous>` / `(index N)` tails) are dropped. Preservation goldens added for the
  review's three probes (tabular summary, indented "at least..." prose, `--:--:--`
  sentinel as content). **Equivalence proven two ways**: old-vs-new normalization
  diffed over all 1,808 distinct multiline texts in the live corpus → 0 differences
  (after adding the `(index N)` frame tail the first diff pass caught); L0 truncated
  and rebuilt → bounded checksum over (run_id, event_ord, fingerprint) is
  **byte-identical** to the pre-rewrite corpus (`343d91a2…`, 185,090 rows). FP_VERSION
  stays 1 with proof, not assertion.
- **RF3 (low)** — watermark audit metadata: the advance now uses
  `updated_at = clock_timestamp()` and `RETURNING last_inserted_at`; the run summary
  reports the STORED watermark (`watermark_after`) plus the requested
  `snapshot_upper_bound`. Proven live: with a future watermark, the summary reports
  the preserved future value (matches the DB to the millisecond), not the rejected
  snapshot.
- **RF4 (low)** — canonical docs contradicted the corrected contracts: this entry's
  Built section updated (no cap / noise-line filter, skip_reason chain, entity
  order + 64, post-lock snapshot, fp_version); `prompt_2_materialize.txt` carries an
  explicit SUPERSEDED-clauses banner; the Architecture Data-Contract Rule now names
  `note.skip_reason` and `note.system_id`.

Deferred findings (per round 1's "verified without findings" guidance, reaffirmed in
round 2):

- Single-transaction memory model: revisit before ~3–5× volume growth; record peak
  RSS / add a max-window bound when that work happens.
- `dt` source-clock policy for Phase 3 lifecycle timestamps (define fallback/skew
  policy using the source row's `inserted_at` — noted in prompt_3 planning).
- `raw_event` storage share (~101 MB of 230 MB): parked with the retention decision.
- Overlap default (5s) is adequate for autocommit producers; keep configurable and
  monitor for lock/commit stalls longer than the overlap (round 2 confirmation).

## Problems Encountered

- classify test initially asserted 27 table entries; the live table has 26 (authoring
  miscount, not a code defect). Fixed the assertion.

## Follow-Up Tasks

- Codex review of this phase (handoff ready); then commit.
- Phase 3 (`prompt_3_aggregate_incidents.txt`): aggregate `(fingerprint, entity)` →
  `incidents.incidents` with blast radius + enrichment join. Note for Phase 3: only
  ~39% of event smes exist in `stats.acquisition_history` — enrichment must be a LEFT
  join; recovery-oracle coverage gap matters in Phase 5.
- Open decisions unchanged: cron cadence, acquisition-v2 onboarding, self-ingestion,
  retention.

## Commit Readiness

- Requirements implemented: yes (per the re-evaluated prompt).
- Write-isolation / least-privilege rules hold: yes (no new grants; writes confined).
- Jobs idempotent (watermark + ON CONFLICT): yes — proven by re-run and rewind replay.
- Assessment deterministic (no LLM in critical path): n/a (assessor is Phase 4); all
  domain logic pure.
- Source queries read warn_error_logs only, partition-pruned: yes (EXPLAIN verified).
- Schema assumptions confirmed live: yes (see Schema Facts).
- Review findings addressed or deferred: yes — all 6 Codex findings fixed and
  re-proven live; 3 monitoring items deferred with reasons (see Review Notes).
- Validation recorded: yes.
- Ready to commit: yes, pending developer confirmation.

---

# Phase 1 — App Skeleton + Schema + Role Provisioning

Date:
2026-07-13

Status:
Completed

Prompt:
`prompts/prompt_1_app_skeleton_provision.txt`

Git Commit:
Pending

Review Artifacts:

- Codex handoff: `notes/codex_handoff_phase_1.md`
- Review results: `notes/review_results_phase_1.md` (1 high, 4 medium, 1 low — all fixed)
- Plus self-review against `markdown/REVIEW_CHECKLIST.md`

## Goals

- Stand up a runnable cron-batch app skeleton mirroring `data_acquisition` (CommonJS,
  positional-array logger, `pg-promise` pool with env fallback chains, `pgp.helpers`
  ColumnSets, `node index.js <job>` switch dispatch, batch one-shot compose).
- Create the owned `incidents` schema (`db/schema.sql`) exactly per
  `docs/incidents-schema.md`.
- Create + provision the least-privilege `incident_engine_rw` role
  (`db/setup-owner-role.sql`, fail-closed), switch `.env` off the borrowed
  `ops_dashboard_ro` role, and prove it with a self-log smoke run.

## Built

- `package.json` — CJS (no `"type"`), scripts `materialize`/`assess`/`run`/`test`;
  deps mirror `data_acquisition` (`dotenv`, `pg`, `pg-promise`, `uuid`).
- `index.js` — switch dispatch (`materialize`/`assess`/`run`/`noop`) + full run-log
  lifecycle (`makeAppRunLog` → `onBoot` → `runJob` → `addRunSummary` →
  `dbInsertLogEvents` → `writeLogEvents`). `materialize`/`assess` are logged stubs
  until Phases 2–5; `run` chains both.
- `utils/logger/log.js` + `enums.js` — copied from `data_acquisition` (positional-array
  export intact; express-http branch dropped — this app always writes a per-run file).
- `utils/db/pg-pool.js` — copied verbatim (`PGHOST||PG_HOST` fallbacks + `buildSsl`).
- `utils/db/sql/pg-helpers.js` — TableNames + ColumnSets for `util.app_run_logs`
  (self-log), `incidents.error_events`, `incidents.incidents` (+ `pipeline_state`
  TableName). JSONB columns carry explicit `::jsonb` casts.
- `docker-compose.yaml` — `pg_net` only, no port/server/redis, `user: "105:987"`,
  node_modules from `/opt/resources/node_mod_cache/incident-engine`, `RUN_LOGS_DIR`
  bind, `/opt/resources/ssl` read-only.
- `.env.example` — variable names per `markdown/ENVIRONMENT.md`, no secrets.
- `db/schema.sql` — `incidents.error_events` / `incidents.incidents` /
  `incidents.pipeline_state`, house DDL (BIGSERIAL where the contract has an `id`,
  TIMESTAMPTZ DEFAULT NOW(), BRIN on time columns, partial indexes, no partitioning).
- `db/setup-owner-role.sql` — idempotent, `-v pw=` parameterized, forced-safe role
  attrs (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`); transfers
  ownership of schema `incidents` + relations; fail-closed REVOKE→GRANT→DO-verify for
  `util` (SELECT+INSERT on `app_run_logs` only), `stats` (SELECT on
  `acquisition_history` only), and `alert` (nothing at all, USAGE included).
- `test/enums.test.js` — dependency-free smoke of the only pure helper this phase.
- Provisioned live: schema + role applied as superuser; strong generated password;
  `.env` now `PGUSER=incident_engine_rw` (password only in gitignored `.env`,
  `chmod 600`); host dirs `/opt/resources/node_mod_cache/incident-engine` and
  `/opt/run-logs/incident-engine` created group-`docker` mode `2775`.

## Schema Facts Confirmed (live DB)

- `util.app_run_logs`: partitioned table, RANGE on `inserted_at`, 7 partitions;
  columns `app_name text`, `run_id uuid`, `verbose_log json`, `warn_error_logs json`
  (both plain `json`, not `jsonb`), `inserted_at timestamptz DEFAULT now()`. Matches
  `/opt/apps/ops-dashboard/docs/logging-schema.md` — no doc fix needed.
- `stats.acquisition_history`: all documented columns confirmed (`run_id uuid NOT NULL`,
  `system_id varchar(8) NOT NULL`, `successful_acquisition boolean NOT NULL`,
  `error_category varchar(64)`, `phase varchar(32)`, `inserted_at timestamptz NOT NULL
  DEFAULT now()`); BRIN on `inserted_at`; not partitioned. Matches
  `docs/incidents-schema.md` assumptions.
- Apps writing `util.app_run_logs` in the last 3 days: `acquisition-v2`,
  `data_acquisition`, `hhm_rpp_ge`, `hhm_rpp_philips`, `ops-dashboard`.
- Server is PostgreSQL 16.13; neither schema `incidents` nor role
  `incident_engine_rw` existed before this phase.

## Important Decisions

### Ownership, not grants, for the owned schema

Decision: `incident_engine_rw` OWNS schema `incidents` and every relation in it
(transferred by `setup-owner-role.sql`), rather than receiving table-level grants.

Reason: matches the Least-Privilege Rule ("owns schema incidents — full DML/DDL
there") and survives future DDL phases without new grant plumbing.

Tradeoff: `db/schema.sql` can still be applied by a superuser first; the role script
must run after it to transfer ownership (runbook order in `DEPLOYMENT.md`).

### Linked BIGSERIAL sequences follow their table

Decision: the ownership-transfer loop alters tables/views only; sequences linked to
an identity/serial column cannot be `ALTER ... OWNER`'d directly (PG raises "cannot
change owner of sequence ... linked to table") — they follow the table
automatically. The DO-verify still asserts sequences ended up owned by the role.

Reason: first run of the script failed on `incidents.incidents_id_seq`; fixed and
re-run clean (the script is idempotent, so the partial first run was harmless).

Tradeoff: none.

### Non-zero exit on batch failure (deliberate house-style deviation)

Decision: `index.js` sets `process.exitCode = 1` in the `onBoot` catch block;
`data_acquisition` exits 0 on error.

Reason: this app is invoked by cron as a one-shot; a failed batch must be visible to
the scheduler/operator. Also added `db.$pool.end()` in `finally` so the one-shot
exits promptly instead of waiting out the pool idle timeout.

Tradeoff: small divergence from the mirrored app, documented here.

### `run` job defined now, cadence still open

Decision: `run` = `materialize` then `assess` in one process (stubs this phase); the
one-cron-line vs. two-staggered-lines question stays open in `PROMPTS.md` ("Not
decided yet") until the real jobs exist.

Reason: keeps Phase 1 within scope while making the normal cron invocation runnable.

Tradeoff: none.

## Architecture Notes

- Write-isolation / least-privilege impact: enforced at the credential layer now.
  Live grant matrix proven as the role itself (not SET ROLE): SELECT on
  `util.app_run_logs` ✓, SELECT on `stats.acquisition_history` ✓, INSERT self-log via
  the check-option view ✓, DDL/DML in `incidents` ✓; DENIED: INSERT on the
  `util.app_run_logs` base table, view-INSERT with a foreign `app_name` (check
  option), UPDATE/DELETE on `util.app_run_logs`, INSERT/UPDATE on
  `stats.acquisition_history`, `nextval` on external sequences, any access to
  `alert.*` (even SELECT — no USAGE), CREATE in schema `util`. Post-review, the
  `app_name='incident-engine'` discipline is **DB-enforced** (view WITH CHECK OPTION),
  not just code-level, and the role script's database-wide allowlist audit proves the
  whole surface on every run.
- Idempotency / watermark impact: `incidents.pipeline_state` table exists;
  `error_events` PK `(run_id, event_ord)` and `incidents` UNIQUE
  `(fingerprint, entity)` are in place as the future `ON CONFLICT` keys. No job
  logic yet.
- Classifier / fingerprint stability impact: none (no classifier code this phase).
- Determinism impact: none (no assessor code this phase); `ASSESSOR_KIND=rules`
  reserved in `.env.example`.
- Data-contract impact: no source reads yet beyond the grant; self-log INSERT only.
- Deployment impact: first real deploy surface — compose file + provisioned role.
  Superuser steps performed this phase: `db/schema.sql`, `db/setup-owner-role.sql`.
  Cron line NOT installed yet (cadence decided when real jobs land).

## Validation

Commands run:

```bash
docker exec -i pg_db psql -U postgres -d staging -X -v ON_ERROR_STOP=1 -f - < db/schema.sql
docker exec -i pg_db psql -U postgres -d staging -X -v pw="$PW" -f - < db/setup-owner-role.sql
# grant matrix as incident_engine_rw (via container psql, real login)
docker compose run --rm app npm install
docker compose run --rm app node index.js run          # also: materialize, assess, noop
docker run --rm -v "$PWD":/w -w /w node:lts node --test
```

Results:

- Passed: schema applied; hardened role script clean end-to-end (all DO-verify blocks
  + database-wide allowlist audit pass); drift-detection proven (injected PUBLIC grant
  and column-only grant both abort the script; clean after cleanup); grant matrix per
  spec including view semantics (correct-`app_name` view INSERT ✓; foreign `app_name`
  → check option violation; base-table INSERT → denied; external `nextval` → denied);
  `run`/`noop` exit 0 over `verify-full` TLS (TLSv1.3, hostname verified); failure
  paths exit 1 (unknown job, `APP_NAME` mismatch, closed `PGPORT` self-log failure,
  broken CA under `verify-full`); unit tests 8/8 pass (enums + build-ssl).
- Failed: first `setup-owner-role.sql` run only — linked-sequence ownership error
  (see decision above); fixed, re-run clean.
- Not run: none outstanding (the post-review failure-path smokes covered the
  previously deferred exit-code check).

Manual / smoke tests:

- Self-log row present: `util.app_run_logs` has `app_name='incident-engine'` rows
  (`verbose_log` 5 events, `warn_error_logs` 0 events on the `run` smoke).
- Per-run JSON written to `/opt/run-logs/incident-engine/` by the container user.
- Login as `incident_engine_rw` with the provisioned password works over TCP.

## Review Notes

Source:

- `notes/review_results_phase_1.md` (Codex, from `notes/codex_handoff_phase_1.md`) +
  self-review against `markdown/REVIEW_CHECKLIST.md`.

Critical issues:

- Codex verdict was "needs fixes before commit": (1) **high** — the fail-closed audit
  was per-schema table-level only (missed column-only grants, sequences, and
  PUBLIC-inherited privileges outside util/stats/alert); (2) **medium** — run-log
  persistence failures still exited 0 (reproduced with a closed port); (3) **medium** —
  self-log `app_name` not constrained at the credential layer; (4) **medium** —
  `verify-ca`/`verify-full` silently downgraded to unauthenticated TLS, and the deploy
  used `require`; (5) **medium** — an unknown job name reported success; (6) **low** —
  `addLogEvent` threw on a null/non-Error `err`.

Accepted fixes (all six findings):

- **F1**: `db/setup-owner-role.sql` now REVOKEs sequences as well as tables, verifies
  with `has_any_column_privilege` (catches column-only grants) +
  `has_sequence_privilege`, and ends with a **database-wide allowlist audit** over
  every non-system schema (allowlist: owned `incidents.*`; `util.app_run_logs` SELECT;
  `util.incident_engine_self_log` INSERT; `stats.acquisition_history` SELECT;
  documented `public.pg_stat_statements*` PUBLIC SELECT). Proven live: injected drift
  (a PUBLIC table grant, and a column-only `UPDATE(b)` grant — the old false negative)
  aborts the script; clean after cleanup. Residuals documented in the script header
  (cross-DB CONNECT/TEMP via PUBLIC needs pg_hba/cluster-wide action; PUBLIC EXECUTE
  on functions).
- **F3**: self-log now goes through `util.incident_engine_self_log` — a
  postgres-owned, auto-updatable view `WHERE app_name = 'incident-engine' WITH
  CASCADED CHECK OPTION`; the role's base-table INSERT is revoked. Proven live:
  view-INSERT with `app_name='data_acquisition'` → check option violation;
  direct base-table INSERT → permission denied. `index.js` also pins `APP_NAME` as a
  code constant and fails boot on a mismatched env.
- **F2**: single finalization path in `onBoot` — `makeAppRunLog` moved inside the
  lifecycle, both sinks (`dbInsertLogEvents`, `writeLogEvents`) return success/failure,
  stream errors are captured and awaited (`write_stream.end` callback + error listener),
  `db.$pool.end()` failures counted, `onBoot().catch(...)` terminates. Proven: the
  Codex repro (closed `PGPORT`) now exits 1.
- **F5**: unknown job throws after the WARN log event → exit 1 (`node index.js bogus`
  proven). `noop` remains the explicit successful no-op.
- **F4**: `buildSsl` extracted to `utils/db/build-ssl.js` (pure, unit-tested):
  `verify-ca`/`verify-full` fail closed on missing/unreadable CA, unknown modes abort,
  `verify-ca` gets `checkServerIdentity` skip, `require` kept as documented exception.
  Live `verify-full` against `pg_db` with the mounted CA verified (TLSv1.3) and made
  the deployed + `.env.example` default; broken-CA run proven to exit 1.
- **F6**: `addLogEvent` normalizes `err` (`err?.stack ?? (err == null ? "Unknown
  error" : String(err))`).

Deferred findings:

- Cross-database `CONNECT`/`TEMP` via `PUBLIC` and PUBLIC-function `EXECUTE` — not
  addressable per-role without cluster-wide impact; documented in the role script
  header with the pg_hba.conf option (per Codex's own framing).
- `psql -v pw=` process-visibility during one-time provisioning — accepted low
  residual per the review itself.

## Problems Encountered

- Problem: `ALTER TABLE ... OWNER` on a serial-linked sequence is rejected by PG.
  Resolution: alter tables/views only; sequences follow the table owner; verify
  block still checks them. Script re-run clean (idempotent).

## Follow-Up Tasks

- Phase 2 (`prompt_2_materialize.txt`): materialize job — watermark, partition-pruned
  `warn_error_logs` scan, normalize/fingerprint/classify, `ON CONFLICT DO NOTHING`
  into `incidents.error_events`; exercise the failure exit path.
  **Re-evaluated 2026-07-14 (FLOW Step 3) before implementation** — prompt revised:
  explicit `PRODUCING_APPS` allowlist with `incident-engine` self-log exclusion
  (feedback loop proven live), `acquisition-v2` parked, fingerprint text chain extended
  to `err_msg || note.message || note.txt` while it's still free (`FP_VERSION` stays 1),
  Phase 1 conventions folded in. Details: `notes/phase_2_reevaluation.md`.
- Decide cron cadence (one `run` line vs. staggered `materialize`/`assess`) when the
  real jobs exist; install the cron line.

## Commit Readiness

- Requirements implemented: yes (all Phase 1 deliverables).
- Write-isolation / least-privilege rules hold: yes — proven fail-closed at the
  credential layer.
- Jobs idempotent (watermark + ON CONFLICT): n/a this phase (keys + state table in
  place; no job logic yet).
- Assessment deterministic (no LLM in critical path): n/a (no assessor yet).
- Source queries read warn_error_logs only, partition-pruned: n/a (no source reads
  yet).
- Schema assumptions confirmed live: yes (see Schema Facts).
- Review findings addressed or deferred: yes.
- Validation recorded: yes.
- Ready to commit: yes, pending developer confirmation.

---

# Phase 0 — Workflow Scaffold

Date:
2026-07-13

Status:
Completed

Prompt:
`prompts/prompt_0_workflow_scaffold.txt`

Git Commit:
Pending

Review Artifacts:

- Review handoff: none (docs-only scaffold)
- Review results: none

## Goals

- Establish a measured, phase-based, prompt-driven development workflow for
  `incident-engine`, modeled on `ops-dashboard`'s, so future work is repeatable and
  reviewable.
- Encode the app's durable, non-negotiable rules — adapted from ops-dashboard to this
  app's **writer** identity (owns the `incidents` schema), **deterministic (no-LLM)**
  assessment, **idempotency**, and `data_acquisition` house style.
- Lay out the pipeline as a governed roadmap of small phases (1–5).

## Built

- `CLAUDE.md` — orientation + working agreement (writer app; deterministic; mirrors
  `data_acquisition`).
- `markdown/`: `FLOW.md`, `ARCHITECTURE_PRINCIPLES.md`, `PROMPTS.md`, `PHASE_TEMPLATE.md`,
  `PHASE_LOG.md` (this file), `REVIEW_CHECKLIST.md`, `ENVIRONMENT.md`, `DEPLOYMENT.md`.
- `prompts/`: `prompt_0_workflow_scaffold.txt` + planned phase prompts `prompt_1`..`prompt_5`.
- `notes/README.md` — review-handoff / findings convention.
- `docs/`: `error-taxonomy.md` (classifier vocabulary reused from `connection_regex.js`),
  `incidents-schema.md` (the owned schema contract), `README.md` (pointer to shared suite
  docs).
- `README.md` — fleshed out from the initial stub.

## Schema Facts Confirmed (live DB)

- None — this phase is documentation only; no queries, no schema, no `.env` change. Schema
  facts referenced in `docs/` are carried from the approved plan's live-DB exploration and
  are to be **re-confirmed in the phase that first uses them** (per the FLOW Step-2 rule).

## Important Decisions

### Governance-first, mirroring ops-dashboard

Decision: Build the full `markdown/` + `prompts/` + `notes/` + `docs/` governance system
before any pipeline code.

Reason: The user wants incident-engine to run on the same measured, reviewable workflow as
ops-dashboard from day one, so the pipeline is built as small governed phases rather than
one large change.

Tradeoff: Upfront docs effort before any runnable code; accepted for long-term
repeatability.

### Writer identity (Write-Isolation Rule replaces Read-Only Rule)

Decision: Encode a Write-Isolation Rule — writes confined to the owned `incidents` schema,
`SELECT`-only on `util`/`stats`, self-log INSERT under `app_name='incident-engine'` only.

Reason: Unlike ops-dashboard (strictly read-only), this app must write, but the same
least-privilege discipline applies. The suite precedent is a per-app owned schema
(`data_acquisition` → `alert.*`/`stats.*`).

Tradeoff: The app is a genuine pipeline writer; contained via a dedicated
`incident_engine_rw` role and fail-closed grants (provisioned in Phase 1).

### Deterministic assessment, pluggable for a future LLM

Decision: Assessment is a pure, unit-tested `assess(dossier)` behind an `ASSESSOR_KIND`
seam; no LLM now.

Reason: The user wants predictable, programmatic assessment; the production classifier
`connection_regex.js` already provides a deterministic taxonomy to reuse.

Tradeoff: Rules cover the known taxonomy; the unknown tail is flagged `unknown`/low
confidence for a human — an LLM can later fill that gap as an advisory implementation of
the same interface, never driving state.

## Architecture Notes

- Write-isolation / least-privilege impact: rule defined; enforcement (role + grants) lands
  in Phase 1.
- Idempotency / watermark impact: rule defined; implemented from Phase 2.
- Classifier / fingerprint stability impact: `FP_VERSION` + frozen `normalize.js` contract
  defined; implemented from Phase 2.
- Determinism impact: assessor purity + no-LLM-in-critical-path rule defined; implemented
  in Phase 4.
- Data-contract impact: `warn_error_logs`-only, partition-pruned source scans defined;
  implemented from Phase 2.
- Deployment impact: none this phase (docs-only). Cron-batch one-shot model documented in
  `DEPLOYMENT.md`.

## Validation

Commands run:

```bash
git status --short
# grep cross-references resolve (FLOW <-> PROMPTS <-> ARCHITECTURE_PRINCIPLES <-> REVIEW_CHECKLIST <-> PHASE_TEMPLATE)
```

Results:

- Passed: all scaffold files created and cross-reference correctly.
- Failed: none.
- Not run: app build / unit tests / DB smoke — none exist yet (docs-only phase).

Manual / smoke tests:

- Confirmed `.env` is gitignored and unchanged; no secrets in any doc.

## Review Notes

Source: self-review against `REVIEW_CHECKLIST.md` (Phase Scope + Secrets sections apply;
code sections N/A for a docs-only phase).

Critical issues: none.
Accepted fixes: none.
Deferred findings: none.

## Problems Encountered

- None.

## Follow-Up Tasks

- Phase 1: scaffold the app (mirror `data_acquisition`) and provision the `incidents`
  schema + `incident_engine_rw` role; switch `.env` from `ops_dashboard_ro` to the new
  role.

## Commit Readiness

- Requirements implemented: yes (governance scaffold).
- Write-isolation / least-privilege rules hold: yes (documented; no code yet).
- Jobs idempotent: N/A (no jobs yet).
- Assessment deterministic: N/A (no assessor yet; rule documented).
- Source queries read warn_error_logs only, partition-pruned: N/A (no queries yet; rule
  documented).
- Schema assumptions confirmed live: N/A (docs-only).
- Review findings addressed or deferred: yes (none).
- Validation recorded: yes.
- Ready to commit: yes.

---

# Pre-history (before this workflow existed)

- 2026-07-13: `/opt/apps/incident-engine` repo created (git init, `.gitignore`, stub
  `README.md`); `.env` added pointing at the `staging` DB on `pg_db` (initially reusing the
  read-only `ops_dashboard_ro` role — to be switched to `incident_engine_rw` in Phase 1).
- 2026-07-13: architecture + first-increment plan approved (standalone app mirroring
  `data_acquisition`; deterministic no-LLM assessment; full first increment decomposed into
  governed phases). Plan: `~/.claude/plans/i-would-like-to-sunny-newell.md`.
