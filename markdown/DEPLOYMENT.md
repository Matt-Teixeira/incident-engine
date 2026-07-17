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

The app runs as `user: "105:987"` on the external `pg_net` network, with `node_modules`
bind-mounted from `/opt/resources/node_mod_cache/incident-engine`.

## Cadence (decided 2026-07-16, after Phase 3)

**One** cron line calling `run`, half-hourly at **:25/:55** — installed in the host crontab:

```cron
25,55 * * * * cd /opt/apps/incident-engine && docker compose run --rm app node index.js run
```

Why one line, not two staggered ones: `materialize` and the `assess` aggregate **serialize on
a shared watermark row lock** (`pipeline_state['util.app_run_logs']` — see
`jobs/aggregate/index.js`), so they can never run concurrently by construction. Two lines
would only block each other while doubling the self-log rows, exit codes to monitor, and
failure modes. A single sequential `run` also guarantees the aggregate sees the freshest L0
and never waits on the lock at all.

Why :25/:55: the producers are all half-hourly and write in two bursts —
`data_acquisition` at `00,30` (+ staggered `10,40`/`16,46`/`17,47`/`58,28`) and
`hhm_rpp_ge`/`hhm_rpp_philips` at `15,45` (5–50s sleep stagger). Live, the bursts finish by
~:21 and ~:51, so :25/:55 runs just after each one and never piles onto the producers' DB
load. Steady-state a `run` is ~4–7s (~116ms when the window is empty). Trade-off: the small
`58,28` stragglers wait until the next run (~27 min).

The `cd` prefix is required — cron runs from `$HOME`, and `docker compose` without it fails
with "no configuration file provided". Match the suite's existing lines.

Output is not redirected (matching the rest of the suite), so run output lands in the cron
mail spool; the app's real observability is its self-log row in `util.app_run_logs`
(`app_name = 'incident-engine'`) and the per-run JSON in `/opt/run-logs/incident-engine/`.
A non-zero exit means the batch failed (see the exit-code rule in `PHASE_LOG.md` Phase 1).

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

## ⚠ Deploy boundary (Phase 5 review, medium — INFRA STEP PENDING)

**The cron currently executes the mutable working tree.** `docker-compose.yaml` mounts
`./:/workspace` and the cron line `cd`s into this directory — so a `git checkout`, or
half-saved uncommitted edits, are LIVE at the next :25/:55 tick with no deploy boundary.
Both Phase 4 and Phase 5 branch code ran in production before review this way.

Decided fix (pending the infra step, which needs root): run cron from a **dedicated
deployment worktree** that only ever points at a reviewed, committed ref:

```bash
# one-time (root or a user with /opt/apps write):
git -C /opt/apps/incident-engine worktree add /opt/apps/incident-engine-deploy main
cp /opt/apps/incident-engine/.env /opt/apps/incident-engine-deploy/.env   # gitignored, copied not linked
# edit the cron line to: cd /opt/apps/incident-engine-deploy && docker compose run --rm app node index.js run

# per deploy (after a phase is reviewed, committed, and merged):
git -C /opt/apps/incident-engine-deploy fetch origin && git -C /opt/apps/incident-engine-deploy checkout <reviewed-sha>
# then re-apply db/schema.sql if the phase changed it, and smoke per this runbook
```

The dev tree keeps its mount (that's what makes `docker compose run` smoke tests work);
only the CRON pointer moves. Until the infra step happens, treat `git checkout` in this
directory as a production deploy — because it is.

## Rollback

Batch jobs are stateless between runs (state lives in `incidents.*` + the watermark).
To roll back code, redeploy the previous commit; data written by a bad run is idempotent
and can be corrected by a re-run once the code is fixed. Schema changes roll back via a
reverse migration applied as a superuser.
