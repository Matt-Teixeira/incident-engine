# Phase Log

Durable memory of what's been done and why. Newest entry at the top. Add an entry (from
`PHASE_TEMPLATE.md`) after each phase is implemented, validated, and ready to commit.

---

# Phase 6 — Engine Classifier Layer: Classify the Unknowns

Date:
2026-07-17

Status:
Completed

Prompt:
`prompts/prompt_6_classify_unknowns.txt` (written from live evidence the same day;
committed `d8eab9f`)

Git Commit:
`0367268` (phase, all 4 review rounds squashed into one commit; ff-merged to `main`,
pushed; deploy worktree pinned `0367268`)

Review Artifacts:

- Codex handoff: `notes/codex_handoff_phase_6.md`
- Review results: `notes/review_results_phase_6.md` (pending — developer runs the review)

## Goals

- Classify the known message families out of `unknown`, each severity from PRODUCER
  EVIDENCE (the F2 standard: what the producer DOES after emitting, never the label), via a
  layered engine-owned classifier that can extend but never shadow the verbatim production
  mirror. Discharge the Phase 4/5 review obligations (interim-M2 reason string removed;
  `RULES_VERSION` → 2). **Non-goals held:** `connection_regex.js` untouched; FP_VERSION 1;
  no L0 rewrite; no state-machine/oracle changes; no upstreaming (tracked).

## Built

- `utils/classify/engine_regexes.js` — 9 engine categories, each entry citing the producer
  file/lines that justify its verdict. New `error_type` vocabulary: `config`, `halt`,
  `crash`, `quality`, `status` (plus deliberate reuse of production `credentials`/`file`
  semantics where they genuinely match).
- `domain/classify.js` — two ordered layers: production mirror first, engine table ONLY on
  a miss, `unknown` only when both miss. Still pure.
- `domain/assessor/rules.js` — R7b branches for the new error_types (halt→medium,
  crash→medium, quality→medium — review round 2, was low —, status→info; config/credentials ride R5 via
  manual_intervention; engine `file` rides R7 — `input_file_missing`'s medium is
  developer-decided); per-category actions citing the evidence; R1 rewritten to the
  PERMANENT residual policy (developer-decided: medium both types; "interim" language
  retired and unit-asserted absent); `RULES_VERSION = 2`.
- Tests (196 total, +27): layer precedence; a 26-text no-collision sweep (one real sample
  per production pattern — no engine regex may match any of them); one classification test
  per family from the producers' real messages; per-family severity table with a
  no-silent-additions guard; counts restructured (20 production + 9 engine + 2 caller-set
  = 31, zero slug collisions); interim language asserted gone.
- Docs: `docs/error-taxonomy.md` restructured as two layers with the engine-verdict table;
  `docs/incidents-schema.md` category note. NO schema change (verified — classification is
  vocabulary, not storage).

## The Verdicts (producer evidence quoted at each engine_regexes.js entry)

