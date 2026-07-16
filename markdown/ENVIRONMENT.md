# Environment

Environment variable **names and rules** for `incident-engine`. This doc names variables;
it never contains secret **values**. `.env` stays gitignored (see the Secrets Rule in
`ARCHITECTURE_PRINCIPLES.md`). The live `.env.example` (added in Phase 1) is the
copy-pasteable template.

## Variables

| Var | Purpose |
| --- | --- |
| `APP_NAME` | Identity for self-logging into `util.app_run_logs`. **Must be `incident-engine`** — `index.js` fails boot on a mismatch, and the DB-side check-option view rejects any other value. |
| `LOGGER` | Logger tag in the run-log filename (`${APP_NAME}-log.${LOGGER}.${run_id}.json`). Mirrors `data_acquisition`. |
| `RUN_LOGS_DIR` | Where per-run JSON logs are written (e.g. `/opt/run-logs/incident-engine`). The host dir must be writable by `105:987`. |
| `PGHOST` / `PG_HOST` | DB host. In-suite: `pg_db`. (`PGHOST` is tried first, then `PG_HOST`.) |
| `PGPORT` / `PG_PORT` | DB port (`5432`). |
| `PGDATABASE` / `PG_DB` | DB name (`staging`). |
| `PGUSER` / `PG_USER` | DB role. **Must be `incident_engine_rw`** (least-privilege owner of `incidents`). Not a superuser. |
| `PGPASSWORD` / `PG_PW` | DB password for the role. **Never** appears in docs/commits. |
| `PG_SSLMODE` | `disable` / `require` / `verify-ca` / `verify-full`. **This app deploys `verify-full`** (CA + hostname, fail-closed: a missing/unreadable CA aborts the run rather than downgrading). `require` (encrypted, unauthenticated) is a documented trust-boundary exception, not a default. |
| `PG_SSL_PATH` | CA cert path for `verify-*` modes (shared host cert `/opt/resources/ssl/pg_ssl.crt`). |
| `ASSESSOR_KIND` | Which assessor implementation to use. Default **`rules`** (the only one that exists — Phase 4). Unset/blank ⇒ `rules`; an **unrecognized value throws** and fails the run rather than silently defaulting (`domain/assessor/index.js`). A future `llm` value would select an **advisory** implementation of the same `assess(dossier)` interface — it never drives incident `state`. |
| `MATERIALIZE_OVERLAP_MS` | Watermark overlap lookback for the materialize scan. Default **30000** (30s): the overlap is the only protection against a producer row whose INSERT→commit gap outlives it (statement-time `inserted_at`, commit-time visibility) — such a row is skipped silently and permanently once source retention expires. Re-scanned rows are absorbed by `ON CONFLICT`. |
| `MATERIALIZE_BATCH_ROWS` | Max source rows per insert chunk (bounds memory). |
| `ASSESS_WINDOW_HOURS` | (optional, **not yet read by any code**) Reserved for Phase 5: how far back auto-close re-evaluates open incidents against the recovery oracle. Phase 4's assessment step deliberately takes **no** window — it re-assesses every incident each run, because blast radius is a fingerprint-level property and a row-local/windowed predicate leaves an untouched row's severity stale forever (see `utils/db/queries/assess.js` and PHASE_LOG Phase 4). |

## Rules

- **Least privilege:** `PGUSER` is `incident_engine_rw` — it owns the `incidents` schema,
  has `SELECT` on `util.app_run_logs` + `stats.acquisition_history`, and `INSERT` only
  through the `util.incident_engine_self_log` check-option view (self-log; no INSERT on
  the base table). Never point the app at a superuser. Create/alter the role once with
  `db/setup-owner-role.sql` (as a superuser). See the Least-Privilege Rule.
- **Fallback chain:** the pool reads `process.env.PGHOST || process.env.PG_HOST` (and the
  same for port/db/user/password), mirroring `data_acquisition/utils/db/pg-pool.js`.
- **Secrets:** only variable **names** appear here and in prompts. Values live only in the
  gitignored `.env`.
- **Self-log identity:** `APP_NAME` must stay `incident-engine` so self-logged runs are
  attributable and never collide with another app's rows.
