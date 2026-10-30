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

## Cadence (decided 2026-07-16; svc crontab at :02/:32 since 2026-10-30)

**One** cron line calling `run`, half-hourly at **:02/:32**, in the **svc crontab**: on a
fleet host the svc crontab is the only schedule (pg_manage_v2 runbook
`docs/runbook/full_setup_3.0.md` 5.1), never a named user's crontab. The owner installs
it with the runbook's 5.2 append method (back up, append, count; never
`crontab -u svc <file>`, which replaces the whole crontab). A svc crontab change is
approved by the owner each time.

```cron
# ---------------- INCIDENT ENGINE (svc crontab; runs the release copy as svc) ----------------
02,32 * * * * cd /opt/apps/incident-engine && /usr/bin/flock -n /tmp/incident-engine.run.lock /usr/bin/docker compose run --rm -T app node index.js run >/opt/run-logs/incident-engine/cron.run.out 2>&1
```

Hardening notes: absolute `/usr/bin/docker` + `/usr/bin/flock` (cron's PATH is minimal);
`-T` (no TTY under cron); `flock -n` skips a tick rather than queueing (overlap is already
serialized DB-side by the `pipeline_state` row lock — the flock is belt-and-braces);
single-`>` bounded `.out` file whose first line is the boot provenance line
(`[incident-engine] job=run release_sha=<sha>`), catching failures that happen before
node starts and therefore reach neither log sink. `RUN_USER` is deliberately NOT set
(the entrypoint defaults to svc). The lock file lives in `/tmp`, where
`fs.protected_regular=2` stops one user opening another user's file with `O_CREAT`: any
hand run that takes the same lock must run as svc (see "First run after a gap"), or a
lock file left owned by someone else can fail every later tick.

Why one line, not two staggered ones: `materialize` and the `assess` aggregate **serialize on
a shared watermark row lock** (`pipeline_state['util.app_run_logs']` — see
`jobs/aggregate/index.js`), so they can never run concurrently by construction. Two lines
would only block each other while doubling the self-log rows, exit codes to monitor, and
failure modes. A single sequential `run` also guarantees the aggregate sees the freshest L0
and never waits on the lock at all.

Why :02/:32 (acq-vm-2, RPP spread cadence, runbook 5.3.2–5.3.4): producer writes to
`util.app_run_logs` measured over 24h on 2026-10-30 —

| Minutes | Producer | Events per half-hour |
| --- | --- | --- |
| :20/:50 | hhm_rpp_ge | ~145 |
| :22–:28 / :52–:58 | hhm_rpp_philips (sleep stagger up to 48s) | ~260 |
| :03, :05, :10, :12 / :33, :35, :40, :42 | data_acquisition reduced block | ~13 |
| :15–:22 / :45–:52 | data_acquisition queue consumers | 0 |

The runbook's reference slot :25/:55 (chosen when the producers burst at :00/:30 and
:15/:45) now falls inside the Philips burst, so the runbook says to move it on this
profile. :02/:32 starts about three minutes after the last Philips run ends, takes the
whole burst in one run, and finishes (~4–7s steady state) before data_acquisition's
:03/:33 run. :29/:59 was rejected: the :28/:58 Philips runs may still be writing. That
is harmless to correctness (watermark), but it splits a burst across two runs.
Trade-off: data_acquisition's small :03–:12 writes wait 20–29 minutes.

History: from 2026-07-16 the line lived in matt-teixeira's user crontab at :25/:55. It
was never installed on acq-vm-2. The only real runs against that host's `dev` database
were the hand-run first controlled runs of 2026-10-09 (runbook 4.5, dev tree), so
nothing ran `run` there until 2026-10-30 (see "First run after a gap").

The `cd` prefix is required — cron runs from `$HOME`, and `docker compose` without it fails
with "no configuration file provided".

Observability: the self-log row in `util.app_run_logs` (`app_name = 'incident-engine'`,
boot note carries `RELEASE_SHA`), the per-run JSON in `/opt/run-logs/incident-engine/`,
and `cron.run.out` for anything that dies before node starts. A non-zero exit means the
batch failed (see the exit-code rule in `PHASE_LOG.md` Phase 1); a SIGTERM/SIGINT kill
also flushes both sinks and exits 1 (flush-once handlers in `index.js`).

## First run after a gap

`materialize` reads EVERYTHING since the watermark in ONE scan and ONE transaction. It has
no window cap, so after days or weeks unscheduled the first run carries the whole backlog
in memory. Then the state step resolves, all at once, every open incident that stayed
quiet for more than 7 days (`stale`) or that the oracle shows recovered (`auto_recovery`).
Problems that began and ended inside the gap are created already resolved.

Measured on acq-vm-2 (2 vCPU, 8 GiB, no swap) on 2026-10-30, three weeks after the
2026-10-09 watermark. This was a read-only dry run of the real scan, flatten and
insert-SQL build in the dev image; the insert itself was scaled from the 2026-10-09 run
(109,507 events, 40s):

| Measure | Value |
| --- | --- |
| source rows / events | 22,447 / 365,113 |
| scan + flatten + SQL build (no DB write) | 39s |
| estimated full `run` | 2.5–3 min |
| peak RSS / heap (Node heap limit 2,240 MB) | 815 MB / 634 MB |
| incidents before → after | 280 → 609 |
| existing open → resolved | 165 stale, 16 auto_recovery (9 stay open) |
| existing resolved → recurring | 1 |
| new incidents | 216 open, 53 auto_recovery, 60 stale |

Rule of thumb: the producers emit about 20k events per day, and the backlog costs about
1.7 KB of heap (2.2 KB RSS) per event. The 2.2 GB heap limit is therefore near 1.3M
events. Keeping a safety margin, treat about five weeks (~700k events) as the ceiling
for an unbounded first run. A longer gap needs a bounded catch-up, and today's code has
no such mode. The other hard limit is source
retention: events in a `util.app_run_logs` partition dropped before the catch-up are lost
silently.

Procedure: the owner approves the first run (it writes `incidents.*`) and runs it **by
hand from the release copy as svc**, BEFORE the cron line goes in. Start it outside the
:20–:28 and :50–:58 bursts. Running it as svc keeps the lock file svc-owned.

```bash
cd /
sudo -u svc env HOME=/opt/apps/.svc-home bash -c 'cd /opt/apps/incident-engine && /usr/bin/flock -n /tmp/incident-engine.run.lock /usr/bin/docker compose run --rm -T app node index.js run; echo "exit=$?"'
ls -l /tmp/incident-engine.run.lock     # expect owner svc
```

Expected: the provenance line with the release SHA, then `exit=0`. Then check
`incidents.pipeline_state` (both watermarks at the run's time), the `state` counts in
`incidents.incidents`, and the run's self-log row (the `materialize` timer carries
`src_rows`/`events_inserted`; the `state` timer carries `transition_counts`).

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
bash build-release.sh          # refuses a dirty tree; stamps RELEASE_SHA + RELEASE_AT
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
