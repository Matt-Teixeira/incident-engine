# CLAUDE.md — incident-engine

Orientation for an AI assistant (or new contributor) picking this project up cold.

> ## ⚠ MID-MIGRATION (started 2026-08-26)
>
> This app is being migrated to the fleet dev/release paradigm — the same migration
> `data_acquisition` (pilot, 2026-08-24) and `monday` (2026-08-25) completed. The spec is
> `/opt/apps/data_acquisition/docs/migration_CLAUDE.md` (Part 1 = conventions, Part 3 =
> checklist); `~/apps/data_acquisition` and `~/apps/monday` are the reference
> implementations. **Until this banner is removed, sections of this file and of
> `markdown/DEPLOYMENT.md` may describe the PRE-migration state** (deploy worktree,
> stock `node:lts` image, `user: "105:987"` pin, `RUN_ENV`/`RUN_LOGS_DIR`/`LOGGER` env
> keys). Where this file disagrees with the migration spec, the spec wins. Sections are
> corrected in the commit that makes them true.
>
> Target state: editable clone at `~/apps/incident-engine`; `/opt/apps/incident-engine`
> is release output produced only by `build-release.sh`; own image
> `incident-engine:${USER_ID}` (dev) / `incident-engine:svc` (release) with a gosu
> entrypoint; logs via `${LOG_DIR:-./utils/logger/logs}` failing safe to the dev path;
> `RELEASE_SHA` provenance in every run's boot note; hardened cron entry at the
> unchanged :25/:55 cadence. The `/opt/apps/incident-engine-deploy` worktree is retired
> at cutover.

## What this project is

`incident-engine` is a **deterministic error→incident pipeline** for the cron-driven
data-pipeline apps under `/opt/apps` (the same suite `ops-dashboard` monitors). Those
apps ingest medical-imaging equipment telemetry (GE / Philips / Siemens modalities) and
log uniformly into `util.app_run_logs`. They already surface tens of thousands of
WARN/ERROR events per day, but there is **no aggregation, classification, or
assessment** — an operator sees a firehose, not a small set of distinct problems.

This app closes that gap. It reads the shared error stream, collapses it into
**incidents** (one per distinct problem, per affected equipment), classifies each with a
**deterministic** rules engine (no LLM), assesses severity/state, and auto-resolves
incidents when the underlying system recovers. It **owns** a new `incidents` schema and
writes only there.

Nothing is built yet beyond this governance scaffold. Work proceeds one small,
reviewable **phase** at a time — see `markdown/FLOW.md`.

## The single most important fact

The suite already logs in a **uniform, shared format** to PostgreSQL table
**`util.app_run_logs`** (`app_name`, `run_id`, `verbose_log`, `warn_error_logs`, both
`json`, `inserted_at`). This app reads **`warn_error_logs` only** (never `verbose_log` —
that column detoasts expensively) and needs **no changes to the other apps**. The full
contract is in `/opt/apps/ops-dashboard/docs/logging-schema.md`; **verify column types
against the live DB before relying on them.**

The deterministic classifier this app reuses already exists in production:
`/opt/apps/data_acquisition/util/tools/connection_regex.js` — an ordered, first-match-wins
regex table mapping raw error text to a stable `error_category`. Its vocabulary is
mirrored in `docs/error-taxonomy.md`.

## This app is a WRITER (unlike ops-dashboard)

`ops-dashboard` is strictly read-only. `incident-engine` is a **first-class pipeline
writer** — but a disciplined one:

- It **owns** the `incidents` schema and writes **only** there.
- It reads `util.app_run_logs` and `stats.acquisition_history` **read-only**.
- It self-logs its own runs into `util.app_run_logs` under `app_name = "incident-engine"`
  — the one write outside `incidents`, via the `util.incident_engine_self_log`
  check-option view, so the DB rejects any other `app_name`.
- It **never** writes `util`/`alert`/`stats` data, and connects as a dedicated
  least-privilege role `incident_engine_rw`, never a superuser.

See the **Write-Isolation Rule** and **Least-Privilege Rule** in
`markdown/ARCHITECTURE_PRINCIPLES.md`.

## Key docs (read in this order)

| Doc | What's in it |
|---|---|
| `markdown/FLOW.md` | **Start here.** The phase-based workflow loop |
| `markdown/ARCHITECTURE_PRINCIPLES.md` | Durable, non-negotiable rules for this app |
| `docs/error-taxonomy.md` | The deterministic classifier vocabulary (reused from `connection_regex.js`) |
| `docs/incidents-schema.md` | The `incidents` schema contract this app owns |
| `markdown/PROMPTS.md` | Phase roadmap + status |
| `markdown/PHASE_LOG.md` | Durable memory of what's been done and why |
| `/opt/apps/ops-dashboard/docs/logging-schema.md` | The shared `util.app_run_logs` data contract |
| `/opt/apps/ops-dashboard/docs/infra-conventions.md` | Suite house style (deploy/compose/DB) |

