# Codex Review Handoff — Phase 3 (Aggregate Incidents)

## 1. What this app is

`incident-engine` is a **deterministic error→incident pipeline** for the `/opt/apps`
medical-imaging data-pipeline suite. It reads the shared error stream
(`util.app_run_logs.warn_error_logs`, read-only) and writes **only** the `incidents`
schema it owns. Orientation: `CLAUDE.md`, durable rules in
`markdown/ARCHITECTURE_PRINCIPLES.md`, the schema contract in `docs/incidents-schema.md`.

Pipeline stages: **materialize (L0, Phase 2) → aggregate (L1/L2, this phase) → assess
(L3, Phase 4) → state/auto-close (L5, Phase 5)**.

## 2. Scope of this review

**Branch:** `phase-3-aggregate-incidents` (off `phase-2-materialize`). Phases 0–2 are
committed/unmerged and chain in order; review only the Phase 3 delta.

**What Phase 3 does:** roll new `incidents.error_events` rows up into `incidents.incidents`,
one row per `(fingerprint, entity)`, via a watermarked, idempotent
`INSERT … SELECT … GROUP BY … ON CONFLICT (fingerprint, entity) DO UPDATE` upsert:
`occurrence_count` (additive), `first_seen`/`last_seen` (LEAST/GREATEST), `apps[]`/`systems[]`
unions, a representative event, and best-effort enrichment. No assessor/severity/state/
auto-close (`state`, `severity`, `confidence`, `assessor_kind`, `assessment`, `resolved_*`,
`action_*` stay unwritten).

**Files (the delta):**

- `domain/entity.js` — **dropped `job_id`** from the entity fallback (now `sme → system_id
  → __global__`); `test/entity.test.js` updated.
- `jobs/materialize/flatten.js` — stamps `entity` (via `entity()`) on each L0 row; computes
  `system_id` once and reuses it; `test/flatten.test.js` updated.
- `utils/db/sql/pg-helpers.js` — `entity` added to the `error_events` ColumnSet.
- `db/schema.sql` — `error_events.entity VARCHAR(64) NOT NULL` in CREATE + a Phase 3 UPGRADE
  section (add nullable → SQL backfill → SET NOT NULL).
- `utils/db/queries/incidents.js` — the aggregate upsert SQL (the correctness core).
- `utils/db/queries/enrichment.js` — the `stats.acquisition_history` corroboration fragment.
- `jobs/aggregate/index.js` — the watermarked, serialized, zero-overlap transaction.
- `index.js` — `assess` now calls `aggregate` (was a stub).
- Docs: `docs/incidents-schema.md`, `markdown/PROMPTS.md`, `markdown/PHASE_LOG.md`.

**Out of scope:** the frozen `normalize.js`/`fingerprint.js`/classifier (`FP_VERSION=1`
untouched); the materialize job's internals (only its ColumnSet + entity stamping changed);
the least-privilege role (no new grant needed — the role owns `incidents`, so the new
`error_events.entity` column and all `incidents` writes are already covered; verify this).

## 3. How to run / verify it

`node` is **not** on the host. Unit tests in bare `node:lts`; jobs via compose; DB as
superuser via `docker exec`.

```bash
# unit tests (pure domain logic)
docker run --rm -v "$PWD":/w -w /w node:lts node --test          # 48/48

# apply the schema upgrade (adds + backfills error_events.entity), as superuser
docker exec -i pg_db psql -U postgres -d staging -X -v ON_ERROR_STOP=1 -f - < db/schema.sql

# run the aggregate as the app role (incident_engine_rw), then re-run
docker compose run --rm app node index.js assess                 # upsert
docker compose run --rm app node index.js assess                 # re-run: no double-count
docker compose run --rm app node index.js run                    # materialize → assess

# exactly-once invariant: sum(occurrence_count) must equal the L0 row count
docker exec -i pg_db psql -U postgres -d staging -Atc \
 "SELECT (SELECT sum(occurrence_count) FROM incidents.incidents)
       - (SELECT count(*) FROM incidents.error_events) AS delta;"   # must be 0
```

## 4. Hard constraints the code must respect (please try to falsify)

- **Idempotency / exactly-once (the crux).** `occurrence_count` is additive
  (`+= EXCLUDED`). There is **no overlap lookback** (unlike materialize). Completeness
  instead comes from **serialization**: the aggregate transaction locks the *materialize*
  watermark row (`pipeline_state['util.app_run_logs']`) `FOR UPDATE` before taking its
  `clock_timestamp()` snapshot, so no materialize tx is in flight during the snapshot and
  there is no commit-skew to lose. **Please attack this:** can a `error_events` row be
  committed-but-invisible below the snapshot and thus be skipped forever? Can any row be
  counted twice under normal re-run / crash-retry? Is the lock order deadlock-free
  (materialize locks only the util row; aggregate locks util-row then its own error_events
  row)? Rationale is in the header of `utils/db/queries/incidents.js` and
  `jobs/aggregate/index.js`.
