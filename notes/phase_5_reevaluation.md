# Phase 5 Re-evaluation (pre-implementation) — 2026-07-16

FLOW Step 3 pass over `prompts/prompt_5_state_autoclose.txt` after Phase 4 completed (three
review rounds, converged, committed `f5d62ed`). Verdict: **implement as revised** — the
phase's shape (pure `domain/state.js` transitions, oracle SELECT-only, engine-driven
transitions only, re-open on post-resolve recurrence, `acknowledged`/`suppressed`
defined-but-never-set, no L4/notifications/LLM) is unchanged and correct. But the prompt
repeats two failure patterns this project has already paid for — a **dead clause** written
against a structure that doesn't exist (Phase 4's blast-radius lesson) and a **state trigger
the live data makes universal and therefore signal-free** (Phase 4's flat-medium lesson) —
and it is silent about an oracle coverage gap, a cross-clock comparison bug in its own
re-open rule, and two of our integration tests that this phase structurally breaks.

Three decisions below are **developer-approved (2026-07-16)**: the staleness close, the
`recurring` semantics, and phase ordering.

## Live measurements (superuser, `staging`, 2026-07-16)

The pipeline is cron-live (`25,55`), so these move. Snapshot: 504 incidents / 82
fingerprints / ~230k L0 events; post-Phase-4 severity 184 high / 319 medium / 1 info.

### The oracle (`stats.acquisition_history`)

- 89,246 rows, fresh to the current cron cycle; 72,761 successes / 16,485 failures;
  `successful_acquisition` NOT NULL.
- **`capture_datetime`: 0 nulls across all 89k rows** (column is nullable; never null live).
- `inserted_at - capture_datetime`: min ~118s, median ~5.4 min, **max ~76 days**. So
  `capture_datetime` always precedes `inserted_at`, usually by pipeline delay — but a
  BACKFILLED acquisition can be inserted months late. Under `inserted_at`, that backfill
  would read as "recovered today" and wrongly close an incident; under `capture_datetime`
  it correctly predates the incident. **The prompt's open question resolves:
  `capture_datetime`**, with `COALESCE(..., inserted_at)` only as the documented fallback
  for the column's nominal nullability.
- Written by five live streams (`app_name`: mmb 66.8k, ip_reset 14k, philips 4.3k, hhm 3k,
  althea_env 1.3k — all current to the last cycle). Note these are `data_acquisition`'s
  internal job names, not suite app names. The `philips`/`hhm` streams are success-only
  (100% `successful_acquisition=true`), so for their systems the oracle only ever supplies
  timing, never failure corroboration — fine for auto-close.

### Oracle REACH — the number the prompt doesn't know

| incidents | oracle-reachable | entity absent from oracle | `__global__` |
| --- | --- | --- | --- |
| 504 | **305 (60%)** | **188** (106 distinct entities, ALL valid `^SME\d{5}$`) | 11 |

Reachable by producer: data_acquisition 254, hhm_rpp_philips 32, hhm_rpp_ge 19. The 188
unreachable are real SME-format equipment the oracle has simply never recorded (mostly
GE/Philips systems). Coverage is per-system, not per-app, and all streams are live — so it
can grow — but **~40% of incidents can never auto-close on recovery evidence.**

Recency of that gap (why it's benign today and structural tomorrow): 377/504 incidents are
active (<1 day since `last_seen`) — 196 of the unreachable ones are among them, i.e.
*correctly open*. Quiet 1–3d: 77; 3–7d: 41; >7d: 9 (3 unreachable). So today only a handful
linger; over weeks, every GE/Philips problem that ENDS would accrete as "open" forever.

### Day-one auto-close (recovery later than `last_seen`, measured now)

164 incidents would close immediately: rsync_io_timeout 100 high + 20 medium,
connection_timeout 15, unknown 14, connection_reset 9, partial_transfer_timeout 5,
rsync_partial 1. Zero of the 164 have a failure event newer than that success (no immediate
re-opens).

### Flap and recurrence

- **60 entities had BOTH a successful acquisition and new failure events within the last
  48h** — close→re-open cycling WILL occur at steady state; the state machine needs to make
  flappers visible, not pretend they won't happen.
- Incident lifetime spans: **303/504 span ≥9 days** — effectively the entire L0 history —
  and everything recurs every cron cycle. Any occurrence/span threshold for `recurring`
  is crossed by ~everything instantly.

## Changes to `prompt_5_state_autoclose.txt`

### 1. Auto-close keys on `entity`, not "resolvable `systems[]`" (dead clause)

`systems[]` is structurally ≤1 (the entity IS the system; empty for `__global__`) — the
same class of dead clause as Phase 4's `apps.length` blast radius. The oracle join is
`ah.system_id = incident.entity`.

### 2. `recurring` = re-opened after a resolution, nothing else (developer-approved)

The prompt's trigger ("cross a recurrence threshold or multi-run span") would mark ~all 504
incidents `recurring` immediately (303 span ≥9 days; everything recurs every run) — a state
everything has distinguishes nothing. Revised: `recurring` is entered ONLY by re-open (a
resolved incident whose problem returns). Scarce, meaningful, and it doubles as the flap
signal (60 interleaving entities live). Ordinary repetition while open just bumps
`occurrence_count`/`last_seen`, exactly as today.

### 3. Staleness close added: `resolved_reason = 'stale'` (developer-approved)

Auto-close on recovery evidence alone leaves ~40% of incidents (`__global__` + the 188
oracle-invisible) unable to EVER resolve — the incident list would stop reflecting current
reality, which is this app's stated purpose. Added: a second deterministic close — no
recurrence in `STALE_AFTER_DAYS` (default 7, a named constant; re-justify against live
recency in Step 2) ⇒ `resolved`, `resolved_reason='stale'`. Distinct reason from
`'auto_recovery'` (one is positive recovery evidence, the other is absence of failure);
identical re-open rule. Precedence: recovery is checked first, staleness second, so an
incident eligible for both records the stronger reason. 7 days sits above the live
quiet-1–3d hump (77 incidents that are merely between recurrences must NOT close) and at
the source-retention horizon; DB-vs-producer clock skew (minutes) is immaterial at that
scale.

### 4. Timestamp question resolved: `capture_datetime` (see measurements)

Also settles the clock-domain argument: `capture_datetime` and the event `dt` feeding
`last_seen` both originate producer-side, so "success AFTER failure" compares within one
clock domain. `inserted_at` would compare DB time against producer time AND mis-order
backfills (the 76-day case).

### 5. Re-open must compare within ONE clock domain: new column `resolved_last_seen`

The prompt's re-open ("recurs AFTER `resolved_at`") compares producer-clock `last_seen`
against DB-clock `resolved_at`. A producer whose clock trails the DB by more than the
resolve gap emits new failures that advance `last_seen` without ever exceeding
`resolved_at` — the incident stays resolved WHILE FAILING, which is precisely the stale
auto-close the prompt says re-open must prevent. Revised: at resolve time, persist the
incident's current `last_seen` as **`resolved_last_seen TIMESTAMPTZ`** (CREATE + idempotent
UPGRADE, mirroring the `entity`/`type` precedents); re-open iff
`last_seen > resolved_last_seen` — a same-domain, skew-immune, idempotent comparison.
`resolved_at` remains the human-facing "when did the engine close this" stamp.

### 6. Transition-table completeness (was implicit or missing)

- **Backlog init**: 504 live rows have `state` NULL. NULL → `open` on the first run
  (the Phase 4 backlog precedent). "New (fingerprint, entity) → open" alone doesn't cover it.
- **From `acknowledged`**: recovery/staleness also close it (ack = "a human saw it", not
  "keep it open"). Vacuous this phase (nothing sets it) but the table must define it.
- **From `suppressed`**: engine-terminal — no engine transition out, ever. A suppressed
  incident is a human's statement; only a human (future dashboard) un-suppresses.
- **Scope**: the state step evaluates ALL incidents from durable facts every run (the
  Phase 4 sibling-staleness lesson — no touched-only predicate), writes only rows whose
  state actually changes (no-op filter; `resolved_at` is stamped once at transition, never
  refreshed on re-runs).

### 7. Purity wording: the pure function receives time, it never reads it

`resolved_at=now()` cannot live inside `domain/state.js` (Determinism Rule: no clock
inside). The JOB passes the batch's evaluation timestamp + the per-incident oracle facts in;
the transition function returns the next state + reason; SQL stamps the write-time columns.

### 8. This phase must rework two existing tests (in scope, not incidental)

- `integration/assess_parity.js` asserts `state`/`resolved_*` are NULL on all rows (the
  Phase 4 boundary). Phase 5 moves that boundary: the check becomes "`action_state`/
  `action_ref` NULL everywhere; `state` ∈ vocabulary; `acknowledged`/`suppressed` never
  engine-set; **the assessor still writes no state** (its ColumnSet remains the enforcement)".
- `integration/rep_determinism.js` TRUNCATEs `incidents.incidents` and restores by
  re-aggregating + re-assessing — valid ONLY while every column is a pure function of
  L0-derived facts. `state`/`resolved_at`/`resolved_last_seen` are history-dependent, so
  the recorded landmine (PHASE_LOG Phase 4) comes due HERE: rework the test to
  snapshot-and-restore (or a scratch table) BEFORE the state step ships. Not optional.

## Ordering decision (developer-approved)

**Phase 5 runs before the queued classification phase.** Auto-close is the roadmap's next
increment and delivers immediate value (164 day-one closes); classification is severity
labeling, orthogonal to lifecycle, and carries a cross-app vocabulary conversation
(`connection_regex.js` is `data_acquisition`-owned). The classification phase retains its
Phase 4 obligations: remove/update the interim-M2 reason string and bump `RULES_VERSION`.

## Not changed

- Pure `domain/state.js`; oracle SELECT-only; writes confined to the state columns on
  `incidents.incidents`; engine-driven transitions only; no L4 (`action_*` never written),
  no notifications, no LLM, no human-transition UI.
- `severity` is deliberately NOT a state input this phase — lifecycle and severity stay
  orthogonal; couple them only with evidence.
- No watermark for the state step: like assessment, re-runnability is a property of
  recomputing from durable facts, not of bookkeeping.

## Watch items for the implementer (not prompt changes)

- **Flap churn**: with 60 interleaving entities, resolve→re-open cycles are expected. This
  phase makes them VISIBLE (`recurring`), not dampened. If churn proves noisy, hysteresis
  (e.g. require quiet-for-X alongside a success) is a future, logged decision — don't
  invent it silently.
- The one live `rsync_partial`/info incident closes on day one and will predictably flap
  (its category means acquisitions succeed WHILE the problem recurs) — a preview of why
  `successful_acquisition`-flagged categories may eventually want different close semantics.
- Producer-vs-DB clock skew at minute scale is immaterial to the 7-day staleness rule but
  should be re-checked if `STALE_AFTER_DAYS` is ever lowered drastically.
