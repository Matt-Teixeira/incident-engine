# Review Results — Phase 4 (Deterministic Assessor)

Round 1. Source: Codex, from `notes/codex_handoff_phase_4.md`.
Verdict: **needs fixes** — 1 high, 2 medium. **All three confirmed against live data and
producer source, and all three fixed.**

Reviewer's own verification (unchanged by the fixes): 93/93 unit tests, live parity PASS,
generated UPDATE SQL valid, live counts matched the handoff, zero mixed-type fingerprints /
null types / lifecycle leaks. They did not run the destructive rep-determinism test or
reapply the schema.

---

## F1 (HIGH) — Oracle-only categories drive incorrect assessments

**Finding.** The assessor treats `incidents.category` as the event's classifier result, but
Phase 3 replaces `unknown` with the latest non-unknown category for the same `system_id`,
with no run or time correlation (`utils/db/queries/enrichment.js`). 40 incidents have a
non-unknown category while their classifier `error_type` is empty; all 40 categories are
absent from their own L0 events. Examples: "No new file data" assessed as `credentials`;
ENOENT/TypeError failures assessed as `rsync_io_timeout`.

**Verified independently — confirmed, and worse than stated.** Of the 40, **zero** have their
assessed category anywhere in their own L0 events:

| assessed as | severity | incidents | corroborated by own L0 |
| --- | --- | --- | --- |
| `rsync_io_timeout` | low | 27 | **0** |
| `rsync_io_timeout` | medium | 8 | **0** |
| `credentials` | medium | 4 | **0** |
| `host_unreachable` | low | 1 | **0** |

Actual messages: `No new monitoring data found.` → `rsync_io_timeout`; `missing host_ip` →
`rsync_io_timeout`; `File not present` → `host_unreachable`.

**Root cause (mine).** `enrichment.js` documented the corroboration as "advisory only" from
day one. Nothing *enforced* it, and the docs simultaneously reassured the reader that "the
oracle's values ARE our vocabulary, so `category` is always a valid classifier category" —
which is true of the *string* and irrelevant to whether it describes *this* incident. I read
the reassurance and consumed advisory data as fact. The first consumer of an advisory field
consumed it as evidence — which is what "advisory with no enforcement" always converges to.

**Fix — the reviewer's PRIMARY suggestion, not the interim one.** Persist provenance:

- `incidents.incidents.category_source VARCHAR(16)` — `'classifier' | 'oracle'` (`db/schema.sql`,
  CREATE + idempotent UPGRADE + backfill).
- `CATEGORY_SOURCE_EXPR` (`enrichment.js`) derives it **from the enrichment join itself** —
  the thing that actually made the decision. The aggregate writes it, refreshed under the
  *identical* ON CONFLICT guard as `category` so the pair can never desync.
- The dossier carries `category_source`; **R0** in `rules.js` gates on it and assesses
  anything not explicitly `'classifier'` as `unknown`, surfacing the discarded category in
  the reasons (it is a real hint for a human, just not a basis for severity).

**Why not the interim detector** (`category <> 'unknown' AND error_type = ''`): it is exact
*today* only because classify returns `error_type: ''` for exactly the unknown case — and
"populate `error_type` on corroborated rows" is an **already-tracked Phase 3 follow-up**. The
day someone lands it, that detector silently stops matching and this HIGH bug returns with no
test failing. It is used *once*, in the backfill (where it is the only signature available for
rows whose join cannot be replayed), and never at runtime.

**Result.** 32 severities changed; distribution now **high 184 / medium 144 / info 176**
(low → 0) — exactly the reviewer's predicted numbers. Pinned by unit tests (incl. the two
named regressions) and by the parity test asserting provenance against L0.

---

## F2 (MEDIUM) — WARN does not mean the operation succeeded

**Finding.** Several branches asserted WARN means "the run continued"/"the fault was absorbed"
and capped severity. Producer behaviour contradicts it: `exec-hhm_data_grab.js:146` logs a
connection problem as WARN then returns false, and records `successful_acquisition: false`.
Other paths log `JOB HALTED` as WARN and return immediately.

