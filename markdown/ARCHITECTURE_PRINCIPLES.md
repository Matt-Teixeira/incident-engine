# Architecture Principles

Durable rules for `incident-engine`. A phase prompt that conflicts with these must be
revised, or the rule must be changed deliberately (with a `PHASE_LOG.md` entry) before
implementation. These are not incidental preferences.

## Product Identity

`incident-engine` is a **deterministic error→incident pipeline** over the cron-driven
data-pipeline apps under `/opt/apps`. It reads the shared error stream and produces:

- **error events** — `util.app_run_logs.warn_error_logs` flattened one row per event,
  fingerprinted and classified (`incidents.error_events`)
- **incidents** — one row per distinct problem × affected equipment
  (`UNIQUE (fingerprint, entity)`), with occurrence count, blast radius, category,
  a deterministic **assessment** (severity/state/reasons), and lifecycle **state**
  (`incidents.incidents`)

The pipeline runs as stages: **materialize → fingerprint → classify → aggregate → assess →
state**. It reads pipeline logs; it never mutates them. It is a companion to
`ops-dashboard` (which will later *display* these incidents, read-only).

## Write-Isolation Rule

This app is a **writer**, but a contained one. (This is the counterpart to ops-dashboard's
Read-Only Rule.)

- It writes **only** the `incidents` schema, which it **owns**.
- It reads `util.app_run_logs` and `stats.acquisition_history` **read-only**.
- It self-logs its own runs into `util.app_run_logs` under **`app_name = "incident-engine"`
  only** — the single write outside `incidents`, via `INSERT` on that table.
