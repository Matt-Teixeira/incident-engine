# Codex Handoff — Phase 6: Engine Classifier Layer (classify the unknowns)

Branch: `phase-6-classify-unknowns` (off `main` @ `d8eab9f`, which is the prompt commit) —
**uncommitted working tree**, nothing pushed. The production cron runs the PINNED Phase 5
worktree (`8307bd5`), so — for the first time — this branch is NOT live; that shapes the
validation story (§5.2).

## 1. What this app is

`incident-engine`: deterministic error→incident pipeline (materialize → aggregate → assess
→ state; Phases 2–5, all reviewed and deployed). This phase attacks the largest remaining
dishonesty: 213 incidents / ~184k events sat in `unknown` at interim-medium (the Phase 4 M2
decision), although the messages decompose into ~12 recognizable families. Orientation:
`CLAUDE.md`, `docs/error-taxonomy.md` (now two layers), `notes/review_results_phase_{4,5}.md`
for the F2/M2 history this phase discharges.

## 2. Scope of this review

| File | What |
| --- | --- |
| `utils/classify/engine_regexes.js` | NEW — **the core**: 9 engine categories, producer evidence cited per entry |
| `domain/classify.js` | MODIFIED — two-layer composition (production first, engine on miss) |
| `domain/assessor/rules.js` | MODIFIED — R7b branches (halt/crash/quality/status), actions, R1 permanent policy, `RULES_VERSION=2` |
| `test/classify.test.js` | MODIFIED — layering, 26-text no-collision sweep, per-family classification |
| `test/assessor-rules.test.js` | MODIFIED — restructured counts (20+9+2), per-family severities, interim-language-absent sweep |
| `docs/error-taxonomy.md`, `docs/incidents-schema.md` | MODIFIED — two-layer vocabulary + verdict table |
| `markdown/PHASE_LOG.md`, `markdown/PROMPTS.md` | records |

Diff: `git add -N . && git diff main`. **No schema change; no SQL change; no job change** —
this phase is vocabulary + severity rules only.

Out of scope (settled): the mirror itself (`connection_regex.js`, verbatim, untouched —
diff it against `/opt/apps/data_acquisition/util/tools/connection_regex.js` to verify);
fingerprint/normalize (FP_VERSION 1); the state machine, recovery scope, and oracle
provenance (Phase 5, 3 rounds); upstreaming (tracked, not this phase).

## 3. How to run / verify

```bash
cd /opt/apps/incident-engine
docker run --rm -v "$PWD":/w -w /w node:lts node --test          # 196/196
docker compose run --rm app node index.js run                    # dev-tree run, new classifier
docker compose run --rm app node integration/assess_parity.js    # PASS
```

```sql
-- engine-category convergence so far (grows with each dev-tree run; completes at deploy):
SELECT category, category_source, count(*), sum(occurrence_count)
FROM incidents.incidents WHERE category NOT IN ('unknown') AND category NOT IN
 (SELECT DISTINCT error_category FROM incidents.error_events WHERE inserted_at < now() - interval '30 days')
GROUP BY 1,2;  -- or simply: WHERE category IN ('job_halted','no_new_data',...)
-- the residual policy: no reason may say 'interim'
SELECT count(*) FROM incidents.incidents WHERE assessment::text ILIKE '%interim%';  -- expect 0
```

## 4. Hard constraints to falsify

1. **The mirror is untouched and unshadowable.** `connection_regex.js` byte-identical to
   production; the engine table is consulted only on production miss (`||` in classify.js);
   the no-collision sweep pins one real sample per production pattern. Can you construct a
   text where the engine layer changes a production outcome?
2. **Every verdict is producer-evidence-backed.** Each `engine_regexes.js` entry cites
   file:lines. The F2 standard is the bar — check the citations against the actual code
   (all three producer repos are readable). `Command failed: ...rsync_mmb.sh` deliberately
   stays unknown (inconclusive).
3. **Purity/determinism unchanged**: classify is two ordered tables; the assessor's new
   branches dispatch on entry fields; `type` still moves severity nowhere.
4. **The obligations discharged**: no reason string contains "interim" (unit-swept + SQL
   above); `RULES_VERSION=2` stamped on all 509 (one-time re-stamp, then re-run 0).

## 5. Known weak spots — scrutinize

### 5.1 Regex breadth vs. the messages' truth

`input_file_missing` unifies 5 message shapes + the ENOENT exception variant into one
category on the claim they share a root cause (expected input absent). If any of those
shapes has a DIFFERENT producer meaning I missed, the unification is wrong. The anchored
patterns (`^File not found$` etc.) are deliberately narrow — check they neither over- nor
under-match (e.g. an ENOENT from a non-input path would land here; is that acceptable?).

