# Codex Handoff — Phase 4: Deterministic Assessor (L3)

Branch: `phase-4-deterministic-assessor` (off `main` @ `8e724ac`) — **uncommitted working
tree**, nothing pushed.

---

## 1. What this app is

`incident-engine` is a **deterministic error→incident pipeline** over the cron-driven
data-pipeline apps under `/opt/apps` (medical-imaging equipment telemetry: GE / Philips /
Siemens modalities). Those apps log uniformly into `util.app_run_logs` and emit tens of
thousands of WARN/ERROR events a day with no aggregation or assessment — an operator sees a
firehose, not a set of distinct problems.

This app reads that shared error stream (`warn_error_logs` **only** — never `verbose_log`,
which detoasts expensively), collapses it into **incidents** (one per distinct problem ×
affected equipment), classifies each with a **deterministic** rules engine (no LLM), and —
as of this phase — **assesses** severity. It **owns** the `incidents` schema and writes only
there (plus a self-log row via a check-option view).

Orientation: `CLAUDE.md`, `markdown/ARCHITECTURE_PRINCIPLES.md`, `docs/error-taxonomy.md`,
`docs/incidents-schema.md`. Pipeline stages: materialize (L0, Phase 2) → aggregate (L1/L2,
Phase 3) → **assess (L3, this phase)** → state/auto-close (L5, Phase 5, not built).

Phases 0–3 are complete and merged to `main` (unpushed, deliberately).

---

## 2. Scope of this review

Phase 4 implements the L3 assessor: a **pure** `assess(dossier)` behind a pluggable
`ASSESSOR_KIND` seam, plus the job that assembles dossiers and writes results.

**Files to review:**

| File | What it is |
| --- | --- |
| `domain/assessor/contract.js` | NEW — JSDoc typedefs (`Dossier`, `AssessResult`) + frozen `SEVERITY`/`EVENT_TYPE` |
| `domain/assessor/rules.js` | NEW — **the core**: the deterministic rules impl (pure, async) |
| `domain/assessor/index.js` | NEW — the `ASSESSOR_KIND` seam |
| `jobs/assess/index.js` | NEW — the assessment step: all the I/O lives here |
| `utils/db/queries/assess.js` | NEW — dossier SELECT + update predicate |
| `integration/assess_parity.js` | NEW — live-DB parity test (not run by `node --test`) |
| `test/assessor-rules.test.js` | NEW — 44 unit tests |
| `db/schema.sql` | MODIFIED — `incidents.type` + `incidents.assessor_version` (CREATE + idempotent UPGRADE + guarded backfill) |
| `utils/db/sql/pg-helpers.js` | MODIFIED — new `incidents_assessment` ColumnSet; `type`/`assessor_version` added to the (dead) insert ColumnSet |
| `utils/db/queries/incidents.js` | MODIFIED — the Phase 3 aggregate now writes `type` |
| `index.js` | MODIFIED — `assess` job = `aggregate` → `assessIncidents` |
| `integration/rep_determinism.js` | MODIFIED — its TRUNCATE-and-restore became destructive once Phase 4 added assessment columns; restore now re-assesses (§5.7) |
| `docs/*`, `markdown/*`, `utils/db/queries/enrichment.js` | MODIFIED — doc corrections (see §5.1) |

**Getting the diff — read this first, or you will silently miss most of the phase.** The work
is uncommitted, and the core files (`domain/assessor/`, `jobs/assess/`,
`utils/db/queries/assess.js`, both new tests) are **untracked** — so a plain `git diff main`
shows only the 11 modified files and none of the new ones. Use:

```bash
cd /opt/apps/incident-engine
git add -N .            # intent-to-add: makes untracked files visible to git diff; stages no content
git diff main           # now the complete phase, new files included
git diff --stat main    # ~17 files
```

`git add -N` is non-destructive (it records path intent, not content); `git reset` undoes it.
Or just read the files directly — the table above is the complete list.

**Explicitly OUT of scope** (settled in earlier phases — please don't relitigate):

- The CommonJS / pg-promise / cron-batch-in-Docker stack, and the `data_acquisition` house
  style generally.
- The fingerprint formula, `normalize.js`, and the classifier table. **Untouched this phase**;
  `FP_VERSION` stays 1. The assessor only *reads* the taxonomy's flags.
- The Phase 3 aggregate's exactly-once design (watermark, additive counter, post-lock
  `clock_timestamp()` cursor, clock-nondecreasing assumption). Reviewed over three rounds
  already. **In scope only** insofar as this phase added a `type` column to its upsert.
- The entity grain (`sme → system_id → __global__`) and the dropped `job_id`.
- The fact that `incidents.phase` is `''` and enrichment is coarse (Phase 3 decisions).

