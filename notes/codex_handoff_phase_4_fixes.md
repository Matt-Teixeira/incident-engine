# Codex Handoff — Phase 4 FIX ROUND (delta)

Branch: `phase-4-deterministic-assessor` — still **uncommitted**, nothing pushed.
Round 1: `notes/codex_handoff_phase_4.md` → `notes/review_results_phase_4.md`
(verdict *needs fixes*: 1 high, 2 medium).

**All three findings were verified independently against live data and producer source before
being fixed. All three were real.** Thank you — F1 in particular was a genuine correctness bug
that my own parity test was structurally incapable of catching (which was F3).

**Scope of this re-review: THE FIXES ONLY.** Please don't re-review what round 1 verified clean
(the seam, purity, the Phase 5 boundary, idempotency, the write path, the ColumnSet, the
threshold justification). Per-finding verdict requested: **closed / partially closed / not
closed**.

---

## Finding → fix

| # | Sev | Finding | Fix | Files |
| --- | --- | --- | --- | --- |
| F1 | high | Oracle-only categories drive incorrect assessments | **Persisted provenance** (your primary suggestion, not the interim detector) + a gate in the rules | `enrichment.js`, `db/schema.sql`, `incidents.js`, `assess.js`, `jobs/assess`, `rules.js`, `contract.js` |
| F2 | medium | WARN does not mean the operation succeeded | WARN now costs **confidence, never severity**; every recovery claim removed and pinned by a test | `rules.js`, `contract.js`, `docs/error-taxonomy.md` |
| F3 | medium | Parity test shares the dossier query it verifies | Rewritten with **independent SQL** + explicit provenance/type validation against L0 | `integration/assess_parity.js` |
| — | — | *(found while fixing)* backtick in a SQL template literal broke `require()` — again | New `test/sql-modules-load.test.js` guard | `test/sql-modules-load.test.js` |

### F1 — what I did, and one deliberate departure from your suggestion

You offered two paths: persist provenance, or (interim) treat
`category != 'unknown' && error_type = ''` as oracle-only. **I did the first and deliberately
avoided the second at runtime**, because the interim detector is a time bomb here:

> It is exact *today* only because `classify()` returns `error_type: ''` for exactly the
> `unknown` case. **"Populate `error_type` on oracle-corroborated incidents" is an
> already-tracked Phase 3 follow-up** (PHASE_LOG Phase 3 §Follow-Up). The day someone lands
> it, that predicate silently matches nothing, the gate opens, and this HIGH bug returns with
> no test failing.

So:

- **`incidents.category_source VARCHAR(16)`** (`classifier` | `oracle`), written by the
  aggregate from **`CATEGORY_SOURCE_EXPR`** — derived from *the enrichment join that actually
  made the decision* (`rep.error_category = 'unknown' AND se.enr_category IS NOT NULL`), which
  cannot rot that way.
- Refreshed under the **identical** ON CONFLICT guard as `category` (they are one fact in two
  columns; desync would silently mislabel provenance).
- **R0** in `rules.js`: anything not explicitly `'classifier'` is assessed as `unknown`.
  Fail-safe — NULL/garbled/typo'd provenance is untrusted, never trusted-by-default.
- The discarded oracle category is recorded in `assessment.reasons` (a real hint for a human,
  just not a basis for severity).
- The `error_type = ''` signature IS used **once**: the `db/schema.sql` backfill for rows whose
  join cannot be replayed (the oracle has moved on). It is correct at that instant and never
  consulted again. **This is the one place I'd most like a second opinion.**

Result — exactly your predicted numbers: **high 184 / medium 144 / info 176**, low → 0
(32 severities changed).

### F2 — scope note, and one thing I did NOT change

Confirmed from source, not just accepted: `exec-hhm_data_grab.js:146` logs the connection error
**WARN** then `return false`s on **both** branches (the *success* path is the one passing
`successful_acquisition: true`), and `jobs/demo_systems/index.js:124` logs `JOB HALTED` **WARN**
when `fileSizeAfterRsync === null` and returns. So WARN is a *failure* path.

Changed: `manual_intervention`+WARN medium→**high** @0.75; transport+WARN low→**blast-radius
split** @0.6; file+WARN low→**medium**; `hanging_exec`+WARN low→**medium**. All "the fault was
absorbed" / "the run continued" strings are gone; a test sweeps all 22 categories × WARN and
fails on any reason matching `/absorbed|run continued|survived/i`.

**Live impact: zero rows moved** — because *every* transport/manual-intervention WARN incident
turned out to be oracle-sourced (F1), so R0 makes them all `unknown`. The caps were live dead
code. Luck, not design.

**NOT changed, deliberately — please weigh in:** `unknown` + WARN → `info` is now the ONLY rule
where `type` moves severity. It is **176 incidents (~145k events), including `JOB HALTED`
(~28k events)** — which your own evidence shows is a real acquisition failure, not the
"pipeline-status noise" the Step-3 note called it. I did not reverse it unilaterally because it
is a twice-developer-approved product decision and promoting it gives **high 184 / medium 320 /
info 0** — the firehose Phase 3 existed to collapse. Its reasons are now factual (no recovery
claim). My view: the durable fix is to **classify** those messages so they leave `unknown`
entirely (`error_category` is not in the fingerprint, so `FP_VERSION` is unaffected) — but that
means editing `connection_regex.js`, which `data_acquisition` owns and this app copies verbatim,
so it is a cross-app call and a Phase 4 non-goal. **Is deferring that defensible, or is `info`
on a real acquisition failure a bug I should be fixing now?**

