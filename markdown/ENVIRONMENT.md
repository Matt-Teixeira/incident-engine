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
| `ASSESSOR_KIND` | Which assessor implementation to use. Default **`rules`** (the only one now). A future `llm` value selects the advisory implementation of the same `assess(dossier)` interface. |
| `MATERIALIZE_OVERLAP_MS` | Watermark overlap lookback (commit-skew safety) for the materialize scan. Small (e.g. a few seconds). |
| `MATERIALIZE_BATCH_ROWS` | Max source rows per insert chunk (bounds memory). |
| `ASSESS_WINDOW_HOURS` | (optional) Bound for how far back `assess` re-evaluates open incidents / recovery. |

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
