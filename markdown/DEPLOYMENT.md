# Deployment

`incident-engine` is a **cron-batch one-shot** app, like the rest of the `/opt/apps`
pipeline (and unlike `ops-dashboard`, which is a long-running service). Each run is
`docker compose run --rm app node index.js <job>` — it runs to completion and exits. There
is **no server and no published port**. See the Deployment Rule in
`ARCHITECTURE_PRINCIPLES.md`.

Since the 2026-08 migration this app follows the **fleet dev/release paradigm**
(`data_acquisition/docs/migration_CLAUDE.md` Part 1):

- **Dev tree** = the editable clone `~/apps/incident-engine`. Image
  `incident-engine:<your-username>`, runs as you (`RUN_USER=<you>`), logs land in-tree
  (`./utils/logger/logs`, gitignored), boot note records `RELEASE_SHA=dev-tree`.
- **Release copy** = `/opt/apps/incident-engine`, produced ONLY by `bash build-release.sh`
  from a clean, pushed dev tree. Image `incident-engine:svc`, runs as `svc` (entrypoint
  default — omit `RUN_USER`), logs to `/opt/run-logs/incident-engine`, boot note records
  the stamped `RELEASE_SHA`.
- `bash preflight-check.sh` validates either copy — expect **zero warnings**.

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

Invocation (host):

```bash
# dev tree (~/apps/incident-engine) — run as yourself
RUN_USER=$(id -un) docker compose run --rm app node index.js run
# release copy (/opt/apps/incident-engine) — omit RUN_USER, entrypoint defaults to svc
docker compose run --rm app node index.js run
```

The app runs its own image `incident-engine:${USER_ID}` on the external `pg_net`
network; `docker/entrypoint.sh` drops to the target user via gosu. `node_modules` is
in-tree, installed by `build.sh` (the shared `/opt/resources/node_mod_cache` is retired
for this app).

## Cadence (decided 2026-07-16, after Phase 3)

**One** cron line calling `run`, half-hourly at **:25/:55** — a hardened entry in
matt-teixeira's user crontab (this host's job apps historically live there; consolidation
into the shared svc crontab is data_acquisition BACKLOG 6f, a separate follow-up):

```cron
# ---------------- INCIDENT ENGINE (hardened 2026-08-26; runs release copy as svc) ----------------
25,55 * * * * cd /opt/apps/incident-engine && /usr/bin/flock -n /tmp/incident-engine.run.lock /usr/bin/docker compose run --rm -T app node index.js run >/opt/run-logs/incident-engine/cron.run.out 2>&1
```

Hardening notes: absolute `/usr/bin/docker` + `/usr/bin/flock` (cron's PATH is minimal);
`-T` (no TTY under cron); `flock -n` skips a tick rather than queueing (overlap is already
serialized DB-side by the `pipeline_state` row lock — the flock is belt-and-braces);
single-`>` bounded `.out` file whose first line is the boot provenance line
(`[incident-engine] job=run release_sha=<sha>`), catching failures that happen before
node starts and therefore reach neither log sink. `RUN_USER` and `HOME` are deliberately
NOT set. (Pre-migration the entry ran unhardened from the retired
`/opt/apps/incident-engine-deploy` worktree with output to the mail spool.)

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
with "no configuration file provided".

Observability: the self-log row in `util.app_run_logs` (`app_name = 'incident-engine'`,
boot note carries `RELEASE_SHA`), the per-run JSON in `/opt/run-logs/incident-engine/`,
and `cron.run.out` for anything that dies before node starts. A non-zero exit means the
batch failed (see the exit-code rule in `PHASE_LOG.md` Phase 1); a SIGTERM/SIGINT kill
also flushes both sinks and exits 1 (flush-once handlers in `index.js`).

## Smoke test (after a job/schema/role change)

```bash
# unit tests (pure domain logic)
docker run --rm -v "$PWD":/w -w /w --user "$(id -u):$(id -g)" node:lts node --test

# lifecycle smoke: boot → self-log insert → log file → exit 0
RUN_USER=$(id -un) docker compose run --rm app node index.js noop

# materialize a narrow window, then assess; re-run to prove idempotency
# (from the dev tree these advance the REAL watermark — that is safe by
# design: idempotent, and serialized against a concurrent cron run by the
# pipeline_state row lock. The runs self-log with RELEASE_SHA=dev-tree.)
RUN_USER=$(id -un) docker compose run --rm app node index.js materialize
RUN_USER=$(id -un) docker compose run --rm app node index.js assess
RUN_USER=$(id -un) docker compose run --rm app node index.js assess   # re-run: counts advance, no duplicate incidents
```

From the release copy, run the same commands in `/opt/apps/incident-engine` with
`RUN_USER` omitted.

Verify against the DB (as a superuser or the role):

- `SELECT count(*) FROM incidents.error_events;` ≈ the scanned source event count
- `SELECT count(*), count(*) FILTER (WHERE state='resolved') FROM incidents.incidents;`
- a self-log row exists: `SELECT max(inserted_at) FROM util.app_run_logs WHERE app_name='incident-engine';`
- the role is denied writes outside `incidents`:
  `SET ROLE incident_engine_rw; INSERT INTO stats.acquisition_history ...;  -- expect: permission denied`
- the self-log identity is DB-enforced:
  `INSERT INTO util.incident_engine_self_log(app_name, ...) VALUES ('data_acquisition', ...);  -- expect: check option violation`

## Deploy boundary (fleet paradigm — replaced the deploy worktree 2026-08-26)

The deploy boundary is **`build-release.sh`**: cron runs the release copy
`/opt/apps/incident-engine`, which only that script (run from a **clean, pushed** dev
tree) can replace — a `git checkout` in the clone never touches production.

**Per deploy** (after a phase is reviewed, committed, merged, and pushed):

```bash
cd ~/apps/incident-engine
# re-apply db/schema.sql FIRST if the phase changed it (as superuser), then:
bash build-release.sh          # refuses a dirty tree; stamps RELEASE_SHA
cd /opt/apps/incident-engine && bash preflight-check.sh   # expect zero warnings
docker compose run --rm app node index.js noop            # release smoke as svc
```

History: from 2026-07-17 to 2026-08-26 the deploy boundary was a git worktree,
`/opt/apps/incident-engine-deploy`, pinned to a reviewed SHA (Phase 5 review F3); before
that the cron executed the mutable dev tree, where a `git checkout` was an accidental
deploy. The worktree was retired at the paradigm cutover — same guarantee, one deploy
mechanism fleet-wide, plus the clean-tree guard and `RELEASE_SHA` provenance the worktree
never had. Credentials rotate in BOTH `.env` copies (clone + release).

## Rollback

Batch jobs are stateless between runs (state lives in `incidents.*` + the watermark).
To roll back code: `git checkout <previous-sha>` in the clone (or revert), then
`bash build-release.sh` — the stamp keeps `util.app_run_logs` honest about what ran.
Data written by a bad run is idempotent and can be corrected by a re-run once the code
is fixed. Schema changes roll back via a reverse migration applied as a superuser.
