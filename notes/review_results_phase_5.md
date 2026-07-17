# Review Results — Phase 5 (State Machine + Auto-Close)

Round 1. Source: Codex, from `notes/codex_handoff_phase_5.md`.
Verdict: 1 high, 2 medium. **All three verified independently; the high and first medium
are fixed and re-validated live; the third (infra) has its repo-side fix in place with the
root-requiring step pending developer action.**

Reviewer's own verification: 147/147 unit tests; parity PASS over 509; all four live
`recurring` rows had genuine L0 events newer than their mementos — with the explicit caveat
that those checks did not cover recovery-stream provenance or the concurrent-update race.
Correct caveat: both findings lived exactly there.

---

## F1 (HIGH) — Cross-producer recovery evidence closes unrelated incidents — FIXED

**Finding.** `RECOVERY_SQL` groups by `system_id` only and the job applies that success to
every incident on the entity regardless of producer. 28 hhm_rpp_ge/hhm_rpp_philips incidents
were auto-closed by mmb successes. Example: incident 17157 (hhm_rpp_ge, `File not present`,
12:15:09) closed by an unrelated `mmb / remote_rsync` success at 12:16:37 — creating false
recovery and artificial resolved→recurring flapping.

**Verified — confirmed, count 30 by fix time (cron drift), and worse in one respect:** all
4 of the "natural re-opens" the phase record celebrated were artifacts of these false
closes flapping. The decisive mapping fact, established by joining
`acquisition_history.run_id` to `util.app_run_logs`: **every one of the five oracle streams
(mmb, ip_reset, althea_env, philips, hhm) is written by `data_acquisition`** — they are its
internal job names, including the `philips`/`hhm` streams. The oracle records
data_acquisition's own acquisition outcomes and nothing else. A successful mmb rsync of
system X says nothing about whether hhm_rpp_ge's separate file-read workflow on X recovered.

**Root cause (mine).** The re-evaluation measured "reachable by producer: data_acquisition
254, hhm_rpp_philips 32, hhm_rpp_ge 19" and read reachability as *coverage*, never asking
WHOSE successes those systems' oracle rows were. Same failure family as Phase 4's F1: an
identifier match (system_id) treated as semantic evidence.

**Fix — the reviewer's suggestion, both arms:**

- **Explicit recovery scope** in the pure function: `ORACLE_SCOPED_APPS = ['data_acquisition']`
  (`domain/state.js`), justified by the run_id-join proof and unit-pinned. The dossier
  carries `src_app` (`apps[1]`, structurally single-element); recovery evidence is
  inadmissible unless the incident's producer is in scope. Fail-safe: missing/unknown
  `src_app` is NOT scoped. Re-open deliberately ignores scope (recurrence is the incident's
  own evidence).
- **Conservatively disabled for unmapped workflows**: GE/Philips incidents close by
  staleness only until a producer-specific oracle exists.
- **Scope provenance in parity** (the explicit ask): an `auto_recovery` reason on a
  non-data_acquisition incident — resolved OR recurring — is a failure; this is the check
  that would have caught all 30.
- **Remediation** (idempotent, in `db/schema.sql`): lifecycle reset (`state`/`resolved_*` →
  NULL) for every close whose evidence is inadmissible under the scope —
  `resolved_reason='auto_recovery' AND NOT ('data_acquisition' = ANY(apps))`. Applied live:
  **UPDATE 30**; next state run re-decided them under valid rules — 29 → open, 1 →
  stale. Incident 17157 is now honestly `open`. Re-apply matches nothing, and the fixed
  engine can never re-create the matched state.

**Post-fix live table:** every `auto_recovery` row (135 resolved + 5 recurring) is
data_acquisition; GE/Philips carry only `stale` closes (5) and opens. The 5 `recurring`
rows are now GENUINE data_acquisition flaps — the live re-open proof survives on valid
closes.

## F2 (MEDIUM) — State updates race their own facts (id-only matching) — FIXED

