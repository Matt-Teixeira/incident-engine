# Phase Log

Durable memory of what's been done and why. Newest entry at the top. Add an entry (from
`PHASE_TEMPLATE.md`) after each phase is implemented, validated, and ready to commit.

---

# Phase 1 — App Skeleton + Schema + Role Provisioning

Date:
2026-07-13

Status:
Completed

Prompt:
`prompts/prompt_1_app_skeleton_provision.txt`

Git Commit:
Pending

Review Artifacts:

- Codex handoff: `notes/codex_handoff_phase_1.md`
- Review results: `notes/review_results_phase_1.md` (1 high, 4 medium, 1 low — all fixed)
- Plus self-review against `markdown/REVIEW_CHECKLIST.md`

## Goals

- Stand up a runnable cron-batch app skeleton mirroring `data_acquisition` (CommonJS,
  positional-array logger, `pg-promise` pool with env fallback chains, `pgp.helpers`
  ColumnSets, `node index.js <job>` switch dispatch, batch one-shot compose).
- Create the owned `incidents` schema (`db/schema.sql`) exactly per
  `docs/incidents-schema.md`.
- Create + provision the least-privilege `incident_engine_rw` role
  (`db/setup-owner-role.sql`, fail-closed), switch `.env` off the borrowed
  `ops_dashboard_ro` role, and prove it with a self-log smoke run.

## Built

- `package.json` — CJS (no `"type"`), scripts `materialize`/`assess`/`run`/`test`;
  deps mirror `data_acquisition` (`dotenv`, `pg`, `pg-promise`, `uuid`).
- `index.js` — switch dispatch (`materialize`/`assess`/`run`/`noop`) + full run-log
  lifecycle (`makeAppRunLog` → `onBoot` → `runJob` → `addRunSummary` →
  `dbInsertLogEvents` → `writeLogEvents`). `materialize`/`assess` are logged stubs
  until Phases 2–5; `run` chains both.
- `utils/logger/log.js` + `enums.js` — copied from `data_acquisition` (positional-array
  export intact; express-http branch dropped — this app always writes a per-run file).
- `utils/db/pg-pool.js` — copied verbatim (`PGHOST||PG_HOST` fallbacks + `buildSsl`).
- `utils/db/sql/pg-helpers.js` — TableNames + ColumnSets for `util.app_run_logs`
  (self-log), `incidents.error_events`, `incidents.incidents` (+ `pipeline_state`
  TableName). JSONB columns carry explicit `::jsonb` casts.
- `docker-compose.yaml` — `pg_net` only, no port/server/redis, `user: "105:987"`,
  node_modules from `/opt/resources/node_mod_cache/incident-engine`, `RUN_LOGS_DIR`
  bind, `/opt/resources/ssl` read-only.
- `.env.example` — variable names per `markdown/ENVIRONMENT.md`, no secrets.
- `db/schema.sql` — `incidents.error_events` / `incidents.incidents` /
  `incidents.pipeline_state`, house DDL (BIGSERIAL where the contract has an `id`,
  TIMESTAMPTZ DEFAULT NOW(), BRIN on time columns, partial indexes, no partitioning).
