# Codex Handoff — Phase 5: State Machine + Auto-Close (L5)

Branch: `phase-5-state-autoclose` (off `main` @ `77df163`) — **uncommitted working tree**,
nothing pushed. Note: the working tree IS what the :25/:55 cron executes (see §5.6) — this
code is already running live.

---

## 1. What this app is

`incident-engine` is a deterministic error→incident pipeline over the cron-driven
medical-imaging data apps under `/opt/apps`. It flattens `util.app_run_logs.warn_error_logs`
into fingerprinted events (L0, Phase 2), aggregates them into incidents — one per
`(fingerprint, entity)` (Phase 3), assesses severity deterministically (Phase 4, 3 review
rounds) — and, as of this phase, gives incidents a **deterministic lifecycle**: backlog/new
→ `open`, auto-close on **recovery** (the `stats.acquisition_history` oracle) or
**staleness** (no recurrence in 7 days), and re-open as `recurring` when a resolved problem
returns. Orientation: `CLAUDE.md`, `markdown/ARCHITECTURE_PRINCIPLES.md`,
`docs/incidents-schema.md`.

The phase prompt was REVISED pre-implementation (FLOW Step 3, committed `77df163`) —
`notes/phase_5_reevaluation.md` holds the live evidence and the three developer decisions
(staleness close; `recurring` = re-opened-only; ordering). **Treat the prompt and note as
fallible; the live DB is the authority** — that stance has produced findings in every prior
round.

## 2. Scope of this review

| File | What it is |
| --- | --- |
| `domain/state.js` | NEW — **the core**: pure SYNC transition function + `STALE_AFTER_DAYS=7` |
| `utils/db/queries/recovery.js` | NEW — oracle lookup + state-facts SELECT + update predicate |
| `jobs/assess/state.js` | NEW — the state step: all I/O + the single clock reading |
| `utils/db/sql/pg-helpers.js` | MODIFIED — two split state ColumnSets (see §4.3) |
| `index.js` | MODIFIED — assess job = aggregate → assess → **state** (order load-bearing) |
| `db/schema.sql` | MODIFIED — `resolved_last_seen` + CHECK constraints on `state`/`resolved_reason` |
| `integration/rep_determinism.js` | REWORKED — single-tx + forced ROLLBACK (the Phase 4 landmine, discharged first) |
| `integration/assess_parity.js` | MODIFIED — boundary moved to `action_*`-only + per-row lifecycle invariants |
| `test/state.test.js` | NEW — 33 tests, full transition table |
| `test/sql-modules-load.test.js` | MODIFIED — `recovery.js` registered |
| `docs/incidents-schema.md`, `markdown/PROMPTS.md`, `markdown/PHASE_LOG.md` | docs (incl. Git Commit backfill on prior entries) |

Getting the diff: `git add -N . && git diff main` (untracked files are half the phase).

**Out of scope** (settled): the assessor (3 rounds, converged), the aggregate's exactly-once
design, the fingerprint/classifier (untouched, `FP_VERSION` 1), the queued classification
phase (runs AFTER this one, developer-ordered), flap hysteresis (explicit non-goal — flapping
is made visible via `recurring`, not dampened), notifications/UI/L4.

## 3. How to run / verify it

No `node` on the host. DB `staging` on `pg_db:5432`; app runs as `incident_engine_rw`.

```bash
cd /opt/apps/incident-engine
docker run --rm -v "$PWD":/w -w /w node:lts node --test                  # 147/147
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql    # idempotent
docker compose run --rm app node index.js assess                         # aggregate→assess→state
docker compose run --rm app node integration/assess_parity.js            # incl. lifecycle invariants
docker compose run --rm app node integration/rep_determinism.js          # non-destructive now
docker compose run --rm app node integration/aggregate_race.js
```

Live at hand-off (2026-07-17): 509 incidents — **335 open / 165 resolved(auto_recovery) /
5 resolved(stale) / 4 recurring** (4 natural re-opens observed ~35 min after the first state
run — see §5.1); re-run writes 0; exactly-once delta 0.

```sql
SELECT state, resolved_reason, count(*) FROM incidents.incidents GROUP BY 1,2;
-- the re-open invariant (must be 0):
SELECT count(*) FROM incidents.incidents
 WHERE state='resolved' AND last_seen > resolved_last_seen;
```

## 4. Hard constraints to falsify

1. **Determinism/purity.** `nextState(facts)` — pure, SYNC (deliberately: no async/advisory
   impl can ever drive state; the signature is the promise). No clock inside — the job
   passes ONE `clock_timestamp()` snapshot used for every staleness comparison and every
   `resolved_at` stamped that run. Is it actually pure? Is the one-clock claim airtight?
