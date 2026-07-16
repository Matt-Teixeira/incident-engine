# Prompt Roadmap

Prompt files live in `prompts/`. Each is a structured, self-contained prompt for one
phase. Before running any phase prompt, read the Primary Reference Documents listed in
`markdown/FLOW.md`.

---

# Current Direction

`incident-engine` is new. The near-term direction is to build the **deterministic
error→incident pipeline** bottom-up, one reviewable phase at a time, so each layer is
validated against the live DB before the next is built:

- stand up the **governance workflow** first, so all work is repeatable and reviewable
  (Phase 0)
- scaffold the **app skeleton** (mirroring `data_acquisition`) and **provision** the owned
  `incidents` schema + least-privilege `incident_engine_rw` role (Phase 1)
- **materialize** the error stream: flatten `util.app_run_logs.warn_error_logs` into
  `incidents.error_events`, fingerprinted and classified, idempotently (Phase 2)
- **aggregate** into `incidents.incidents`: one row per `(fingerprint, entity)` with
  occurrence count, cross-app blast radius, and enrichment (Phase 3)
- add the **deterministic assessor**: a pure `assess(dossier)` producing
  severity/state/reasons, behind a pluggable seam for a future LLM (Phase 4)
- add the **state machine + auto-close** using the `stats.acquisition_history`
  `successful_acquisition` recovery oracle (Phase 5)

Later, read-only insight moves to the operator surface: a **dashboard incidents view**
(built in `ops-dashboard`, cross-repo, with a fail-closed read grant on `incidents`).

## Current decisions

- the app connects as the least-privilege role **`incident_engine_rw`**, never a
  superuser; it **writes only the `incidents` schema** it owns, reads `util`/`stats`
  read-only, and self-logs under `app_name = "incident-engine"`
- assessment is **deterministic** (rules-based, pure, unit-tested) behind a pluggable
  `assess(dossier)` interface; **no LLM** now — an LLM assessor is a future *advisory*
  implementation of the same signature and never drives state/auto-close
- the classifier **reuses the production vocabulary** from
  `/opt/apps/data_acquisition/util/tools/connection_regex.js` rather than inventing one
- house style mirrors **`data_acquisition`** (CommonJS, positional logger,
  `PGHOST||PG_HOST`, BRIN-not-partition DDL, batch one-shot) — **not** `acquisition-v2`
- reads `warn_error_logs` **only** (never detoasts `verbose_log`); every job is
  **idempotent** (watermark + `ON CONFLICT`)
- deployed as a **cron-batch one-shot**, not a long-running service
- **job cadence (decided 2026-07-16):** a single `run` cron line (materialize→assess) at
  **`25,55`** — half-hourly, just after the producers' bursts finish (~:21/:51). Two
  staggered lines were rejected: `materialize` and the `assess` aggregate serialize on a
  shared watermark lock, so they cannot run concurrently anyway. See `DEPLOYMENT.md`.

## Not decided yet

- whether/when to onboard **`acquisition-v2`** as a producing app: it writes
  `util.app_run_logs` rows but (as of 2026-07-14) zero `warn_error_logs` events, and its
  event shape is unverified — the Phase 2 `PRODUCING_APPS` allowlist excludes it until
  this is decided (see `notes/phase_2_reevaluation.md`)
- whether incident-engine ever **ingests its own** self-logged errors (self-monitoring);
  excluded from the scan for now to avoid a feedback loop
- `incidents.error_events` retention (BRIN + full history now; revisit detach/partitioning
  only if volume demands)
- whether the dashboard incidents view drills into `incidents.error_events` or only
  `incidents.incidents`
- if/when to add the LLM advisory assessor, L4 auto-remediation, notifications, or a bridge
  to the manual `public.network_issues` tracker (all explicitly out of the first increment)

These are decided in future phases, not hidden inside unrelated edits.

---

# Phase Index

