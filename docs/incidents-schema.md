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
| `category` | VARCHAR(64) | the representative event's `error_category`; when that is `unknown` it may be **corroborated** from the oracle. Same vocabulary either way — the oracle's values are a subset of this app's classifier taxonomy (both trace to `connection_regex.js`), so `category` is always a valid classifier **string**. ⚠ **That is NOT the same as describing this incident** — and this sentence, as originally written ("always a valid classifier category"), is what talked Phase 4 into consuming an advisory field as evidence. A corroborated category is the latest *unrelated* category for the equipment. **Always read `category_source` before trusting `category`** (Phase 4 review, HIGH). The assessor dispatches on `category` only when `category_source = 'classifier'`; never on `error_type` (see below) |
| `error_type` | VARCHAR(16) | the classifier's `error_type` only — **not** corroborated (the oracle has no type column and the aggregate does no category→type lookup). **`''` on 253 of 504 live rows** (2026-07-16): every `unknown` incident (classify returns `error_type: ''`) *plus* the ~40 oracle-corroborated ones. The Phase 3 record said "~39" — that counted only the corroborated rows and missed the `unknown`s, i.e. it understated the gap by an order of magnitude. **Consequence: a rules table keyed on this column misfires on half the table** — the Phase 4 assessor keys on `category` and looks the taxonomy's `error_type`/flags up by category from `connection_regex.js`. Deriving it from the corroborated category is possible and is a tracked follow-up |
| `category_source` | VARCHAR(16) | `classifier` \| `oracle` — **where `category` came from**, added Phase 4 (review, HIGH finding). `classifier` = this incident's own events matched a pattern. `oracle` = they did **not**; the aggregate filled the `unknown` with the latest non-unknown category for the same `system_id` — time- and run-uncorrelated, i.e. a fact about the equipment's recent past, **not about this problem**. Live: 464 classifier / **40 oracle**, and **all 40 oracle rows carry a category that appears nowhere in their own L0 events** (`No new monitoring data found.` was stamped `rsync_io_timeout`; `File not present` → `host_unreachable`). Written by the aggregate from the enrichment join itself — never inferred from `error_type = ''`, a signature that dies the moment the tracked "populate `error_type` on corroborated rows" follow-up lands. **The assessor assesses anything not explicitly `classifier` as `unknown`**: a category alone is not evidence. "Advisory only" was documented from Phase 3 and enforced by nothing, so its first consumer consumed it as fact |
| `type` | VARCHAR(8) | `WARN` / `ERROR` — the producing app's own label, denormalized from `error_events` by the aggregate (Phase 4). **Lossless**: `type` is inside the fingerprint, so one fingerprint carries exactly one type (live-verified: 0 fingerprints carry both; `db/schema.sql` re-proves this on every apply and RAISEs if it ever stops holding). **It does NOT mean the operation succeeded** — producers log real failures as WARN (see `docs/error-taxonomy.md` §"What `type` does NOT mean"), so it lowers the assessor's `confidence` but **never moves `severity`** — anywhere, since round 2's M2 decision collapsed the last split (`unknown` → interim medium for both types, pending classification of the confirmed hard-failure messages). **Nullable on purpose** (unlike `error_events.entity`): `incidents` is the durable rollup and `error_events` is the volatile layer, so an incident whose L0 rows aged out has nothing to backfill from. The assessor treats a null type as ERROR (fail-safe) |
| `phase` | VARCHAR(32) | `''` in Phase 3 (not enriched; per-run, uncorrelatable without a `run_id` join) |
| `func` | VARCHAR(64) | |
| `severity` | VARCHAR(16) | assessor: critical/high/medium/low/info. **WARN/ERROR never caps severity** — it only lowers `confidence` (Phase 4 review, MEDIUM). `critical` is declared but **no Phase 4 rule emits it** — nothing in the taxonomy distinguishes a worse-than-fleet-wide fault, so it is reserved rather than decorative |
| `confidence` | NUMERIC(3,2) | assessor: 0..1. The assessor rounds to 2dp so the stored value equals the pure function's output exactly (the DB would otherwise round it silently) |
| `assessor_kind` | VARCHAR(16) | `rules` now (`llm` reserved). Selected by `ASSESSOR_KIND`; an unrecognized value fails the run rather than defaulting |
| `assessor_version` | SMALLINT | which **rules content** produced the stored severity (`RULES_VERSION` in `domain/assessor/rules.js`), mirroring the `error_events.fp_version` precedent. `assessor_kind` alone is not provenance — it stays `rules` across every rules change, so a severity from a superseded threshold would otherwise be indistinguishable from a current one. Bump `RULES_VERSION` whenever a rule, threshold, or action string changes |
| `assessment` | JSONB | `{ reasons[], recommendedAction? }` — the rationale only. `severity`/`confidence` are first-class indexed columns and are not duplicated here. Carries **no** `state`/`resolved_*`: the assessor must never set lifecycle state (Phase 5), and the `AssessResult` shape has nowhere to put it |
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