- No `INSERT`/`UPDATE`/`DELETE`/DDL against any other pipeline-owned table (`alert.*`,
  `stats.*`, other apps' `util` rows).
- Enforce this at the credential layer (see Least-Privilege Rule), so a bug cannot write
  outside `incidents` even if the code tries.

## Determinism Rule

Assessment is **deterministic, pure, and unit-tested**, behind a pluggable interface.

- `assess(dossier)` is a pure function of an assembled dossier object — no DB handle, no
  clock, no network inside it. Same input → same output. Testable exactly like the
  domain helpers.
- **No LLM dependency now.** An LLM assessor is a *future* implementation of the **same
  `assess(dossier)` signature**, selected by `ASSESSOR_KIND`, and is **advisory only** —
  its output lands in the same columns but never drives incident **state** or
  **auto-close**, which stay deterministic.
- The classifier is deterministic and mirrors the production vocabulary in
  `/opt/apps/data_acquisition/util/tools/connection_regex.js` (see `docs/error-taxonomy.md`).

## Data-Contract Rule

The source is `util.app_run_logs`; confirmed facts (re-verify if the table changes):

- `verbose_log` and `warn_error_logs` are **`json`**, not `jsonb`. Accessing one element
  detoasts the whole blob. **This app reads `warn_error_logs` ONLY — never `verbose_log`.**
- The table is range-partitioned by month; every source scan **must** bound
  `inserted_at` so partitions prune.
- Only a few apps emit warn/error events (`data_acquisition`, `hhm_rpp_ge`,
  `hhm_rpp_philips`). Event fields are **top-level** (`type`, `func`, `tag`, `err_msg`,
  `dt`) with a nested `note`. `err_msg` is sparse (0% on `hhm_rpp_ge`); fall back to
  `note.message`. `note.sme` (~64% present) is the cross-app equipment key.
- **Source retention is short (~7 days)**, so this app **persists its own durable
  rollups** rather than assuming long history upstream.

A **second, read-only contract** backs enrichment and the recovery oracle:
`stats.acquisition_history` (per-run × per-system facts with `error_category`, `phase`,
`modality`, `manufacturer`, and `successful_acquisition`). BRIN-indexed on `inserted_at`,
not partitioned. This app only reads it. See `docs/incidents-schema.md` for the join.

## Idempotency Rule

Every job is re-runnable with no double-count.

- A persistent **watermark** (`incidents.pipeline_state`) advances only within the batch's
  fixed `now()` upper bound; a small overlap lookback absorbs commit skew.
- All writes are `ON CONFLICT` (append-only `error_events` keyed `(run_id, event_ord)`;
  aggregated `incidents` keyed `(fingerprint, entity)`).
- The watermark advances in the **same transaction** as the batch's writes, so a crash
  mid-batch re-scans and the idempotent writes absorb the replay.

## Least-Privilege Rule

The app connects as a dedicated role **`incident_engine_rw`**. Its grants are: **owns
schema `incidents`** (full DML/DDL there); `CONNECT`; `SELECT` on exactly
`util.app_run_logs` and `stats.acquisition_history`; `INSERT` on `util.app_run_logs`
(self-log only). Nothing else — no other object in any schema, no writes outside
`incidents` + the self-log INSERT. The external `SELECT` grants are applied **fail-closed**
(the setup script REVOKEs, re-grants only the intended privileges, then a `DO` block RAISEs
if any other effective privilege remains), so re-running the script *proves* the surface.
Never ship the app pointed at a superuser. Role setup lives in `db/setup-owner-role.sql`
(idempotent; re-run as a superuser to apply changes before deploying code that needs them).

## Fingerprint-Stability Rule

Incidents are only as good as their grouping key.

- The fingerprint is `sha1(src_app_name | func | tag | type | normalize(err_msg ||
  note.message))`, carrying a `FP_VERSION` constant so a formula change is detectable.
- `normalize.js` (scrubbing IPs / paths / ids / timestamps into placeholders) is a
  **frozen, golden-tested contract** — changing it changes every fingerprint, so it moves
  only in a deliberate, logged phase with `FP_VERSION` bumped.
- `hhm_rpp_ge` emits **no `err_msg`**, so its signal is `func` + `app` + `note.message` —
  validate GE grouping quality specifically whenever the formula changes.

## House-Style Rule

Match the **existing `data_acquisition` app** (not the in-progress `acquisition-v2`):

- Node.js, **CommonJS**; positional-array logger (`utils/logger/log.js`); `pg-promise` with
  env fallback chains (`PGHOST || PG_HOST`); writes via `pgp.helpers` ColumnSets, never
  hand-rolled string SQL
- DDL house style: `BIGSERIAL` PK, `TIMESTAMPTZ DEFAULT NOW()`, BRIN on time columns,
  **no table partitioning** (mirror `stats.acquisition_history`); declare all columns up
  front
- `node index.js <job>` dispatch via a `switch`
- runs in Docker on the external `pg_net` network, DB at `pg_db:5432`, `user: "105:987"`,
  `node_modules` from `/opt/resources/node_mod_cache/incident-engine`

Deviate only with a clear, logged reason.

## Deployment Rule

Unlike `ops-dashboard` (a long-running service), this is a **cron-batch one-shot** like the
rest of the pipeline: `docker compose run --rm app node index.js <job>`, run to completion,
exit. **No published port, no server.** Deployment changes happen only when a phase calls
for them. See `markdown/DEPLOYMENT.md`.

## Secrets Rule

No phase exposes `.env` values, passwords, connection strings, or SSL cert contents in
docs, prompts, screenshots, or commits. Docs may name environment variables; they must not
contain secret values. `.env` stays gitignored.

## Decision Rule

When choices conflict, prefer the option that:

1. keeps writes confined to the owned `incidents` schema and the app least-privilege
2. keeps assessment deterministic, pure, and testable (no LLM in the critical path)
3. keeps jobs idempotent (watermark + `ON CONFLICT`)
4. confirms schema assumptions against the live DB rather than trusting docs
5. reads `warn_error_logs` only (never detoasts `verbose_log`)
6. matches the `data_acquisition` house style
7. avoids secret exposure
8. can be reviewed and reverted in a small phase