**The prompt is `prompts/prompt_4_deterministic_assessor.txt`, but note it was REVISED
pre-implementation** (FLOW Step 3 — see `notes/phase_4_reevaluation.md` for the evidence).
Four of its original clauses were wrong against live data. Then Step 2 found three MORE wrong
claims — including some in the re-evaluation note itself (§5.1). **Please treat both the
prompt and that note as fallible**; the live DB is the authority.

---

## 3. How to run / verify it

`node` is **not** on the host. The DB is `staging` on container `pg_db:5432`; the app connects
as the least-privilege role `incident_engine_rw` (creds in the gitignored `.env`).

```bash
cd /opt/apps/incident-engine

# Unit tests (dependency-free, no DB). 93/93 expected.
docker run --rm -v "$PWD":/w -w /w node:lts node --test

# Apply the schema (superuser). Idempotent; re-running is safe and proves convergence.
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql

# The job (as incident_engine_rw). `assess` = aggregate + assess; `run` = materialize + assess.
docker compose run --rm app node index.js assess
docker compose run --rm app node index.js run

# Live parity test — the important one (see §5.2). PASS expected.
docker compose run --rm app node integration/assess_parity.js

# Phase 3's integration tests should still pass (this phase touched its upsert):
docker compose run --rm app node integration/aggregate_race.js
docker compose run --rm app node integration/rep_determinism.js
```

Useful live queries:

```sql
-- distribution + "is this a real queue or a relabeled firehose?"
SELECT severity, count(*) AS rows, count(DISTINCT fingerprint) AS problems
FROM incidents.incidents GROUP BY 1;

-- the Phase 5 boundary: MUST be 0
SELECT count(*) FROM incidents.incidents
WHERE state IS NOT NULL OR resolved_at IS NOT NULL OR action_state IS NOT NULL;

-- provenance
SELECT assessor_kind, assessor_version, count(*) FROM incidents.incidents GROUP BY 1,2;
```

**The pipeline is cron-live at `:25,:55`** (`node index.js run`), so counts move under you.
Live at hand-off: 504 incidents / 82 fingerprints / ~229k L0 events; high 184 / medium 148 /
low 28 / info 144.

---

## 4. Hard constraints the code must respect

Please try to **falsify** these (`markdown/ARCHITECTURE_PRINCIPLES.md`):

1. **Determinism / purity.** `assess(dossier)` must be a pure function — no DB handle, no
   clock, no network, no `process.env` read *inside* it. Same dossier → same result, forever.
   Is it *actually* pure? Does anything reach outside the dossier? Is the `TAXONOMY` map built
   at require time a hidden mutable-state hazard?
2. **No LLM in the critical path.** Only the rules impl + the seam exist. Can an unknown
   `ASSESSOR_KIND` silently select something? Can the seam be made to default to a
   non-deterministic impl?
3. **The assessor must NOT set incident `state` or auto-close.** That is Phase 5's alone. I
   tried to make this structural (the `AssessResult` shape has no such field; the
   `incidents_assessment` ColumnSet has no such column). **Is there any path that writes
   `state`/`resolved_*`/`action_*`?**
4. **Write-isolation.** Writes confined to the assessment columns on `incidents.incidents`
   (the app owns `incidents`). `stats.acquisition_history` SELECT-only. No writes outside
   `incidents` other than the self-log. Never `verbose_log`.
5. **Least-privilege.** Connects as `incident_engine_rw`, never a superuser. I believe no new
   grant is needed (the role owns the schema, and both new columns are in it) — please verify
   rather than trust that.
6. **Idempotency.** Re-running `assess` must be stable. There is deliberately **no watermark**
   here (purity ⇒ re-runnability). Is that reasoning sound? Can a re-run double-anything?
   Does the no-op-write filter ever wrongly skip a needed write?
7. **Fingerprint stability.** `FP_VERSION` stays 1; identity domain untouched. The new `type`
   column is a *denormalization* of an existing L0 fact — verify it introduces no new identity
   input and that the "lossless" claim holds.
8. **House style.** CommonJS; writes via `pgp.helpers` ColumnSets, not hand-rolled SQL; DDL
   with `IF NOT EXISTS` + an idempotent UPGRADE section.

---

## 5. Known weak spots — please scrutinize

### 5.1 The docs lied three times, and I only caught it by counting

**Please assume more of this remains.** Step 2 found three confidently-stated,
never-verified claims — repeated across `docs/`, the prompt, AND
`notes/phase_4_reevaluation.md` (which I wrote):

