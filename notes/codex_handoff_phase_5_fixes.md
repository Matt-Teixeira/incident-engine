# Codex Handoff — Phase 5 FIX ROUND (delta)

Branch: `phase-5-state-autoclose` — uncommitted, nothing pushed. Round 1:
`codex_handoff_phase_5.md` → `review_results_phase_5.md` (1 high, 2 medium; all verified
real). **Scope: the fixes only**; per-finding verdict requested (closed / partially / not).

## Finding → fix

**F1 (high, cross-producer recovery) — fixed, both arms of your suggestion:**
- The mapping is now PROVEN, not assumed: every `acquisition_history.run_id` joins to a
  `data_acquisition` run — all five streams (incl. `philips`/`hhm`) are its internal job
  names. So the scope is `ORACLE_SCOPED_APPS = ['data_acquisition']` (`domain/state.js`),
  gated in the pure function on the dossier's `src_app` (`apps[1]`). Fail-safe: unknown
  src_app ⇒ not scoped. Re-open deliberately ignores scope (recurrence is the incident's
  own evidence — please sanity-check that call).
- GE/Philips close by staleness only (your conservative arm).
- Parity gained the scope checks you asked for: `auto_recovery` on a non-data_acquisition
  incident (resolved OR recurring) is a failure.
- Remediation in `db/schema.sql` (idempotent): lifecycle reset for closes with
  inadmissible evidence — applied live, **UPDATE 30**; the fixed engine re-decided them
  (29 open, 1 stale). Your example 17157 is now `open`. The 4 artificial `recurring` rows
  are gone; the 5 current ones are genuine data_acquisition flaps.

**F2 (medium, id-only update race) — fixed, the optimistic arm:** both state ColumnSets
carry `prev_state`/`prev_last_seen`/`prev_resolved_last_seen` as cnd columns and
`UPDATE_STATE_WHERE` matches them with `IS NOT DISTINCT FROM` (NULL backlog must match).
Mismatch ⇒ skipped, counted (`incidents_skipped_concurrent`), WARN-logged, re-evaluated
next run. I chose optimistic-skip over `FOR UPDATE` (no locks held across JS compute;
convergence within a cron cycle) — verdict welcome on that trade. Live: skipped=0 so far.

**F3 (medium, working-tree cron) — repo side done, infra pending:** `DEPLOYMENT.md` now
has the "Deploy boundary" section (dedicated worktree at `/opt/apps/incident-engine-deploy`
pinned to a reviewed ref; cron pointer moves; dev tree keeps its mount). The one-time step
needs root and is awaiting the developer. Until then the runbook states: a checkout here
IS a deploy.

## Verify

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test        # 153/153 (6 new scope tests)
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql   # remediation idempotent (UPDATE 0 on re-apply)
docker compose run --rm app node index.js assess               # re-run: 0 written, 0 skipped
docker compose run --rm app node integration/assess_parity.js  # PASS incl. scope invariants
```

```sql
-- the round-1 invariant (must be 0 rows):
SELECT count(*) FROM incidents.incidents
 WHERE resolved_reason='auto_recovery' AND NOT ('data_acquisition' = ANY(apps));
```

Live: 363 open / 141 resolved (135 auto_recovery + 6 stale) / 5 recurring.

## Weak spots in these fixes

1. The scope list is a hand-maintained constant justified by today's run_id-join proof.
   If a future producer starts writing the oracle, nothing detects that the list is stale
   — is a periodic assertion (parity checking oracle streams' suite-app) worth it now?
2. The remediation predicate uses `NOT ('data_acquisition' = ANY(apps))` — exact for the
   buggy-era rows and unreachable afterwards, but it encodes the scope in SQL a second
   time (the schema can't import the JS constant). Drift risk accepted; flag if you
   disagree.
3. `skipped=0` everywhere so far means the optimistic guard is live-unexercised (nothing
   concurrent exists yet). Unit-covered? No — it's SQL. Loader-guard landmarks cover the
   predicate's shape only.
