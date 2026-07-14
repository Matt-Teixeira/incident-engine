# Review Checklist

The quality gate run before any phase commits. Walk it explicitly; record the outcome in
the phase's `PHASE_LOG.md` entry. Every implementation phase must also produce a Codex
review handoff, `notes/codex_handoff_phase_X.md`, modeled on
`/opt/apps/ops-dashboard/docs/code-review-handoff.md` (required sections in
`notes/README.md`; docs-only phases may skip it).

## Phase Scope

- Did the change stay within the current phase prompt?
- Were the prompt's non-goals respected?
- Were unrelated code, query, dependency, or deployment changes avoided?
- Was `markdown/PROMPTS.md` status updated if it changed?
- Was a `markdown/PHASE_LOG.md` entry added after implementation and validation?
- Was `notes/codex_handoff_phase_X.md` generated (mandatory for implementation phases)
  and linked from the phase's Review Artifacts?

## Write-Isolation & Least Privilege

- Do all writes target **only** the owned `incidents` schema?
- Is the sole write outside it the self-log `INSERT` under `app_name = "incident-engine"`?
- Does the app connect as `incident_engine_rw` (not a superuser), and would the grants
  **deny** any write outside `incidents` + the self-log even if code tried?
- Are new external reads limited to `SELECT` on `util.app_run_logs` /
  `stats.acquisition_history`, applied fail-closed in `db/setup-owner-role.sql`?

## Idempotency

- Is every job re-runnable with no double-count (persistent watermark + `ON CONFLICT`)?
- Does the watermark advance in the same transaction as the batch's writes, within a fixed
  `now()` upper bound (with an overlap lookback for commit skew)?
- Was re-running the job proven no-op/additive-only in the smoke test?

## Determinism (no LLM)

- Is `assess(dossier)` a **pure** function (no DB handle, clock, or network inside)?
- Is the assessor selected via `ASSESSOR_KIND`, with `rules` the only implementation?
- Do incident **state** and **auto-close** stay deterministic (never delegated to any
  advisory assessor)?
- If the classifier/fingerprint changed: was `FP_VERSION` bumped and `normalize.js`'s
  golden tests updated deliberately?

## Data Contract & Queries

- Were schema assumptions confirmed against the **live DB** this phase?
- Does every source scan read **`warn_error_logs` only** (never `verbose_log`) and bound
  `inserted_at` so partitions prune? (Confirm with `EXPLAIN` when a query is new/changed.)
- Is JSON parsing defensive (missing `err_msg` → fall back to `note.message`; missing
  `sme` → documented entity fallback; malformed values never crash the batch)?
- If a shared doc (`/opt/apps/ops-dashboard/docs/logging-schema.md`, `docs/*`) was
  contradicted, was it updated/noted?

## Security & Secrets

- Is `.env` still uncommitted? Are only variable names (no values) in docs?
- Are passwords, connection strings, and cert contents absent from docs/commits?
- Is external input (ids, params) validated before it reaches Postgres?

## Validation

- Did `node --test` pass for the pure `domain/` logic (or are failures documented)?
- Were focused tests added/updated for changed behavior (normalize/fingerprint/classify/
  entity/assessor/state)?
- Was a live smoke run done if a job, query, schema, role, or the `.env` role changed?
  (materialize → `error_events` count; assess → `incidents` upserted; re-run → idempotent.)

## House Style & Compatibility

- Does the change match `data_acquisition` conventions (CommonJS, positional logger,
  `PGHOST||PG_HOST`, `pgp.helpers` writes, BRIN-not-partition DDL)?
- Does `node index.js <job>` dispatch still hold for any new entrypoint?
- Is the deploy still cron-batch one-shot (no server/port introduced)?

## Commit Decision

- Safe to commit?
- Needs fixes first?
- Any roadmap status to revalidate before the next phase?
