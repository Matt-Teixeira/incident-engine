# Deployment

`incident-engine` is a **cron-batch one-shot** app, like the rest of the `/opt/apps`
pipeline (and unlike `ops-dashboard`, which is a long-running service). Each run is
`docker compose run --rm app node index.js <job>` — it runs to completion and exits. There
is **no server and no published port**. See the Deployment Rule in
`ARCHITECTURE_PRINCIPLES.md`.

> This runbook is the target shape; the concrete `docker-compose.yaml`, `package.json`
> scripts, and cron entries are created in **Phase 1**. Until then this documents intent.

## One-time provisioning (superuser)

Before the app can run, the owned schema + least-privilege role must exist. Apply as a
superuser (e.g. `docker exec -i pg_db psql -U postgres -d staging`):

1. `db/schema.sql` — creates the `incidents` schema, tables, indexes, and `pipeline_state`.
   The same file carries **idempotent per-phase UPGRADE sections** at the end: re-apply
   it (as superuser) whenever a phase changes the schema — a fresh database gets the
   final shape from the CREATEs, an existing one converges via the upgrade sections.
   Never apply schema changes manually outside this file.
2. `db/setup-owner-role.sql` — creates `incident_engine_rw` (owns `incidents`; fail-closed
   `SELECT` on `util.app_run_logs` + `stats.acquisition_history`; `INSERT` via the
   `util.incident_engine_self_log` check-option view for self-log — no base-table INSERT).
   Ends with a database-wide allowlist audit that aborts on any unexpected effective
   privilege. Idempotent; re-run to apply grant changes **before** deploying code that
   needs them.
3. Point `.env` at the role: `PGUSER=incident_engine_rw`, `PGPASSWORD=<the role's password>`.

Re-run `db/setup-owner-role.sql` after any DB reset — a reset wipes schemas/grants (roles
survive). This is the same failure mode ops-dashboard hit; the fail-closed script re-proves
the grant surface.

## Jobs

| Job | What it does |
| --- | --- |
| `materialize` | L0: watermark → scan `warn_error_logs` → flatten/fingerprint/classify → `incidents.error_events`. |
| `assess` | L1/L2/L3/L5: aggregate → `incidents.incidents`, deterministically assess, run the state machine + auto-close. |
| `run` | `materialize` then `assess` in one process (the normal cron invocation). |

Invocation (host, in the app dir):

```bash
docker compose run --rm app node index.js run
```

Cadence is a cron line calling `run` (or two staggered lines for `materialize` / `assess`)
— decided in Phase 1. The app runs as `user: "105:987"` on the external `pg_net` network,
with `node_modules` bind-mounted from `/opt/resources/node_mod_cache/incident-engine`.

## Smoke test (after a job/schema/role change)

```bash
# unit tests (pure domain logic)
docker run --rm -v "$PWD":/w -w /w node:lts node --test

# materialize a narrow window, then assess; re-run to prove idempotency
docker compose run --rm app node index.js materialize
docker compose run --rm app node index.js assess
docker compose run --rm app node index.js assess   # re-run: counts advance, no duplicate incidents
```

Verify against the DB (as a superuser or the role):

- `SELECT count(*) FROM incidents.error_events;` ≈ the scanned source event count
- `SELECT count(*), count(*) FILTER (WHERE state='resolved') FROM incidents.incidents;`
- a self-log row exists: `SELECT max(inserted_at) FROM util.app_run_logs WHERE app_name='incident-engine';`
- the role is denied writes outside `incidents`:
  `SET ROLE incident_engine_rw; INSERT INTO stats.acquisition_history ...;  -- expect: permission denied`
- the self-log identity is DB-enforced:
  `INSERT INTO util.incident_engine_self_log(app_name, ...) VALUES ('data_acquisition', ...);  -- expect: check option violation`

## Rollback

Batch jobs are stateless between runs (state lives in `incidents.*` + the watermark).
To roll back code, redeploy the previous commit; data written by a bad run is idempotent
and can be corrected by a re-run once the code is fixed. Schema changes roll back via a
reverse migration applied as a superuser.
