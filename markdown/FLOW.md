# Development Flow

This project uses a **measured, phase-based workflow** (the same system as
`ops-dashboard`). Each unit of work is a small, reviewable, revertible *phase* driven by
a structured prompt. The system exists so that any contributor — human or AI agent —
produces consistent, verifiable results and so the project stays repeatable as it grows.

| File | Purpose |
| ---- | ------- |
| `markdown/ARCHITECTURE_PRINCIPLES.md` | Durable, non-negotiable rules for this app |
| `markdown/PROMPTS.md` | Phase roadmap, status, and prompt quality rules |
| `markdown/REVIEW_CHECKLIST.md` | Quality gate run before every phase commits |
| `markdown/PHASE_LOG.md` | Durable memory of decisions, validation, and outcomes |
| `markdown/PHASE_TEMPLATE.md` | Template for new phase log entries |
| `markdown/ENVIRONMENT.md` | Environment variable rules (names only, no secrets) |
| `markdown/DEPLOYMENT.md` | Docker cron-batch deploy + smoke-test runbook |
| `prompts/prompt_X_*.txt` | Phase-specific implementation prompts |
| `notes/` | Review handoffs, findings, and temporary investigation notes |
| `docs/` | This app's domain contracts (`error-taxonomy.md`, `incidents-schema.md`) |

The shared suite/domain docs live in `/opt/apps/ops-dashboard/docs/` (`logging-schema.md`,
`infra-conventions.md`, `apps-suite.md`). This `markdown/` system references them; it does
not duplicate them.

---

# Core Philosophy

`incident-engine` is a **deterministic error→incident pipeline** — a first-class pipeline
**writer** that owns the `incidents` schema. Unlike `ops-dashboard` (read-only), this app
writes; the discipline is different but just as strict. The workflow priorities are:

- **write only the schema we own** (`incidents`); read `util`/`stats` read-only; never
  mutate pipeline-owned data; stay least-privilege
- **deterministic, not clever** — assessment is a pure, unit-tested function; no LLM
  dependency; an LLM is a future *advisory* seam behind the same interface
- **idempotent** — every job re-runnable via a persistent watermark + `ON CONFLICT`; a
  re-run never double-counts
- verify assumptions against the **live database** before building query logic
- read **`warn_error_logs` only** — never detoast `verbose_log`
- match the existing `data_acquisition` house style instead of inventing new conventions
- keep each phase small enough to review and revert
- keep secrets (`.env`, passwords, connection strings) out of docs and commits

When in doubt, prefer the safe, smaller, more reviewable, more deterministic option. See
the Decision Rule in `ARCHITECTURE_PRINCIPLES.md`.

---

# Primary Reference Documents

Before beginning any phase, review:

1. `CLAUDE.md` — project orientation and working agreement
2. `markdown/ARCHITECTURE_PRINCIPLES.md` — durable rules
3. `/opt/apps/ops-dashboard/docs/logging-schema.md` — the source data contract (verify live)
4. `docs/error-taxonomy.md` — the deterministic classifier vocabulary
5. `docs/incidents-schema.md` — the schema this app owns and writes
6. `/opt/apps/ops-dashboard/docs/infra-conventions.md` — suite house style to copy
7. `markdown/ENVIRONMENT.md` — env var rules
8. `markdown/DEPLOYMENT.md` — deploy + smoke runbook
9. `markdown/PROMPTS.md` — roadmap and the current phase prompt
10. `markdown/REVIEW_CHECKLIST.md` — the quality gate
11. recent entries in `markdown/PHASE_LOG.md`

These files are part of the development system, not incidental notes.

---

# Phase Execution Flow

## Step 1 — Review Context

- read the reference documents above
- run `git status --short`
- confirm the current phase goal and **non-goals**
- identify the commands that validate the phase
- identify anything the phase touches that reads/writes the DB, changes deploy, or relies
  on a schema assumption that must be confirmed live

## Step 2 — Confirm Assumptions Against The Live DB

This is the rule that makes this project trustworthy. Before writing or changing query
logic, confirm the relevant facts against the live DB (`util.app_run_logs` column types,
`json` vs `jsonb`, which apps write, the shape of `warn_error_logs` events and `note`
keys; `stats.acquisition_history` columns for enrichment/oracle). The schema docs are
reconstructed from app code, not DDL — treat them as hypotheses until verified.

If reality differs from the docs, **update the docs in the same phase** and note it in
`PHASE_LOG.md`.

## Step 3 — Revalidate Roadmap Alignment

If direction has changed, decide whether the phase prompt should be implemented as
written, revised, split, deferred, or discarded. Record the decision in `PHASE_LOG.md`
and update `PROMPTS.md`.

## Step 4 — Create Or Checkout Phase Branch

One branch per phase unless the developer chooses otherwise.

```txt
phase-X-short-name      # e.g. phase-2-materialize
```

Run `git status --short` before switching. Do not carry unrelated uncommitted work into a
phase branch.

## Step 5 — Implementation

- stay within the current phase prompt
- preserve working behavior unless the phase says otherwise
- **write only the `incidents` schema**; read `util`/`stats` read-only; self-log only under
  `app_name = "incident-engine"`
- keep every time-windowed source query **bounded on `inserted_at`**; read
  `warn_error_logs` only (never `verbose_log`)
- keep every job **idempotent** (watermark + `ON CONFLICT`)
- keep the assessor **deterministic and pure** (no I/O inside `assess`)
- connect to the DB as `incident_engine_rw`, never a superuser
- add or update tests when behavior changes (pure `domain/` logic is unit-tested)
- update phase docs when scope or status changes
- keep `.env` values out of docs and commits

## Step 6 — Validation

At minimum:

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test    # unit tests (pure domain logic)
# plus a live smoke run if a job/query/schema/role changed — see DEPLOYMENT.md:
#   materialize on a narrow window → assert error_events counts
#   assess → assert incidents upserted → RE-RUN → assert idempotent (no double-count)
```

Broaden validation when a phase touches DB credentials, the schema, the classifier/
fingerprint, the watermark, or deployment.

## Step 7 — Review And Log

- run through `markdown/REVIEW_CHECKLIST.md`
- add a phase entry to `markdown/PHASE_LOG.md` (use `PHASE_TEMPLATE.md`)
- update `markdown/PROMPTS.md` status
- store any review handoff/results in `notes/`

## Step 8 — Commit Readiness

A phase is ready to commit only when implementation matches the prompt, the
write-isolation / least-privilege / idempotency / determinism rules still hold, validation
results are recorded, and the docs reflect the actual state.
