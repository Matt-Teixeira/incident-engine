# `incidents` schema (owned by incident-engine)

The schema this app **owns and writes**. House DDL style (mirror
`data_acquisition/db/tables/TABLES.sql`): `CREATE ... IF NOT EXISTS`, `BIGSERIAL` PK,
`TIMESTAMPTZ ... DEFAULT NOW()`, BRIN on time columns, `IF NOT EXISTS` named indexes,
partial indexes with `WHERE col IS NOT NULL`, **no table partitioning**. All columns
declared up front. The concrete DDL is `db/schema.sql` (created in Phase 1); this doc is the
contract it must match.

## `incidents.error_events` — append-only flattened facts (L0)

One row per `warn_error_logs` event, fingerprinted + classified at materialize time.

| column | type | notes |
| --- | --- | --- |
| `run_id` | UUID | source `util.app_run_logs.run_id` |
| `event_ord` | INT | 0-based index within the `warn_error_logs` array |
| `src_app_name` | VARCHAR(64) | `data_acquisition` / `hhm_rpp_ge` / `hhm_rpp_philips` |
| `type` | VARCHAR(8) | `WARN` / `ERROR` |
| `func` | VARCHAR(64) | event `func` (richest per-app axis) |
| `tag` | VARCHAR(32) | `DETAILS` / `CATCH` / `CALL` / `QA FAILURE` / '' |
| `err_msg` | TEXT | sparse (0% on hhm_rpp_ge) |
| `note_message` | TEXT | `note.message` (err_msg fallback) |
| `sme` | VARCHAR(16) | `note.sme` — cross-app equipment key (~46–84% by app) |
| `job_id` | TEXT | `note.job_id` (stored for provenance; **not** an entity key — see `entity`) |
| `system_id` | VARCHAR(8) | `note.system_id` when present (validated), else derived from `sme` (`^SME\d{5}$` ⇒ sme IS the system_id) |
| `entity` | VARCHAR(64) NOT NULL | the incident dimension, stamped at materialize time by `domain/entity()`: `sme → system_id → '__global__'`. The Phase 3 aggregate GROUPs on this stored value (single source of truth; never re-derived in SQL). |
| `fingerprint` | CHAR(40) | `sha1(app\|func\|tag\|type\|normalize(err_msg\|\|note.message\|\|note.txt\|\|note.skip_reason))` |
| `fp_version` | SMALLINT NOT NULL | which fingerprint formula produced this row (`FP_VERSION`) — provenance for version-aware rebuilds |
| `error_category` | VARCHAR(64) | classify output (`unknown` when unmatched) |
| `error_type` | VARCHAR(16) | connection / key / credentials / file |
| `phase` | VARCHAR(32) | best-effort from enrichment; default '' |
| `dt` | TIMESTAMPTZ | event `dt` |
| `raw_event` | JSONB | the whole original event |
| `inserted_at` | TIMESTAMPTZ | `DEFAULT clock_timestamp()` (insert-time, **not** transaction-start `NOW()`). This is the cursor the Phase 3 aggregate watermarks on; stamping it post-lock keeps a late-committing materialize's rows from landing below an advanced aggregate watermark (exactly-once). |

- **PK `(run_id, event_ord)`** → idempotent re-materialize via `ON CONFLICT DO NOTHING`.
- Indexes: BRIN(`inserted_at`); `(fingerprint, dt DESC)`; partial `(sme, dt DESC) WHERE sme
  IS NOT NULL`; partial `(system_id) WHERE system_id IS NOT NULL`.

## `incidents.incidents` — one row per `(fingerprint, entity)` (L1/L2/L3/L5)