- `db/setup-owner-role.sql` — idempotent, `-v pw=` parameterized, forced-safe role
  attrs (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`); transfers
  ownership of schema `incidents` + relations; fail-closed REVOKE→GRANT→DO-verify for
  `util` (SELECT+INSERT on `app_run_logs` only), `stats` (SELECT on
  `acquisition_history` only), and `alert` (nothing at all, USAGE included).
- `test/enums.test.js` — dependency-free smoke of the only pure helper this phase.
- Provisioned live: schema + role applied as superuser; strong generated password;
  `.env` now `PGUSER=incident_engine_rw` (password only in gitignored `.env`,
  `chmod 600`); host dirs `/opt/resources/node_mod_cache/incident-engine` and
  `/opt/run-logs/incident-engine` created group-`docker` mode `2775`.

## Schema Facts Confirmed (live DB)

- `util.app_run_logs`: partitioned table, RANGE on `inserted_at`, 7 partitions;
  columns `app_name text`, `run_id uuid`, `verbose_log json`, `warn_error_logs json`
  (both plain `json`, not `jsonb`), `inserted_at timestamptz DEFAULT now()`. Matches
  `/opt/apps/ops-dashboard/docs/logging-schema.md` — no doc fix needed.
- `stats.acquisition_history`: all documented columns confirmed (`run_id uuid NOT NULL`,
  `system_id varchar(8) NOT NULL`, `successful_acquisition boolean NOT NULL`,
  `error_category varchar(64)`, `phase varchar(32)`, `inserted_at timestamptz NOT NULL
  DEFAULT now()`); BRIN on `inserted_at`; not partitioned. Matches
  `docs/incidents-schema.md` assumptions.
- Apps writing `util.app_run_logs` in the last 3 days: `acquisition-v2`,
  `data_acquisition`, `hhm_rpp_ge`, `hhm_rpp_philips`, `ops-dashboard`.
- Server is PostgreSQL 16.13; neither schema `incidents` nor role
  `incident_engine_rw` existed before this phase.

## Important Decisions

### Ownership, not grants, for the owned schema

Decision: `incident_engine_rw` OWNS schema `incidents` and every relation in it
(transferred by `setup-owner-role.sql`), rather than receiving table-level grants.

Reason: matches the Least-Privilege Rule ("owns schema incidents — full DML/DDL
there") and survives future DDL phases without new grant plumbing.

Tradeoff: `db/schema.sql` can still be applied by a superuser first; the role script
must run after it to transfer ownership (runbook order in `DEPLOYMENT.md`).

### Linked BIGSERIAL sequences follow their table

Decision: the ownership-transfer loop alters tables/views only; sequences linked to
an identity/serial column cannot be `ALTER ... OWNER`'d directly (PG raises "cannot
change owner of sequence ... linked to table") — they follow the table
automatically. The DO-verify still asserts sequences ended up owned by the role.

Reason: first run of the script failed on `incidents.incidents_id_seq`; fixed and
re-run clean (the script is idempotent, so the partial first run was harmless).

Tradeoff: none.

### Non-zero exit on batch failure (deliberate house-style deviation)

Decision: `index.js` sets `process.exitCode = 1` in the `onBoot` catch block;
`data_acquisition` exits 0 on error.

Reason: this app is invoked by cron as a one-shot; a failed batch must be visible to
the scheduler/operator. Also added `db.$pool.end()` in `finally` so the one-shot
exits promptly instead of waiting out the pool idle timeout.

Tradeoff: small divergence from the mirrored app, documented here.

### `run` job defined now, cadence still open

Decision: `run` = `materialize` then `assess` in one process (stubs this phase); the
one-cron-line vs. two-staggered-lines question stays open in `PROMPTS.md` ("Not
decided yet") until the real jobs exist.

Reason: keeps Phase 1 within scope while making the normal cron invocation runnable.

Tradeoff: none.

## Architecture Notes

- Write-isolation / least-privilege impact: enforced at the credential layer now.
  Live grant matrix proven as the role itself (not SET ROLE): SELECT on
  `util.app_run_logs` ✓, SELECT on `stats.acquisition_history` ✓, INSERT self-log via
  the check-option view ✓, DDL/DML in `incidents` ✓; DENIED: INSERT on the
  `util.app_run_logs` base table, view-INSERT with a foreign `app_name` (check
  option), UPDATE/DELETE on `util.app_run_logs`, INSERT/UPDATE on
  `stats.acquisition_history`, `nextval` on external sequences, any access to
  `alert.*` (even SELECT — no USAGE), CREATE in schema `util`. Post-review, the
  `app_name='incident-engine'` discipline is **DB-enforced** (view WITH CHECK OPTION),
  not just code-level, and the role script's database-wide allowlist audit proves the
  whole surface on every run.
- Idempotency / watermark impact: `incidents.pipeline_state` table exists;
  `error_events` PK `(run_id, event_ord)` and `incidents` UNIQUE
  `(fingerprint, entity)` are in place as the future `ON CONFLICT` keys. No job
  logic yet.
- Classifier / fingerprint stability impact: none (no classifier code this phase).
- Determinism impact: none (no assessor code this phase); `ASSESSOR_KIND=rules`
  reserved in `.env.example`.
- Data-contract impact: no source reads yet beyond the grant; self-log INSERT only.
- Deployment impact: first real deploy surface — compose file + provisioned role.
  Superuser steps performed this phase: `db/schema.sql`, `db/setup-owner-role.sql`.
  Cron line NOT installed yet (cadence decided when real jobs land).

## Validation

Commands run:

```bash
docker exec -i pg_db psql -U postgres -d staging -X -v ON_ERROR_STOP=1 -f - < db/schema.sql
docker exec -i pg_db psql -U postgres -d staging -X -v pw="$PW" -f - < db/setup-owner-role.sql
# grant matrix as incident_engine_rw (via container psql, real login)
docker compose run --rm app npm install
docker compose run --rm app node index.js run          # also: materialize, assess, noop
docker run --rm -v "$PWD":/w -w /w node:lts node --test
```

Results:

- Passed: schema applied; hardened role script clean end-to-end (all DO-verify blocks
  + database-wide allowlist audit pass); drift-detection proven (injected PUBLIC grant
  and column-only grant both abort the script; clean after cleanup); grant matrix per
  spec including view semantics (correct-`app_name` view INSERT ✓; foreign `app_name`
  → check option violation; base-table INSERT → denied; external `nextval` → denied);
  `run`/`noop` exit 0 over `verify-full` TLS (TLSv1.3, hostname verified); failure
  paths exit 1 (unknown job, `APP_NAME` mismatch, closed `PGPORT` self-log failure,
  broken CA under `verify-full`); unit tests 8/8 pass (enums + build-ssl).
- Failed: first `setup-owner-role.sql` run only — linked-sequence ownership error
  (see decision above); fixed, re-run clean.
- Not run: none outstanding (the post-review failure-path smokes covered the
  previously deferred exit-code check).

Manual / smoke tests:

- Self-log row present: `util.app_run_logs` has `app_name='incident-engine'` rows
  (`verbose_log` 5 events, `warn_error_logs` 0 events on the `run` smoke).
- Per-run JSON written to `/opt/run-logs/incident-engine/` by the container user.
- Login as `incident_engine_rw` with the provisioned password works over TCP.

## Review Notes

Source:

- `notes/review_results_phase_1.md` (Codex, from `notes/codex_handoff_phase_1.md`) +
  self-review against `markdown/REVIEW_CHECKLIST.md`.

Critical issues:

- Codex verdict was "needs fixes before commit": (1) **high** — the fail-closed audit
  was per-schema table-level only (missed column-only grants, sequences, and
  PUBLIC-inherited privileges outside util/stats/alert); (2) **medium** — run-log
  persistence failures still exited 0 (reproduced with a closed port); (3) **medium** —
  self-log `app_name` not constrained at the credential layer; (4) **medium** —
  `verify-ca`/`verify-full` silently downgraded to unauthenticated TLS, and the deploy
  used `require`; (5) **medium** — an unknown job name reported success; (6) **low** —
  `addLogEvent` threw on a null/non-Error `err`.

Accepted fixes (all six findings):

- **F1**: `db/setup-owner-role.sql` now REVOKEs sequences as well as tables, verifies
  with `has_any_column_privilege` (catches column-only grants) +
  `has_sequence_privilege`, and ends with a **database-wide allowlist audit** over
  every non-system schema (allowlist: owned `incidents.*`; `util.app_run_logs` SELECT;
  `util.incident_engine_self_log` INSERT; `stats.acquisition_history` SELECT;
  documented `public.pg_stat_statements*` PUBLIC SELECT). Proven live: injected drift
  (a PUBLIC table grant, and a column-only `UPDATE(b)` grant — the old false negative)
  aborts the script; clean after cleanup. Residuals documented in the script header
  (cross-DB CONNECT/TEMP via PUBLIC needs pg_hba/cluster-wide action; PUBLIC EXECUTE
  on functions).
- **F3**: self-log now goes through `util.incident_engine_self_log` — a
  postgres-owned, auto-updatable view `WHERE app_name = 'incident-engine' WITH
  CASCADED CHECK OPTION`; the role's base-table INSERT is revoked. Proven live:
  view-INSERT with `app_name='data_acquisition'` → check option violation;
  direct base-table INSERT → permission denied. `index.js` also pins `APP_NAME` as a
  code constant and fails boot on a mismatched env.
- **F2**: single finalization path in `onBoot` — `makeAppRunLog` moved inside the
  lifecycle, both sinks (`dbInsertLogEvents`, `writeLogEvents`) return success/failure,
  stream errors are captured and awaited (`write_stream.end` callback + error listener),
  `db.$pool.end()` failures counted, `onBoot().catch(...)` terminates. Proven: the
  Codex repro (closed `PGPORT`) now exits 1.
- **F5**: unknown job throws after the WARN log event → exit 1 (`node index.js bogus`
  proven). `noop` remains the explicit successful no-op.
- **F4**: `buildSsl` extracted to `utils/db/build-ssl.js` (pure, unit-tested):
  `verify-ca`/`verify-full` fail closed on missing/unreadable CA, unknown modes abort,
  `verify-ca` gets `checkServerIdentity` skip, `require` kept as documented exception.
  Live `verify-full` against `pg_db` with the mounted CA verified (TLSv1.3) and made
  the deployed + `.env.example` default; broken-CA run proven to exit 1.
- **F6**: `addLogEvent` normalizes `err` (`err?.stack ?? (err == null ? "Unknown
  error" : String(err))`).

Deferred findings:

- Cross-database `CONNECT`/`TEMP` via `PUBLIC` and PUBLIC-function `EXECUTE` — not
  addressable per-role without cluster-wide impact; documented in the role script
  header with the pg_hba.conf option (per Codex's own framing).
- `psql -v pw=` process-visibility during one-time provisioning — accepted low
  residual per the review itself.

## Problems Encountered

- Problem: `ALTER TABLE ... OWNER` on a serial-linked sequence is rejected by PG.
  Resolution: alter tables/views only; sequences follow the table owner; verify
  block still checks them. Script re-run clean (idempotent).

## Follow-Up Tasks

- Phase 2 (`prompt_2_materialize.txt`): materialize job — watermark, partition-pruned
  `warn_error_logs` scan, normalize/fingerprint/classify, `ON CONFLICT DO NOTHING`
  into `incidents.error_events`; exercise the failure exit path.
  **Re-evaluated 2026-07-14 (FLOW Step 3) before implementation** — prompt revised:
  explicit `PRODUCING_APPS` allowlist with `incident-engine` self-log exclusion
  (feedback loop proven live), `acquisition-v2` parked, fingerprint text chain extended
  to `err_msg || note.message || note.txt` while it's still free (`FP_VERSION` stays 1),
  Phase 1 conventions folded in. Details: `notes/phase_2_reevaluation.md`.
- Decide cron cadence (one `run` line vs. staggered `materialize`/`assess`) when the
  real jobs exist; install the cron line.

## Commit Readiness

- Requirements implemented: yes (all Phase 1 deliverables).
- Write-isolation / least-privilege rules hold: yes — proven fail-closed at the
  credential layer.
- Jobs idempotent (watermark + ON CONFLICT): n/a this phase (keys + state table in
  place; no job logic yet).
- Assessment deterministic (no LLM in critical path): n/a (no assessor yet).
- Source queries read warn_error_logs only, partition-pruned: n/a (no source reads
  yet).
- Schema assumptions confirmed live: yes (see Schema Facts).
- Review findings addressed or deferred: yes.
- Validation recorded: yes.
- Ready to commit: yes, pending developer confirmation.

---

# Phase 0 — Workflow Scaffold

Date:
2026-07-13

Status:
Completed

Prompt:
`prompts/prompt_0_workflow_scaffold.txt`

Git Commit:
Pending

Review Artifacts:

- Review handoff: none (docs-only scaffold)
- Review results: none

## Goals

- Establish a measured, phase-based, prompt-driven development workflow for
  `incident-engine`, modeled on `ops-dashboard`'s, so future work is repeatable and
  reviewable.
- Encode the app's durable, non-negotiable rules — adapted from ops-dashboard to this
  app's **writer** identity (owns the `incidents` schema), **deterministic (no-LLM)**
  assessment, **idempotency**, and `data_acquisition` house style.
- Lay out the pipeline as a governed roadmap of small phases (1–5).

## Built

- `CLAUDE.md` — orientation + working agreement (writer app; deterministic; mirrors
  `data_acquisition`).
- `markdown/`: `FLOW.md`, `ARCHITECTURE_PRINCIPLES.md`, `PROMPTS.md`, `PHASE_TEMPLATE.md`,
  `PHASE_LOG.md` (this file), `REVIEW_CHECKLIST.md`, `ENVIRONMENT.md`, `DEPLOYMENT.md`.
- `prompts/`: `prompt_0_workflow_scaffold.txt` + planned phase prompts `prompt_1`..`prompt_5`.
- `notes/README.md` — review-handoff / findings convention.
- `docs/`: `error-taxonomy.md` (classifier vocabulary reused from `connection_regex.js`),
  `incidents-schema.md` (the owned schema contract), `README.md` (pointer to shared suite
  docs).
- `README.md` — fleshed out from the initial stub.

## Schema Facts Confirmed (live DB)

- None — this phase is documentation only; no queries, no schema, no `.env` change. Schema
  facts referenced in `docs/` are carried from the approved plan's live-DB exploration and
  are to be **re-confirmed in the phase that first uses them** (per the FLOW Step-2 rule).

## Important Decisions

### Governance-first, mirroring ops-dashboard

Decision: Build the full `markdown/` + `prompts/` + `notes/` + `docs/` governance system
before any pipeline code.

Reason: The user wants incident-engine to run on the same measured, reviewable workflow as
ops-dashboard from day one, so the pipeline is built as small governed phases rather than
one large change.

Tradeoff: Upfront docs effort before any runnable code; accepted for long-term
repeatability.

### Writer identity (Write-Isolation Rule replaces Read-Only Rule)

Decision: Encode a Write-Isolation Rule — writes confined to the owned `incidents` schema,
`SELECT`-only on `util`/`stats`, self-log INSERT under `app_name='incident-engine'` only.

Reason: Unlike ops-dashboard (strictly read-only), this app must write, but the same
least-privilege discipline applies. The suite precedent is a per-app owned schema
(`data_acquisition` → `alert.*`/`stats.*`).

Tradeoff: The app is a genuine pipeline writer; contained via a dedicated
`incident_engine_rw` role and fail-closed grants (provisioned in Phase 1).

### Deterministic assessment, pluggable for a future LLM

Decision: Assessment is a pure, unit-tested `assess(dossier)` behind an `ASSESSOR_KIND`
seam; no LLM now.

Reason: The user wants predictable, programmatic assessment; the production classifier
`connection_regex.js` already provides a deterministic taxonomy to reuse.

Tradeoff: Rules cover the known taxonomy; the unknown tail is flagged `unknown`/low
confidence for a human — an LLM can later fill that gap as an advisory implementation of
the same interface, never driving state.

## Architecture Notes

- Write-isolation / least-privilege impact: rule defined; enforcement (role + grants) lands
  in Phase 1.
- Idempotency / watermark impact: rule defined; implemented from Phase 2.
- Classifier / fingerprint stability impact: `FP_VERSION` + frozen `normalize.js` contract
  defined; implemented from Phase 2.
- Determinism impact: assessor purity + no-LLM-in-critical-path rule defined; implemented
  in Phase 4.
- Data-contract impact: `warn_error_logs`-only, partition-pruned source scans defined;
  implemented from Phase 2.
- Deployment impact: none this phase (docs-only). Cron-batch one-shot model documented in
  `DEPLOYMENT.md`.

## Validation

Commands run:

```bash
git status --short
# grep cross-references resolve (FLOW <-> PROMPTS <-> ARCHITECTURE_PRINCIPLES <-> REVIEW_CHECKLIST <-> PHASE_TEMPLATE)
```

Results:

- Passed: all scaffold files created and cross-reference correctly.
- Failed: none.
- Not run: app build / unit tests / DB smoke — none exist yet (docs-only phase).

Manual / smoke tests:

- Confirmed `.env` is gitignored and unchanged; no secrets in any doc.

## Review Notes

Source: self-review against `REVIEW_CHECKLIST.md` (Phase Scope + Secrets sections apply;
code sections N/A for a docs-only phase).

Critical issues: none.
Accepted fixes: none.
Deferred findings: none.

## Problems Encountered

- None.

## Follow-Up Tasks

- Phase 1: scaffold the app (mirror `data_acquisition`) and provision the `incidents`
  schema + `incident_engine_rw` role; switch `.env` from `ops_dashboard_ro` to the new
  role.

## Commit Readiness

- Requirements implemented: yes (governance scaffold).
- Write-isolation / least-privilege rules hold: yes (documented; no code yet).
- Jobs idempotent: N/A (no jobs yet).
- Assessment deterministic: N/A (no assessor yet; rule documented).
- Source queries read warn_error_logs only, partition-pruned: N/A (no queries yet; rule
  documented).
- Schema assumptions confirmed live: N/A (docs-only).
- Review findings addressed or deferred: yes (none).
- Validation recorded: yes.
- Ready to commit: yes.

---

# Pre-history (before this workflow existed)

- 2026-07-13: `/opt/apps/incident-engine` repo created (git init, `.gitignore`, stub
  `README.md`); `.env` added pointing at the `staging` DB on `pg_db` (initially reusing the
  read-only `ops_dashboard_ro` role — to be switched to `incident_engine_rw` in Phase 1).
- 2026-07-13: architecture + first-increment plan approved (standalone app mirroring
  `data_acquisition`; deterministic no-LLM assessment; full first increment decomposed into
  governed phases). Plan: `~/.claude/plans/i-would-like-to-sunny-newell.md`.