## Conventions this app follows (house style)

Mirror the **existing `data_acquisition` app**, not the in-progress `acquisition-v2`
rewrite:

- **Runtime:** Node.js, **CommonJS** (`require`/`module.exports`, no `"type": "module"`).
- **Logger:** reuse the suite's positional-array logger (`utils/logger/log.js`:
  `[addLogEvent, writeLogEvents, dbInsertLogEvents, makeAppRunLog, ...]`); self-log under
  `APP_NAME`.
- **DB:** `pg-promise` with env fallback chains (`process.env.PGHOST || process.env.PG_HOST`),
  SSL via `PG_SSLMODE`/`PG_SSL_PATH`. Writes via `pgp.helpers` ColumnSets (parameterized),
  never hand-rolled string SQL.
- **Image:** own image `incident-engine:${USER_ID}` (dev = your username, release = `svc`)
  built from `docker/Dockerfile` — node:lts + gosu, docker group + svc/dev users from
  no-default build ARGs, baked `docker/entrypoint.sh` (defaults `RUN_USER` to svc, repairs
  a root-owned log dir before dropping privileges). Deps are in-tree `node_modules` via
  `build.sh` (the `/opt/resources/node_mod_cache` mount is retired).
- **Logs:** container path is always `utils/logger/logs/`; the compose mount
  `${LOG_DIR:-./utils/logger/logs}` decides the host side — unset FAILS SAFE to the dev
  tree, the release copy points at `/opt/run-logs/incident-engine` via `#RELEASE:LOG_DIR`.
  Filename tag is `${USER_ID}`; `LOGGER_MODE` (`log`/`log_and_console`) gates console
  output. (`RUN_ENV`, `RUN_LOGS_DIR`, `LOGGER` are retired.)
- **Provenance:** `build-release.sh` stamps `RELEASE_SHA` into the deployed `.env`;
  every boot logs it in the `env_note` (and on stdout), `dev-tree` when unset. A scheduled
  run showing `dev-tree` means cron is running the wrong copy.
- **DDL:** house style — `BIGSERIAL` PK, `TIMESTAMPTZ DEFAULT NOW()`, BRIN on time columns,
  **no table partitioning** (mirror `stats.acquisition_history`).
- **Dispatch:** `node index.js <job>` via a `switch` in `index.js`.
- **Deploy:** cron-**batch** one-shot in Docker on `pg_net` — **not** a long-running
  service. The editable clone lives at `~/apps/incident-engine`;
  `/opt/apps/incident-engine` is release output produced ONLY by `build-release.sh`
  (clean-tree guard, `#RELEASE:` overrides, `RELEASE_SHA` stamp). Dev:
  `RUN_USER=<you> docker compose run --rm app node index.js <job>` from the clone.
  Production: same command from `/opt/apps/incident-engine` with `RUN_USER` omitted
  (entrypoint defaults to svc). See `markdown/DEPLOYMENT.md`.

## Working agreement

- **Determinism first.** Assessment is a **pure, deterministic, unit-tested** function
  behind a pluggable `assess(dossier)` interface. **No LLM dependency** now; an LLM is a
  future *advisory* implementation of the same signature — it never drives state.
- **Idempotent.** Every job is re-runnable (persistent watermark + `ON CONFLICT`) with no
  double-count.
- Confirm the live schema (`util.app_run_logs`, `stats.acquisition_history`) before writing
  query logic. `/opt/apps` is **not** a git repo at the top level; this `incident-engine`
  dir **is** its own repo. Only commit within this dir.
- Keep secrets (`.env`, passwords) out of docs and commits. `.env` stays gitignored.

## Development workflow

Phase-based and prompt-driven, identical in spirit to ops-dashboard:

- `markdown/FLOW.md` — the workflow loop and phase execution steps (**start here**)
- `markdown/ARCHITECTURE_PRINCIPLES.md` — durable rules
- `markdown/PROMPTS.md` — the phase roadmap and status
- `markdown/PHASE_LOG.md` — durable memory of what's been done and why
- `markdown/REVIEW_CHECKLIST.md` — the quality gate before any commit
- `markdown/ENVIRONMENT.md`, `markdown/DEPLOYMENT.md` — env rules + deploy runbook
- `prompts/prompt_X_*.txt` — the structured prompt for each phase
- `notes/` — review handoffs and findings

Next planned work is **Phase 1 — App skeleton + schema + role provisioning**
(`prompts/prompt_1_app_skeleton_provision.txt`).