2. **The engine can never write `acknowledged`/`suppressed`, or transition out of
   `suppressed`.** Four layers claim it: `ENGINE_STATES`, a unit sweep, the parity
   invariant, the DB CHECK (values only — the CHECK can't stop an engine write of a *legal*
   human state; the ColumnSets can't either since `state` is a column they carry). Try to
   construct the write.
3. **Write surface.** Two split ColumnSets: `incidents_state_only` (init/re-open — carries
   NO resolved_* column, so re-open structurally cannot clear resolution history) and
   `incidents_resolution` (all four lifecycle columns atomically). No severity/assessment/
   action_* anywhere. Oracle strictly SELECT-only. No new grant (verified).
4. **Clock domains.** Auto-close compares oracle `capture_datetime` (producer side) against
   `last_seen` (producer side). Re-open compares `last_seen` against the
   `resolved_last_seen` memento (producer side both). `resolved_at` (DB clock) is
   deliberately NOT a transition input — the unit suite pins its absence. Is any
   cross-domain comparison left?
5. **Idempotency.** No watermark by design; re-run writes 0; `resolved_at` stamped once.
6. **Ordering.** recovery > staleness precedence; strict `>` on both close comparisons;
   `capture_datetime` not `inserted_at` (76-day backfill hazard, measured).

## 5. Known weak spots — please scrutinize

### 5.1 Re-open HAS now fired against real data — verify the 4 rows

Initially the one synthetically-verified behavior; then the producers' next burst (~35 min
after the first state run) delivered new failures for 4 resolved incidents and the state
step re-opened all 4 as `recurring` (`{"reopened":4}`; parity invariants PASS over them).
So the happy path is live-proven. What remains unproven is the UNHAPPY paths: the
producer-clock-skew case (unit-tested only — no skewed producer exists to observe) and
re-close-after-re-open (expected within cycles; not yet seen at hand-off). Please verify
the 4 live `recurring` rows independently:

```sql
SELECT id, entity, category, last_seen, resolved_last_seen, resolved_at
FROM incidents.incidents WHERE state='recurring';
-- each must have L0 events with COALESCE(dt, inserted_at) > resolved_last_seen
```

**If you can reason a re-open failure mode the tests and invariants miss, that is still
the highest-value finding available.**

### 5.2 The parity test's recovery check half-shares an expression with production

`assess_parity`'s `recovery_evidence` EXISTS uses `COALESCE(capture_datetime, inserted_at)`
— the same expression `RECOVERY_SQL` uses. The queries are independently written (EXISTS vs
GROUP BY max), but if the *expression choice itself* is wrong (e.g. `capture_datetime` has a
failure mode we haven't seen), both sides agree and parity is blind to it — the F3 lesson
one level up. I don't see a way to make it more independent without inventing a second
timestamp theory; push on whether the choice is sound instead.

### 5.3 One-transition-per-evaluation means resolved→recurring→resolved takes two cron cycles

A resolved incident that recurred AND already re-recovered re-opens this run and re-closes
next run (~30 min at `recurring`). Deliberate: single-step transitions are simpler to reason
about and the intermediate `recurring` blip is honest flap visibility. Defensible, or churn?

### 5.4 The stale threshold vs. the quiet distribution

`STALE_AFTER_DAYS = 7` with strict `>`, one clock reading. Live: 50 incidents sit quiet
1–3d (must NOT close — they're between recurrences) and none closed. But the 3–7d bucket
(40 incidents) will cross the boundary over the coming days — if a 5-day-quiet problem
routinely recurs on day 8, we'll close and re-open it. That's `recurring` doing its job, or
an argument for a longer threshold; data will tell. The constant is one line.

### 5.5 The re-worked rep_determinism holds an ACCESS EXCLUSIVE lock

The single-tx design TRUNCATEs inside the transaction, so a cron tick during the test
blocks on the lock for the test's duration (seconds). It takes no `pipeline_state` locks
(the old watermark manipulation is gone — rollback discards everything), so I see no
deadlock cycle against the aggregate's lock order. Verify that claim.

### 5.6 DISCOVERED THIS PHASE: the cron executes the working tree

`docker-compose.yaml` mounts `./:/workspace`; the cron `cd`s here. **Whatever is checked
out runs at the next tick, committed or not** — this branch went live before review, and
Phase 4's branch did the same during its development (nobody noticed). Everything shipped
happens to have been validated first, but the discipline is luck-shaped. Review question:
is dev-on-prod acceptable for this suite (it matches how the other `/opt/apps` are
operated), or should the runbook pin cron to a committed ref (e.g. a `deploy/` worktree)?
Not fixed this phase — flagging, not deciding.

### 5.7 Smaller

- `acknowledged` auto-closes (ack ≠ keep-open) — untestable live until a human surface
  exists; the transition table defines it now so the dashboard doesn't improvise later.
- A resolved row missing its memento re-opens (fail-visible). Unreachable at rest today;
  is that the right default if a future migration ever produces one?
- The state step evaluates ALL 509 rows every run (the Phase 4 assess-all reasoning).
  ~74ms live. Same growth argument as Phase 4.

## 6. Intentionally deferred — not bugs

No hysteresis; no notifications; no human surface; no L4; severity ⟂ state; the
classification phase (next, with its interim-M2-reason + RULES_VERSION obligations); the
working-tree-cron question (§5.6, flagged for a decision, not silently changed);
`acquisition-v2` onboarding; retention.

## 7. Output format requested

Severity / `path:line` / what & why (trace or query) / suggested fix. Fewer, high-confidence
findings. Priority: (1) a state the DB can reach that the transition table doesn't intend —
especially anything that closes an incident that is still failing or fails to re-open one
that recurred; (2) the §4 constraints; (3) the §5 judgment calls; (4) wrong claims in
comments/docs — every phase has had one, and comments here are load-bearing.