**Verified independently — confirmed.** Read the producer source:

- `data_acquisition/read/exec-hhm_data_grab.js:146` — a `connection_error` is logged WARN,
  then `return false` on **both** branches. The ip_reset path forwards
  `successful_acquisition: extracted_stderr.successful_acquisition` (false for connection
  errors). **The WARN path is the failure path** — the *success* path is the one that passes
  `successful_acquisition: true`.
- `data_acquisition/jobs/demo_systems/index.js:124` — `JOB HALTED` is logged WARN when
  `fileSizeAfterRsync === null` (the rsync produced nothing) and the job returns. **28,171
  live events.** Not noise: a real acquisition failure.

**Root cause (mine).** I flagged this exact assumption in the handoff (§5.5, "is that trust
warranted?") and shipped it anyway without reading the producers. Flagging an unverified claim
is not the same as verifying it — the same failure mode I criticised in the docs (§5.1) and
then reproduced.

**Fix.** WARN now costs **confidence, never severity**. No branch caps on it:

| branch | was | now |
| --- | --- | --- |
| `manual_intervention` + WARN | medium @0.7 | **high @0.75** (ERROR: high @0.9) |
| transport + WARN | **low @0.6, never escalates** | blast-radius split like ERROR, @0.6 (ERROR @0.8) |
| `file` family + WARN | low @0.6 | **medium @0.6** |
| `hanging_exec` + WARN | low @0.5 | **medium @0.4** |

Every reason string asserting recovery is gone, replaced with the fact ("producer labeled this
WARN rather than ERROR — which says nothing about whether the acquisition succeeded"). A unit
test now sweeps **all 22 categories × WARN** and fails on any reason matching
`/absorbed|run continued|survived/i`, so the claim cannot creep back. The producer evidence is
recorded at the top of `rules.js` and in `contract.js` so the next person does not re-derive it.

**Live impact: zero rows moved** — because *every* transport/manual-intervention WARN incident
turned out to be oracle-sourced (F1), so after R0 they are all `unknown`. The caps were live
dead code. That is luck, not design: the rules were wrong and would have mis-rated the first
genuine classifier-backed WARN transport incident to arrive.

**Left open for the developer** (see PHASE_LOG §Follow-Up): `unknown` + WARN → `info` (176
incidents, ~145k events, incl. `JOB HALTED`) still uses `type` to split severity. Its
reasons are now factual (no recovery claim), and it rests on a *developer-approved* decision
justified as "unclassified ⇒ not actionable" rather than "WARN ⇒ recovered" — but the
`JOB HALTED` evidence undermines the Step-3 note's characterisation of that bucket as
"pipeline-status noise". Not changed unilaterally: it is a twice-approved product decision
worth 176 incidents. The real fix is to **classify** those messages (they would leave `unknown`
entirely, and `error_category` is not in the fingerprint, so `FP_VERSION` is unaffected).

---

## F3 (MEDIUM) — The parity test shares the dossier query it claims to verify

**Finding.** `integration/assess_parity.js` duplicated `toDossier` but imported and executed
the production `SELECT_DOSSIERS_SQL`, so a wrong category/type/blast-radius expression is
reproduced identically by both paths. F1 proves it: parity passed while 40 dossiers carried
unrelated oracle categories.

**Verified — confirmed, and self-inflicted.** I named this exact risk in the handoff (§5.2:
"is that test actually sound, or does it share a bug with the code it checks?"). It was not.
It tested the JS mapping and nothing else.

**Fix.** Rewritten with **independent SQL** that derives expectations from the deepest facts
available rather than from the columns the job read:

- `entity_count` — a correlated `count(DISTINCT entity)` subquery, not the job's `blast` CTE.
- `type` — read back from `incidents.error_events` (L0) and compared to the denormalized
  `incidents.type`; also asserts no fingerprint carries >1 type (the losslessness claim).
- `category_source` — cross-checked **against L0**: a `'classifier'` category must appear in
  the incident's own events; an `'oracle'` one must not. This is the invariant F1 violated.
- An oracle-sourced category must resolve to `unknown` — F1, pinned.

The file now carries an explicit **independence rule**: it must not import from
`utils/db/queries/assess.js`, because that import *is* the bug it exists to detect.

---

## Not raised by the review — found while fixing it

**A backtick inside the SQL template literal broke `require()` — again.** While adding the
`category_source` refresh comment to `incidents.js`, I wrote `` `category` `` in markdown
style inside the template literal. It terminated the string; `node index.js assess` died at
require time with **101/101 unit tests green**. This is the *identical* defect Phase 3's
round-3 review hit, in the same file, documented in PHASE_LOG Phase 3 §Process note.

Twice is a pattern, and "remember not to type a backtick" is not a control. Added
**`test/sql-modules-load.test.js`**: it requires every module owning SQL and asserts the
exports are non-empty backtick-free strings, plus structural landmarks (the upsert still has
its ON CONFLICT/RETURNING, still writes `category_source`/`type`, no unevaluated `${}`; the
dossier SELECT still carries the fields the contract promises; the update predicate is only a
predicate). No DB needed, runs in milliseconds. **Verified by re-injecting the real bug — the
guard fails; removed — it passes.** It would have caught both incidents instantly.

---

## Re-validation after fixes (all green)

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test          # 113/113 (was 93; +12 F1/F2/F3 + guard)
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql   # category_source: UPDATE 504
docker compose run --rm app node index.js assess                 # exit 0, 504 written
docker compose run --rm app node index.js assess                 # re-run: 0 written / 504 unchanged
docker compose run --rm app node index.js run                    # full cron path, exit 0
docker compose run --rm app node integration/assess_parity.js    # PASS (independent SQL)
docker compose run --rm app node integration/aggregate_race.js   # PASS
docker compose run --rm app node integration/rep_determinism.js  # PASS
```

- **113/113** unit tests.
- Provenance backfill: **464 classifier / 40 oracle**, 0 NULL.
- Distribution: **high 184 / medium 144 / info 176** — matches the reviewer's prediction exactly.
- No oracle-sourced incident carries a category-derived severity; the discarded category is
  recorded in `assessment.reasons`.
- Independent parity PASS across all 504 (provenance vs L0, type vs L0, Phase 5 boundary).
- Exactly-once delta **0**; re-run writes **0**; Phase 3 integration tests still PASS.
- **Bonus proof:** `rep_determinism.js` TRUNCATEs and rebuilds via the aggregate, and
  provenance came back **464/40 — identical to the backfill**. So the aggregate's
  join-derived `category_source` INSERT path independently reproduces the backfill's
  signature. Neither was trusted; they agree.

`RULES_VERSION` stays **1**: the rules changed materially, but v1 has never been committed or
deployed, so it is still "the version Phase 4 ships". Bump on the first *post-commit* change.

## Status

All three findings fixed. Ready for a re-review (`notes/codex_handoff_phase_4_fixes.md`), with
one open developer decision: `unknown` + WARN → `info` (see F2).

---

# Round 2 (re-review of the fixes)

Source: Codex, from `notes/codex_handoff_phase_4_fixes.md`. Round 1's three findings:
effectively **closed** (F1's gate and F3's independence confirmed; F2 closed for known
categories but **held open for `unknown`+WARN** — see M2). New: 2 medium, 1 low, plus a count
correction. All verified live before fixing; M1 and L1 fixed; M2 escalated to the developer.

The reviewer also resolved round 1's open judgment calls in our favor: the one-time
`error_type=''` backfill is safe under the current migration order (with the requirement that
any future error_type-population migration assert provenance is already complete — now
guaranteed structurally, since migrations live in one file applied top-to-bottom and any
future section lands below the Phase 4 SET NOT NULL); the identical category/category_source
upsert guards are sound (both assignments are atomic in one conflict update); F2's zero live
impact does not invalidate the fix; `RULES_VERSION = 1` is right while uncommitted.

## M1 (medium) — Invalid provenance fails quiet and can downgrade a known failure to info — FIXED

**Finding.** `category_source` was nullable with no value constraint, and R0 treated NULL,
`''`, `ORACLE`, and typos identically to `'oracle'` → unknown → (for WARN) **info**. A stored
credentials/WARN incident with a NULL provenance would be buried at "no action" by a
bookkeeping bug — while the reasons falsely claimed the category "came from the recovery
oracle" when the actual cause was a broken writer or migration gap. Confirmed by tracing the
round-1 R0 code: correct.

**Fix — both layers, per the suggestion:**

- **DB**: `category_source` is now `NOT NULL` + `CHECK (category_source IN
  ('classifier','oracle'))` (`chk_incidents_category_source`), in CREATE and as an idempotent
  UPGRADE step after the backfill. Negative-tested live: `UPDATE ... SET category_source =
  NULL` and `= 'bogus'` both rejected; re-apply clean.
- **Rules**: R0 now splits **three ways**. `'classifier'` → trust; `'oracle'` → unknown,
  quiet, naming the discarded category (round 1); anything else → **medium @ 0.2, LOUD,
  type-independent** — never info, reasons name the writer/migration gap instead of blaming
  the oracle, and 0.2 trips the job's WARN log. The job additionally counts
  `invalid_provenance` per run and emits a dedicated WARN ("the DB CHECK constraint is
  missing on this database") if it is ever non-zero.
- **Why not fail the job** (the suggestion's other arm): one bad row must not block
  assessment of the other 500; the DB constraint is the hard stop that keeps the state from
  persisting at all. The per-row medium + dedicated WARN is the loud-but-degraded middle.

Unit tests updated: the round-1 "fail-safe" test asserted the exact quiet behavior round 2
rejected; it now asserts medium/0.2/never-info for all five invalid shapes × both types,
including the reviewer's credentials/WARN case verbatim.

## M2 (medium) — F2 remains open for `unknown`+WARN — DECIDED (interim medium)

**Finding.** The known-category WARN caps are gone, but `unknown`+WARN → info + "No action"
still auto-reduces confirmed failure signals: `JOB HALTED` (1 incident / 28,291 events),
`NO TUNNEL FOUND` (1 / 13,394), plus other missing-data/exception messages. Suggested:
classify the known hard-failure messages before release; until then `unknown`/WARN should not
universally be info.

**Verified — the live composition confirms it** (143 classifier-unknown WARN + 32
oracle→unknown WARN = 175 incidents / 148,429 events at info).

**Not fixed unilaterally.** This is the open decision flagged in both round handoffs: it is a
twice-developer-approved product rule, the only remaining place `type` moves severity, and
each resolution has a real cost (blanket medium → high 184 / medium ~319 / info ~1, the
firehose; classifying now → editing the frozen classifier table this phase explicitly
declared a non-goal, and `connection_regex.js` is `data_acquisition`-owned vocabulary).
Escalated to the developer with options. **Decision (2026-07-16): interim MEDIUM for both
types** — the reviewer's explicit fallback — with the classification of confirmed hard-failure
messages queued as its own follow-up phase (cross-app vocabulary, `FP_VERSION` unaffected).
Applied live: 175 rows rewritten, distribution **high 184 / medium 319 / info 1**, re-run 0,
independent parity PASS. The R1 branch records the interim status in its reasons; `type` now
moves severity nowhere in the rules.

**Count correction (applied):** 175 unknown-resolved WARN incidents / 148,429 events, not
176/~145k — the 176-row info total includes one `rsync_partial` incident. Fixed in
`docs/error-taxonomy.md` and `PHASE_LOG`.

## L1 (low) — Parity provenance check omitted the incident entity — FIXED

**Finding.** `category_in_own_l0` joined L0 on `fingerprint` only, but the incident key is
`(fingerprint, entity)` — another entity's events could vouch for (or falsely indict) this
incident's category.

**Verified — the premise is live, not theoretical:** oracle corroboration is per-entity, so
**9 fingerprints already carry mixed categories across entities**. Fixed: `AND e.entity =
i.entity` added; the invalid-value check also widened from NULL-only to the full vocabulary.
Parity re-run PASS across all 504 — now meaningfully exercised against those 9 fingerprints.

## Re-validation (all green)

113/113 unit tests. Schema re-applied idempotently; constraint negative-tested (NULL and
'bogus' both rejected). `assess` exit 0; re-run writes 0; full `run` exit 0; exactly-once
delta 0. Independent parity PASS (entity-scoped). Distribution unchanged: high 184 /
medium 144 / info 176 (175 unknown-WARN + 1 rsync_partial). Provenance 464/40, 0 invalid.

---

# Round 3 (re-review of the round-2 fixes)

Source: Codex, from `notes/codex_handoff_phase_4_fixes_round_2.md`.
Verdict: **needs minor fixes — no high or medium**; two lows. **CONVERGED.**

Per-finding verdicts on the prior rounds — all closed/accepted:

- **M1 closed** — the NOT NULL/CHECK, three-way R0 gate, medium@0.2 fallback, and dedicated
  WARN are sound; *continuing the job is a defensible degraded mode* (the hard-fail arm is
  formally declined).
- **M2 closed for this phase** — the interim medium rule is consistently implemented and
  exhaustively tested. The interim-M2 reason string is acceptable while the hard failures
  remain unclassified; **the classification follow-up must remove/update it and bump
  RULES_VERSION** (added to that queued phase's requirements below).
- **L1 closed** — the full (fingerprint, entity) correlation is present and exercised by the
  nine live mixed-category fingerprints.
- **Backfill ordering accepted** — no RAISE needed under the documented single-file ordering.
- **RULES_VERSION = 1 accepted** while this remains the uncommitted first release.

Reviewer verification: 114/114 tests; independent parity PASS across 504; distribution
184/319/0/1; provenance 464/40/0 invalid; constraint validated; `git diff --check` clean.
(The WARN bucket had drifted 148,429 → 149,113 events between handoffs — flagged by the
reviewer as ordinary active-ingestion drift, not a discrepancy.)

## L1 (low) — invalid provenance recommended the wrong remediation — FIXED

The invalid-provenance branch returned `GENERIC_ACTION` ("add an assessor rule"), but the gap
is in the DATA (a broken writer / missing constraint), not the rules table — an operator
following that action would be misdirected. Fixed: dedicated `PROVENANCE_REPAIR_ACTION`
("repair category_source, re-apply db/schema.sql, re-run assess"), asserted in the
invalid-shape test. Live no-op (the branch is unreachable at rest): re-run wrote 0.

## L2 (low) — current-contract docs still described the superseded type policy — FIXED

Three cited spots plus two more a sweep found (historical/superseded-marked sections left
as the record they are):

- `db/schema.sql` — the `type` column comment (CREATE) still said the assessor needs it "to
  tell 143 WARN pipeline-noise incidents from 70 real unclassified ERRORs"; the UPGRADE
  comment still said "type-aware". Both now state: confidence and reasons only, never
  severity (round-2 M2).
- `docs/error-taxonomy.md` — the assess intro still mapped "category + **type** + blast
  radius to severity". Now: category + blast radius; type feeds confidence/reasons only.
- `markdown/PROMPTS.md` — the phase-4 row's Step-3 narrative read as current contract; now
  explicitly marked superseded inline with a pointer to the current contract.
- `utils/db/queries/incidents.js` — the batch-CTE comment (inside the SQL template literal —
  edited backtick-free, `require` re-verified) said "type-aware"; now states the M2 contract.

## Re-validation

114/114 unit; live re-run writes 0 (both lows touch an unreachable branch and comments);
independent parity PASS; distribution unchanged 184/319/0/1.

## Status: review converged — ready for FLOW Step 8 (commit)

Three rounds: 1 high + 2 medium → 2 medium + 1 low (+1 decision) → 2 low, all closed. The
queued classification follow-up phase inherits two requirements from this round: remove/update
the interim-M2 reason string, and bump `RULES_VERSION`.
