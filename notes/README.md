# notes/

Working outputs of the development workflow (see `markdown/FLOW.md`): review handoffs,
review results/findings, and temporary investigation notes for a phase.

These are durable enough to keep but distinct from:

- `markdown/` — the process system and durable rules
- `docs/` — stable domain/contract docs the app is built against
- `markdown/PHASE_LOG.md` — the canonical, summarized record of each phase

Suggested naming, keyed to the phase:

- `review_handoff_phase_X.md` — briefing for a reviewer (cf.
  `/opt/apps/ops-dashboard/docs/code-review-handoff.md`)
- `review_results_phase_X.md` — the findings that came back
- `<topic>_investigation.md` — ad-hoc analysis (e.g. `fingerprint_ratio_investigation.md`)

When a note's conclusion matters long-term, fold the summary into that phase's
`PHASE_LOG.md` entry; the note itself can stay here as the detail.