**Finding.** Facts are read, transitions computed in JS, updates match by `id` alone. A row
read as `open` and concurrently set to `suppressed` (future human surface) would be
overwritten with `resolved` — disproving "suppressed is engine-terminal"; a concurrent
aggregate advancing `last_seen` enables a stale close on outdated quietness.

**Verified — confirmed by inspection** (no live repro exists: nothing can set `suppressed`
yet and the job is sequential today — but the *guarantee as stated* was false, and the
guarantee is the product).

**Fix — the optimistic arm of the suggestion** (convergence over locking; no `FOR UPDATE`
held across JS compute): both state ColumnSets gained `prev_state` / `prev_last_seen` /
`prev_resolved_last_seen` as condition-only columns, and the UPDATE predicate matches the
facts the decision was computed from (`IS NOT DISTINCT FROM` — the backlog's NULL state
must match NULL). A mismatched row is **skipped**, counted (`incidents_skipped_concurrent`
in the run summary, with a WARN log when non-zero), and re-evaluated next run against its
new facts. Live: `skipped=0` on every run since (the sequential job makes mismatches rare;
the guard exists for the concurrent futures the finding names).

## F3 (MEDIUM) — Production cron executes the mutable working tree — REPO-SIDE DONE, INFRA STEP PENDING

**Finding.** `./:/workspace` + a cron that `cd`s into the repo means checkouts and
uncommitted edits go live with no deploy boundary; this phase (and Phase 4, unnoticed)
ran in production before review.

**Fix (decided: dedicated deployment worktree).** `markdown/DEPLOYMENT.md` now carries the
"Deploy boundary" section with the exact one-time and per-deploy commands: a git worktree
at `/opt/apps/incident-engine-deploy` pinned to a reviewed ref; the CRON pointer moves
there; the dev tree keeps its mount for smoke tests. **The one-time step needs root (write
to `/opt/apps`, cron edit) — pending developer action.** Until then the runbook states the
operative rule: a `git checkout` in this directory IS a production deploy.

---

## Re-validation after fixes (all green)

- **153/153** unit (6 new scope tests, incl. the 17157 regression pinned verbatim and the
  fail-safe unscoped-src_app sweep).
- Remediation applied (UPDATE 30) → fixed engine re-decided: 29 open + 1 stale (+2
  unrelated data_acquisition closes arriving in the same run). Re-run: **0 written,
  0 skipped**. Parity + lifecycle + scope invariants PASS across 509.
- Distribution: **363 open / 141 resolved (135 auto_recovery + 6 stale) / 5 recurring**
  — every auto_recovery row is data_acquisition; GE/Philips carry only stale closes.
- Exactly-once delta 0; loader guard green (`recovery.js` registered).

## Status

F1 + F2 closed pending re-review; F3 closed on the repo side with one root-requiring infra
step awaiting the developer. Fix-round delta handoff:
`notes/codex_handoff_phase_5_fixes.md`.

---

# Round 2 (re-review of the fixes)

Source: Codex, from `notes/codex_handoff_phase_5_fixes.md`.
Verdicts: **F2 closed. F1 partially closed** (one residual medium). **F3 not closed**
(operationally — the documented fix exists, the worktree does not).

## Residual (medium) — RECOVERY_SQL still accepted evidence from any producer — FIXED

**Finding.** The round-1 fix scoped the CONSUMER (which incidents may accept oracle
evidence) but not the EVIDENCE POOL: `RECOVERY_SQL` aggregated successes from every
producer, so a future suite app writing `stats.acquisition_history` could falsely close a
data_acquisition incident on the same entity — and parity would miss it, since it only
checked `row.src_app`. "All 97,944 rows join to data_acquisition" was measured state, not
an enforced contract. Exactly my §1 weak-spot question, answered: yes, it was worth
enforcing now.

**Fix — the reviewer's suggestion, all three arms:**