### F3 — independence restored

`integration/assess_parity.js` no longer imports anything from `utils/db/queries/assess.js`.
Its SQL is written independently and derives from the deepest facts available:

- `entity_count` — correlated `count(DISTINCT entity)`, not the job's `blast` CTE
- `type` — read back from `error_events` (L0) and compared to the denormalized column; also
  asserts no fingerprint carries >1 type (the losslessness claim)
- `category_source` — cross-checked **against L0**: a `classifier` category MUST appear in the
  incident's own events; an `oracle` one must NOT (the invariant F1 violated)
- an oracle-sourced category MUST resolve to `unknown`

The file carries an explicit independence rule at the top. **Does it still share a blind spot
with the job?** It re-states `toDossier` by hand, which is duplication I chose on purpose — but
if the job's assembly and my restatement drift in the same direction, it still proves nothing.

### The extra one — a repeat defect, now guarded

While writing the F1 refresh comment I typed `` `category` `` inside the SQL **template
literal**. It terminated the string; `assess` died at require() with **101/101 unit tests
green**. This is the identical defect Phase 3 hit in the same file (PHASE_LOG Phase 3 §Process
note). Twice is a pattern, so: **`test/sql-modules-load.test.js`** requires every SQL-owning
module and asserts the exports are non-empty backtick-free strings, plus structural landmarks
(upsert still has ON CONFLICT/RETURNING, still writes `category_source`/`type`, no unevaluated
`${}`; dossier SELECT still carries the contract's fields; the update predicate is only a
predicate). **Verified by re-injecting the real bug — the guard fails; removed — it passes.**

---

## How to verify

```bash
cd /opt/apps/incident-engine
git add -N . && git diff main          # untracked files are most of the phase — see round 1 §2

docker run --rm -v "$PWD":/w -w /w node:lts node --test                  # 113/113
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql    # adds category_source, backfills
docker compose run --rm app node index.js assess                         # exit 0
docker compose run --rm app node index.js assess                         # re-run: 0 written
docker compose run --rm app node integration/assess_parity.js            # PASS (independent SQL)
docker compose run --rm app node integration/aggregate_race.js           # PASS
docker compose run --rm app node integration/rep_determinism.js          # PASS (⚠ destructive; self-restores)
```

```sql
-- the HIGH finding, before/after
SELECT category_source, severity, count(*) FROM incidents.incidents GROUP BY 1,2 ORDER BY 1;
-- no oracle-sourced row may carry a category-derived severity:
SELECT count(*) FROM incidents.incidents i
 WHERE i.category_source='oracle'
   AND NOT (i.assessment->'reasons')::text LIKE '%recovery oracle%';   -- expect 0
```

Round-1 numbers that MOVED: distribution is now **high 184 / medium 144 / low 0 / info 176**
(was 184/148/28/144); unit tests **113** (was 93); provenance **464 classifier / 40 oracle**.
Unchanged: 504 incidents / 82 fingerprints, exactly-once delta 0, zero lifecycle leaks.

**Independent corroboration worth knowing:** `rep_determinism.js` TRUNCATEs `incidents` and
rebuilds via the aggregate — provenance came back **464/40, identical to the backfill**. So the
join-derived `category_source` and the one-time `error_type=''` backfill agree exactly, via two
completely different routes. Neither was trusted; they concur.

---

## Weak spots in THESE fixes — please scrutinise

1. **The backfill signature** (`db/schema.sql`) — the one place `error_type = ''` still
   appears. Correct now; a no-op after the tracked follow-up lands. Is "used once, at
   migration, on rows whose join cannot be replayed" genuinely safe, or should the backfill
   refuse to run / RAISE if it detects the follow-up has landed?
2. **R0's fail-safe default.** Untrusted ⇒ `unknown` ⇒ often `info` (for WARN). Is failing
   *quiet* the right direction, or should an unverifiable provenance be *louder* than the
   category it discards?
3. **`category_source` refresh guard.** I reused `category`'s exact ON CONFLICT guard. Is
   there an interleaving where the pair still desyncs?
4. **F2's zero live impact.** The caps were dead code because of F1. Did I actually fix the
   rule, or just move it somewhere the data cannot reach yet?
5. **The open `unknown`+WARN question** above — the one I most want a second opinion on.
6. **`RULES_VERSION` stays 1** though the rules changed materially. Reasoning: v1 has never
   been committed or deployed, so it is still "the version Phase 4 ships"; and assess-all
   re-assesses everything each run regardless. Right call, or should it be 2?

## Output format

Same as round 1: severity / `path:line` / what & why (with a trace or query) / suggested fix.
Bias to fewer, high-confidence findings. Priority: (1) did the fixes actually close the
findings, (2) did they introduce anything new, (3) the judgment calls above.
