# notes/

Working outputs of the development workflow (see `markdown/FLOW.md`): review handoffs,
review results/findings, and temporary investigation notes for a phase.

These are durable enough to keep but distinct from:

- `markdown/` — the process system and durable rules
- `docs/` — stable domain/contract docs the app is built against
- `markdown/PHASE_LOG.md` — the canonical, summarized record of each phase

Naming, keyed to the phase:

- `codex_handoff_phase_X.md` — briefing for the external reviewer (Codex).
  **Mandatory after every implementation phase** (docs-only phases may skip it) — see
  `markdown/FLOW.md` Step 7. Model: `/opt/apps/ops-dashboard/docs/code-review-handoff.md`.
- `review_results_phase_X.md` — the findings that came back
- `<topic>_investigation.md` — ad-hoc analysis (e.g. `fingerprint_ratio_investigation.md`)

Required sections of a codex handoff (mirror the model's numbering):

1. **What this app is** — 30-second orientation, pointer to `CLAUDE.md`/`docs/`
2. **Scope of this review** — the phase's branch/commits + concrete file list; what is
   explicitly out of scope (don't relitigate settled stack/architecture decisions)
3. **How to run / verify it** — copy-pasteable commands (docker; `node` is not on the host)
4. **Hard constraints the code must respect** — this app's durable rules the reviewer
   should try to falsify (write-isolation, least-privilege, determinism, idempotency,
   `warn_error_logs`-only, house style)
5. **Known weak spots — please scrutinize** — what the author already suspects; ask the
   reviewer to verify and deepen, not restate
6. **What is intentionally deferred** — tracked follow-ups the reviewer should not file
   as bugs
7. **Output format requested** — severity / `path:line` / what & why / suggested fix,
   plus the priority order; bias toward fewer, high-confidence findings

When a note's conclusion matters long-term, fold the summary into that phase's
`PHASE_LOG.md` entry; the note itself can stay here as the detail.