- `RECOVERY_SQL` admits a row only if its `run_id` links to a `util.app_run_logs` run with
  `app_name = 'data_acquisition'` (semi-join, both scans 14-day-bounded so partitions prune
  per the Data-Contract Rule — EXPLAIN'd: 6 subplans removed, ~8k cost once per run). The
  bound is safe by construction: log retention (~7d) is the real admissibility horizon, and
  any incident an older success could close is stale-closed in the same run — worst case is
  the reason label, never a missed close. Supersedes the "deliberately unbounded" design.
- **Fail-closed alarm**: `ORACLE_PROVENANCE_AUDIT_SQL` counts `foreign_rows` (run links to
  another app ⇒ a new producer — review the scope) and `unlinked_rows` (1h–2d lagged window
  ⇒ a producer not self-logging), surfaced in the run summary + a WARN when non-zero.
  Live: 0 / 0. Measured in-flight lag: 0 unlinked even in the last hour.
- **Parity**: `recovery_evidence` now requires the provenance link (with an honest-aging OR
  arm — a row older than the oldest surviving run log cannot be expected to link), and a
  standalone fail-closed assertion makes ANY foreign oracle row a parity failure.
- Loader-guard landmarks pin the semi-join, the run link, and the time bound — dropping any
  of them fails the unit suite.

**Re-validation:** 156/156 unit; live run audit 0/0; legitimate closes unchanged; re-run 0
written; parity PASS. (Live drift during the round — recurring 5→7 — is genuine
data_acquisition flap, the expected steady-state behavior.)

## F3 — still the developer's one-time root step

The reviewer is right that documentation does not remove the live risk. The runbook is in
`DEPLOYMENT.md` §"Deploy boundary"; the worktree creation + cron edit need root and remain
**the single outstanding action of this phase**.

## Status

F1 + residual + F2: closed pending final verdict. F3: blocked on the developer's infra
step. All other validation green.

---

# Round 3 (final verdict)

Source: Codex. **Residual provenance finding closed. No new findings. F1: closed.
F2: closed. F3: not closed** — the deployment worktree/cron change remains pending (the
developer's one-time root step, sequenced AFTER commit+merge so the deploy worktree lands
on the reviewed ref — see PHASE_LOG §Follow-Up).

Reviewer verification: 156/156 tests; parity across 509; foreign oracle rows 0; unlinked
oracle rows 0; auto_recovery rows lacking current scoped evidence 0; auto_recovery outside
data_acquisition 0. The reviewer also independently endorsed the 14-day-bound reasoning:
evidence too old to retain provenance can only apply to an incident already eligible for
stale closure, and the semi-join excludes foreign/unlinked evidence BEFORE aggregation
while the audit keeps both conditions visible.

## Phase 5 review summary

Three rounds: 1 high + 2 medium → residual medium + F3 → clean. Every code finding fixed
and verified; the one open item is operational (F3 infra), deliberately sequenced
post-merge. The phase's headline lesson mirrors Phase 4's: an identifier match
(system_id) is not semantic evidence — provenance must be carried, gated on, AND enforced
at the evidence source, with a fail-closed audit for the day the assumption rots.

---

# Final verdict (round 3 addendum)

**F1: closed. F2: closed. F3: closed.** Reviewer-verified for F3: the deploy worktree
exists, clean and detached at the reviewed commit `8307bd5`; deployment `.env` present;
the installed cron runs from `/opt/apps/incident-engine-deploy`; dev and deploy worktrees
are separate. The reviewer conditioned continued closure on the post-deploy smoke — the
next cron tick from the new line.

**Post-deploy smoke: PASSED.** The 14:25 UTC tick (2026-07-17) fired from the deploy
worktree — self-log row at 14:25:04, exit clean, and the run did real work
(`{"opened":0,"reopened":10,"auto_recovery":3,"stale":0}`). F3 remains closed.

Operational observation from that tick, for the record: 10 re-opens in one cycle is the
steady-state flap the re-evaluation predicted, now fully visible as `recurring` (and
scope-verified — parity fails on any non-data_acquisition auto_recovery history). This is
the designed behavior surfacing real transport instability, and the standing dataset for
the "is two-cycle flap rhythm right?" watch item when an operator surface exists.

**Phase 5 is fully closed**: three review rounds, 1 high + 3 medium, every finding fixed
and verdicted closed, the deploy boundary installed and smoke-confirmed.