| category | evidence in one line | severity |
| --- | --- | --- |
| `tunnel_not_found` | failing IP has no tunnel row → auto-reset impossible, `continue` | high |
| `config_missing` | system row lacks config → skipped "so ops can fix the row" | high |
| `credential_decrypt_error` | stored credential fails decrypt → cannot authenticate | high |
| `job_halted` | rsync produced nothing → job returns (the F2 family; NON-CONFORMANT variant re-homed to `config_missing` in review round 1) | medium |
| `input_file_missing` | upstream file absent → run yields nothing for that SME (incl. GE's explicit dir message — round 1; bare "File not found" reverted to `unknown`, ambiguous across producers) | medium* |
| `unhandled_type_error` | TypeError reaches CATCH — parser code defect | medium |
| `datetime_parse_null` | record KEPT with null `host_datetime`; a null LAST record breaks the offline-health upsert (round 2 — was low) | medium |
| `no_new_data` | nothing new to process — GE-delta + rmmu shapes only (monitoring text reverted to `unknown`, round 1 HIGH) | info |
| `counter_reset_reread` | file shrank → producer re-reads whole file, continues | info |

\* developer-decided 2026-07-17, as was the residual-`unknown` policy (medium, both types,
permanent). Deliberately still `unknown`: the generic `Command failed: ...rsync_mmb.sh`
wrapper — inconclusive, not guessed.

## Schema Facts Confirmed (live DB)

- The unknown bucket at implementation: 213 incidents / ~184k events, decomposing into the
  12 families above (Step 2 re-measured; the prompt's table was same-day).
- All producer evidence read directly: `data_acquisition` (get-tunnels-by-ip.js,
  hhm/_shared.js, hhm/_configs.js + encrypt/), `hhm_rpp_ge` (GE_CT_CV_MRI.js,
  tooling/gzip_file.js), `hhm_rpp_philips` (insert_jsonb_data.js, lod_eventlog.js,
  eal_parser.js, Philips_MRI_Logcurrent.js, logcurrent.js, rmmu_*.js, util/gzip_file.js) —
  sandbox access confirmed this session, no pairing needed.

## Important Decisions

### The layered classifier (made in the prompt, held)

The production mirror is never edited and never shadowed; engine vocabulary is a separate,
engine-owned file consulted only on production miss. Re-sync stays a file copy; upstreaming
stays a clean one-file proposal; identity untouched (category is not in the fingerprint).

### `input_file_missing` reuses production `file` semantics → medium (developer-decided)

~110 per-SME incidents. A scanner whose telemetry is not flowing is a real actionable gap;
dormant ones stale-close. The alternative (low) would have hidden broken pipelines among
dormant SMEs.

### Residual `unknown` = medium, both types, PERMANENT (developer-decided)

Replaces the interim-M2 rule. An unrecognized message is conservatively actionable until a
pattern or producer-evidence verdict exists. Residual volume is tiny (the ~5-event generic
wrapper + future novelties).

### The deploy boundary shaped validation (a first)

The production cron runs the PINNED Phase 5 code, so events consumed by cron ticks still
classify `unknown` until this phase deploys — dev-tree manual runs demonstrate convergence
only on the event slices they materialize first. This is the boundary WORKING (unreviewed
code no longer leaks into production), at the price of staged convergence: full bucket
collapse completes at deploy. Validation therefore proves the mechanism per-family, not the
end-state numbers.

## Architecture Notes

- Write-isolation/least-privilege: no new write surface, no grant, no schema change.
- Determinism: classify stays pure (two ordered tables); assessor pure; version provenance
  via `assessor_version=2` on every row (the one-time full re-stamp, expected).
- Fingerprint stability: FP_VERSION 1; zero re-bucketing. Mixed-category fingerprints are
  now REAL (old L0 events 'unknown', new ones classified) — newest-representative-wins
  converges to the classified category; the Phase 3 prefer-confident caveat stays a caveat
  (no flap observed; watch item).
- Idempotency: assess re-run after the v2 re-stamp writes 0.

## Validation

Commands run:

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test        # 196/196 (+27)
docker compose run --rm app node index.js run                  # new classifier live (dev tree)
docker compose run --rm app node index.js assess               # re-run: 0 written
docker compose run --rm app node integration/assess_parity.js  # PASS
docker compose run --rm app node integration/rep_determinism.js && node integration/aggregate_race.js  # PASS / PASS
```

Results *(round-0 snapshot — the convergence/severity numbers below were SUPERSEDED by
review round 1; see Review Notes for the corrected ones)*:

- 196/196 unit. `assessor_version=2` on all 509 (one-time re-stamp; re-run 0). Parity +
  lifecycle + scope invariants PASS.
- **Convergence: ~97% complete BEFORE deploy** — the staged-convergence caveat proved
  overly cautious. The 15:33 slice converged `credential_decrypt_error` ×6 +
  `config_missing` ×2 (→ high); the timed 15:51 run caught the :45 producer burst ahead of
  the :55 pinned cron and converged the rest in one pass:
  `input_file_missing` 121 incidents / 98k events (medium), `no_new_data` 86 / 41k (info),
  `job_halted` 1 / 31k (medium), `tunnel_not_found` 1 / 15k (high),
  `unhandled_type_error` 26 / 12.5k (medium). **`unknown` collapsed 213 incidents / ~184k
  events → 7 incidents / 426 events** — the residuals are exactly the predicted dormant
  stragglers (3 already resolved; all from known families awaiting their next recurrence)
  plus the deliberate rsync_mmb generic (whose incident now carries an oracle-corroborated
  category and is severity-gated by R0 as before).
- **Severity distribution — before Phase 6 → after:** medium 312 → **225**, high 196 →
  **197**, info 1 → **87** (509 total; parity + lifecycle + scope invariants PASS over the
  converged table). The medium deflation is honest relabeling-into-legibility: the 87 info
  are the status families with producer evidence they are the normal between-acquisition
  state; the mediums that remain are real per-system gaps (input files not flowing,
  crashes, halts).

## SELF-CAUGHT POST-VALIDATION: cross-version assessment oscillation (until deploy)

A final-sweep assess re-run wrote 509 when it should have written 0 — read the run history:
the :55 pinned-cron tick (v1 rules) had rewritten every assessment to v1 (engine categories
→ the not-in-taxonomy default), and the dev-tree run flipped them back. **The deploy
boundary isolates code, not DATA: both trees write the shared production DB, and
version-stamped assess-all turns concurrent rule versions into a 30-minute oscillation.**
Not corruption (each state internally consistent; lifecycle severity-independent),
resolves at deploy. **Round-1 correction: "category convergence unaffected" was FALSE** —
each cron tick that processes a burst stamps the new events `unknown` (v1 classifier) and
newest-representative refresh flips actively-recurring incidents' CATEGORIES back too
(measured 17:39: all 213 back to `unknown`, all 509 at v1). The oscillation is total; the
Results numbers above are transient post-dev-run snapshots; convergence is real only at
deploy. Interim: no further dev-tree assess runs, so
the cron owns the table (v1 view) during review. LESSON FOR EVERY FUTURE PHASE: dev-tree
validation runs are production WRITES — a phase whose writes were not version-idempotent
would corrupt, not oscillate. Isolation story for validation = open question, put to the
reviewer.

**RESOLVED AT DEPLOY (2026-07-17, commit `0367268`).** The deploy worktree moved
`8307bd5` → `0367268`; both trees now run v2, so no scheduled v1 writer remains and the
oscillation is structurally over. Post-deploy the `18:40` deploy-tree run landed pre-burst
(watermarked materialize won't re-classify the batch the 18:25 v1 tick already stamped
`unknown`), so convergence waited for the **`18:55` production cron tick (v2)** to pull the
:45 burst through the engine classifier. Definitive post-deploy measurement at `18:57`
(production cron, not a dev run — the true smoke test):

- **`unknown`: 79 incidents / 38,900 events** (from 213 / ~185k at phase start).
- `input_file_missing` 74 / 73,200 · `no_new_data` 49 / 23,907 · `job_halted` 1 / 31,862 ·
  `unhandled_type_error` 26 / 12,688 · `tunnel_not_found` 1 / 15,222 ·
  `credential_decrypt_error` 6 / 2,928 · `config_missing` 2 / 976. (`datetime_parse_null` /
  `counter_reset_reread` dormant — 0 current events.)
- **severity: medium 262 / high 197 / info 50**; **assessor_version v2 on all 509** — the
  whole table at one version. These match the round-1 corrected snapshot exactly, now
  production-verified and STABLE (the next tick is v2 too — nothing reverts them). The two
  reverted-text families (`No new monitoring data found.`, bare `File not found`) sit in
  `unknown`/medium as intended.
- The residual 79 `unknown` are the dormant known-family stragglers + the two deliberately-
  ambiguous texts + the deliberate `rsync_mmb` generic — the honest floor, not the pretty
  one.

## Review Notes

Source:

- Codex handoff (round 1): `notes/codex_handoff_phase_6.md`
- Review results (round 1): `notes/review_results_phase_6.md` — **1 high, 2 medium, 2 low;
  all five verified real against producer code; all fixed** (196/196 after)
- Codex handoff (fix round, delta): `notes/codex_handoff_phase_6_fixes.md`
- Review results (round 2): `notes/review_results_phase_6.md` §Round 2 — prefix +
  permanent-unknown handling **accepted**; **F4 escalated to medium, verified real**
- Codex handoff (fix round 2, delta): `notes/codex_handoff_phase_6_fixes_round_2.md`
- Review results (round 3): `notes/review_results_phase_6.md` §Round 3 — F4 **partially
  closed** (MRI/CT accepted; generalize the reason/action across all emitters); fixed
- Codex handoff (fix round 3, delta): `notes/codex_handoff_phase_6_fixes_round_3.md`
- Review results (round 4): `notes/review_results_phase_6.md` §Round 4 — verdict sound but
  **evidence miscounted** (8 emitters not 7; 7-of-8 share the upsert; CV/eventlog selects
  the first record); corrected everywhere authoritative
- Codex handoff (fix round 4, delta): `notes/codex_handoff_phase_6_fixes_round_4.md` —
  re-review pending

Round 1 (verdict "needs changes" — the tests passed but "encode several unsupported
producer assumptions"; correct, three findings were my own citations mis-read):

- **F1 (high):** `No new monitoring data found.` rated info was UNSUPPORTED —
  `insert_jsonb_data.js` emits it whenever the per-file loop added nothing, and the only
  paths there are `continue`s (absent file, stale cache, catch-all read error; the
  `!matches` branch is dead code — `matchAll` is never falsy). Reverted to `unknown`/
  residual medium until the producer distinguishes the cases. **37 live incidents moved
  info → medium** — the round's real-world size.
- **F2 (medium):** `JOB HALTED -> NON-CONFORMANT config` is a pre-acquisition config GATE
  (`mmb/index.js:37-45`), not a halt → second `config_missing` entry ordered above the
  generic `^JOB HALTED`; halt citation corrected to `mmb/index.js:74-82`.
- **F3 (medium):** `input_file_missing` under- and over-matched: GE's thrown
  `File not found in directory: <path>` (`GE_CT_CV_MRI.js:139-144`) now matches; bare
  `^File not found$` removed — same text carries OPPOSITE truth values across producers
  (`lod_eventlog.js` genuine existsSync miss vs `insert_jsonb_data.js` relabel of ANY
  caught read error). Self-caught on top: my entry cited `eal_parser.js:56-64`, an
  INFO-level site that never reaches `warn_error_logs`.
- **F4 (low):** null-datetime records are APPENDED with `host_datetime = null`
  (`data.push` in both parsers), not skipped — evidence/action corrected, low retained.
- **F5 (low):** both current-contract docs still stated the superseded interim-unknown
  policy — updated to the permanent policy. Docs-drift prediction now 6 phases for 6.

Corrected snapshot (timed 17:51 post-burst run): `unknown` 79 / 38,742 (the reverted
families), `input_file_missing` 74 / 72,900, `no_new_data` 49 / 23,809 (GE-delta + rmmu
shapes only); severity **medium 262 / high 197 / info 50**. The round-0 "medium 225 /
info 87" numbers in Results above are SUPERSEDED — 37 of those infos were F1's
unsupported claim.

Round 2 (on the fix delta): prefix and permanent-unknown handling accepted (upstream
producer disambiguation is the durable fix for the two ambiguous texts; the conservative
fallback suffices for this branch). **F4 escalated to medium — verified real, two parts:**
my round-1 fix corrected the ACTIONS string but missed the R7b reason string (still said
"skipped"), and — the substantive part — both Philips parsers interpolate the LAST
record's `host_datetime` into the offline-health upsert (`util/upsertHostDatatime.js`
quotes the value), so a null last record sends the string `'null'` to a `timestamptz`,
PostgreSQL rejects it, and `alert.offline_hhm_conn` goes stale for that system. Fixed:
quality → medium @ 0.7, reason/action rewritten with the evidence, tests/docs updated
(196/196). Live: family dormant (0 events carry the category; its 2 incidents sit at
`unknown`/medium already), so the rating binds at deploy. The producer fix itself is
cross-app — tracked below, not made from this repo.

Round 3 (on the round-2 delta): MRI/CT medium **accepted**; F4 **partially closed** — the
`datetime object null` regex matches the same exact text from 7 emitters, so the reason/
action must not claim every match breaks the specific Philips upsert. Verified by full
producer sweep: **6 of 7 emitters share the identical `build_upsert_str` →
`alert.offline_hhm_conn` failure mode** (Philips MRI/CT/CV-eventlog, GE MRI/CT/CV, Siemens
CV — GE/Siemens `build_upsert_str` quote identically); the exception is Philips
CV/lod_eventlog (persists the null, no upsert). Fixed by GENERALIZING the reason/action to
the cross-vendor pattern (not source-aware: identical text, `error_category` not in the
fingerprint → conservative medium across all matches, exception recorded at the entry);
the cross-app follow-up broadened to cover all emitters (the reviewer's deferral
condition). 196/196; family dormant, binds at deploy. **[The "7 emitters / 6 of 7 / last
record" numbers in this paragraph were miscounted — corrected in round 4 below.]**

Round 4 (on the round-3 delta): the generalized medium verdict is sound, but the evidence
was **miscounted** (reviewer caught it): there are **8 emitters, not 7** (Philips has four —
MRI, CT, CV/eventlog, CV/lod_eventlog — GE three, Siemens one), **7 of 8 call the upsert**,
and **Philips CV/eventlog selects the FIRST record** (`mappedData[0]`) where the other six
select the last. Fixed: "last record" → "selected record" and the count → 8 / 7-of-8
across the assessor reason/action, the `engine_regexes.js` 8-row table, the taxonomy row,
and this follow-up (all eight emitters named). The medium verdict and deferral are
unchanged — only the count/wording. 196/196; family dormant, binds at deploy.

Critical issues:

- None open from rounds 1–4 (all findings fixed; round 4 was an evidence-count correction,
  no severity change); round-4-delta re-review pending.

## Problems Encountered

- Two trivial test-plumbing fumbles (a referenced-but-unimported helper; a duplicated
  import) — both caught by the suite immediately.

## Follow-Up Tasks

- ~~Codex review; iterate; commit; then DEPLOY (fetch + checkout in the worktree — this
  phase's convergence completes there; re-measure the unknown bucket and final severity
  distribution post-deploy and record them).~~ **DONE** — 4 review rounds converged;
  committed `0367268`, ff-merged to `main`, pushed; deploy worktree pinned `0367268`;
  post-deploy convergence measured at 18:57 (see the oscillation-RESOLVED section above).
- Upstreaming the proven engine entries into `data_acquisition`'s connection_regex.js —
  tracked open decision, now with a concrete candidate file.
- **Producer fixes surfaced by review (cross-app — never made from this repo):**
  (1) the offline-health upsert breaks on a null selected `host_datetime` (`build_upsert_str`
  quotes the value → `'null'` rejected by timestamptz) — round-2 F4 found it in Philips
  MRI/CT; **rounds 3–4 corrected the count: 7 of the 8 emitters of `datetime object null`
  share the identical upsert — Philips MRI, CT, CV/eventlog, CV/lod_eventlog; GE MRI, CT,
  CV; Siemens CV** (only Philips CV/lod_eventlog persists the null without an upsert; and
  Philips CV/eventlog selects the FIRST record `mappedData[0]`, the other six the last).
  The follow-up covers ALL EIGHT emitters (all four distinct Philips CV+MRI+CT parsers,
  the three GE parsers, the Siemens one): skip/null-handle or select a VALID timestamp. (2) the two
  permanently-ambiguous texts (`No new monitoring data found.`, bare `File not found`)
  need producer-side disambiguation before they can ever classify.
- Watch: mixed-category fingerprint flap (none observed; prefer-confident is the recorded
  fix); dormant incidents keeping the old 'unknown' category until they recur or
  stale-close (counted at deploy).
- The oracle `error_type` corroboration follow-up (Phase 3) remains separately tracked.

## Commit Readiness

- Requirements implemented: yes — per the prompt; both developer decisions recorded.
- Rules hold (write-isolation/least-privilege/idempotency/determinism): yes — no new write
  surface; classify/assess pure; re-run 0.
- Schema assumptions confirmed live: yes (no schema change needed, verified).
- Review findings addressed: **yes — converged.** Four Codex rounds (1 high, 2 medium,
  2 low, then F4 refined medium→generalized→count-corrected across rounds 2–4); all six
  findings verified real against producer code, fixed, and closed. Reviewer's round-4
  verdict: "F4 is closed"; remaining items are superseded historical wording, not fix-worthy.
- Ready to commit: **yes.** 196/196; parity + lifecycle + scope invariants PASS; no schema
  change; `.env` clean. Awaiting the developer's explicit commit word (commit-on-request
  discipline).

---

# Phase 5 — State Machine + Auto-Close (L5)

Date:
2026-07-17

Status:
Completed

Prompt:
`prompts/prompt_5_state_autoclose.txt` (revised 2026-07-16 pre-implementation, FLOW Step 3 —
`notes/phase_5_reevaluation.md`; committed `77df163`)

Git Commit:
`8307bd5` (phase) + `1b32f61` (deploy boundary installed, post-merge) + `7785c8a` (close-out)

Review Artifacts:

- Codex handoff (round 1): `notes/codex_handoff_phase_5.md`
- Review results (round 1): `notes/review_results_phase_5.md` (1 high, 2 medium — all real;
  F1/F2 fixed and re-validated live, F3 repo-side done + infra step pending)
- Codex handoff (fix round, delta): `notes/codex_handoff_phase_5_fixes.md`
- Review results (rounds 2–3): `notes/review_results_phase_5.md` §round 2–3 — residual
  evidence-pool provenance finding fixed and **verdicted closed; F1 closed, F2 closed,
  no new findings**. F3 stays open pending the post-merge infra step (by design).
- Step-3 re-evaluation (pre-implementation): `notes/phase_5_reevaluation.md`

## Goals

- Deterministic lifecycle on `incidents.incidents.state` (open / acknowledged / recurring /
  resolved / suppressed), engine-driven only: backlog/new → open; auto-close on **recovery**
  (oracle success after `last_seen`) or **staleness** (no recurrence in `STALE_AFTER_DAYS`);
  re-open past-resolution recurrences as `recurring`.
- **Non-goals (held):** no L4 (`action_*` never written), no notifications, no human UI, no
  LLM, no flap hysteresis (flapping is made VISIBLE, not dampened), severity is not a state
  input.

## Built

- `domain/state.js` — the pure transition function. **Deliberately SYNCHRONOUS** — the
  inverse of `assess()`'s deliberate async: lifecycle stays deterministic forever, and a sync
  signature refuses an async (I/O-doing) implementation structurally. No clock inside — the
  job supplies the evaluation instant. Exports `STATE`, `ENGINE_STATES` (open/recurring/
  resolved — the only values the engine may write), `RESOLVED_REASON`, `STALE_AFTER_DAYS=7`.
- `utils/db/queries/recovery.js` — the oracle lookup (max successful
  `COALESCE(capture_datetime, inserted_at)` per system, deliberately unbounded — a ~3k-cost
  hash aggregate over ~97k rows once per run) + the all-incidents state-facts SELECT +
  the update predicate. Registered in `test/sql-modules-load.test.js`.
- `utils/db/sql/pg-helpers.js` — TWO state ColumnSets, split on purpose:
  `incidents_state_only` (init + re-open; carries NO resolved_* column, so a re-open cannot
  clear resolution history even if the job code regressed) and `incidents_resolution`
  (state + resolved_at/reason/resolved_last_seen, atomically).
- `jobs/assess/state.js` — the state step: ONE clock reading per run (post-connection
  `clock_timestamp()` snapshot) used for every staleness comparison AND every `resolved_at`
  stamped that run, so the stored timestamp is exactly the instant the decision was evaluated
  against (the parity invariants depend on this equality). Evaluates ALL incidents from
  durable facts; writes only transitions; no watermark (purity gives re-runnability).
- `index.js` — `assess` job = aggregate → assessIncidents → **applyState** (order
  load-bearing: state keys on the `last_seen` the aggregate just advanced; running last means
  the lifecycle invariants hold at job-rest).
- `db/schema.sql` — `resolved_last_seen TIMESTAMPTZ` (CREATE + idempotent UPGRADE; no
  backfill needed — nothing was ever resolved before this column existed) + CHECK constraints
  on `state` and `resolved_reason` (the round-2 M1 at-rest pattern, added unprompted;
  negative-tested live: `state='closed'` and `resolved_reason='manual'` both rejected).
- `integration/rep_determinism.js` — **the recorded Phase 4 landmine, discharged FIRST**
  (before any state code existed): the TRUNCATE-and-restore design is retired for a
  single-transaction + forced-ROLLBACK design. Nothing commits, so history-dependent state is
  untouched by construction and a crash mid-test auto-rolls-back. No watermark manipulation
  remains (rollback discards everything), so it takes no `pipeline_state` locks — no deadlock
  surface against a concurrent aggregate; a cron tick mid-test blocks on the TRUNCATE's
  ACCESS EXCLUSIVE lock for seconds instead of interleaving.
- `integration/assess_parity.js` — the Phase 5 boundary move: `action_*`-only for the
  never-written check, plus per-row LIFECYCLE INVARIANTS asserted from independent facts:
  state non-NULL and engine-writable; open ⇒ no resolved_*; resolved ⇒ complete resolved_*,
  reason in vocabulary, `last_seen ≤ resolved_last_seen`; recurring ⇒ prior-resolution
  history AND `last_seen > resolved_last_seen`; `auto_recovery` ⇒ an oracle success after the
  memento still exists (append-only); `stale` ⇒ `resolved_at - resolved_last_seen` > 7 days.
- Tests: `test/state.test.js` (33 new; 147 total) — the full transition table incl. the
  producer-clock-skew re-open case, strict boundaries, precedence, engine-states sweep.
- Docs: `docs/incidents-schema.md` (state/resolved_at/resolved_reason/resolved_last_seen
  rows), `markdown/PROMPTS.md`. Also backfilled the `Git Commit:` field on all five prior
  PHASE_LOG entries (they all read "Pending"; the field exists to link record to code and
  never did).

## Schema Facts Confirmed (live DB)

Step 2 re-measurement (2026-07-17; the re-evaluation's numbers were 2026-07-16):

- 509 incidents (was 504 — cron-live). Oracle: 97,551 rows, `capture_datetime` **0 nulls**,
  all five streams current. Day-one recovery set: **169**. Quiet recency: active 406 /
  1–3d 50 / 3–7d 40 / >7d 13.
- Recovery lookup plan: seq scan + hash aggregate, cost ~3.1k — trivial once per run.
- Grants: `incident_engine_rw` has SELECT on `stats.acquisition_history` and UPDATE on the
  new column; **no new grant needed** (proven by execution as the role, then explicitly).
- **DEPLOYMENT-MODEL FACT (new, important):** `docker-compose.yaml` mounts `./:/workspace`
  and the cron `cd`s into this directory — **the cron executes whatever is checked out in
  the working tree**, committed or not. Phase 5 branch code went live at the first cron tick
  after checkout, exactly as Phase 4's did during its development (unnoticed then). Recorded
  in the handoff as a review question: acceptable dev-on-prod discipline, or does deploy need
  pinning to a committed ref?

## Important Decisions

The load-bearing design decisions were made in the Step 3 re-evaluation (committed
`77df163`, developer-approved): entity-keyed auto-close, `recurring` = re-opened-only,
staleness close at 7 days, `capture_datetime` over `inserted_at`, the `resolved_last_seen`
same-clock-domain re-open. Implementation-time decisions on top:

### `nextState` is synchronous on purpose

Decision: sync signature, tested to return a non-Promise.
Reason: `assess()` is async so an advisory LLM can slot in; lifecycle is the opposite — no
advisory implementation may ever drive state (Determinism Rule), and the sync signature makes
that promise structural rather than conventional.
Tradeoff: none foreseen; changing it would be a deliberate signal worth reviewing.

### A NULL-state incident that is already closeable resolves in ONE evaluation

Decision: initialization is defaulting (`NULL` treated as `open`), composed with the same
run's close evaluation — the 169 day-one closes did not wait a cron cycle at `open`.
Tradeoff: the backlog never observably passes through `open`; accepted, the state field is
current reality, not a journal.

### A resolved row WITHOUT its memento re-opens (fail-visible)

Decision: `resolved_last_seen IS NULL` on a resolved row (predates Phase 5, or a foreign
write) ⇒ `recurring`.
Reason: an unverifiable close must not mask recurrences forever — the same direction as the
assessor's provenance gate. Unreachable at rest today (nothing was resolved before Phase 5).

### An unrecognized state string is left alone

Decision: not clobbered, no transition; it surfaces in the run summary's counts.
Reason: never overwrite a value we don't understand. Now ALSO impossible at rest (CHECK
constraint), so this is pure-function defense in depth.

### CHECK constraints on `state` and `resolved_reason` (unprompted hardening)

Decision: vocabulary enforced at rest, mirroring the round-2 M1 pattern before a reviewer
asks. A future human surface adding a state/reason must widen the constraint in a deliberate,
logged phase — that friction is the point.

## Architecture Notes

- **Write-isolation / least-privilege:** state writes go through the two dedicated
  ColumnSets (no severity/assessment/action_* columns to write); oracle SELECT-only; no new
  grant. The engine can only produce open/recurring/resolved — pinned by `ENGINE_STATES`,
  the unit sweep, the parity invariant, AND the DB CHECK.
- **Idempotency:** no watermark; re-run writes 0 (proven). `resolved_at` stamped once per
  transition, never refreshed (proven by the no-op re-run).
- **Determinism:** transitions are a pure sync function of durable facts + one supplied
  clock reading. Auto-close ordering compares producer-clock `capture_datetime` against
  producer-clock `last_seen`; re-open compares producer-clock `last_seen` against the
  producer-clock memento. No cross-domain comparison remains.
- **Fingerprint/classifier:** untouched. `FP_VERSION` 1; assessor untouched (its parity
  identity still holds bit-exact).
- **Deployment:** no new deploy surface; superuser step = re-apply `db/schema.sql` (new
  column + 2 constraints) before running this code. Plus the working-tree-is-live fact above.

## Validation

Commands run:

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test              # 147/147 (33 new)
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql # column + constraints; re-applied idempotently
docker compose run --rm app node index.js assess                     # first state run
docker compose run --rm app node index.js assess                     # re-run: 0 written
docker compose run --rm app node index.js run                        # full cron path
docker compose run --rm app node integration/rep_determinism.js      # reworked: PASS, rollback verified
docker compose run --rm app node integration/assess_parity.js        # PASS incl. lifecycle invariants
# constraint negative tests; grant checks; EXPLAIN of the recovery lookup
```

Results:

- **147/147** unit. First state run: 509 evaluated / 509 written — **335 opened /
  169 auto_recovery / 5 stale / 0 reopened**. The 169 matches the Step 2 day-one measurement
  exactly; the 13 quiet->7d split 8 auto_recovery + 5 stale (precedence observed working).
  The 5 stale closes are all genuinely 8–10 days quiet (`Delta is negative value`,
  `datetime object null`, …). Re-run: **0 written**, all transition counts 0. Full `run`
  exit 0; exactly-once delta 0 (Phase 3 invariant intact).
- `rep_determinism.js` (reworked): comparison PASS AND rollback restored the table —
  0 unassessed afterwards, parity green immediately after.
- `assess_parity.js`: PASS across 509 incl. every lifecycle invariant; state distribution
  335 open / 174 resolved.
- Constraints negative-tested (`state='closed'`, `resolved_reason='manual'` → both
  rejected); schema re-apply clean.
- **Natural re-open OBSERVED LIVE, ~35 minutes after the first state run**: the producers'
  next burst delivered new failure events for 4 previously-resolved incidents, and the state
  step re-opened all 4 as `recurring` (`{"reopened":4}` in the run summary; distribution
  335 open / 165+5 resolved / 4 recurring). Parity's lifecycle invariants PASS over them
  (prior-resolution history kept; `last_seen > resolved_last_seen`). Re-open is therefore
  verified against real data, not only the unit suite — and this is the flap set doing
  exactly what the re-evaluation predicted (close→re-open cycles surfacing as `recurring`
  rather than churning silently). These 4 will likely re-close on a future recovery — the
  two-cycle rhythm is the §5.3 handoff question.

## Review Notes

Source:

- `notes/review_results_phase_5.md` — pending; the developer runs the review from
  `notes/codex_handoff_phase_5.md`.

Critical issues:

Verdict: 1 high, 2 medium — all three real (verified independently before fixing).

- **F1 (high) — cross-producer recovery evidence.** Recovery grouped by system_id only, so
  a data_acquisition (mmb) success closed hhm_rpp_* incidents on the same system: 30 false
  closes live, and ALL FOUR of the "natural re-opens" this entry originally celebrated were
  artifacts of those false closes flapping. Decisive fact (run_id join): every oracle
  stream — including `philips`/`hhm` — is written by data_acquisition; the oracle is its
  self-record. Root cause mine: the re-evaluation measured "reachable by producer" and read
  reachability as coverage without asking WHOSE successes those were — the Phase 4 F1
  family (identifier match treated as semantic evidence). FIXED: `ORACLE_SCOPED_APPS`
  gate in the pure function (fail-safe on unknown src_app; re-open ignores scope), parity
  scope invariants, and an idempotent remediation in db/schema.sql (UPDATE 30 → the fixed
  engine re-decided: 29 open, 1 stale; incident 17157 honestly open).
- **F2 (medium) — id-only state updates race their facts.** A row changed between read and
  write (future human sets suppressed; concurrent aggregate advances last_seen) would be
  overwritten by a decision made against old facts — disproving "suppressed is
  engine-terminal" as stated. FIXED with the optimistic arm: prev_state/prev_last_seen/
  prev_resolved_last_seen as cnd columns, `IS NOT DISTINCT FROM` matching, skipped rows
  counted + WARN-logged, convergence next run. No locks held across JS compute.
- **F3 (medium) — the working-tree cron (my §5.6 flag, now a finding).** FIXED repo-side:
  `DEPLOYMENT.md` "Deploy boundary" section with the dedicated-worktree runbook
  (`/opt/apps/incident-engine-deploy` pinned to reviewed refs; cron pointer moves; dev tree
  keeps its mount). The one-time step needs root — **pending developer action**. Until
  then: a `git checkout` here IS a production deploy.

Post-fix validation: 153/153 unit (6 new scope tests incl. the 17157 regression verbatim);
re-run 0 written / 0 skipped; parity + lifecycle + scope invariants PASS; distribution
**363 open / 141 resolved (135 auto_recovery + 6 stale) / 5 recurring** — every
auto_recovery row is data_acquisition, and the 5 recurring are genuine data_acquisition
flaps (the live re-open proof survives, now on valid closes). Full record:
`notes/review_results_phase_5.md`; delta handoff for re-review:
`notes/codex_handoff_phase_5_fixes.md`.

Round 2 (re-review): F2 closed; F1 partially — one residual medium, FIXED: `RECOVERY_SQL`
scoped the consumer but not the evidence pool, so a future producer writing the oracle
could falsely close data_acquisition incidents. Now a provenance semi-join admits only
rows whose run_id links to a data_acquisition run (14-day-bounded, partition-pruned), with
a fail-closed audit (`foreign_rows`/`unlinked_rows`, WARN when non-zero; live 0/0), parity
provenance-verified evidence + a foreign-row failure assertion, and loader-guard landmarks
pinning the semi-join. 156/156 unit; re-run 0. F3 not closed operationally — see below.

Deferred findings:

- **F3 infra step: DONE (2026-07-17, post-merge, developer-delegated).** It turned out to
  need no root at all — the cron line lives in the operating user's crontab and /opt/apps
  is docker-group-writable. `/opt/apps/incident-engine-deploy` created as a git worktree
  pinned to the reviewed merge commit `8307bd5`; `.env` copied; the crontab's one line
  re-pointed (full backup at `~/crontab.backup.20260717-140908`; diff verified to be
  exactly that line before install). Proven by running the exact cron command from the
  deploy worktree (exit 0, self-log written); the next :25 tick CONFIRMED it (self-log
  14:25:04, clean exit, a working run: 10 re-opens + 3 recovery closes).
  One incident during install: a mangled temp path made the first `crontab <file>`
  invocation fail — the existing crontab was verified untouched before retrying via a
  short path. From now on a `git checkout` in the dev tree touches nothing in production;
  deploys are the two-command runbook in DEPLOYMENT.md §Deploy boundary. **Final verdict
  received: F1 closed, F2 closed, F3 CLOSED (post-deploy smoke passed) — Phase 5 fully
  closed.**

## Problems Encountered

- **Wrote SQL-style `--` comment lines inside a JS block comment** in the first cut of
  `utils/db/queries/recovery.js` — invalid JavaScript, `require()` would have thrown.
  Caught on immediate re-read, and it is EXACTLY the class `test/sql-modules-load.test.js`
  exists for (the guard was run right after the fix: 13/13). The Phase 3/4 template-literal
  backtick lesson, third variant.
- A garbled self-comparison assertion in a new unit test (caught by the suite failing, fixed).

## Follow-Up Tasks

- Codex review of this phase (handoff ready); iterate; then commit.
- **Watch the first natural re-open** (expected within cron cycles; the `recurring` count in
  the state step's run summary + parity invariants will show it).
- **The classification phase is NEXT** (queued, developer-ordered): classify the confirmed
  hard-failure messages out of `unknown`; remove/update the interim-M2 reason string; bump
  `RULES_VERSION`.
- The `acknowledged`/`suppressed` human surface (dashboard) remains future; adding any new
  state/reason now requires a deliberate constraint widening (see Decisions).
- Decide whether the working-tree-is-live cron model needs hardening (pin deploys to a
  committed ref?) — surfaced this phase, not resolved.
- Open decisions unchanged: acquisition-v2 onboarding, self-ingestion, retention.

## Commit Readiness

- Requirements implemented: yes — per the revised prompt (all five supersessions honored).
- Write-isolation / least-privilege rules hold: yes — dedicated ColumnSets; oracle
  SELECT-only; no new grant; proven live as `incident_engine_rw`.
- Jobs idempotent: yes — re-run writes 0; `resolved_at` stamped once; no watermark by design.
- Assessment/lifecycle deterministic (no LLM): yes — pure SYNC transition function; engine
  can only write open/recurring/resolved (four independent enforcement layers).
- Source queries warn_error_logs-only / partition-pruned: n/a this step (reads own table +
  the BRIN-indexed oracle; EXPLAIN'd).
- Schema assumptions confirmed live: yes (Step 2 re-measured; oracle facts verified).
- Review findings addressed or deferred: **three rounds complete** — 1 high + 2 medium
  (round 1), 1 residual medium (round 2), clean (round 3). F1/F2 + residual: fixed,
  re-validated live, verdicted CLOSED. F3 (deploy worktree/cron): runbook written,
  root-requiring infra step deliberately sequenced AFTER commit+merge so the worktree
  lands on the reviewed ref — the phase's single open item, and it is operational, not
  code.
- Validation recorded: yes (incl. reviewer-verified: 0 foreign / 0 unlinked oracle rows,
  0 unscoped auto_recovery, 156/156, parity across 509).
- Ready to commit: **yes.**

---

# Phase 4 — Deterministic Assessor (L3)

Date:
2026-07-16

Status:
Completed

Prompt:
`prompts/prompt_4_deterministic_assessor.txt` (revised 2026-07-16 pre-implementation, FLOW
Step 3 — `notes/phase_4_reevaluation.md`)

Git Commit:
`f5d62ed`

Review Artifacts:

- Codex handoff (round 1): `notes/codex_handoff_phase_4.md`
- Review results (round 1): `notes/review_results_phase_4.md` (1 high, 2 medium — all three
  confirmed against live data + producer source, all three fixed and re-validated live)
- Codex handoff (fix round, delta): `notes/codex_handoff_phase_4_fixes.md`
- Codex handoff (fix round 2, delta): `notes/codex_handoff_phase_4_fixes_round_2.md`
- Review results (round 3): `notes/review_results_phase_4.md` §round 3 (**converged** — no
  high/medium, 2 low, both fixed: a misdirecting remediation action on the invalid-provenance
  branch, and five current-contract passages still describing the superseded type policy.
  All prior findings verdicted closed; M1's degraded mode and RULES_VERSION=1 formally
  accepted)
- Review results (round 2): `notes/review_results_phase_4.md` §round 2 (2 medium + 1 low +
  a count correction; round-1 judgment calls all resolved clean. M1 provenance-fails-quiet
  and L1 entity-scoped parity check: fixed. M2 `unknown`+WARN → info: **escalated to the
  developer** — the one open decision before commit)
- Step-3 re-evaluation (pre-implementation): `notes/phase_4_reevaluation.md`

## Goals

- Assess every incident deterministically — severity / confidence / reasons / recommended
  action — via a **pure** `assess(dossier)` behind a pluggable `ASSESSOR_KIND` seam a future
  LLM could implement without reworking the pipeline.
- Cover the WHOLE classifier vocabulary with reasoned severities; no dead branches.
- **Non-goals (held):** no LLM implementation (seam only); the assessor must NOT set
  incident `state` or auto-close (Phase 5); no writes outside `incidents`; identity domain
  (`normalize.js`/`fingerprint.js`/classifier table) untouched — `FP_VERSION` stays 1.

## Built

- `domain/assessor/contract.js` — JSDoc typedefs (`Dossier`, `AssessResult`) + frozen
  `SEVERITY`/`EVENT_TYPE`. The `AssessResult` shape carries **no** `state`/`resolved_*`:
  the Phase 5 boundary is structural, not a convention.
- `domain/assessor/rules.js` — the deterministic impl. Pure, async from day one. Dispatches
  on the taxonomy's OWN fields (`manual_intervention`, `successful_acquisition`,
  `error_type`) built into a category→flags map from `connection_regex.js` at require time,
  never a hand-listed set of slugs. `RULES_VERSION = 1`; `BLAST_RADIUS_ENTITIES = 22`.
- `domain/assessor/index.js` — the seam. `resolveKind(env)` is pure and exported so the
  SELECTION is unit-testable; the registry is the allowlist (an unknown `ASSESSOR_KIND`
  throws rather than silently defaulting); `getAssessor()` returns `{kind, version, assess}`.
- `jobs/assess/index.js` — the assessment step (runs after `aggregate` in the `assess` job).
  Holds ALL the I/O: assembles a plain dossier per incident, `await assess(dossier)`, writes
  back only rows whose result changed. Resolves the impl once per run.
- `utils/db/queries/assess.js` — the dossier SELECT (incl. the fingerprint-level
  `entity_count` rollup) + the update predicate.
- `utils/db/sql/pg-helpers.js` — new `incidents_assessment` ColumnSet: **exactly** the
  assessment columns, so the write surface is enforced by the ColumnSet rather than by care.
- `db/schema.sql` — `incidents.incidents.type VARCHAR(8)` + `assessor_version SMALLINT` in
  CREATE + an idempotent Phase 4 UPGRADE (ADD IF NOT EXISTS + backfill), mirroring the
  Phase 3 `entity` precedent. The backfill is guarded by a `DO` block that RAISEs if any
  fingerprint ever carries >1 type.
- `utils/db/queries/incidents.js` — the Phase 3 aggregate now writes `type`
  (`COALESCE(inc.type, EXCLUDED.type)` on conflict: fingerprint-invariant, and self-healing).
- `index.js` — `assess` job = `aggregate` → `assessIncidents` (order is load-bearing).
- Tests: `test/assessor-rules.test.js` (44 new; 93 total) + `integration/assess_parity.js`
  (live DB, not discovered by `node --test`).
- `integration/rep_determinism.js` (Phase 3) — **fixed a footgun this phase created**: it
  TRUNCATEs `incidents.incidents` and restored only the aggregation, so from Phase 4 onward a
  bare run silently blanked every incident's severity. Its restore now re-assesses via the
  real `jobs/assess` (driven with an in-memory run_log stub, so it still writes no log file or
  self-log row). See Problems Encountered.
- Docs: `docs/error-taxonomy.md` (category count corrected 19→20; the `assess` section
  rewritten to the real rules), `docs/incidents-schema.md` (`type`/`assessor_version`;
  `error_type` `''` count corrected ~39→253), `utils/db/queries/enrichment.js` (19→20),
  `markdown/PROMPTS.md`.

## Schema Facts Confirmed (live DB)

Superuser, `staging`, 2026-07-16. The pipeline is cron-live (`25,55`), so these move.

- 504 incidents / 82 fingerprints / 228,490 L0 events; `severity`/`state` NULL on all 504
  before this phase.
- **0 fingerprints carry both types** — `type` is inside the fingerprint, so denormalizing it
  onto `incidents` is lossless. Re-proved by `db/schema.sql` on every apply.
- `apps[]` / `systems[]` max length = **1**, confirming the prompt's blast-radius clause was
  structurally dead (the Step-3 finding).
- **The taxonomy holds 20 distinct `error_category` values, not 19** (22 with the caller-set
  `unknown` / `hanging_exec`). Every doc, the prompt, and `notes/phase_4_reevaluation.md`
  said 19. Nobody had counted. Zero categories carry inconsistent flags across their
  multiple entries (which is what makes the first-entry-wins map well-defined).
- **`error_type` is `''` on 253 of 504 incidents, not ~39.** The Phase 3 record's ~39 counted
  only the oracle-corroborated rows and missed that every `unknown` incident carries `''`
  too. Half the table. This is what makes "key on `category`" load-bearing rather than a nicety.
- **`permission_denied_partial` carries BOTH `manual_intervention: true` and
  `successful_acquisition: true`** — the only such category, and a head-on collision between
  two of the prompt's rules.
- Blast radius (entities per fingerprint): 1..59; 43 of 82 fingerprints are single-entity;
  the wide tail is 22/27/40/42/42/46/59. Live fleet = **221 distinct entities**.
- `occurrence_count` does **not** track impact: for `rsync_io_timeout`, `entity_count=1`
  incidents run min 5 / avg 147 / max 428 while `entity_count=59` runs min 1 / avg 214 /
  max 797. The value 428 recurs at nearly every blast radius — it is the cron cadence.

## Important Decisions

### Blast radius threshold = 22 entities (~10% of the fleet)

Decision: `BLAST_RADIUS_ENTITIES = 22`; an ERROR transport fault at ≥22 entities sharing one
fingerprint → `high`, else `medium`. Developer-approved after seeing the measured
distributions.

Reason: chosen as a **principle** (≥~10% of the live 221-entity fleet is one identical
problem ⇒ fleet-wide, not one flaky scanner) rather than reverse-engineered to hit a target
queue size. Thresholds of 10 / 22 / 40 were measured first (183 / 168 / 119 escalated rows).

Tradeoff: **no threshold yields a small `high` queue** — the data genuinely contains a few
very wide fingerprints, and the count is dominated by them at every threshold. At 22, ~150
transport rows land high — but they are only ~4 DISTINCT fingerprints (184 high rows = 16
distinct problems overall). Accepted as honest rather than papered over: severity is
per-incident by design, 59 scanners that cannot rsync IS 59 high incidents, and any operator
view groups by fingerprint. Recorded so a future reader does not "fix" the count by moving
the threshold.

### ~~Severity is type-aware in every family, with a WARN cap on transport~~ — SUPERSEDED (review rounds 1–2)

Original decision (kept for the record, struck because both premises failed review): WARN
never escalates on blast radius; `unknown`+WARN → info; transport+WARN → low;
`manual_intervention`+WARN → medium. Premise: "a WARN means the run continued / the fault
was absorbed."

**That premise is FALSE** (round 1, F2 — the producers log real failures as WARN:
`exec-hhm_data_grab.js:146` returns false on both branches of its WARN path; `JOB HALTED` is
a WARN emitted when the rsync produced nothing). And the surviving `unknown`+WARN → info
split fell in round 2 (M2, developer-decided 2026-07-16).

**Current policy: `type` moves severity NOWHERE.** WARN lowers *confidence* only
(manual_intervention 0.75 vs 0.9; transport 0.6 vs 0.8; file 0.6 vs 0.7; hanging_exec 0.4 vs
0.5); `unknown` → interim medium @0.3 for both types until the confirmed hard-failure
messages are classified out of `unknown` (follow-up phase — see Follow-Up Tasks). The
fail-safe survives: anything not literally `'WARN'` is treated as ERROR. See Review Notes
F2/M2 and the R1 comment in `domain/assessor/rules.js` for the full decision history.

### `successful_acquisition` outranks `manual_intervention` (precedence, not table order)

Decision: the data-acquired rule runs BEFORE the manual-intervention rule.
`permission_denied_partial` (both flags) → `low`, not `high`.

Reason: the prompt's two rules collide on exactly one category. `successful_acquisition: true`
means the data WAS acquired — the pipeline lost nothing — so it must not page as high. But a
human is flagged, so it must not be `info` either. Severity answers "how bad is this?"
(nothing was lost); the recommended action answers "who fixes it?" (a human). `low` is the
only cell satisfying both.

Tradeoff: a human-actionable problem sits in the low queue. Accepted — it is genuinely not
urgent, and the action string carries the instruction.

### Rules dispatch on the taxonomy's fields, never on hand-listed category slugs

Decision: every rule keys on `manual_intervention` / `successful_acquisition` / `error_type`
looked up BY CATEGORY from `connection_regex.js`, built into a map at require time.

Reason: keeps `connection_regex.js` the single source of truth, and a new category added
there inherits a reasoned severity by construction instead of silently hitting the default.
It also fixes the prompt's coverage gap by construction: the prompt hand-listed 4 transport
categories for escalation, but the connection family has **10** — `max_retries`,
`session_timeout`, `rsync_protocol_error`, `http2_cancel`, `connection_refused`,
`partial_transfer_timeout` are the same kind of fault and would have fallen to the default.
Hand-listing is precisely how the prompt came to claim 19 categories and omit the #2 one.

Tradeoff: severity is now coupled to flags owned by `data_acquisition`. Acceptable — this app
already copies that file verbatim, and the unit suite pins the built map against the table.

### `occurrence_count` deliberately does NOT drive severity

Decision: it stays in the dossier (contract + a future LLM impl) but no rule keys on it,
despite the prompt naming it as a key.

Reason: live data says it measures retry chattiness, not impact (see Schema Facts). There is
no monotone relationship with blast radius, and a "singleton ⇒ one-off blip ⇒ downgrade" rule
would be actively wrong: `entity_count=59` incidents include `occurrence_count=1` rows, so it
would downgrade a genuine fleet-wide incident. Confirmed live: a `run` that materialized
~1,000 new events changed no severity — occurrence counts moved, severities did not.

Tradeoff: a chatty single-system problem is not escalated. Correct at this grain; revisit only
with evidence that it tracks impact.

### `assessor_version` column added (developer-approved)

Decision: `incidents.assessor_version SMALLINT`, stamped per row from `RULES_VERSION`,
mirroring the `error_events.fp_version` precedent.

Reason: `assessor_kind` is not provenance — it stays `'rules'` across every rules change, so
a severity produced by a superseded threshold is otherwise indistinguishable from a current
one. This is the first cut of a rules table whose thresholds are expected to move.

Tradeoff: a column that the assess-all design does not strictly need to *trigger*
re-assessment (see below). Kept because provenance ("which rules produced this row?") is
valuable independently, and it is exactly the `fp_version` precedent. Bump `RULES_VERSION`
whenever a rule, threshold, or action string changes.

### DEVIATION: assess ALL incidents every run, not `touched OR severity IS NULL`

Decision: the assess step selects every incident each run and writes back only rows whose
result changed. This departs from the prompt and from `notes/phase_4_reevaluation.md` §6.

Reason: **the prompt's predicate is subtly wrong and would ship a permanent staleness bug.**
`entity_count` is a property of the FINGERPRINT, not of the incident row. When a fingerprint
gains its 22nd entity, that new incident is the only row "touched" — but its 21 siblings just
crossed the threshold too and should re-assess from medium to high. A touched-only predicate
leaves all 21 at medium forever, because nothing will ever touch them again. A row's severity
depends on facts outside that row, so a row-local predicate cannot be correct. The same holds
for a rules change: `touched OR severity IS NULL` never re-assesses an already-assessed
backlog.

Affordable by construction, not by luck: `incidents` is the L2 rollup — bounded by distinct
problems × equipment (504 rows over 228k L0 events), NOT by event volume. Live cost: 20–62ms
for the whole step. The no-op filter keeps `updated_at` from churning every 30 minutes.

Tradeoff: a full scan of `incidents` per run. If that table ever grew to where this hurts, the
fix is a bounded candidate set (touched fingerprints ∪ their siblings ∪ stale
`assessor_version`) — NOT the row-local predicate. Recorded in `utils/db/queries/assess.js`.

## Architecture Notes

- **Write-isolation / least-privilege:** writes are `incidents.incidents` assessment columns
  only, through the `incidents_assessment` ColumnSet (which has no `state`/`resolved_*`
  column to write). No new grant — the role owns `incidents`; proven by the live runs as
  `incident_engine_rw`. `stats.acquisition_history` is not read at all by this step.
- **Idempotency:** no watermark, and none needed — `assess` is a pure function of the
  dossier, so re-runnability is a property of the function rather than of bookkeeping. Proven
  live: re-run → identical md5 over all assessments, `updated_at` unchanged, 504 assessed / 0
  written. The Phase 3 exactly-once invariant still holds after a full `run`
  (`sum(occurrence_count)` == L0 count, delta 0).
- **Classifier / fingerprint stability:** untouched. `FP_VERSION` stays 1; `normalize.js` /
  `fingerprint.js` / `connection_regex.js` unmodified — the assessor only READS the taxonomy's
  flags. The new `type` column is a denormalization of an existing L0 fact, not a new identity
  input.
- **Determinism:** `assess` is pure (no DB handle, clock, network, or env read inside); all
  I/O lives in `jobs/assess`. No LLM implementation exists — the registry has one entry and an
  unknown `ASSESSOR_KIND` throws. The assessor sets no `state` and performs no auto-close;
  asserted live by `integration/assess_parity.js`.
- **Data-contract:** this step reads only `incidents.incidents` (own schema). Never
  `verbose_log`. The aggregate's source scan is unchanged.
- **Deployment:** no new deploy surface (same batch one-shot, same `25,55` cron `run` line).
  **Superuser step required before deploying this code:** re-apply `db/schema.sql` (adds
  `type` + `assessor_version`, backfills `type`). `ASSESSOR_KIND` is a new optional env var
  (default `rules`); documented in `markdown/ENVIRONMENT.md`.

## Validation

Commands run:

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test              # 93/93 pass (44 new)
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql # type+assessor_version, UPDATE 504
docker compose run --rm app node index.js assess                     # first assess: 504 written
docker compose run --rm app node index.js assess                     # re-run: 0 written, md5 identical
docker compose run --rm app node index.js run                        # full cron path: materialize→aggregate→assess
docker compose run --rm app node integration/assess_parity.js        # live parity: PASS
docker compose run --rm app node integration/aggregate_race.js       # Phase 3 regression: PASS
docker compose run --rm app node integration/rep_determinism.js      # Phase 3 regression: PASS
# aggregate INSERT-path proof for `type`, inside a ROLLBACK'd superuser tx (see below)
# EXPLAIN of the new dossier SELECT; has_table_privilege matrix for incident_engine_rw
```

Results:

- **Passed:** 93/93 unit tests. Schema applied idempotently; the mixed-fingerprint guard
  passed; `type` backfilled 504/504 (0 nulls; 175 WARN / 329 ERROR). First assess wrote 504
  rows, `severity`/`confidence`/`assessment` populated, `assessor_kind='rules'`,
  `assessor_version=1` on every row; `state`/`resolved_*`/`action_*` NULL on all 504
  (Phase 5 boundary intact). Re-run: 504 assessed / **0 written**, md5 over all assessments
  identical, `max(updated_at)` unchanged. Full `run`: exactly-once delta **0** (229,532 L0 ==
  `sum(occurrence_count)`), `type` and `severity` complete. `integration/assess_parity.js`
  PASS — every stored assessment byte-identical to a fresh `assess()` of the same row.
- **Severity distribution** (the "did we just relabel the firehose?" review question):

  **After the review fixes** (the pre-fix numbers were high 184 / medium 148 / low 28 /
  info 144 — see Review Notes F1):

  | severity | incident rows | distinct fingerprints |
  | --- | --- | --- |
  | high | 184 | 16 |
  | medium | 319 | — |
  | low | **0** | — |
  | info | **1** | — |

  (Post-round-2/M2. The intermediate state after round 1 was 184/144/0/176; the M2 decision
  moved the 175 unknown-resolved WARN incidents from info to interim medium.) `low` empties
  because every incident that had been rated low was oracle-sourced (F1) and is now correctly
  `unknown`; the surviving info row is the one `rsync_partial` (data acquired). 184 high rows
  = 16 real problems. Provenance: 464 classifier / 40 oracle, 0 NULL — now enforced at rest
  (NOT NULL + CHECK, negative-tested). The swollen medium queue is the M2 decision's accepted
  cost until the classification follow-up phase lands.
- **Failed:** none outstanding. Two defects were found and fixed DURING validation — both
  invisible to the unit suite (see Problems Encountered).
- **Not run:** a fault-injected demonstration of the sibling-staleness bug the assess-all
  design prevents (reasoned + covered by the unit boundary test, not staged against live
  data). No LLM impl exists to test the seam against a second implementation.

Manual / smoke tests:

- Spot-checked a fleet-wide `high`: `SME01107` / `rsync_io_timeout`, reasons name the
  transport family, the ERROR label, and "blast radius: 27 entities … at or above the
  22-entity threshold (~10% of the fleet)". Reads as an operator explanation, not a label.
- Spot-checked the `credentials` split: ERROR → high @0.90, WARN → medium @0.70, both with
  "Update the stored credentials for this host, then re-run."
- The run summary self-logs `severity_counts` + `unresolved_categories` (empty live), so a
  taxonomy gap surfaces in the logs rather than hiding behind a severity.
- **The aggregate's `type` INSERT path was proven separately.** All 504 live incidents already
  existed, so they got `type` from the UPGRADE *backfill* — the aggregate's `INSERT` column
  only fires for a brand-new `(fingerprint, entity)`, which no run happened to produce. Proof
  without mutating live data: inside a **ROLLBACK'd** superuser transaction, delete one
  incident and re-run the REAL `UPSERT_INCIDENTS_SQL` (emitted from the module, not retyped)
  over an all-time window → the row is re-INSERTed with `type='WARN'`, matching its pre-delete
  value. Rolled back; live data verified unchanged (504 rows, 0 null types).
- Phase 3's `integration/aggregate_race.js` and `rep_determinism.js` both still PASS — this
  phase modified their upsert, so they are regression coverage, not decoration.
- `EXPLAIN` of the new dossier SELECT: two seq scans + a hash join over `incidents`, total cost
  ~106 (the deliberate assess-all full scan; the table is 504 rows). No index needed at this
  size and none added.
- Grant matrix re-confirmed: `incident_engine_rw` has SELECT-only on `util.app_run_logs` and
  `stats.acquisition_history` (UPDATE = false on both) and full DML on `incidents.incidents`,
  incl. the two new columns. **No new grant was needed** — the role owns the schema.

## Review Notes

Source:

- `notes/review_results_phase_4.md` (Codex, from `notes/codex_handoff_phase_4.md`).

Critical issues:

Verdict "needs fixes": 1 high, 2 medium. **All three verified independently before fixing —
all three real.**

- **F1 (high) — oracle-only categories drove incorrect assessments.** The rules keyed on
  `incidents.category` without regard for where it came from. Phase 3 fills an `unknown`
  category with the latest non-unknown category for the same `system_id` — time- and
  run-uncorrelated. Live: **40 incidents whose assessed category appears in ZERO of their own
  L0 events**. `No new monitoring data found.` was rated `rsync_io_timeout`; `missing host_ip`
  likewise; `File not present` → `host_unreachable`; four `No new file data` → `credentials`.
  `enrichment.js` had said "advisory only" since Phase 3 — and nothing enforced it, while
  `docs/incidents-schema.md` simultaneously reassured the reader that "`category` is always a
  valid classifier category" (true of the string, irrelevant to whether it describes THIS
  incident). The first consumer of an unenforced advisory field consumed it as evidence.
- **F2 (medium) — WARN does not mean the operation succeeded.** Several branches asserted
  "the run continued / the fault was absorbed" and capped severity. The producers refute it:
  `exec-hhm_data_grab.js:146` logs a connection error **WARN** then `return false`s on both
  branches (the success path is the one passing `successful_acquisition: true`), and
  `JOB HALTED` (~28k events) is a **WARN** emitted when the rsync produced nothing and the job
  returns. I flagged this exact assumption in the handoff (§5.5) and shipped it without
  reading the producers — flagging is not verifying.
- **F3 (medium) — the parity test shared the query it verified.** It imported the production
  `SELECT_DOSSIERS_SQL`, so a wrong dossier is reproduced identically on both sides. F1 proves
  it: PASS across 504 while 40 were being assessed off unrelated categories. I named this risk
  in the handoff (§5.2) too.

Accepted fixes (all three; detail in `notes/review_results_phase_4.md`):

- **F1**: persist provenance — the reviewer's PRIMARY suggestion, not the interim detector.
  New `incidents.category_source` (`classifier` | `oracle`), derived by the aggregate **from
  the enrichment join itself** and refreshed under the identical ON CONFLICT guard as
  `category`. New **R0** in `rules.js` assesses anything not explicitly `classifier` as
  `unknown` (fail-safe: NULL/garbled ⇒ untrusted), surfacing the discarded category in the
  reasons. The interim detector (`category <> 'unknown' AND error_type = ''`) was rejected for
  runtime use: it is exact only until the **already-tracked** "populate `error_type` on
  corroborated rows" follow-up lands, at which point it silently stops matching and the high
  bug returns with no test failing. It is used once, in the backfill, where the join cannot be
  replayed. → 32 severities changed; **high 184 / medium 144 / info 176** (low → 0), matching
  the reviewer's predicted numbers exactly.
- **F2**: WARN now costs **confidence, never severity** — no branch caps on it
  (manual_intervention+WARN medium→**high** @0.75; transport+WARN low→**blast-radius split**
  @0.6; file+WARN low→**medium**; hanging_exec+WARN low→**medium**). Every recovery claim
  removed from the reason strings, replaced with the fact. A test sweeps all 22 categories ×
  WARN and fails on any reason matching `/absorbed|run continued|survived/i`. **Live impact:
  zero rows** — every transport/manual-intervention WARN incident turned out to be
  oracle-sourced (F1), so the caps were live dead code. Luck, not design: the first genuine
  classifier-backed WARN transport incident would have been mis-rated.
- **F3**: parity test rewritten with **independent SQL** — correlated `count(DISTINCT entity)`
  instead of the job's CTE; `type` read back from L0; `category_source` cross-checked against
  L0 (a `classifier` category MUST appear in the incident's own events, an `oracle` one must
  NOT); an oracle category must resolve to `unknown`. The file now carries an explicit
  independence rule: importing from `utils/db/queries/assess.js` is the bug it detects.

Found while fixing (not raised by the review):

- **A backtick inside the SQL template literal broke `require()` — the identical defect Phase 3
  hit, in the same file** (PHASE_LOG Phase 3 §Process note). `node index.js assess` died at
  require time with **101/101 green**, because no unit test loads a SQL module. Twice is a
  pattern and "remember not to type a backtick" is not a control → added
  **`test/sql-modules-load.test.js`**: requires every SQL-owning module, asserts exports are
  non-empty backtick-free strings, plus structural landmarks. **Verified by re-injecting the
  real bug (guard fails) and removing it (passes).** It would have caught both incidents.

Deferred findings:

- `pg_column_sets.incidents.incidents` is **dead code** (noticed this phase): the Phase 3
  aggregate is set-based SQL and never formats against it, so nothing enforces that it
  matches the table. Kept accurate (`type` added) rather than deleted — removing a Phase 3
  artifact is outside this phase. Flagged in the handoff.
- `error_type` on oracle-corroborated rows is still `''` (the Phase 3 follow-up). Phase 4 no
  longer *needs* it (rules key on `category`), which lowers its priority but does not close
  it — the column is still half-empty and still misleading to any future consumer.

## Problems Encountered

- **The prompt's assess-scope predicate is incorrect** (`touched OR severity IS NULL`).
  Resolution: implemented assess-all + no-op-write filter; reasoned in
  `utils/db/queries/assess.js` and in Important Decisions above. This one is a design bug in
  the phase spec, not a mistake in it being followed.
- **Three assertions repeated across the docs were simply wrong**, and none had been checked:
  "19 categories" (it is 20 / 22), "`error_type` is `''` on ~39 rows" (253), and the implicit
  assumption that `manual_intervention` and `successful_acquisition` never co-occur (they do,
  on `permission_denied_partial`). Resolution: verified in Step 2, corrected in the docs, and
  pinned by unit tests so they cannot drift silently again. Same failure mode as the Phase 3
  taxonomy correction (commit 747e0cc): a confident claim nobody counted.
- **A 42601 syntax error on the very first live `assess` run, with a green 93/93 suite.**
  `updated_at = clock_timestamp()` was appended to the string returned by
  `pgp.helpers.update()`, which lands AFTER the `FROM (VALUES …) AS v` clause — a SET
  assignment cannot go there. Resolution: `updated_at` moved into the `incidents_assessment`
  ColumnSet (raw `mod: '^'`), and the query file now says only the WHERE predicate may ever be
  appended. **Exactly the Phase 3 lesson** — `node --test` never loads the SQL modules, so
  only running the job could catch it.
- **A grammar bug in operator-facing text** ("1 entity share this fingerprint"), visible only
  by reading the rows the job actually wrote. Fixed; the 25 affected single-entity rows
  re-converged on the next run (which is itself a live demonstration of the no-op filter and
  the re-assess path working).
- **This phase turned a Phase 3 integration test into a destructive one, and the validation
  step itself tripped it.** `integration/rep_determinism.js` TRUNCATEs `incidents.incidents`
  and restores "a correct full aggregation" — which was a COMPLETE restore in Phase 3, when
  aggregation was everything the table held. Phase 4 added assessment columns the aggregate
  does not write, so running it (as the review checklist's regression step) silently blanked
  the severity of all 504 incidents. Caught only because `integration/assess_parity.js` was
  run afterwards and reported `never-assessed: 504` — a checklist pass would have looked
  green. Resolution: the test's restore now calls the real `jobs/assess`, verified by running
  it and re-checking parity (504 assessed, identical distribution). **Note for Phase 5:** the
  restore works only because assessment is a pure function of L0-derived facts. Lifecycle
  `state`/`resolved_*` will NOT be re-derivable that way, so that TRUNCATE becomes genuinely
  lossy and the test needs reworking (snapshot-and-restore or a scratch table), not another
  patch. Flagged in the test header.

## Follow-Up Tasks

- Codex review of this phase (handoff ready); iterate on findings; then commit.
- Phase 5 (`prompt_5_state_autoclose.txt`): lifecycle state + deterministic auto-close via the
  `successful_acquisition` recovery oracle. **The assessor must stay out of it** — `state` is
  Phase 5's alone. Note that `severity` is now available as an input to state decisions.
- If/when the rules table changes: bump `RULES_VERSION`. The assess-all design re-assesses
  automatically on the next cron run; `assessor_version` makes the change detectable in the
  data.
- **DECIDED (developer, 2026-07-16, round-2 M2): `unknown`+WARN → interim MEDIUM.**
  175 incidents / 148,429 events (round 2 corrected an earlier "176 (~145k)" — that swept in
  the one `rsync_partial` info incident) were at info + "No action" although the bucket
  contains confirmed hard failures (`JOB HALTED` 28,291 events; `NO TUNNEL FOUND` 13,394).
  Options weighed: interim medium (chosen — reviewer's explicit fallback; honest severity,
  swollen medium queue ~319 until classification); interim low (cleaner queue, still
  type-reduced); classify now (the real fix, but edits the frozen `data_acquisition`-owned
  classifier — a declared non-goal); keep info (reviewer on record against). Applied live:
  175 rewritten → **high 184 / medium 319 / info 1**; re-run 0.
- **QUEUED FOLLOW-UP PHASE: classify the confirmed hard-failure messages out of `unknown`.**
  Round-3 requirements folded in: that phase must also REMOVE/UPDATE the interim-M2 reason
  string in `rules.js` R1 (it claims "medium until these messages are classified" — stale the
  moment they are) and **bump `RULES_VERSION`**.
  The durable M2 fix. Candidates: `JOB HALTED`, `NO TUNNEL FOUND`, the missing-data and
  ENOENT/TypeError families — each needs its producer context read (the way F2 was verified)
  to decide failure-vs-status per message. `error_category` is NOT in the fingerprint, so new
  patterns re-label without re-bucketing and `FP_VERSION` is untouched; existing incidents
  pick the new category up as fresh events refresh the representative (JOB HALTED recurs every
  cron cycle, so convergence is fast). It IS a deliberate divergence of our copied
  `connection_regex.js` from `data_acquisition`'s production vocabulary — coordinate or
  upstream it. When it lands, the medium queue deflates and `unknown` shrinks to genuinely
  unrecognized messages.
- **Populate `error_type` on oracle-corroborated rows** (the Phase 3 follow-up) is now
  LOWER value and HIGHER risk than it looked: Phase 4 keys on `category` + `category_source`,
  so nothing needs it — and the `db/schema.sql` Phase 4 backfill uses
  `error_type = ''` as its one-time oracle signature. Landing that follow-up would make the
  BACKFILL a no-op on any database that had not yet run it. Runtime provenance is derived from
  the join and is unaffected, but re-read that backfill comment before doing it.
- Consider whether `critical` should ever be emitted. Declared but unused — nothing in the
  taxonomy currently distinguishes a worse-than-fleet-wide fault. Left reserved deliberately.
- Watch the `high` queue against operator reality: 184 rows / 16 problems is defensible at
  this grain, but it is the phase's most debatable call and the first thing to revisit once
  anyone actually *uses* the queue (an `ops-dashboard` incidents view grouping by fingerprint
  is the natural consumer).
- Open decisions unchanged: acquisition-v2 onboarding, self-ingestion, retention.

## Commit Readiness

- Requirements implemented: yes — per the revised prompt, plus three Step-2 corrections and
  one reasoned, documented deviation (assess-scope).
- Write-isolation / least-privilege rules hold: yes — assessment columns only, enforced by the
  ColumnSet; no new grant; proven live as `incident_engine_rw`.
- Jobs idempotent (watermark + ON CONFLICT): yes — purity gives re-runnability without a
  watermark (re-run: 0 written, md5 identical); Phase 3's exactly-once invariant still holds
  after a full `run` (delta 0).
- Assessment deterministic (no LLM in critical path): yes — `assess` is pure and unit-tested;
  no LLM impl exists; an unknown `ASSESSOR_KIND` throws; the assessor writes no `state`
  (asserted live).
- Source queries read warn_error_logs only, partition-pruned: n/a this step (reads own
  `incidents.incidents`); the aggregate's scan is unchanged.
- Schema assumptions confirmed live: yes — and three documented assumptions were found FALSE
  and corrected (see Schema Facts).
- Review findings addressed or deferred: **two rounds complete** (Codex). Round 1: 1 high + 2 medium, all fixed. Round 2 (re-review of the fixes): 2 medium + 1 low — M1 (provenance fails quiet → NOT NULL + CHECK at rest, three-way LOUD gate in R0, negative-tested live) and L1 (parity provenance check now scoped to the full (fingerprint, entity) key — 9 live mixed-category fingerprints made this real) fixed; count corrected (175/148,429, not 176/~145k). M2 (`unknown`+WARN → info on confirmed halts) was decided by the developer (2026-07-16): interim medium for both types; classification follow-up phase queued.
- Validation recorded: yes, incl. the two defects found by running the job rather than the
  tests.
- Ready to commit: **yes** — three review rounds, converged (1 high + 2 medium → 2 medium + 1 low + 1 developer decision → 2 low; every finding fixed, decided, or formally accepted). All validation green: 114/114 unit; independent parity PASS; re-run 0; exactly-once delta 0; constraint negative-tested. The classification follow-up phase is queued (with the round-3 reason-string + RULES_VERSION requirements), not blocking.

---

# Phase 3 — Aggregate Incidents (L1/L2)

Date:
2026-07-15

Status:
Completed

Prompt:
`prompts/prompt_3_aggregate_incidents.txt`

Git Commit:
`444e33a`

Review Artifacts:

- Codex handoff (round 1): `notes/codex_handoff_phase_3.md`
- Review results (round 1): `notes/review_results_phase_3.md` (1 high, 1 medium,
  2 low — all fixed and re-validated live)
- Codex handoff (fix round, delta): `notes/codex_handoff_phase_3_fixes.md`
- Review results (round 2, re-review): `notes/review_results_phase_3.md` (§round 2 —
  1 medium clock-assumption + stale comments, 1 low whitespace-trim; both addressed;
  F2/F3 confirmed closed)
- Review results (round 3, independent self-review): `notes/review_results_phase_3.md`
  (§round 3 — no high/medium; 4 low; #1 backfill-trim + #3 corroborated-type-doc fixed,
  #2 noted, #4 left; a backtick-in-template-literal bug introduced by the #2 note was
  caught by RUNNING the job and fixed)

## Goals

- Roll new `incidents.error_events` rows up into `incidents.incidents`, one row per
  `(fingerprint, entity)`, via a watermarked, idempotent
  `INSERT … SELECT … GROUP BY … ON CONFLICT (fingerprint, entity) DO UPDATE` upsert:
  additive `occurrence_count`, `first_seen`/`last_seen` (LEAST/GREATEST), `apps[]`/
  `systems[]` unions, a representative event, category/error_type/func, and best-effort
  enrichment.
- No assessor / severity / state / auto-close (Phases 4–5); `action_*` never written.

## Built

- `domain/entity.js` — **dropped `job_id`** from the entity fallback (`sme → system_id →
  __global__`). `entity()` is the single source of truth; `test/entity.test.js` updated.
- `jobs/materialize/flatten.js` + `utils/db/sql/pg-helpers.js` — each L0 row now carries a
  stored `entity` (stamped by `entity()`), computed from the same `system_id` value that is
  persisted (no drift). The aggregate GROUPs on this column, never re-deriving entity in SQL.
- `db/schema.sql` — `error_events.entity VARCHAR(64) NOT NULL` in CREATE + a Phase 3 UPGRADE
  section (add nullable → one-time SQL backfill mirroring `entity()` → SET NOT NULL). Also
  moved `error_events.inserted_at` to `DEFAULT clock_timestamp()` (was `NOW()`) — the
  aggregate cursor must be stamped at insert-time/post-lock, not transaction-start (review
  F1). Fresh and upgraded installs converge; re-apply is idempotent.
- `utils/db/queries/incidents.js` — the aggregate upsert (set-based, static, parameterized
  `$1/$2` window). Strict window `(watermark, snapshot]`, **no overlap**; additive
  `occurrence_count`; array-union apps/systems; `DISTINCT ON` representative on the total
  order `ts, run_id, event_ord`; representative-derived fields refreshed on the
  `(last_seen, sample_run_id)` total order so rebuild == incremental (review F3); `msg`
  reconstructs `eventText` with `btrim` + `jsonb_typeof='string'` guards (review F4);
  `RETURNING (xmax = 0)` to report inserted vs. updated.
- `utils/db/queries/enrichment.js` — `stats.acquisition_history` corroboration, **system_id
  only**, category-when-`unknown` only (advisory; never overwrites a confident category or
  writes NULL).
- `jobs/aggregate/index.js` — the transaction: lock the materialize watermark row
  `FOR UPDATE`, ensure+lock own watermark, post-lock `clock_timestamp()` snapshot, upsert,
  `GREATEST`-guarded advance — all one tx. Exactly-once rests on BOTH this lock AND the
  post-lock `inserted_at` cursor stamp (review F1); overlap-free additive count. Reuses the
  generic watermark SQL from Phase 2.
- `index.js` — `assess` now calls `aggregate` (was a stub); the deterministic assessor lands
  here in Phase 4.
- Docs: `docs/incidents-schema.md` (entity column + dropped job_id + enrichment reality +
  sample_message wording + `inserted_at` cursor note), `markdown/PROMPTS.md` status.
- Tests: 49 unit (dependency-free, bare `node:lts`) + 2 live DB integration tests under
  `integration/` (`aggregate_race.js`, `rep_determinism.js` — run in the app container, not
  discovered by `node --test`).

## Schema Facts Confirmed (live DB)

- `incidents.incidents` columns/types match the contract; **no** `modality`/`manufacturer`
  columns exist (the prompt's enrichment list overshot the schema).
- `error_events.dt` is **never null** across the 186k rows (`dt_null = 0`); all `fp_version=1`.
- **Entity grain:** with `job_id` in the fallback, the L0 rows produced **38,578**
  `(fingerprint, entity)` pairs — ~38,084 singleton incidents keyed on per-run job UUIDs,
  from just **4** `(app, func, fingerprint)` combos (all `unknown`). Dropping `job_id` →
  **498** pairs. This answered the prompt's "sane bucket sizes?" review question with data.
- **Enrichment reality:** the source `run_id` does **not** correlate with
  `stats.acquisition_history.run_id` — **0 of 124,361** rows matched on `(system_id, run_id)`.
  On `system_id` alone, **111 of 217** distinct systems match. So the join is system_id-only
  and LEFT.
- Source retention still covered the full L0 window at implementation time (src_min
  2026-07-07 14:58), but the entity migration was done **non-destructively** (add column +
  in-place backfill), not by rebuild.
- Backfill parity: stored `entity` == `entity()` expression for **all** 186k rows
  (0 mismatches); 0 nulls after `SET NOT NULL`.

## Important Decisions

### Drop `job_id` from the entity fallback (contract change)

Decision: `entity()` is now `sme → system_id → '__global__'`; `job_id` is stored on L0 for
provenance but is never an entity key.

Reason: `job_id` is a per-run UUID. As an entity it mints one incident identity **per run**,
never aggregates across runs, and turns the incidents table back into the firehose the app
exists to collapse (live: 4 fingerprints → ~38k singleton incidents). Phase 2 had already
demoted `job_id` below `system_id` for this reason; Phase 3, its first consumer, removes it.

Tradeoff: an event with no `sme`/`system_id` now shares the `__global__` bucket for its
fingerprint (one incident per distinct problem when equipment is unknown) instead of a
per-run bucket. Developer-approved before implementation.

### Exactly-once via serialize-vs-materialize + post-lock cursor + zero overlap

Decision: the aggregate takes **no** overlap lookback; the window is the strict
`(watermark, snapshot]`. Exactly-once rests on TWO guarantees together (the second was
added in the round-1 high fix — the lock alone is insufficient):
(a) the aggregate locks the materialize watermark row `FOR UPDATE` before snapshotting, so
no materialize tx *commits* between the read and the advance; and (b) `error_events.inserted_at`
— the cursor — is `DEFAULT clock_timestamp()` (insert-time, post-lock), so a materialize tx
that *started* before the aggregate but commits after it still stamps its rows above the
aggregate's watermark and is caught next window.

Reason: `occurrence_count` is additive, and an additive counter double-counts any row that
falls in two windows — exactly what an overlap lookback causes (trace: a row at
`inserted_at=98` re-scanned by a later `(95,200]` window is added twice). A clock-based
overlap cannot distinguish "already counted" from "newly visible after commit-skew", so the
only exactly-once options are per-row dedup state or removing the skew. The lock+post-lock-cursor
removes the skew, letting the additive count be exactly-once by construction. Materialize's
job code is unchanged (the aggregate simply also locks the row materialize already holds; the
cursor fix is a column default). Proven by `integration/aggregate_race.js`.

Tradeoff: `assess` and `materialize` cannot run concurrently (acceptable — both are
sub-second/second-scale internal jobs; the normal `run` path is sequential anyway). A
deliberate watermark **rewind** after a committed batch is **not** idempotent for an additive
counter — treated as out-of-scope operator action (recovery = truncate + reset + re-aggregate).
CLOCK CAVEAT (re-review R1): "exactly-once" holds under a **nondecreasing database clock** —
the timestamp cursor is a wall clock; a backward step could silently undercount. This matches
the assumption the rest of the pipeline's watermarks already make; the unconditional fix is a
monotonic post-lock cursor (upgrade path, not built).

### Enrichment scoped to system_id-only, category-when-unknown

Decision: LEFT JOIN `stats.acquisition_history` on `system_id` only; use it solely to
corroborate `category` when classify returned `unknown`. No `phase`/`modality`/`manufacturer`.

Reason: `run_id` never joins (0/124,361), so per-run correlation is impossible; `incidents`
has no modality/manufacturer columns; a per-run `phase` from an uncorrelated run is
misleading. Developer-approved. Time-correlated oracle use (auto-close) is Phase 5.

Tradeoff: corroboration is coarse (latest non-`unknown` category for the system, time-
uncorrelated). Advisory only; classify stays primary; 39/498 incidents corroborated live.

### `first_seen`/`last_seen` from `COALESCE(dt, inserted_at)`

Decision: lifecycle timestamps derive from the event's own `dt`, falling back to L0
`inserted_at` only for null-`dt` rows (currently none).

Reason: `dt` is the semantically correct "when the problem occurred"; `inserted_at` is
materialization time (a poor proxy after a backfill), used only so a null-`dt` row still
contributes a real instant instead of being dropped. Source-clock skew is the producer's
truth, not corrected here (noted for Phase 5 auto-close timing).

## Architecture Notes

- Write-isolation / least-privilege: writes are `incidents.incidents` +
  `incidents.pipeline_state` only; `stats.acquisition_history` SELECT-only in the enrichment
  CTE. No new grant — the role owns `incidents` (covers the new `error_events.entity` column
  and all `incidents` writes); proven by the live `assess`/`run` smokes as `incident_engine_rw`.
- Idempotency / watermark: second `pipeline_state` row `incidents.error_events`, mirroring
  materialize's ensure→lock→post-lock-snapshot→GREATEST-advance, same tx. **Zero overlap**;
  exactly-once via the materialize-row serialization lock (see decision). Proven live: first
  aggregate `sum(occurrence_count)` == L0 total (delta 0); re-run unchanged; incremental
  `run` counted ~17k new events exactly once (delta stays 0).
- Classifier / fingerprint stability: untouched. `FP_VERSION` stays 1; `normalize.js`/
  `fingerprint.js` not modified. `category` on an incident may differ from its events only
  when enrichment corroborated an `unknown` (advisory), never via a fingerprint change.
- Determinism: aggregate is pure SQL over stored facts; enrichment advisory; no LLM. The
  assessor (Phase 4) is still absent — `state`/`severity`/`assessment` unwritten.
- Data-contract: reads `error_events` (this app's own L0) + `stats.acquisition_history`
  (SELECT); never `verbose_log`. EXPLAIN: steady-state narrow window uses BRIN
  (`idx_error_events_inserted_brin`, cost ~1.8k); full backfill window seq-scans (correct —
  whole table); enrichment uses `idx_acq_hist_err_cat_inserted`; conflict arbiter is
  `uq_incidents_fingerprint_entity`.
- Deployment: no new deploy surface (same batch one-shot). Superuser step this phase:
  re-apply `db/schema.sql` (adds + backfills `error_events.entity`) **before** running the
  new `assess`. Cron cadence **decided + installed after this phase** (2026-07-16): a single
  `run` line at `25,55` — see `markdown/DEPLOYMENT.md` "Cadence".

## Validation

Commands run:

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test                       # 48/48 pass
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql          # entity add+backfill+NOT NULL (UPDATE 186131)
docker compose run --rm app node index.js assess                               # first aggregate, exit 0
docker compose run --rm app node index.js assess                               # re-run: no double-count
docker compose run --rm app node index.js run                                  # materialize → assess incremental
# EXPLAIN of the upsert (full + narrow window) as postgres
```

Results:

- Passed: 48/48 unit tests. Backfill parity 0 mismatches / 0 nulls. First aggregate = 498
  incidents, `sum(occurrence_count)` = 186,131 = L0 total (**exactly-once delta 0**). Re-run
  (empty window) = unchanged (498 / 186,131). Incremental `run` materialized ~17,465 new
  events and aggregated them → 503 incidents, `sum` = 203,596 = new L0 total (**delta still
  0**). `state`/`severity` NULL on all rows (Phase 4 boundary). Enrichment corroborated
  39/498 `unknown` incidents. EXPLAIN: BRIN for steady-state, correct conflict arbiter.
- Failed: none.
- Not run initially, ADDED in the fix round: the concurrent-race integration test
  (`integration/aggregate_race.js`, deterministic two-connection interleaving — the
  round-1 high finding's proof) and the representative rebuild-vs-incremental determinism
  test (`integration/rep_determinism.js`). Still not run: a watermark-rewind
  demonstration (would corrupt the additive count — documented as out-of-scope operator
  action); crash-mid-batch is covered by transactional rollback (reasoned, not fault-injected).

Manual / smoke tests:

- Formerly-fractured job_id fingerprints are now single `__global__` incidents with high
  counts (runJob 23,163; getTunnelsByIP 10,698; gzip_n_save 13,533 / 9,369; phil_cv_eventlog
  2,776) — the aggregation win, visible directly.
- Representative messages are human-readable ("JOB HALTED", "NO TUNNEL FOUND", "File Not
  Present"), not the normalized hash input.

## Review Notes

Source:

- `notes/review_results_phase_3.md` (Codex, from `notes/codex_handoff_phase_3.md`).

Critical issues:

- Codex verdict was "needs fixes before commit": (1) **high** — the shared watermark
  lock did NOT eliminate commit skew. `error_events.inserted_at DEFAULT NOW()` is
  transaction-START time; a materialize tx can fix its `NOW()` before acquiring the
  lock, be descheduled, and commit AFTER an aggregate advanced its watermark, leaving
  its rows below the strict `inserted_at > watermark` window — skipped forever. The
  lock serialized commits but not the cursor value. (2) **medium** — flatten derived
  `entity` from the UNcapped sme while storing sme capped to 16, so a >16-char sme got
  a 64-char entity on new rows but a 16-char entity from the backfill → split incident.
  (3) **low** — the representative tie-break was deterministic only within a batch (the
  `>=` refresh resolved equal-ts events by batch arrival order → rebuild ≠ incremental).
  (4) **low** — the SQL `msg` reconstruction didn't match `eventText`: it only rejected
  literal `''`, so a whitespace-only `note.txt` suppressed a valid `skip_reason` and
  padding survived.

Accepted fixes (all four findings; detail in `notes/review_results_phase_3.md`):

- **F1**: `error_events.inserted_at` now `DEFAULT clock_timestamp()` (insert-time,
  post-lock), so the cursor orders with the lock — a late-committing materialize stamps
  its rows AFTER any watermark the aggregate set while it waited, and they're caught
  next window. Exactly-once now explicitly requires BOTH the lock AND the post-lock
  stamp (comments in `incidents.js`/`aggregate/index.js` corrected; the old "lock alone
  suffices" claim was the bug). New `integration/aggregate_race.js` reproduces the
  interleaving and proves the `clock_timestamp()` row is caught while a
  `transaction_timestamp()` (old-default) row in the same commit is skipped → PASS.
- **F2**: `flatten.js` derives stored `sme` and `entity()` from one `cap(sme,16)` value;
  long-sme parity unit test added.
- **F3**: `rep` sort key aligned to `ts DESC, run_id DESC, event_ord DESC` and the ON
  CONFLICT refresh guarded by the `(last_seen, sample_run_id)` total order → order-
  independent. New `integration/rep_determinism.js`: rebuild vs. 2-window
  incremental → 0 mismatches.
- **F4**: `msg` `btrim`s each candidate and guards `raw_event` extraction with
  `jsonb_typeof(...) = 'string'`, matching `nonEmptyString`.

Confirmed clean by the reviewer (left as-is): watermark-rewind policy (reasonable —
`GREATEST` guards ordinary retries; rewind is explicit operator recovery), deadlock-free
lock order, write-isolation + grants, parameterized/injection-safe static SQL.

Re-review (round 2, `notes/review_results_phase_3.md` §round 2): confirmed F2/F3 closed;
raised 1 medium + 1 low against the F1/F4 fixes — both addressed:

- **R1 (medium)** — exactly-once still assumed `clock_timestamp()` is nondecreasing across
  the lock handoff (a wall clock, not a monotonic primitive); a backward clock step in the
  sub-second window between the aggregate's advance and a pre-lock materialize's insert
  could silently UNDERcount (never double-count/corrupt). Also stale comments claimed "no
  materialize tx can be in flight" (pre-lock tx's can be). Resolution (Codex-sanctioned):
  **explicitly documented the guarantee as "exactly-once under a nondecreasing clock"** and
  corrected the comments (the lock excludes *committing* tx's; guarantee (b), the post-lock
  stamp, orders a pre-lock tx's rows) in `jobs/aggregate/index.js`,
  `utils/db/queries/incidents.js`, `db/schema.sql`. The whole pipeline already assumes a
  nondecreasing clock, so a monotonic cursor for the aggregate alone would be inconsistent;
  the unconditional fix (post-lock `BIGSERIAL`/batch-sequence cursor) is recorded as the
  upgrade path, not built (proportionate to the residual; a pipeline-wide decision).
- **R2 (low)** — `btrim` default trims spaces only; JS `String.trim()` also strips tab/
  newline/etc. Fixed: `msg` now `btrim(x, E' \t\n\r\f\v')` on every candidate. Verified
  live (a `"\t\n"` `note.txt` now correctly falls through to `skip_reason`). Exotic Unicode
  whitespace remains uncovered (never in these ASCII messages); persisting `eventText` on L0
  is the exact-parity upgrade, noted in the query comment.

Round 3 (independent self-review, `notes/review_results_phase_3.md` §round 3): high-recall
8-angle pass; **no high/medium** findings (exactly-once core, representative-guard invariant,
enrichment 1:1 join, and consistent ms-truncation all verified). 4 low; developer applied:

- **#1 (low)** — the entity backfill's `btrim` (spaces only) diverged from `entity()`'s JS
  `.trim()` at the 16-char sme cap boundary (the R2 whitespace gap, not applied to the
  backfill). Fixed: `btrim(sme, E' \t\n\r\f\v')` / `btrim(system_id, …)`; re-verified 0
  entity mismatches over all 203,596 live rows.
- **#3 (low)** — an oracle-corroborated `category` left `error_type=''` (~39 live incidents).
  Documented (not a stale pairing): only `category` is corroborated; `error_type`/`phase`
  stay the deterministic classifier's output. **The rationale was later CORRECTED
  (2026-07-16)**: the review claimed the oracle used a different vocabulary so no
  category→type derivation was possible — false. The oracle's 9 live `error_category` values
  are a subset of our classifier's 19 (both trace to `connection_regex.js`, which
  `data_acquisition` owns and this app copied verbatim). Behaviour unchanged and still
  correct; only the stated reason was wrong. Docs fixed; the derivation is now a tracked
  follow-up (see below). See `notes/review_results_phase_3.md` §CORRECTION.
- **#2 (low)** — noted in code that the newest-wins `category` refresh could regress a
  confident category to `unknown` if a fingerprint ever became mixed-category (empirically
  never; single-category live). **#4** (msg computed per batch row) left as-is.

Process note: the #2 note initially used markdown backticks inside the SQL **template
literal**, breaking `require` — invisible to `node --test` (which never loads `incidents.js`),
caught only by RUNNING `assess`. Fixed and re-validated by running the job (assess exit 0,
both integration tests PASS, delta 0), not just the unit suite.

Deferred findings:

- None as bugs. Two upgrade paths recorded (not scheduled): the monotonic-cursor exactly-once
  hardening (R1) and persisting `eventText` on L0 for exact sample-message parity (R2).
  Enrichment coarseness, `apps[]` single-app structure, and `dt`/null-`dt` skew remain the
  intentionally-deferred Phase-5 items already recorded above.

Re-validation after fixes (all green):

- 49/49 unit tests (long-sme parity added). Schema re-applied (default →
  `clock_timestamp()`). `aggregate_race.js` PASS (T0 < Ta; clock row caught, tx-start
  row skipped). `rep_determinism.js` PASS (498/498, 0 mismatches). Real `assess` exit 0.
  Final: `error_events` 203,596 (0 null entity, 0 test leftovers); `incidents` 503 =
  `count(distinct (fingerprint, entity))`; `sum(occurrence_count)` 203,596 →
  **exactly-once delta 0**; watermark caught up.

## Problems Encountered

- The prompt's enrichment premise (join on `run_id`; fill `phase`/`modality`/`manufacturer`)
  did not survive Step 2: `run_id` never joins the oracle and those columns don't exist on
  `incidents`. Resolution: scoped enrichment to system_id-only category corroboration and
  documented the reality in `docs/incidents-schema.md` and the prompt is superseded by this
  entry. Developer-approved before implementation.
- The prompt's "cross-app blast radius" review question rests on a false premise: `src_app_name`
  is part of the fingerprint, so one fingerprint is single-app and `apps[]` is structurally
  length-1. Resolution: documented; `apps[]` kept per contract/future-proofing.

## Follow-Up Tasks

- Codex review of this phase (handoff ready); iterate on findings; then commit Phases 0–3.
- Phase 4 (`prompt_4_deterministic_assessor.txt`): pure `assess(dossier)` → severity/state/
  reasons over the aggregated incidents; wire after `aggregate` in the `assess` job.
- Phase 5: watch the source-clock skew / null-`dt` interaction when the recovery oracle
  drives auto-close timing (this entry's timestamp decision).
- Optional hardening (re-review, if/when clock-step tolerance is wanted): replace the
  timestamp aggregate cursor with a monotonic post-lock `BIGSERIAL`/batch sequence — ideally
  pipeline-wide (materialize's watermark makes the same clock assumption), so it's a
  deliberate cross-cutting phase, not an aggregate-only patch.
- Optional (re-review, exact sample-message parity): persist the computed `eventText` on
  `error_events` and read it directly instead of reconstructing `msg` in SQL.
- **Populate `error_type` on oracle-corroborated incidents** (~39 live rows currently `''`).
  Now known to be feasible: the oracle's categories are our classifier's vocabulary, so
  `connection_regex.js` IS a category→type map. Needs that map available to the SQL aggregate
  (e.g. a VALUES CTE generated from the table at require-time, keeping `connection_regex.js`
  the single source of truth). **Relevant to Phase 4** — a severity rules table keyed on
  `error_type` would misfire on those rows today; keying on `category` avoids it.
- **Cron cadence: DECIDED + installed 2026-07-16** (post-commit) — one `run` line at
  `25,55`; rationale + the exact line in `markdown/DEPLOYMENT.md` "Cadence". Verified by
  running the exact cron command string from a foreign cwd (exit 0); a full-day incremental
  run then held the exactly-once invariant (228,490 L0 rows → 504 incidents, delta 0).
- Open decisions unchanged: acquisition-v2 onboarding, self-ingestion, retention.

## Commit Readiness

- Requirements implemented: yes (aggregate half of `assess`, per the prompt + approved Step-2
  design changes).
- Write-isolation / least-privilege rules hold: yes (no new grant; writes confined; proven
  live as `incident_engine_rw`).
- Jobs idempotent (watermark + ON CONFLICT): yes — exactly-once proven live (delta 0 on first,
  re-run, and incremental runs) AND under the concurrent materialize/aggregate race after the
  round-1 high fix (post-lock `clock_timestamp()` cursor; `aggregate_race.js` PASS).
- Assessment deterministic (no LLM in critical path): n/a (assessor is Phase 4); aggregate is
  pure SQL; enrichment advisory.
- Source queries read warn_error_logs only, partition-pruned: n/a for the source table this
  phase (reads own L0 + oracle); BRIN confirmed on the L0 window scan.
- Schema assumptions confirmed live: yes (see Schema Facts).
- Review findings addressed or deferred: yes — three rounds
  (`notes/review_results_phase_3.md`): round 1 (Codex) 1 high + 1 medium + 2 low, all fixed;
  round 2 (Codex re-review) 1 medium + 1 low, both addressed; round 3 (independent
  self-review) no high/medium, 4 low — 2 fixed, 1 noted, 1 left. Two upgrade paths recorded
  (monotonic cursor; persisted `eventText`), neither scheduled.
- Validation recorded: yes.
- Ready to commit: yes — developer confirmed after round 3.

---

# Phase 2 — Materialize (L0)

Date:
2026-07-14

Status:
Completed (pending external review + commit)

Prompt:
`prompts/prompt_2_materialize.txt` (as revised by `notes/phase_2_reevaluation.md`)

Git Commit:
`381c519`

Review Artifacts:

- Codex handoff (round 1): `notes/codex_handoff_phase_2.md`
- Review results (round 1): `notes/review_results_phase_2.md` (2 high, 3 medium,
  1 low — all fixed, L0 rebuilt)
- Codex handoff (round 2, fix delta): `notes/codex_handoff_phase_2_fixes.md`
- Review results (round 2): `notes/review_results_phase_2_fixes.md` (1 high, 1 medium,
  2 low — all fixed; original findings confirmed closed)
- Review results (round 3, internal adversarial multi-agent pass over the freeze
  surface): `notes/review_results_phase_2_round3.md` (17 confirmed / 5 plausible /
  4 refuted; 10 reported + nits, all fixed — incl. two live-probed poison-event
  stalls (NUL bytes, JS-vs-PG timestamp parsing) and the pre-freeze fingerprint
  separator escape; L0 rebuilt at exact parity, 82 buckets unchanged, 47/47 tests)

## Goals

- Flatten `util.app_run_logs.warn_error_logs` into `incidents.error_events` — one row
  per event, fingerprinted and classified at materialize time — incrementally and
  idempotently (watermark + `ON CONFLICT`), reading `warn_error_logs` only.
- Freeze the identity domain: `normalize.js` golden contract, `FP_VERSION=1`
  fingerprint, classifier copied verbatim from production, entity fallback.

## Built

- `domain/normalize.js` — frozen golden contract: noise-line filter (stateful curl
  progress block, JS-stack-frame-shaped lines only), then ts/uuid/ip/sme/path/hex/
  number → placeholders, whitespace-collapse, lowercase. NO length cap (output is
  only hashed). Golden-tested, incl. preservation goldens for tabular/indented prose.
- `domain/fingerprint.js` — `sha1(app|func|tag|type|normalize(TEXT))`, `FP_VERSION=1`
  persisted per row (`error_events.fp_version`); `eventText` implements the
  live-verified chain `err_msg → note.message → note.txt → note.skip_reason → ''`.
- `domain/classify.js` — thin wrapper over `utils/classify/connection_regex.js`
  (verbatim copy from data_acquisition, 26 ordered entries, diff-verified);
  first-match-wins; `unknown` fallback.
- `domain/entity.js` — `entity()` (`sme → system_id → job_id → __global__`, 64-cap so
  a job-UUID fallback is lossless; consumed in Phase 3) + `deriveSystemId()`
  (`^SME\d{5}$` ⇒ the value IS the system_id; applied to `note.system_id` first,
  then `note.sme`).
- `jobs/materialize/` — single transaction: ensure+lock watermark row (`FOR UPDATE`
  serializes concurrent runs), post-lock `clock_timestamp()` snapshot (monotonic
  under concurrency; advance guarded by `GREATEST` + `RETURNING` the stored value),
  bounded scan over the explicit
  `PRODUCING_APPS` allowlist, pure `flatten.js` (defensive: malformed events → skipped
  + WARN, never a crash), chunked `pgp.helpers` inserts with
  `ON CONFLICT (run_id, event_ord) DO NOTHING`, watermark advanced to the snapshot in
  the same transaction. Env: `MATERIALIZE_OVERLAP_MS` (default 5000),
  `MATERIALIZE_BATCH_ROWS` (default 5000), validated fail-fast.
- `utils/db/queries/materialize.js` — all SQL, parameterized.
- `index.js` — materialize stub replaced with the real job; `assess` still stubbed.
- Tests: 42 (normalize goldens incl. noise + preservation cases, frozen fingerprints,
  classify ordering + table-intact, entity, flatten) — all dependency-free, run in
  bare `node:lts`.
- `db/schema.sql` — now carries idempotent per-phase UPGRADE sections (Phase 2:
  `fp_version` add→backfill→NOT NULL; `entity` widen to 64), so an existing Phase 1
  database is reproducibly upgradeable by re-applying the one tracked file; tested on
  a scratch Phase 1 database, on re-apply, on fresh install, and on live.
- `docs/error-taxonomy.md` — flags column synced to the live classifier (5 rows were
  missing `manual_intervention`; Step 2 doc-drift fix).

## Schema Facts Confirmed (live DB)

- `acquisition-v2` still emits zero `warn_error_logs` events (3-day window) —
  allowlist decision stands.
- Event fields: `dt`/`type` 100% present; `type ∈ {WARN, ERROR}`; max `func` 41 chars,
  max `tag` 10, max `sme` 8; `note` never null (25,210-event day sample).
- `sme` matches `^SME\d{5}$` and `stats.acquisition_history.system_id` uses the same
  format ⇒ format-matching sme IS the system_id. Only 69/175 distinct event smes
  appear in `stats.acquisition_history` — the recovery oracle will not cover every
  entity (noted for Phase 5).
- Live classifier flags differ from the taxonomy doc snapshot — doc updated (see Built).

## Important Decisions

### Single-transaction batch (no paging)

Decision: scan → flatten → insert → advance happens in one transaction holding the
window's rows in memory.

Reason: the crash-consistency story is trivial (any failure rolls back watermark and
all inserts together), and the worst case observed — full 7-day retention backfill —
is 14.8k source rows / 184k events / 23.5s. Volume is ~25k events/day thereafter.

Tradeoff: memory grows with the window; flagged to the reviewer with the break-even
question. Paging (per-page transactions with per-page watermarks) is the known escape
hatch if volume demands it.

### note.txt in the fingerprint text chain

Decision: implemented the re-evaluated chain `err_msg || note.message || note.txt`.

Reason: without it, ~15% of data_acquisition events (note.txt-only, e.g.
"NO TUNNEL FOUND") would fingerprint on func/tag alone. Live result: those 10,573
events group under one fingerprint by their text.

Tradeoff: none now (`FP_VERSION` still 1; nothing was materialized before this phase).

## Architecture Notes

- Write-isolation / least-privilege impact: writes are `incidents.error_events` +
  `incidents.pipeline_state` only, through the Phase 1 role. No new grants needed.
- Idempotency / watermark impact: proven live — re-run inserts 0; a deliberate 1-hour
  watermark rewind re-flattened 1,045 events and inserted 0; PK-distinct = total.
  Forced failure (bad env) exits 1 with the watermark unadvanced.
- Classifier / fingerprint stability impact: **`normalize.js` + `fingerprint.js` are
  frozen as of this phase** (`FP_VERSION=1`, golden tests with literal sha1s). Any
  future change is a deliberate FP_VERSION-bump phase.
- Determinism impact: all domain modules pure + dependency-free; no LLM.
- Data-contract impact: scan reads `warn_error_logs` only, bounded on `inserted_at`
  both ends; EXPLAIN confirms partition pruning (`Subplans Removed: 6`). Explicit
  `PRODUCING_APPS` allowlist excludes `incident-engine` (self-log feedback loop) and
  `acquisition-v2` (parked).
- Deployment impact: none (same batch one-shot; no schema/role change; cron still not
  installed — cadence remains an open decision).

## Validation

Commands run:

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test        # 35/35 pass
docker compose run --rm app node index.js materialize          # backfill, exit 0
docker compose run --rm app node index.js materialize          # re-run, inserts 0
# watermark rewound 1h (superuser) → re-run → 1,045 re-flattened, 0 inserted
docker compose run --rm -e MATERIALIZE_OVERLAP_MS=abc app node index.js materialize  # exit 1
docker compose run --rm app node index.js run                  # cron path, exit 0
# EXPLAIN scan as incident_engine_rw → partition pruning confirmed
```

Results:

- Passed (pre-review): backfill 14,814 source rows → 184,046 events, exactly 1:1 with
  the source window count, 0 skipped, 23.5s; idempotency (re-run + rewind replay)
  proven; failure path exits 1 with watermark unadvanced (closes the Phase 1
  deferral); partition pruning confirmed; 35/35 unit tests.
- Passed (post-review rebuild): L0 truncated + watermark reset + re-backfilled under
  the corrected formula in 22s — 185,090 events, exact source parity; 0
  mixed-category fingerprints; 82 distinct fingerprints; all rows `fp_version=1`;
  5,285 `note.system_id` events captured; 690 skip_reason events fingerprinted on
  their stated reason; watermark-regression proof (future watermark not moved
  backward, catch-up resumes); 41/41 unit tests (6 new).
- Passed (round-2 fixes): schema upgrade tested on scratch Phase 1 DB / re-apply /
  fresh / live; noise-filter rewrite proven fingerprint-preserving (0 diffs over all
  1,808 distinct multiline corpus texts; rebuild checksum byte-identical to the
  round-1 corpus); watermark summary reports the stored value under GREATEST
  rejection; 42/42 unit tests (preservation goldens added).
- Failed: none (one test-authoring miscount fixed: classifier table has 26 entries,
  not 27).
- Not run: none outstanding.

Sanity:

- 184,046 events → 141 distinct fingerprints (~1,305 events/fp; GE 5, Philips 17,
  data_acquisition 119 — proportional to each app's error variety).
- GE (no err_msg) groups sanely by note.message ("No new file data. Delta: 0" →
  14,401 events, one fingerprint).
- `unknown` = 79% of events — expected: most WARN volume is pipeline-status noise;
  the taxonomy targets connection/extraction errors; severity handling is Phase 4's
  job. Category is not part of the fingerprint, so a future taxonomy improvement
  never re-buckets history.

## Review Notes

Source:

- `notes/review_results_phase_2.md` (Codex, from `notes/codex_handoff_phase_2.md`).

Critical issues:

- Codex verdict was "needs fixes before commit": (1) **high** — the 512-char
  normalization cap merged distinct failures (live evidence: two fingerprints each
  mixing `connection_timeout` with `partial_transfer_timeout`; the salient curl line
  sits past a variable-length progress preamble); (2) **high** — `note.system_id`
  (5,270 live events) was dropped and the entity order preferred per-run job UUIDs
  over equipment identity, and the 32-char entity cap truncated 36-char UUIDs;
  (3) **medium** — a blocked concurrent transaction's `now()` (transaction-start
  clock) could move the watermark backward; (4) **medium** — `FP_VERSION` wasn't
  persisted per row; (5) **medium** — 688 live events carry text only in
  `note.skip_reason`, which the chain discarded; (6) **low** — a non-null non-array
  `warn_error_logs` advanced silently.

Accepted fixes (all six findings):

- **F1**: `normalize.js` now line-filters noise BEFORE scrubbing (curl progress
  header/rows — both `--:--:--` and completed-time forms — and Node stack frames) and
  has NO length cap (output is only hashed). New frozen goldens prove: same failure
  with different progress-row counts/IPs/ports → same fingerprint;
  connection-timeout vs partial-transfer → distinct. Rebuilt live: **0 fingerprints
  with mixed categories** (was 2); the noise removal also merged previously
  over-split buckets — 141 → **82 fingerprints** over 185k events.
- **F2**: flatten stores validated `note.system_id` (authoritative) with sme-derivation
  as fallback — all 5,285 such live events now carry `system_id`; entity order is now
  `sme → system_id → job_id → __global__`; `entity` widened to VARCHAR(64) (holds a
  36-char job UUID losslessly). Contract docs + prompt_3 updated.
- **F3**: the batch snapshot is taken via `clock_timestamp()` in a separate statement
  AFTER the watermark row lock is held (a lock-waiting transaction can no longer carry
  an older bound), plus `GREATEST(last_inserted_at, $2)` defense in the advance.
  Proven live: watermark set 1 hour in the future → run exits 0 and the watermark did
  not regress; normal catch-up advances correctly afterward.
- **F4**: `error_events.fp_version SMALLINT NOT NULL` added (schema.sql + live ALTER +
  ColumnSet + flatten); all 185,090 rebuilt rows carry `fp_version = 1`.
- **F5**: `eventText` chain extended to `err_msg → note.message → note.txt →
  note.skip_reason → ''`; the 690 skip_reason-only events now fingerprint on the
  producer's stated reason (2 fingerprints, one per func). Docs synced (taxonomy,
  principles, incidents-schema).
- **F6**: a non-null non-array payload now emits a `skipped` diagnostic
  (`event_ord: null`) surfaced in the run's WARN log — visible but non-blocking; the
  test that locked in the silent behavior now requires the diagnostic.

Rebuild decision: **`FP_VERSION` stays 1.** Version-1 rows existed only as an
uncommitted backfill on this branch, nothing had consumed them, and source retention
still covered the whole window — so L0 was truncated and rebuilt from source under the
corrected formula (185,090 events, exact source parity re-verified) instead of
shipping a version-2 migration for data that was never accepted.

Re-review round 2 (`notes/review_results_phase_2_fixes.md`): confirmed findings
1/3/5/6 closed and 2/4 partially closed pending a tracked upgrade path; raised 1 high,
1 medium, 2 low — all fixed:

- **RF1 (high)** — the live `fp_version`/`entity` ALTERs weren't reproducible from the
  repo (schema.sql only had them inside `CREATE TABLE IF NOT EXISTS`). Fixed:
  `db/schema.sql` now ends with **idempotent per-phase UPGRADE sections** (fp_version
  add → backfill v1 → SET NOT NULL, no default left behind; entity widen-only to 64
  via a typmod-guarded DO block). Tested on all four paths: scratch Phase 1 database
  upgraded (backfill verified), re-apply idempotent, fresh install, live converge.
  DEPLOYMENT.md documents the "re-apply schema.sql on upgrade; never manual ALTERs"
  rule. This fully closes original findings 2 and 4.
- **RF2 (medium)** — the noise filter was over-broad (global `--:--:--`, global
  numeric-columns rule, prose-eating `^\s+at\s`). Fixed: curl progress rows are now
  dropped only inside a block opened by curl's own two-line header (stateful), and
  only lines shaped like real JS stack frames (`:line:col` / `(native)` /
  `<anonymous>` / `(index N)` tails) are dropped. Preservation goldens added for the
  review's three probes (tabular summary, indented "at least..." prose, `--:--:--`
  sentinel as content). **Equivalence proven two ways**: old-vs-new normalization
  diffed over all 1,808 distinct multiline texts in the live corpus → 0 differences
  (after adding the `(index N)` frame tail the first diff pass caught); L0 truncated
  and rebuilt → bounded checksum over (run_id, event_ord, fingerprint) is
  **byte-identical** to the pre-rewrite corpus (`343d91a2…`, 185,090 rows). FP_VERSION
  stays 1 with proof, not assertion.
- **RF3 (low)** — watermark audit metadata: the advance now uses
  `updated_at = clock_timestamp()` and `RETURNING last_inserted_at`; the run summary
  reports the STORED watermark (`watermark_after`) plus the requested
  `snapshot_upper_bound`. Proven live: with a future watermark, the summary reports
  the preserved future value (matches the DB to the millisecond), not the rejected
  snapshot.
- **RF4 (low)** — canonical docs contradicted the corrected contracts: this entry's
  Built section updated (no cap / noise-line filter, skip_reason chain, entity
  order + 64, post-lock snapshot, fp_version); `prompt_2_materialize.txt` carries an
  explicit SUPERSEDED-clauses banner; the Architecture Data-Contract Rule now names
  `note.skip_reason` and `note.system_id`.

Deferred findings (per round 1's "verified without findings" guidance, reaffirmed in
round 2):

- Single-transaction memory model: revisit before ~3–5× volume growth; record peak
  RSS / add a max-window bound when that work happens.
- `dt` source-clock policy for Phase 3 lifecycle timestamps (define fallback/skew
  policy using the source row's `inserted_at` — noted in prompt_3 planning).
- `raw_event` storage share (~101 MB of 230 MB): parked with the retention decision.
- Overlap default (5s) is adequate for autocommit producers; keep configurable and
  monitor for lock/commit stalls longer than the overlap (round 2 confirmation).

## Problems Encountered

- classify test initially asserted 27 table entries; the live table has 26 (authoring
  miscount, not a code defect). Fixed the assertion.

## Follow-Up Tasks

- Codex review of this phase (handoff ready); then commit.
- Phase 3 (`prompt_3_aggregate_incidents.txt`): aggregate `(fingerprint, entity)` →
  `incidents.incidents` with blast radius + enrichment join. Note for Phase 3: only
  ~39% of event smes exist in `stats.acquisition_history` — enrichment must be a LEFT
  join; recovery-oracle coverage gap matters in Phase 5.
- Open decisions unchanged: cron cadence, acquisition-v2 onboarding, self-ingestion,
  retention.

## Commit Readiness

- Requirements implemented: yes (per the re-evaluated prompt).
- Write-isolation / least-privilege rules hold: yes (no new grants; writes confined).
- Jobs idempotent (watermark + ON CONFLICT): yes — proven by re-run and rewind replay.
- Assessment deterministic (no LLM in critical path): n/a (assessor is Phase 4); all
  domain logic pure.
- Source queries read warn_error_logs only, partition-pruned: yes (EXPLAIN verified).
- Schema assumptions confirmed live: yes (see Schema Facts).
- Review findings addressed or deferred: yes — all 6 Codex findings fixed and
  re-proven live; 3 monitoring items deferred with reasons (see Review Notes).
- Validation recorded: yes.
- Ready to commit: yes, pending developer confirmation.

---

# Phase 1 — App Skeleton + Schema + Role Provisioning

Date:
2026-07-13

Status:
Completed

Prompt:
`prompts/prompt_1_app_skeleton_provision.txt`

Git Commit:
`38d52a2`

Review Artifacts:

- Codex handoff: `notes/codex_handoff_phase_1.md`
- Review results: `notes/review_results_phase_1.md` (1 high, 4 medium, 1 low — all fixed)
- Plus self-review against `markdown/REVIEW_CHECKLIST.md`

## Goals

- Stand up a runnable cron-batch app skeleton mirroring `data_acquisition` (CommonJS,
  positional-array logger, `pg-promise` pool with env fallback chains, `pgp.helpers`
  ColumnSets, `node index.js <job>` switch dispatch, batch one-shot compose).
- Create the owned `incidents` schema (`db/schema.sql`) exactly per
  `docs/incidents-schema.md`.
- Create + provision the least-privilege `incident_engine_rw` role
  (`db/setup-owner-role.sql`, fail-closed), switch `.env` off the borrowed
  `ops_dashboard_ro` role, and prove it with a self-log smoke run.

## Built

- `package.json` — CJS (no `"type"`), scripts `materialize`/`assess`/`run`/`test`;
  deps mirror `data_acquisition` (`dotenv`, `pg`, `pg-promise`, `uuid`).
- `index.js` — switch dispatch (`materialize`/`assess`/`run`/`noop`) + full run-log
  lifecycle (`makeAppRunLog` → `onBoot` → `runJob` → `addRunSummary` →
  `dbInsertLogEvents` → `writeLogEvents`). `materialize`/`assess` are logged stubs
  until Phases 2–5; `run` chains both.
- `utils/logger/log.js` + `enums.js` — copied from `data_acquisition` (positional-array
  export intact; express-http branch dropped — this app always writes a per-run file).
- `utils/db/pg-pool.js` — copied verbatim (`PGHOST||PG_HOST` fallbacks + `buildSsl`).
- `utils/db/sql/pg-helpers.js` — TableNames + ColumnSets for `util.app_run_logs`
  (self-log), `incidents.error_events`, `incidents.incidents` (+ `pipeline_state`
  TableName). JSONB columns carry explicit `::jsonb` casts.
- `docker-compose.yaml` — `pg_net` only, no port/server/redis, `user: "105:987"`,
  node_modules from `/opt/resources/node_mod_cache/incident-engine`, `RUN_LOGS_DIR`
  bind, `/opt/resources/ssl` read-only.
- `.env.example` — variable names per `markdown/ENVIRONMENT.md`, no secrets.
- `db/schema.sql` — `incidents.error_events` / `incidents.incidents` /
  `incidents.pipeline_state`, house DDL (BIGSERIAL where the contract has an `id`,
  TIMESTAMPTZ DEFAULT NOW(), BRIN on time columns, partial indexes, no partitioning).
- `db/setup-owner-role.sql` — idempotent, `-v pw=` parameterized, forced-safe role
  attrs (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`); transfers
  ownership of schema `incidents` + relations; fail-closed REVOKE→GRANT→DO-verify for
  `util` (SELECT+INSERT on `app_run_logs` only), `stats` (SELECT on
  `acquisition_history` only), and `alert` (nothing at all, USAGE included).
- `test/enums.test.js` — dependency-free smoke of the only pure helper this phase.
- Provisioned live: schema + role applied as superuser; strong generated password;
  `.env` now `PGUSER=incident_engine_rw` (password only in gitignored `.env`,
  `chmod 600`); host dirs `/opt/resources/node_mod_cache/incident-engine` and
  `/opt/run-logs/incident-engine` created group-`docker` mode `2775`.

## Schema Facts Confirmed (live DB)

- `util.app_run_logs`: partitioned table, RANGE on `inserted_at`, 7 partitions;
  columns `app_name text`, `run_id uuid`, `verbose_log json`, `warn_error_logs json`
  (both plain `json`, not `jsonb`), `inserted_at timestamptz DEFAULT now()`. Matches
  `/opt/apps/ops-dashboard/docs/logging-schema.md` — no doc fix needed.
- `stats.acquisition_history`: all documented columns confirmed (`run_id uuid NOT NULL`,
  `system_id varchar(8) NOT NULL`, `successful_acquisition boolean NOT NULL`,
  `error_category varchar(64)`, `phase varchar(32)`, `inserted_at timestamptz NOT NULL
  DEFAULT now()`); BRIN on `inserted_at`; not partitioned. Matches
  `docs/incidents-schema.md` assumptions.
- Apps writing `util.app_run_logs` in the last 3 days: `acquisition-v2`,
  `data_acquisition`, `hhm_rpp_ge`, `hhm_rpp_philips`, `ops-dashboard`.
- Server is PostgreSQL 16.13; neither schema `incidents` nor role
  `incident_engine_rw` existed before this phase.

## Important Decisions

### Ownership, not grants, for the owned schema

Decision: `incident_engine_rw` OWNS schema `incidents` and every relation in it
(transferred by `setup-owner-role.sql`), rather than receiving table-level grants.

Reason: matches the Least-Privilege Rule ("owns schema incidents — full DML/DDL
there") and survives future DDL phases without new grant plumbing.

Tradeoff: `db/schema.sql` can still be applied by a superuser first; the role script
must run after it to transfer ownership (runbook order in `DEPLOYMENT.md`).

### Linked BIGSERIAL sequences follow their table

Decision: the ownership-transfer loop alters tables/views only; sequences linked to
an identity/serial column cannot be `ALTER ... OWNER`'d directly (PG raises "cannot
change owner of sequence ... linked to table") — they follow the table
automatically. The DO-verify still asserts sequences ended up owned by the role.

Reason: first run of the script failed on `incidents.incidents_id_seq`; fixed and
re-run clean (the script is idempotent, so the partial first run was harmless).

Tradeoff: none.

### Non-zero exit on batch failure (deliberate house-style deviation)

Decision: `index.js` sets `process.exitCode = 1` in the `onBoot` catch block;
`data_acquisition` exits 0 on error.

Reason: this app is invoked by cron as a one-shot; a failed batch must be visible to
the scheduler/operator. Also added `db.$pool.end()` in `finally` so the one-shot
exits promptly instead of waiting out the pool idle timeout.

Tradeoff: small divergence from the mirrored app, documented here.

### `run` job defined now, cadence still open

Decision: `run` = `materialize` then `assess` in one process (stubs this phase); the
one-cron-line vs. two-staggered-lines question stays open in `PROMPTS.md` ("Not
decided yet") until the real jobs exist.

Reason: keeps Phase 1 within scope while making the normal cron invocation runnable.

Tradeoff: none.

## Architecture Notes

- Write-isolation / least-privilege impact: enforced at the credential layer now.
  Live grant matrix proven as the role itself (not SET ROLE): SELECT on
  `util.app_run_logs` ✓, SELECT on `stats.acquisition_history` ✓, INSERT self-log via
  the check-option view ✓, DDL/DML in `incidents` ✓; DENIED: INSERT on the
  `util.app_run_logs` base table, view-INSERT with a foreign `app_name` (check
  option), UPDATE/DELETE on `util.app_run_logs`, INSERT/UPDATE on
  `stats.acquisition_history`, `nextval` on external sequences, any access to
  `alert.*` (even SELECT — no USAGE), CREATE in schema `util`. Post-review, the
  `app_name='incident-engine'` discipline is **DB-enforced** (view WITH CHECK OPTION),
  not just code-level, and the role script's database-wide allowlist audit proves the
  whole surface on every run.
- Idempotency / watermark impact: `incidents.pipeline_state` table exists;
  `error_events` PK `(run_id, event_ord)` and `incidents` UNIQUE
  `(fingerprint, entity)` are in place as the future `ON CONFLICT` keys. No job
  logic yet.
- Classifier / fingerprint stability impact: none (no classifier code this phase).
- Determinism impact: none (no assessor code this phase); `ASSESSOR_KIND=rules`
  reserved in `.env.example`.
- Data-contract impact: no source reads yet beyond the grant; self-log INSERT only.
- Deployment impact: first real deploy surface — compose file + provisioned role.
  Superuser steps performed this phase: `db/schema.sql`, `db/setup-owner-role.sql`.
  Cron line NOT installed yet (cadence decided when real jobs land).

## Validation

Commands run:

```bash
docker exec -i pg_db psql -U postgres -d staging -X -v ON_ERROR_STOP=1 -f - < db/schema.sql
docker exec -i pg_db psql -U postgres -d staging -X -v pw="$PW" -f - < db/setup-owner-role.sql
# grant matrix as incident_engine_rw (via container psql, real login)
docker compose run --rm app npm install
docker compose run --rm app node index.js run          # also: materialize, assess, noop
docker run --rm -v "$PWD":/w -w /w node:lts node --test
```

Results:

- Passed: schema applied; hardened role script clean end-to-end (all DO-verify blocks
  + database-wide allowlist audit pass); drift-detection proven (injected PUBLIC grant
  and column-only grant both abort the script; clean after cleanup); grant matrix per
  spec including view semantics (correct-`app_name` view INSERT ✓; foreign `app_name`
  → check option violation; base-table INSERT → denied; external `nextval` → denied);
  `run`/`noop` exit 0 over `verify-full` TLS (TLSv1.3, hostname verified); failure
  paths exit 1 (unknown job, `APP_NAME` mismatch, closed `PGPORT` self-log failure,
  broken CA under `verify-full`); unit tests 8/8 pass (enums + build-ssl).
- Failed: first `setup-owner-role.sql` run only — linked-sequence ownership error
  (see decision above); fixed, re-run clean.
- Not run: none outstanding (the post-review failure-path smokes covered the
  previously deferred exit-code check).

Manual / smoke tests:

- Self-log row present: `util.app_run_logs` has `app_name='incident-engine'` rows
  (`verbose_log` 5 events, `warn_error_logs` 0 events on the `run` smoke).
- Per-run JSON written to `/opt/run-logs/incident-engine/` by the container user.
- Login as `incident_engine_rw` with the provisioned password works over TCP.

## Review Notes

Source:

- `notes/review_results_phase_1.md` (Codex, from `notes/codex_handoff_phase_1.md`) +
  self-review against `markdown/REVIEW_CHECKLIST.md`.

Critical issues:

- Codex verdict was "needs fixes before commit": (1) **high** — the fail-closed audit
  was per-schema table-level only (missed column-only grants, sequences, and
  PUBLIC-inherited privileges outside util/stats/alert); (2) **medium** — run-log
  persistence failures still exited 0 (reproduced with a closed port); (3) **medium** —
  self-log `app_name` not constrained at the credential layer; (4) **medium** —
  `verify-ca`/`verify-full` silently downgraded to unauthenticated TLS, and the deploy
  used `require`; (5) **medium** — an unknown job name reported success; (6) **low** —
  `addLogEvent` threw on a null/non-Error `err`.

Accepted fixes (all six findings):

- **F1**: `db/setup-owner-role.sql` now REVOKEs sequences as well as tables, verifies
  with `has_any_column_privilege` (catches column-only grants) +
  `has_sequence_privilege`, and ends with a **database-wide allowlist audit** over
  every non-system schema (allowlist: owned `incidents.*`; `util.app_run_logs` SELECT;
  `util.incident_engine_self_log` INSERT; `stats.acquisition_history` SELECT;
  documented `public.pg_stat_statements*` PUBLIC SELECT). Proven live: injected drift
  (a PUBLIC table grant, and a column-only `UPDATE(b)` grant — the old false negative)
  aborts the script; clean after cleanup. Residuals documented in the script header
  (cross-DB CONNECT/TEMP via PUBLIC needs pg_hba/cluster-wide action; PUBLIC EXECUTE
  on functions).
- **F3**: self-log now goes through `util.incident_engine_self_log` — a
  postgres-owned, auto-updatable view `WHERE app_name = 'incident-engine' WITH
  CASCADED CHECK OPTION`; the role's base-table INSERT is revoked. Proven live:
  view-INSERT with `app_name='data_acquisition'` → check option violation;
  direct base-table INSERT → permission denied. `index.js` also pins `APP_NAME` as a
  code constant and fails boot on a mismatched env.
- **F2**: single finalization path in `onBoot` — `makeAppRunLog` moved inside the
  lifecycle, both sinks (`dbInsertLogEvents`, `writeLogEvents`) return success/failure,
  stream errors are captured and awaited (`write_stream.end` callback + error listener),
  `db.$pool.end()` failures counted, `onBoot().catch(...)` terminates. Proven: the
  Codex repro (closed `PGPORT`) now exits 1.
- **F5**: unknown job throws after the WARN log event → exit 1 (`node index.js bogus`
  proven). `noop` remains the explicit successful no-op.
- **F4**: `buildSsl` extracted to `utils/db/build-ssl.js` (pure, unit-tested):
  `verify-ca`/`verify-full` fail closed on missing/unreadable CA, unknown modes abort,
  `verify-ca` gets `checkServerIdentity` skip, `require` kept as documented exception.
  Live `verify-full` against `pg_db` with the mounted CA verified (TLSv1.3) and made
  the deployed + `.env.example` default; broken-CA run proven to exit 1.
- **F6**: `addLogEvent` normalizes `err` (`err?.stack ?? (err == null ? "Unknown
  error" : String(err))`).

Deferred findings:

- Cross-database `CONNECT`/`TEMP` via `PUBLIC` and PUBLIC-function `EXECUTE` — not
  addressable per-role without cluster-wide impact; documented in the role script
  header with the pg_hba.conf option (per Codex's own framing).
- `psql -v pw=` process-visibility during one-time provisioning — accepted low
  residual per the review itself.

## Problems Encountered

- Problem: `ALTER TABLE ... OWNER` on a serial-linked sequence is rejected by PG.
  Resolution: alter tables/views only; sequences follow the table owner; verify
  block still checks them. Script re-run clean (idempotent).

## Follow-Up Tasks

- Phase 2 (`prompt_2_materialize.txt`): materialize job — watermark, partition-pruned
  `warn_error_logs` scan, normalize/fingerprint/classify, `ON CONFLICT DO NOTHING`
  into `incidents.error_events`; exercise the failure exit path.
  **Re-evaluated 2026-07-14 (FLOW Step 3) before implementation** — prompt revised:
  explicit `PRODUCING_APPS` allowlist with `incident-engine` self-log exclusion
  (feedback loop proven live), `acquisition-v2` parked, fingerprint text chain extended
  to `err_msg || note.message || note.txt` while it's still free (`FP_VERSION` stays 1),
  Phase 1 conventions folded in. Details: `notes/phase_2_reevaluation.md`.
- Decide cron cadence (one `run` line vs. staggered `materialize`/`assess`) when the
  real jobs exist; install the cron line.

## Commit Readiness

- Requirements implemented: yes (all Phase 1 deliverables).
- Write-isolation / least-privilege rules hold: yes — proven fail-closed at the
  credential layer.
- Jobs idempotent (watermark + ON CONFLICT): n/a this phase (keys + state table in
  place; no job logic yet).
- Assessment deterministic (no LLM in critical path): n/a (no assessor yet).
- Source queries read warn_error_logs only, partition-pruned: n/a (no source reads
  yet).
- Schema assumptions confirmed live: yes (see Schema Facts).
- Review findings addressed or deferred: yes.
- Validation recorded: yes.
- Ready to commit: yes, pending developer confirmation.

---

# Phase 0 — Workflow Scaffold

Date:
2026-07-13

Status:
Completed

Prompt:
`prompts/prompt_0_workflow_scaffold.txt`

Git Commit:
`2d2039f`

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