| Phase | Prompt file | Status | Notes |
| ----- | ----------- | ------ | ----- |
| 0 | `prompt_0_workflow_scaffold.txt` | Completed | This workflow system: `markdown/` docs, prompt roadmap, phase log, `docs/` contracts. Docs-only. |
| 1 | `prompt_1_app_skeleton_provision.txt` | Completed | App skeleton (CJS `index.js` switch dispatch, `utils/logger`+`utils/db` copied from `data_acquisition`, `package.json`, `docker-compose.yaml`), `db/schema.sql`, `db/setup-owner-role.sql`; provision `incidents` schema + `incident_engine_rw` role + point `.env` at it; self-log smoke. |
| 2 | `prompt_2_materialize.txt` | Completed | L0 materialize: watermark → scan `warn_error_logs` (partition-pruned, no `verbose_log`) → flatten + fingerprint + classify → `incidents.error_events`, idempotent `ON CONFLICT`. Codex review: 6 findings, all fixed; L0 rebuilt under the corrected formula (185k events, 82 fingerprints, `fp_version=1`). `notes/review_results_phase_2.md`. |
| 3 | `prompt_3_aggregate_incidents.txt` | Completed | L1/L2 aggregate by `(fingerprint, entity)` → `incidents.incidents`, watermarked + idempotent (additive `occurrence_count`, exactly-once via serialize-vs-materialize + zero overlap). Step-2 findings changed the design: **dropped `job_id`** from the entity chain (fractured 4 fingerprints into ~38k singletons → 498 incidents); **enrichment is system_id-only, category-when-unknown** (source `run_id` never joins `acquisition_history`); `apps[]` is structurally single-app (app is in the fingerprint). Live: 503 incidents, `sum(occurrence_count)` == L0 total (exactly-once). |
| 4 | `prompt_4_deterministic_assessor.txt` | Planned (prompt **revised** 2026-07-16, FLOW Step 3 — `notes/phase_4_reevaluation.md`) | L3 assessor: pure `assess(dossier)` → severity/reasons; rules impl; pluggable `ASSESSOR_KIND` seam for a future LLM. Revision: the "large `systems[]`" blast-radius clause was **dead** (apps[]/systems[] are structurally ≤1) → replaced by fingerprint-level `entity_count`; severity is now **type-aware** (`type` column added to `incidents.incidents`, lossless — type is in the fingerprint) so `unknown`+WARN (143 noise) → info vs `unknown`+ERROR (70) → medium instead of a flat medium for all 213; `manual_intervention` is a taxonomy **flag**, not a category; rules must cover all 19 categories (the prompt omitted `rsync_io_timeout`, the #2 at 187 incidents); assess scope is `touched OR severity IS NULL` so the existing backlog is picked up. |
| 5 | `prompt_5_state_autoclose.txt` | Planned | L5 state machine (open/acknowledged/recurring/resolved/suppressed) + deterministic auto-close via the `successful_acquisition` recovery oracle; re-open on post-resolve recurrence. |

Deferred (documented, not scheduled): dashboard incidents view (in `ops-dashboard`, +
fail-closed read grant on `incidents`), LLM advisory assessor, L4 auto-remediation,
notifications, `public.network_issues` bridge.

---

# Branching

One branch per phase unless the developer explicitly chooses otherwise.

| Phase | Branch |
| ----- | ------ |
| 0 | `phase-0-workflow-scaffold` |
| 1 | `phase-1-app-skeleton-provision` |
| 2 | `phase-2-materialize` |
| 3 | `phase-3-aggregate-incidents` |
| 4 | `phase-4-deterministic-assessor` |
| 5 | `phase-5-state-autoclose` |

Check `git status --short` before creating or switching branches.

---

# Prompt Quality Rules

Each phase prompt should define:

- **phase goal** — one clear outcome
- **implementation scope** — what to build/change
- **explicit non-goals** — what NOT to touch
- **expected files / layers** — where the work lands
- **validation commands** — how to prove it works (unit tests + live smoke)
- **write-isolation / least-privilege / idempotency constraints** — what must stay safe
- **schema assumptions to confirm live** — what to verify against the DB first
- **review questions** — what a reviewer should interrogate

Preferred terms: *error event, incident, fingerprint, entity, classify, assess, dossier,
watermark, materialize, blast radius, recovery oracle, owned schema, least-privilege role,
idempotent, deterministic*.

Avoid unless a phase explicitly approves them: *LLM/model-based assessment,
auto-remediation, notifications/paging, writing outside the `incidents` schema, reading
`verbose_log`, schema changes to `util.app_run_logs`, replacing the stack*.

If a prompt conflicts with `ARCHITECTURE_PRINCIPLES.md`, update the prompt or get developer
approval before implementation.
