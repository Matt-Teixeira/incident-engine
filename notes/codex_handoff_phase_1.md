# Codex Handoff — incident-engine Phase 1 (App Skeleton + Schema + Role Provisioning)

A briefing for an automated reviewer (e.g. Codex) picking up this codebase to review
the phase that was just implemented. Read this first, then review the code under the
scope below. The goal is a **correctness + security + least-privilege** review of the
app scaffold, the owned-schema DDL, and the fail-closed role provisioning.

---

## 1. What this app is (30-second version)

`incident-engine` is a **deterministic error→incident pipeline** over the cron-driven
data-pipeline apps under `/opt/apps` (medical-imaging telemetry). It reads the shared
error stream `util.app_run_logs.warn_error_logs` (json; never `verbose_log`), collapses
it into incidents (one per distinct problem × affected equipment), classifies and
assesses them with **pure, rules-based functions (no LLM)**, and auto-resolves on
recovery. It **owns and writes only** the `incidents` schema, connecting as the
least-privilege role `incident_engine_rw`; its one write outside that schema is a
self-log INSERT into `util.app_run_logs` under `app_name = 'incident-engine'`.

Full context: `CLAUDE.md`, `markdown/ARCHITECTURE_PRINCIPLES.md`,
`docs/incidents-schema.md`. This document is self-contained enough to review without
them, but they explain the "why".