| Claim | Reality | Where it had propagated |
| --- | --- | --- |
| "19 classifier categories" | **20** in the table (22 with caller-set `unknown`/`hanging_exec`) | `docs/error-taxonomy.md`, prompt_4, `enrichment.js`, PHASE_LOG P3, the re-eval note |
| "`error_type` is `''` on ~39 incidents" | **253 of 504** — every `unknown` carries `''` too, not just corroborated rows | PHASE_LOG P3 §Follow-Up, the re-eval note, prompt_4 |
| (implicit) `manual_intervention` and `successful_acquisition` never co-occur | `permission_denied_partial` carries **both** — the prompt's two rules collide head-on | prompt_4, `docs/error-taxonomy.md` |

All three are corrected and now pinned by unit tests. This is the same failure mode as the
Phase 3 taxonomy correction (commit `747e0cc`). **The most valuable thing you can do is check
my new numbers the same way** — I derived them from the live DB and from
`connection_regex.js`, but so did the people who wrote "19".

### 5.2 Unit tests are structurally blind here — the wiring has no such coverage

`assess` is pure and trivially unit-testable, which makes a green suite *seductive and
misleading*. Phase 3 shipped three defects the tests could not see. This phase repeated it
exactly: **the first live `assess` run died with a 42601 while 93/93 tests passed**
(`updated_at = clock_timestamp()` was appended after `pgp.helpers.update()`'s
`FROM (VALUES …) AS v` clause — `node --test` never loads the SQL modules). A grammar bug in
operator-facing text ("1 entity share this fingerprint") was likewise only visible by reading
written rows.

So: **please don't review this by reading the tests.** `integration/assess_parity.js` is my
attempt to cover the gap — it asserts that for every live incident, the stored
(severity, confidence, assessment) equals a fresh `assess()` of a dossier rebuilt from that
same row. **Is that test actually sound, or does it share a bug with the code it checks?** It
deliberately re-states its own dossier assembly rather than importing the job's — but if the
job's assembly is wrong in a way my duplicate is also wrong, it proves nothing.

### 5.3 The blast-radius threshold is the most debatable call in the phase

`BLAST_RADIUS_ENTITIES = 22` (`domain/assessor/rules.js`), justified as ≥~10% of the live
221-entity fleet. Developer-approved after measuring 10 / 22 / 40 (→ 183 / 168 / 119 escalated
rows).

**The uncomfortable part, stated plainly: no threshold makes the `high` queue small.** The data
contains a few very wide fingerprints (top: 59 entities), so at 22 about 150 transport rows land
`high` — from only ~4 distinct fingerprints. Overall: 184 high rows = 16 real problems. My
argument is that this is honest at the `(fingerprint, entity)` grain (59 scanners that cannot
rsync *is* 59 high incidents; an operator view groups by fingerprint). **Please push on this** —
is a 184-row high queue defensible, or did I just relabel the firehose one level up? Note the
prompt's own success criterion was framed in incident counts ("a ~70-incident medium queue"),
which the medium queue does hit (70 unknown-ERROR).

### 5.4 The deviation: assess ALL incidents every run

The prompt (and my own re-eval note §6) said `touched OR severity IS NULL`. **I believe that
predicate is wrong** and implemented assess-all + a no-op-write filter instead
(`utils/db/queries/assess.js` has the full argument): `entity_count` is a *fingerprint*-level
property, so when a fingerprint gains its 22nd entity, its 21 untouched siblings should
re-assess medium→high — a row-local predicate leaves them stale forever.

**Please check this reasoning.** If it's right, the prompt has a design bug. If it's wrong, I
added a full table scan for nothing. Also: is the no-op filter's `JSON.stringify` comparison
sound (key order, JSONB round-trip normalization)? Is a full scan defensible as `incidents`
grows — and is my "bounded by fleet, not event volume" claim actually true?

### 5.5 Type-awareness rests on trusting the producers' WARN/ERROR discipline

A WARN transport fault is capped at `low` and never escalates, reasoning that the producer
logged WARN ⇒ the run continued ⇒ the fault was absorbed. That is the *only* "did we survive?"
signal available — but it trusts other apps' severity discipline. If `hhm_rpp_ge` mislabels a
hard failure as WARN, we under-rate it. Mitigation: anything not literally `'WARN'` is treated
as ERROR (fail-safe). **Is that trust warranted?** 28 live incidents ride on it, and 143 more
(`unknown`+WARN → info) ride on the same assumption.

### 5.7 Phase 4 made a Phase 3 test destructive — and my own checklist run tripped it

