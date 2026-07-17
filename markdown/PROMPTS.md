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
| 4 | `prompt_4_deterministic_assessor.txt` | Completed (prompt **revised** 2026-07-16, FLOW Step 3 — `notes/phase_4_reevaluation.md`) | L3 assessor: pure async `assess(dossier)` → severity/confidence/reasons/action, behind an `ASSESSOR_KIND` seam (rules only; **no LLM impl**); assessment step after `aggregate` in the `assess` job. Step-3 revisions held: blast radius is fingerprint-level `entity_count` (apps[]/systems[] are structurally ≤1 — dead clause); severity was made **type-aware** via a new lossless `type` column, with `unknown`+WARN (then read as noise) → info vs `unknown`+ERROR → medium *(that type policy was later SUPERSEDED by the review rounds below — current contract: `type` feeds confidence and reasons only, never severity)*. Step-2 corrections **on top of** the revision: the taxonomy holds **20** categories, not 19 (22 with `unknown`/`hanging_exec`) — never checked, simply wrong; `error_type` is `''` on **253** of 504 rows, not ~39 (every `unknown` too), so rules key on `category`; `permission_denied_partial` carries **both** `manual_intervention` and `successful_acquisition`, so the prompt's two rules collide — data-acquired wins for severity (low), the human drives the action. Rules dispatch on the taxonomy's own flags/`error_type`, not hand-listed slugs (all 10 transport categories escalate, not the 4 named). **Deviation:** assess-scope is ALL incidents every run, not `touched OR severity IS NULL` — `entity_count` is a *fingerprint*-level property, so a new entity changes its siblings' blast radius and a row-local predicate leaves them stale forever. Threshold `BLAST_RADIUS_ENTITIES = 22` (≥10% of the 221-entity fleet), developer-approved. `assessor_version` column added (developer-approved) for rules provenance. **Review round 1 (Codex): 1 high + 2 medium, all real, all fixed** — (high) the rules keyed on `category` regardless of provenance, so 40 oracle-corroborated incidents were assessed off an unrelated category (`No new monitoring data found.` → `rsync_io_timeout`); fixed by persisting `category_source` and gating on it. (medium) WARN was asserted to mean "the fault was absorbed" and capped severity — the producers refute it (`exec-hhm_data_grab.js` logs a connection error WARN then returns false; `JOB HALTED` is a WARN with no data acquired), so WARN now costs confidence only. (medium) the parity test imported the SQL it verified; rewritten with independent SQL. Round 2 (re-review): 2 medium + 1 low, judgment calls all clean — provenance hardened at rest (NOT NULL + CHECK, three-way LOUD gate: missing/invalid ⇒ medium @0.2, never info), parity's L0 cross-check scoped to the full (fingerprint, entity) key (9 live mixed-category fingerprints made fingerprint-only wrong), count corrected (175/148,429). **M2 decided by the developer**: `unknown`+WARN → interim medium (WARN bucket holds confirmed halts — JOB HALTED 28k events), so `type` now moves severity nowhere; the durable fix — classifying those messages out of `unknown` — is a queued follow-up phase. Round 3: **converged** — no high/medium, 2 low (misdirecting remediation on the invalid-provenance branch; stale type-policy passages in current-contract docs), both fixed; all prior findings verdicted closed. Live: 504 assessed — **high 184 / medium 319 / low 0 / info 1**; re-run writes 0. |
| 5 | `prompt_5_state_autoclose.txt` | **Completed** (prompt revised 2026-07-16 — `notes/phase_5_reevaluation.md`; 3 review rounds converged: 1 high + 3 medium, all code findings fixed+closed; F3 deploy-worktree infra step sequenced post-merge. Live 2026-07-17: 363 open / 141 resolved (135 auto_recovery + 6 stale) / recurring flap visible; re-run 0) | L5 state machine + deterministic auto-close. Revision (live-evidence-driven, developer-approved): auto-close keys on `entity`, not the dead `systems[]` clause (structurally ≤1); **`recurring` = re-opened after a resolution, only** (the original threshold/span trigger is crossed by ~everything instantly — 303/504 incidents span ≥9 days); a second deterministic close **`resolved_reason='stale'`** (no recurrence in `STALE_AFTER_DAYS`, default 7) because the oracle can only ever speak to 60% of incidents (188 on entities it has never recorded + 11 `__global__`); the timestamp question is resolved — **`capture_datetime`** (0 nulls / 89k; `inserted_at` mis-orders backfills by up to 76 days); re-open compares `last_seen` against a new **`resolved_last_seen`** column (same producer-clock domain — comparing against DB-clock `resolved_at` could leave a skewed producer's incident resolved while failing); backlog `state IS NULL` → open; `acknowledged` auto-closeable / `suppressed` engine-terminal; state step evaluates ALL incidents from durable facts (no watermark). In scope: rework `rep_determinism.js` (its TRUNCATE-restore breaks once state is history-dependent — the recorded Phase 4 landmine) and move `assess_parity.js`'s boundary check to action_*-only. |
| 6 | `prompt_6_classify_unknowns.txt` | **Completed** (`0367268`, ff-merged to `main`, pushed, deployed; 4 Codex rounds converged; post-deploy 18:57 production-cron measurement: `unknown` 79 incidents/38,900 events — from 213/~185k; medium 262 / high 197 / info 50; assessor_version v2 on all 509; 196/196 unit; parity PASS; oscillation resolved at deploy) | Engine classifier LAYER: classify the ~12 known message families out of `unknown` (JOB HALTED 31k events, the GE/Philips file/status families ~130k, the ERROR families ~37k), each severity from PRODUCER EVIDENCE (the F2 method), via a second engine-owned regex table consulted only when the verbatim `connection_regex.js` mirror misses — the mirror is never edited, never shadowed, stays re-syncable; `error_category` is not in the fingerprint so FP_VERSION stays 1. Discharges the Phase 4/5 review obligations: interim-M2 reason string removed (residual-`unknown` policy re-decided with the developer in Step 3), `RULES_VERSION` → 2 (one-time full re-assess, expected). No L0 rewrite: active incidents converge via the newest-representative refresh (~1 cycle); dormant rows keep the old category, counted. Upstreaming proven entries into `data_acquisition` stays a tracked open decision. |

(The post-Phase-5 classification phase is now **scheduled as Phase 6** — see the index.)

Deferred (documented, not scheduled): dashboard incidents view (in `ops-dashboard`, +
fail-closed read grant on `incidents`), LLM advisory assessor, L4 auto-remediation,
notifications, `public.network_issues` bridge, flap hysteresis (Phase 5 makes flapping
visible via `recurring`; dampening only as a future, logged decision).

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
| 6 | `phase-6-classify-unknowns` |

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