| column | type | notes |
| --- | --- | --- |
| `id` | BIGSERIAL PK | |
| `fingerprint` | CHAR(40) | with `entity`, the identity |
| `entity` | VARCHAR(64) | `sme` → `system_id` → `__global__` (Phase 3 **dropped `job_id`**: a per-run UUID as entity fractures one problem into one incident per run — live, that turned 4 fingerprints into ~38k singleton incidents; 498 with it removed). 64 is a harmless backstop; live values are ≤16. |
| `occurrence_count` | BIGINT | += batch count on upsert (additive; exactly-once — see the aggregate query header) |
| `first_seen` / `last_seen` | TIMESTAMPTZ | LEAST / GREATEST of `COALESCE(dt, inserted_at)` on upsert (`dt` = the event's own clock; `inserted_at` fallback only for null-`dt` rows) |
| `apps` | TEXT[] | contributing apps (union). **Structurally single-element**: `src_app_name` is part of the fingerprint, so one fingerprint is one app — kept as contract/future-proofing, not a cross-app signal at this grain |
| `systems` | TEXT[] | affected `system_id`s (union); empty for `__global__` incidents |
| `sample_run_id` | UUID | representative event (most recent by `dt` in the batch) |
| `sample_message` | TEXT | representative message (human-readable `eventText` chain, not the normalized hash input) |
| `category` | VARCHAR(64) | the representative event's `error_category`; when that is `unknown` it may be **corroborated** from the oracle. Same vocabulary either way — the oracle's values are a subset of this app's classifier taxonomy (both trace to `connection_regex.js`), so `category` is always a valid classifier category |
| `error_type` | VARCHAR(16) | the classifier's `error_type` only — **not** corroborated (the oracle has no type column and the aggregate does no category→type lookup). `''` on the ~39 oracle-corroborated rows; deriving it from the corroborated category is possible and is a tracked follow-up |
| `phase` | VARCHAR(32) | `''` in Phase 3 (not enriched; per-run, uncorrelatable without a `run_id` join) |
| `func` | VARCHAR(64) | |
| `severity` | VARCHAR(16) | assessor: critical/high/medium/low/info |
| `confidence` | NUMERIC(3,2) | assessor: 0..1 |
| `assessor_kind` | VARCHAR(16) | `rules` now (`llm` reserved) |
| `assessment` | JSONB | `{ reasons[], recommendedAction? }` |
| `state` | VARCHAR(16) | open / acknowledged / recurring / resolved / suppressed |
| `resolved_at` | TIMESTAMPTZ | |
| `resolved_reason` | VARCHAR(32) | e.g. `auto_recovery` |
| `action_state` | VARCHAR(16) | **reserved for future L4 — never written this increment** |
| `action_ref` | TEXT | reserved |
| `created_at` / `updated_at` | TIMESTAMPTZ | DEFAULT NOW() |

- **`UNIQUE (fingerprint, entity)`** — the upsert key.
- Indexes: `UNIQUE(fingerprint, entity)`; `(state, last_seen DESC)`; `(severity, last_seen
  DESC)`; BRIN(`last_seen`).

## `incidents.pipeline_state` — watermarks

| column | type | notes |
| --- | --- | --- |
| `source_key` | TEXT PRIMARY KEY | `util.app_run_logs` (materialize) / `incidents.error_events` (assess) |
| `last_inserted_at` | TIMESTAMPTZ | advanced only within a batch's fixed `now()` bound |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() |

## Reads (never written by this app)

- **Source:** `util.app_run_logs.warn_error_logs` (json; partitioned; SELECT-only; never
  `verbose_log`).
- **Enrichment + recovery oracle:** `stats.acquisition_history` (SELECT-only). **Phase 3
  Step-2 reality:** the source `run_id` does **not** correlate with
  `acquisition_history.run_id` (0 of 124,361 rows matched on it), so the join is on
  `system_id` **only** (~111/217 distinct systems match → LEFT join, most entities don't
  enrich). `incidents` has no `modality`/`manufacturer` columns and `phase` is a per-run
  fact we can't correlate, so Phase 3 enrichment **only corroborates `category` when the
  deterministic classifier returned `unknown`** (advisory; classify stays primary; never
  overwrites a confident category or writes a NULL). Time-correlated use of this oracle —
  `successful_acquisition=true` later than an incident's `last_seen` driving deterministic
  auto-close — is **Phase 5**, not here.