`integration/rep_determinism.js` TRUNCATEs `incidents.incidents` and restores "a correct full
aggregation". That was a **complete** restore in Phase 3, when aggregation was all the table
held. Phase 4 added assessment columns the aggregate does not write — so running that test (as
the review checklist's regression step) **silently blanked the severity of all 504 incidents**.
I caught it only because I ran `assess_parity.js` afterwards and it reported
`never-assessed: 504`; the checklist itself looked green.

Fixed: the restore now calls the real `jobs/assess` (with an in-memory run_log stub, so it
still writes no log file / self-log row), verified by running it and re-checking parity.

**Please check two things:** (a) is driving the production job from an integration test's
`finally` block acceptable here, or does the run_log stub couple the test to logger internals
that will break? (b) **The deeper issue is a Phase 5 landmine I want on the record**: this
restore works only because assessment is a *pure function of L0-derived facts*. Lifecycle
`state`/`resolved_at` will NOT be re-derivable from L0, so that TRUNCATE becomes genuinely
lossy the moment Phase 5 lands, and the test needs reworking (snapshot-and-restore, or a
scratch table) rather than another patch. Is there a reason to do that now instead of deferring?

### 5.6 Smaller things I'm unsure about

- **`permission_denied_partial` precedence.** I made `successful_acquisition` outrank
  `manual_intervention` → `low`. Defensible? It's the only both-flags category, so the rule
  order is doing real work on exactly one category.
- **`type` is nullable** while `error_events.entity` (the Phase 3 precedent) is `NOT NULL`. My
  reasoning: `incidents` is the durable rollup, `error_events` is volatile, so an aged-out L0
  leaves nothing to backfill from. Is that right, or is it a `NOT NULL` I ducked? The backfill
  currently leaves **0** nulls.
- **`COALESCE(inc.type, EXCLUDED.type)`** in the aggregate's ON CONFLICT (not the
  representative-order guard the neighbouring fields use), justified by type being
  fingerprint-invariant. Correct, or an inconsistency waiting to bite?
- **`updated_at` via raw `mod: '^'`** in a ColumnSet (`utils/db/sql/pg-helpers.js`) — raw SQL
  injected as a fixed constant. Idiomatic pg-promise, or a footgun next to the "never
  hand-rolled SQL" rule?
- **`assess` is not transactionally serialized against `aggregate`** (deliberate — a concurrent
  insert makes `entity_count` momentarily stale, self-correcting next run). Sound?
- **`RULES_VERSION` bump discipline** is a comment, not a mechanism. Nothing forces it.
- **`critical` is declared but never emitted.** Reserved deliberately, or dead vocabulary?

---

## 6. What is intentionally deferred — please don't file these as bugs

- **No LLM assessor.** Seam only, by design (Determinism Rule). Advisory-only if ever added.
- **No `state` / auto-close / re-open.** Phase 5. `action_state`/`action_ref` are reserved for
  a possible L4 and are never written.
- **`error_type` is `''` on 253 rows.** A tracked Phase 3 follow-up. Phase 4 sidesteps it by
  keying on `category`; populating it needs a category→type map in the SQL aggregate.
- **`pg_column_sets.incidents.incidents` is dead code** — the Phase 3 aggregate is set-based
  SQL and never formats against it. Noticed this phase, kept accurate, not removed (deleting a
  Phase 3 artifact is out of scope). Flagging it so you don't have to.
- **`incidents.phase` is `''`; enrichment is coarse** — Phase 3 decisions.
- **The monotonic-cursor exactly-once hardening** and **persisting `eventText` on L0** — Phase 3
  upgrade paths, recorded and unscheduled.
- **The `high` queue size** is a *known* debate (§5.3), not an oversight — but arguments
  welcome.

---

## 7. Output format requested

Bias toward **fewer, high-confidence findings** over breadth. For each:

- **Severity** — high / medium / low
- **`path:line`**
- **What & why** — the concrete failure mode, ideally a trace or a query that demonstrates it
- **Suggested fix**

Priority order:

1. **Correctness of the assessment written to the DB** — anything where the stored row differs
   from the pure function's output, or where the write path is wrong (this is where both of
   this phase's real defects lived, and where unit tests are blind).
2. **Violations of the hard constraints in §4** — especially any path that writes `state`,
   escapes the assessment columns, breaks purity, or needs a grant we don't have.
3. **The judgment calls in §5.3 / §5.4 / §5.5** — the threshold, the assess-all deviation, and
   the WARN-trust assumption. Reasoned disagreement is more useful here than a code nit.
4. **Any remaining false claim in the docs/comments** — §5.1 suggests my prior is badly
   calibrated on this. If a comment asserts a number, please check it.
5. House-style / maintainability nits — last, and only if they'd actually bite someone.

If a finding is "this is fine but the comment explaining it is wrong", that's worth filing —
this repo's comments are load-bearing and a wrong one has already caused a correction commit.