Phase 1 is **scaffold + provisioning only** — there is deliberately no pipeline logic
yet (materialize/aggregate/assess arrive in Phases 2–5 behind the stubs you'll see).

---

## 2. Scope of this review

Review the working tree of branch `phase-1-app-skeleton-provision` (commit pending —
this handoff precedes the phase commit). Concretely:

```
package.json                 CJS app manifest; scripts materialize/assess/run/test
index.js                     entrypoint: switch dispatch + run-log lifecycle; job stubs
utils/logger/log.js          positional-array run logger (copied from data_acquisition)
utils/logger/enums.js        log-event type/tag vocabulary (copied verbatim)
utils/db/pg-pool.js          pg-promise pool, PGHOST||PG_HOST fallbacks, buildSsl
utils/db/sql/pg-helpers.js   pgp.helpers TableNames + ColumnSets (all write surfaces)
db/schema.sql                the owned `incidents` schema (3 tables + indexes)
db/setup-owner-role.sql      incident_engine_rw: ownership + fail-closed grants
docker-compose.yaml          cron-batch one-shot, pg_net, user 105:987, no port
.env.example                 env contract (.env itself is gitignored)
test/enums.test.js           dependency-free smoke test
```

**Out of scope:** `markdown/`, `docs/`, `prompts/`, `notes/` (process docs);
`package-lock.json` beyond dependency sanity; the other suite apps (we only read their
data); and the stack choice (Node CJS + pg-promise + positional logger deliberately
mirrors `/opt/apps/data_acquisition` — don't relitigate it). The `materialize`/`assess`
stubs are placeholders by design; don't file "not implemented" as a finding.

---

## 3. How to run / verify it

`node` is **not** installed on the host — everything runs in Docker. The schema and
role are already provisioned on the live DB (database `staging` on container `pg_db`);
`.env` (gitignored) already points at `incident_engine_rw`.

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test     # unit tests
docker compose run --rm app node index.js run               # smoke: exits 0
docker exec -i pg_db psql -U postgres -d staging -c \
  "SELECT max(inserted_at) FROM util.app_run_logs WHERE app_name='incident-engine';"
```

Re-applying the DDL/role scripts is idempotent (superuser):

```bash
docker exec -i pg_db psql -U postgres -d staging -v ON_ERROR_STOP=1 -f - < db/schema.sql
docker exec -i pg_db psql -U postgres -d staging -v pw='<password>' -f - < db/setup-owner-role.sql
```

---

## 4. Hard constraints the code must respect (verify these hold)

1. **Write isolation.** All writes confined to schema `incidents`; the single
   exception is the self-log INSERT into `util.app_run_logs` under
   `app_name = 'incident-engine'`. No write path (present or latent in the ColumnSets)
   may touch `alert.*`, `stats.*`, or other apps' `util` rows.
2. **Least privilege, fail-closed.** `db/setup-owner-role.sql` must provably deny
   everything outside: ownership of `incidents`; SELECT+INSERT on `util.app_run_logs`
   only; SELECT on `stats.acquisition_history` only; *nothing* in `alert` (not even
   USAGE). The DO-verify blocks must catch drift (including via PUBLIC) and abort.
   The role must keep safe attributes even if it pre-existed.
3. **Never `verbose_log`.** No query may read `util.app_run_logs.verbose_log`
   (the column detoasts expensively). Phase 1 should contain *no* source reads at all
   beyond grants — flag any it sneaks in.
4. **`db/schema.sql` must match `docs/incidents-schema.md` exactly** (columns, types,
   PK/unique keys, index shapes; BRIN on time columns; no partitioning).
5. **House style:** CommonJS (no `"type": "module"`); positional-array logger export;
   `PGHOST || PG_HOST` fallback chains; writes via `pgp.helpers` ColumnSets (no
   string-built SQL anywhere); batch one-shot (no server, no published port);
   `user: "105:987"` on external `pg_net`.
6. **Secrets.** No password/connection string in any tracked file; `.env` gitignored;
   `.env.example` contains names/placeholders only.

---

## 5. Known weak spots — please scrutinize these specifically

The author already knows these are imperfect. Confirm severity, find cases the author
missed, and propose concrete fixes. Do **not** just restate them — verify and deepen.

1. **`app_name` self-log discipline is code-level only.** The INSERT grant on
   `util.app_run_logs` cannot constrain `app_name`; a bug could self-log under another
   app's name and pollute their run history. Is that acceptable residual risk for
   Phase 1, or is a DB-side guard (e.g. a CHECK-enforcing view/trigger owned by a
   superuser, or column-level default) worth its complexity?
2. **`dbInsertLogEvents` swallows DB errors** (`utils/logger/log.js` — catch → appends
   an ERROR event → run still exits 0). A run whose self-log INSERT failed is invisible
   to cron *and* to the DB. Related: `index.js` sets `process.exitCode = 1` only when
   `runJob` throws. Trace every failure path (makeAppRunLog stream creation, DB insert,
   file write, `db.$pool.end()`) and say which ones can exit 0 silently.
3. **`addLogEvent` assumes `err` is non-null for ERROR events**
   (`err.stack ? err.stack : err` — a `null` err throws inside the logger). All current
   call sites pass an error, but verify, and weigh a defensive guard since this is the
   template for Phases 2–5.
4. **Module-level `write_stream`/`path` in `log.js`** — single-run-per-process
   assumption (fine for a one-shot; latent foot-gun if anything ever calls
   `makeAppRunLog` twice). Confirm nothing in the current tree can.
5. **`incidents.incidents` ColumnSet** (`utils/db/sql/pg-helpers.js`) — insert-only
   columns for the future `(fingerprint, entity)` upsert; `resolved_*`, `action_*`,
   `created_at`/`updated_at` excluded on purpose. Sanity-check every listed column
   against `db/schema.sql` (names/types/casts, `::jsonb` on `raw_event`/`assessment`)
   so Phase 3 doesn't inherit a mismatch.
6. **`error_events` has no surrogate id** — PK is `(run_id, event_ord)` per the
   contract, a deliberate deviation from the house "BIGSERIAL PK" pattern. Confirm no
   downstream assumption (e.g. BRIN correlation, future retention jobs) needs one.
7. **SSL `rejectUnauthorized: false` for `PG_SSLMODE=require`** (`utils/db/pg-pool.js`)
   — encrypts but doesn't verify the cert; matches the suite (`.env` uses `require`).
   Flag the MITM implication and whether `verify-full` (cert is mounted read-only at
   `/opt/resources/ssl`) should be the deployed default.
8. **Provisioning passes the password via `psql -v pw=...` on the command line** —
   briefly visible in the container's process list. One-time superuser operation on a
   trusted host; note if you consider that insufficient and what you'd use instead.
9. **`REVOKE ALL ON ALL TABLES IN SCHEMA ...`** in the role script — scoped to this
   role only, but confirm it cannot disturb other roles' grants or default privileges,
   and that the has_*_privilege verify logic can't false-negative on the partitioned
   parent vs. its monthly partitions.
10. **Test coverage is a single enums smoke test** — deliberate (no domain logic yet;
    tests must stay dependency-free because `node_modules` lives in a compose-mounted
    cache, not the repo). Confirm nothing else in Phase 1 is pure enough to deserve a
    test now, and flag if the dependency-free constraint should be solved differently.

---

## 6. What is intentionally deferred (don't file these as bugs)

Tracked follow-ups, not oversights — mention only if you see a concrete
correctness/security issue now:

- **All pipeline logic** — materialize/fingerprint/classify (Phase 2), aggregate
  (Phase 3), deterministic assessor (Phase 4), state machine/auto-close (Phase 5).
  The stubs and the empty `incidents.*` tables are the intended end-state of Phase 1.
- **Cron installation + cadence** (one `run` line vs. staggered) — decided when real
  jobs exist; nothing schedules the app yet.
- **Error-path exit-code smoke** (`process.exitCode = 1`) — no triggerable failure
  mode until Phase 2 adds DB work; will be exercised then.
- **`incidents.error_events` retention policy** — BRIN + full history for now.
- **Dashboard incidents view, LLM advisory assessor, L4 auto-remediation,
  notifications** — explicitly out of this increment.

---

## 7. Output format requested

For each finding, please give:

- **Severity** (blocker / high / medium / low / nit)
- **File + line** (`path:line`)
- **What & why** — the concrete problem and how to trigger/observe it
- **Suggested fix** — minimal, matching house style

Prioritize: (1) anything that violates write-isolation or least-privilege (including
holes in the fail-closed role script), (2) security (credential scope, SSL, secret
leakage, injection surface in the helpers), (3) correctness of the run-log lifecycle
and exit codes, (4) schema/contract mismatches (`db/schema.sql` vs.
`docs/incidents-schema.md` vs. the ColumnSets), then everything else. Bias toward
fewer, high-confidence findings over a long speculative list. File findings back as
`notes/review_results_phase_1.md`.
