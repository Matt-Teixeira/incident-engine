# Phase Log

Durable memory of what's been done and why. Newest entry at the top. Add an entry (from
`PHASE_TEMPLATE.md`) after each phase is implemented, validated, and ready to commit.

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