### 5.2 Convergence: ~97% complete at hand-off (the staged-convergence caveat mostly dissolved)

A timed dev-tree run caught the :45 producer burst ahead of the :55 pinned cron and
converged nearly everything in one pass. Live now: `unknown` is down from 213 incidents /
~184k events to **7 / 426** — the residuals are dormant stragglers from known families (3
already resolved) that converge on their next recurrence. Verify the convergence mechanism
anyway (representative refresh → `category_source='classifier'` → new severity), and note
the between-deploys dynamic: until this phase deploys, pinned-cron ticks still classify new
events `unknown`, so the stragglers may briefly flap between counts (not categories).

> **[CORRECTED in the round-1 fix delta]** The "(not categories)" claim above is FALSE —
> self-caught 17:39 while responding to round 1. Newest-representative refresh means every
> pinned-cron tick that processes a burst flips actively-recurring incidents' CATEGORIES
> back to `unknown` (measured: all 213 were back to `unknown` / all 509 at v1 two hours
> after the §5.2 snapshot). The convergence numbers below are a transient post-dev-run
> snapshot, not a persistent state; true convergence lands at deploy. See
> `codex_handoff_phase_6_fixes.md` §"the oscillation is total".

### 5.3 The end-state queues (measured, not projected)

medium 312 → 225, high 196 → 197, info 1 → 87. Concretely: `input_file_missing` 121 medium
(developer-decided), `no_new_data` 86 info, `unhandled_type_error` 26 medium, `job_halted`
1 medium, needs-human highs +9 (`tunnel_not_found`, `config_missing`,
`credential_decrypt_error`). The review question now asked a third time: is this legible
reality, or relabeling? (My answer: the 87 info carry producer evidence they are the normal
state; the surviving mediums are real per-system gaps. Push back if a family's evidence
does not support that.)

### 5.4 Mixed-category fingerprints are now real

Old L0 events say `unknown`, new ones say the engine category, same fingerprint. Newest-
representative-wins converges forward; the Phase 3 "prefer confident over unknown" caveat
remains unimplemented (no flap observed). If you can construct a flap path, that caveat
becomes this phase's fix.

### 5.5 SELF-CAUGHT: cross-version assessment oscillation until deploy

The deploy boundary protects code execution but both trees share the production DATABASE —
and version-stamped assess-all makes that visible: every :25/:55 pinned-cron tick (v1
rules) rewrites all 509 assessments to v1 (engine categories fall to the not-in-taxonomy
default, medium @0.2; the 7 residual unknowns regain the interim reason), and any dev-tree
assess run flips them back to v2. Observed live: 15:55 v1 wrote 509, 15:57 v2 wrote 509.
Caught by reading the run summary (a re-run that should write 0 wrote 509 — the standing
read-the-rows lesson).

Not corruption — each state is internally consistent under the version that wrote it, and
lifecycle is severity-independent — but three consequences for YOU:
  * **Run `docker compose run --rm app node index.js assess` immediately before
    `assess_parity.js`**, or parity will fail spuriously against a v1 half-cycle.
  * Interim policy until deploy: dev-tree assess runs are now avoided, so the cron owns
    the table (v1 view) during review; the one-flip-to-v2 happens at deploy.
  * The lasting lesson (recorded in PHASE_LOG): dev-tree validation runs against the
    shared DB are THEMSELVES production writes. If a future phase's writes were not
    version-idempotent like these, this same dynamic would be data corruption — worth a
    review opinion on whether validation needs its own isolation story.

### 5.6 New error_type vocabulary is engine-only

`halt`/`crash`/`quality`/`status` exist only in the engine layer and R7b. A future
production-mirror re-sync could introduce a colliding error_type with different semantics —
nothing guards that today beyond the slug-collision test.

## 6. Deferred — not bugs

Upstreaming the engine entries to `data_acquisition`; the dormant-incident stragglers that
keep `unknown` until recurrence or stale-close (counted at deploy); the oracle `error_type`
corroboration follow-up (Phase 3); prefer-confident refresh (caveat until flap observed).

## 7. Output format

Severity / `path:line` / what & why / suggested fix. Priorities: (1) a family whose
producer evidence does not support its verdict (check the citations); (2) any way the
engine layer alters a production classification; (3) regex over/under-match against real
message shapes; (4) the §5 judgment calls; (5) wrong claims in comments/docs — every phase
has had one.