- **Write-isolation.** All writes target `incidents.incidents` + `incidents.pipeline_state`
  only; `stats.acquisition_history` is SELECT-only in the enrichment CTE. No `verbose_log`.
- **Least-privilege.** Runs as `incident_engine_rw`; the live `assess`/`run` smokes
  succeeded as that role (proves it can read `error_events.entity`, SELECT the oracle, and
  write `incidents` with no new grant).
- **Determinism.** No LLM. Enrichment is advisory and only corroborates `category` when
  classify returned `unknown` (never overwrites a confident category; never writes NULL).
- **House style.** The aggregate is a set-based `INSERT … SELECT … ON CONFLICT` (as the
  prompt directs) rather than a `pgp.helpers` per-row insert — fully static + parameterized
  ($1/$2 window bounds only). Confirm this is the right call and injection-free.

## 5. Known weak spots — please scrutinize

1. **`occurrence_count` under overlap-free + serialization.** The whole idempotency story
   rests on the materialize-row lock eliminating commit-skew so overlap can be dropped.
   Verify the argument end-to-end, including: two concurrent `assess` runs; an `assess`
   racing a long `materialize`; a crash between the upsert and the watermark advance.
2. **Watermark rewind is deliberately NOT idempotent.** With an additive counter, moving
   the aggregate watermark backward after a committed batch re-adds rows. We treat rewind
   as out-of-scope operator action (the Idempotency Rule covers re-run/crash, not rewind);
   recovery = truncate `incidents` + reset the watermark + re-aggregate. Is documenting-vs-
   guarding the right call?
3. **Entity contract change.** `job_id` removed from the fallback. `domain/entity()` is the
   single source of truth; the **one-time SQL backfill** in `db/schema.sql` re-implements it
   for stored rows. Parity was verified live (0 mismatches over 186k rows), but confirm the
   backfill expression truly matches `entity()` for all inputs (trim/empty/cap semantics),
   and that a fresh install vs. an upgraded install converge (column present, NOT NULL,
   values equal).
4. **`sample_message` / representative selection.** Reconstructs the human-readable
   `eventText` chain in SQL (`err_msg → note.message → raw_event #>> note.txt →
   note.skip_reason`). Does this match `domain/fingerprint.js:eventText` closely enough?
   Representative is `DISTINCT ON … ORDER BY ts DESC, run_id, event_ord DESC`; the ON
   CONFLICT refresh of representative-derived fields is guarded by
   `EXCLUDED.last_seen >= inc.last_seen`. Look for a way this regresses or flip-flops the
   sample across runs.
5. **`ts = COALESCE(dt, inserted_at)`.** `dt` is the source app's own clock (currently
   never null in 186k rows). A future null-`dt` row falls back to L0 `inserted_at`, which is
   a poor proxy after a backfill. A skewed source clock could push `last_seen` into the
   future — untouched here (producer's truth), relevant to Phase 5 auto-close timing.
6. **Enrichment coarseness.** `run_id` never joins the oracle (0/124,361), so corroboration
   uses the *most recent* non-`unknown` `error_category` for the `system_id`, **time-
   uncorrelated** with the incident. 39/498 incidents were corroborated live. Is advisory,
   system-level, latest-wins corroboration acceptable, or should it be dropped until Phase 5
   can time-correlate?

## 6. What is intentionally deferred (do not file as bugs)

- No assessor / severity / state / confidence / auto-close / `action_*` (Phases 4–5).
- `apps[]`/`systems[]` are structurally near-singleton at the `(fingerprint, entity)` grain
  (fingerprint already partitions by app; entity is the system). Kept per contract; a true
  cross-app blast radius would need a coarser, app-agnostic key — out of scope.
- Cron cadence (`run` vs. staggered), `acquisition-v2` onboarding, self-ingestion,
  `error_events` retention — all still open (`PROMPTS.md`).
- Single-transaction aggregate holds the batch in the DB (set-based, no JS paging); revisit
  with the materialize memory item if volume grows.

## 7. Output format requested

Per finding: **severity** (high/medium/low) · **`path:line`** · **what & why** · **suggested
fix**. Bias toward **fewer, high-confidence** findings; prioritize the idempotency/exactly-
once core (§5.1–5.2) first, then correctness of the entity backfill (§5.3), then enrichment/
representative semantics. Please don't relitigate settled decisions (stack, house style, the
frozen fingerprint, the deterministic-no-LLM stance).
