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
| `job_id` | TEXT | `note.job_id` |
| `system_id` | VARCHAR(8) | `note.system_id` when present (validated), else derived from `sme` (`^SME\d{5}$` ⇒ sme IS the system_id) |
| `fingerprint` | CHAR(40) | `sha1(app\|func\|tag\|type\|normalize(err_msg\|\|note.message\|\|note.txt\|\|note.skip_reason))` |
| `fp_version` | SMALLINT NOT NULL | which fingerprint formula produced this row (`FP_VERSION`) — provenance for version-aware rebuilds |
| `error_category` | VARCHAR(64) | classify output (`unknown` when unmatched) |
| `error_type` | VARCHAR(16) | connection / key / credentials / file |
| `phase` | VARCHAR(32) | best-effort from enrichment; default '' |
| `dt` | TIMESTAMPTZ | event `dt` |
| `raw_event` | JSONB | the whole original event |
| `inserted_at` | TIMESTAMPTZ | DEFAULT NOW() |

- **PK `(run_id, event_ord)`** → idempotent re-materialize via `ON CONFLICT DO NOTHING`.
- Indexes: BRIN(`inserted_at`); `(fingerprint, dt DESC)`; partial `(sme, dt DESC) WHERE sme
  IS NOT NULL`; partial `(system_id) WHERE system_id IS NOT NULL`.

## `incidents.incidents` — one row per `(fingerprint, entity)` (L1/L2/L3/L5)

| column | type | notes |
| --- | --- | --- |
| `id` | BIGSERIAL PK | |
| `fingerprint` | CHAR(40) | with `entity`, the identity |
| `entity` | VARCHAR(64) | `sme` → `system_id` → `job_id` → `__global__` (system_id above job_id: job ids are per-run UUIDs; 64 holds a 36-char UUID losslessly) |
| `occurrence_count` | BIGINT | += batch count on upsert |
| `first_seen` / `last_seen` | TIMESTAMPTZ | LEAST / GREATEST on upsert |
| `apps` | TEXT[] | blast radius across apps (union) |
| `systems` | TEXT[] | affected `system_id`s (union) |
| `sample_run_id` | UUID | representative event |
| `sample_message` | TEXT | representative normalized message |
| `category` | VARCHAR(64) | mirrors `error_category` |
| `error_type` | VARCHAR(16) | |
| `phase` | VARCHAR(32) | |
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
- **Enrichment + recovery oracle:** `stats.acquisition_history` (SELECT-only) — join on
  `system_id`/`run_id` for `error_category`/`phase`/`modality`/`manufacturer`;
  `successful_acquisition=true` with a timestamp later than an incident's `last_seen` drives
  deterministic auto-close.
