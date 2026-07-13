# incident-engine

A **deterministic error→incident pipeline** for the `/opt/apps` medical-imaging
data-pipeline suite. It reads the shared error stream (`util.app_run_logs.warn_error_logs`),
collapses it into **incidents** (one per distinct problem × affected equipment),
classifies each with a **rules-based** engine (no LLM), assesses severity/state, and
auto-resolves incidents when the underlying system recovers. It owns and writes a new
`incidents` schema; it reads everything else read-only.

This is a companion to [`ops-dashboard`](../ops-dashboard) (which is read-only and
*displays* data): incident-engine *produces* the incident data a future dashboard view
will show.

- **Runtime:** Node.js (CommonJS), `pg-promise`, cron-batch in Docker on `pg_net`.
- **House style:** mirrors the existing `data_acquisition` app.
- **Governance:** phase-based, prompt-driven — start with [`markdown/FLOW.md`](markdown/FLOW.md).

Status: **Phase 0 (workflow scaffold) complete.** See [`markdown/PROMPTS.md`](markdown/PROMPTS.md)
for the roadmap and [`markdown/PHASE_LOG.md`](markdown/PHASE_LOG.md) for history.
