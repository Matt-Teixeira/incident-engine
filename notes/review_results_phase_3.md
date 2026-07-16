# Phase 3 — Codex Review Results (round 1)

Source: Codex review of `notes/codex_handoff_phase_3.md` (branch
`phase-3-aggregate-incidents`). Verdict: **needs fixes before commit** — one
release-blocking exactly-once flaw plus three narrower parity/determinism issues.
All four fixed and re-validated live; the reviewer's positive findings (rewind
policy, deadlock-free lock order, write-isolation/grants, injection-safety) were
confirmed and left as-is.

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| F1 | High | Shared lock does not eliminate commit skew — a materialize tx can fix its `NOW()` before acquiring the lock, commit after the aggregate advanced its watermark, and its rows (`inserted_at = NOW()` = tx-start) fall below the watermark → skipped forever. | Fixed |
| F2 | Medium | New-row entity derived from the UNcapped sme (up to 64) but the upgrade backfill sees the 16-capped stored sme → same event splits into two incidents for a >16-char sme. | Fixed |
| F3 | Low | Representative tie-break deterministic only within one batch; the `>=`-guarded refresh resolves equal-timestamp events by batch arrival order, so rebuild vs incremental could pick different samples. | Fixed |
| F4 | Low | SQL `msg` reconstruction doesn't match `eventText`: JS trims every candidate and ignores non-strings; SQL only rejected literal `''`, so a whitespace-only `note.txt` suppressed a valid `skip_reason` and padding survived. | Fixed |

## F1 (High) — commit skew via transaction-start `inserted_at`

Root cause: `error_events.inserted_at DEFAULT NOW()`. `NOW()` = `transaction_timestamp()`
= transaction START. The lock serializes *commits*, but a materialize tx sets its
`NOW()` at its first statement (the ensure), which can be **before** it acquires the
shared lock. If an aggregate then acquires the lock, snapshots `Ta`, and advances its
watermark to `Ta`, a later-committing materialize stamps rows with `inserted_at < Ta`
that the strict `inserted_at > watermark` window skips permanently.

Fix: **stamp the cursor at INSERT time, post-lock.** `error_events.inserted_at` now
defaults to `clock_timestamp()` (evaluated per row at insert, which always runs after
materialize holds the lock), so the cursor orders with the lock — a late-committing
materialize's rows are stamped *after* any watermark the aggregate set while that
materialize was still waiting, and are caught in the next window. No JS `Date`
round-trip of the cursor (the value is assigned DB-side).

- `db/schema.sql`: CREATE default `NOW()` → `clock_timestamp()`; UPGRADE section adds
  `ALTER COLUMN inserted_at SET DEFAULT clock_timestamp()` for existing DBs.
- Corrected the exactly-once reasoning in `utils/db/queries/incidents.js` and
  `jobs/aggregate/index.js` headers: exactly-once now requires BOTH (a) the lock
  (serializes commits) AND (b) the post-lock cursor stamp (orders the cursor with the
  lock) — the old comments claimed the lock alone sufficed.
- **Test** `integration/aggregate_race.js` (new): deterministically reproduces the
  interleaving (materialize starts → aggregate locks & advances first → materialize
  resumes, commits). It inserts two rows in the resumed tx — one with the real
  `clock_timestamp()` default and one forced to `transaction_timestamp()` (the old
  behavior) — and asserts the former IS aggregated while the latter IS skipped.
  Result: `T0 < Ta` confirmed; clock row caught; tx-start row skipped → PASS.

Mechanism proof (psql): mid-transaction, `now()` stayed at tx-start while
`clock_timestamp()` advanced 1.2s — the exact skip window.

## F2 (Medium) — entity/sme cap parity

Fix: `jobs/materialize/flatten.js` computes `sme_stored = cap(sme, 16)` once and derives
BOTH the stored `sme` column and `entity({ sme: sme_stored, system_id })` from it, so a
newly materialized row and a `schema.sql`-backfilled row agree for any sme length.
**Test** `test/flatten.test.js`: a 33-char sme now stores 16 chars and yields a 16-char
entity equal to the stored sme (== the backfill expression). Live parity was already
0-mismatch (sme ≤ 8 live); this closes the latent split.

## F3 (Low) — representative determinism across batches

Fix: `utils/db/queries/incidents.js` aligns the `rep` sort key to the full total order
`ts DESC, run_id DESC, event_ord DESC`, and the ON CONFLICT refresh now guards on
`EXCLUDED.last_seen > inc.last_seen OR (EXCLUDED.last_seen = inc.last_seen AND
EXCLUDED.sample_run_id > inc.sample_run_id)`. Because `last_seen` == the representative's
`ts`, `(last_seen, sample_run_id)` IS the leading pair of that sort key, so incremental
aggregation converges to the same representative a single-batch rebuild picks. Events
sharing `(ts, run_id)` always co-materialize, so the `event_ord` tiebreak never crosses
batches. **Test** `integration/rep_determinism.js` (new): rebuilds incidents in one
window vs. two split windows over identical L0 and diffs the representatives → 498/498,
**0 mismatches**.

## F4 (Low) — SQL eventText parity

Fix: `utils/db/queries/incidents.js` `msg` now `btrim`s each candidate and NULLIFs the
result, and guards the `raw_event` `note.txt`/`note.skip_reason` extraction with
`jsonb_typeof(...) = 'string'` — matching `nonEmptyString` (trim, whitespace-only →
absent, non-string → ignored). Stored `err_msg`/`note_message` were already trimmed at
flatten, so `btrim` there is a harmless belt-and-suspenders.

## Re-validation (all green)

```
docker run --rm -v "$PWD":/w -w /w node:lts node --test                 # 49/49
docker exec ... psql -f db/schema.sql                                    # default → clock_timestamp()
docker compose run --rm app node integration/aggregate_race.js      # RACE TEST: PASS
docker compose run --rm app node integration/rep_determinism.js     # REP DETERMINISM: PASS
docker compose run --rm app node index.js assess                         # exit 0
```

Final consistency: `error_events` = 203,596 (0 null entity, 0 test leftovers);
`incidents` = 503 = `count(distinct (fingerprint, entity))`; `sum(occurrence_count)` =
203,596 → **exactly-once delta 0**; watermark caught up (0 rows above it).

---

# Phase 3 — Codex Re-review Results (round 2)

The round-1 fixes closed F2 and F3 outright. The re-review confirmed those, and raised
two smaller items against the F1/F4 fixes. Both addressed.

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| R1 | Medium | Exactly-once still assumes `clock_timestamp()` is nondecreasing across the lock handoff — a wall clock, not a monotonic primitive. A backward clock step (or equal timestamp) between the aggregate's `Ta` and a pre-lock materialize's insert could stamp `inserted_at <= Ta` → skipped. Also, stale comments claimed "no materialize transaction can be in flight" (pre-lock txns can be). | Resolved |
| R2 | Low | F4 only partially closed: `btrim(text)` (no char set) trims ASCII spaces only, while JS `String.trim()` also strips tab/newline/CR/etc. A `note.txt` of `"\t\n"` still suppressed a valid `skip_reason` in SQL. | Fixed |

## R1 (Medium) — clock-monotonicity assumption made explicit

Assessment: this is a real, narrow residual. The failure needs a backward server-clock
step **inside** the sub-second window between the aggregate advancing its watermark and a
pre-lock materialize inserting; the consequence is a silent **undercount** of
`occurrence_count` (never a double-count or corruption). The entire pipeline's watermark
design already assumes a nondecreasing clock (every `clock_timestamp()` snapshot), so a
monotonic-cursor fix for the aggregate alone would be an inconsistent half-measure — a true
fix is a pipeline-wide decision.

Resolution (Codex's sanctioned alternative): **explicitly downgrade and document the
guarantee** as "exactly-once under a nondecreasing database clock," and record the
monotonic logical cursor (a post-lock `BIGSERIAL`/batch sequence replacing the timestamp
cursor) as the known **upgrade path** if clock-step tolerance is ever required. Applied to
the headers of `jobs/aggregate/index.js` and `utils/db/queries/incidents.js` and the
`db/schema.sql` `inserted_at` comment. Also **corrected the stale claims**: the lock
excludes materialize tx's that are *committing*, not all in-flight tx's — a pre-lock
materialize can still be running, and it is guarantee (b) (post-lock stamp), not the lock,
that orders its rows. (This is a documentation + honesty fix, not a mechanism change; the
`aggregate_race.js` proof of the transaction-start bug is unchanged.)

Not built now: the `BIGSERIAL` cursor. It touches `error_events` (+column/index/backfill),
`pipeline_state` (numeric watermark), the aggregate window + watermark SQL, and would make
the aggregate stricter than the rest of the pipeline — disproportionate to the residual and
better as a deliberate pipeline-wide phase. Flagged for the developer to escalate if
desired.

## R2 (Low) — broaden SQL trim to match `String.trim()`

Fix: `utils/db/queries/incidents.js` `msg` now passes the explicit ASCII-whitespace set to
`btrim(x, E' \t\n\r\f\v')` for every candidate, so tab/newline/CR/FF/VT-only values are
treated as absent — matching JS `nonEmptyString`. Verified live: a `note.txt` of `"\t\n"`
with a real `skip_reason` now yields the `skip_reason` (old `btrim` returned the whitespace).
Exotic Unicode whitespace (NBSP, …) remains uncovered — never present in these ASCII log
messages; persisting the computed `eventText` on L0 is the exact-parity upgrade if needed
(documented in the query comment).

## Re-validation (round 2, all green)

```
docker run --rm -v "$PWD":/w -w /w node:lts node --test               # 49/49
docker compose run --rm app node integration/aggregate_race.js        # RACE TEST: PASS
docker compose run --rm app node integration/rep_determinism.js       # REP DETERMINISM: PASS
docker compose run --rm app node index.js assess                      # exit 0
git diff --check                                                      # clean
```

Final: `incidents` = 503 = `count(distinct (fingerprint, entity))`; `sum(occurrence_count)`
= 203,596 = L0 total → **exactly-once delta 0** (under the documented clock assumption).

---

# Phase 3 — Independent review (round 3, self, not Codex)

An 8-angle independent review (line-by-line, removed-behavior, cross-file tracer, reuse/
simplification/efficiency, altitude, conventions) at high recall. **No high/medium findings**
— the exactly-once core, the representative total-order + ON-CONFLICT guard invariant
(`inc.last_seen` == stored rep's `ts`), the enrichment 1:1 join, and the JS-`Date`
ms-truncation (applied consistently to window upper AND stored watermark → defers, never
skips/double-counts) all check out. Four **low** items; the developer chose to apply #1 + #3
and note #2 (#4 left as-is).

| # | Sev | Finding | Action |
|---|-----|---------|--------|
| 1 | Low | `db/schema.sql` entity backfill used `btrim` (spaces-only) vs `entity()`'s JS `.trim()` (all whitespace) → split at the 16-char sme cap boundary for a trailing non-space whitespace char (pathological; sme ≤8 live). | **Fixed** |
| 2 | Low | ON CONFLICT `category` refresh (newest wins) can regress a confident category to `unknown` — safe only under the empirical single-category-per-fingerprint invariant. | **Noted** in code |
| 3 | Low | Oracle-corroborated `category` leaves `error_type = ''` (~39 live incidents). | **Documented** (see the correction below) |
| 4 | Low | `msg` (jsonb extraction) computed in the `batch` CTE for every row though only the representative's is used (mitigated by COALESCE short-circuit). | Left as-is |

Fixes applied:

- **F1**: backfill now `btrim(sme, E' \t\n\r\f\v')` / `btrim(system_id, …)` matching JS
  `.trim()`. Re-verified live: `entity` == the corrected expression for all 203,596 rows
  (0 mismatches).
- **F3**: documented in `enrichment.js`, the aggregate INSERT, and `docs/incidents-schema.md`
  that only `category` is corroborated; `error_type`/`phase` stay the deterministic
  classifier's output, so `error_type=''` on a corroborated incident means "type not looked
  up", not a stale pairing.

**CORRECTION (2026-07-16, post-commit — the round-3 F3 rationale was wrong).** The review
asserted that a corroborated category is "in the oracle's vocabulary, NOT our classifier's
taxonomy, so no reliable category→type map exists". **That is false**, and it was asserted
from the name `rsync_io_timeout` looking unfamiliar rather than from checking the table.
Verified: `rsync_io_timeout` IS one of our classifier's 19 categories, and the oracle's 9
distinct live `error_category` values are a **subset** of our vocabulary (+ `unknown`) —
`stats.acquisition_history` is written by `data_acquisition` using the same
`connection_regex.js` this app copied verbatim. Consequences:

- The **behaviour is unchanged and still correct** (`error_type=''` on corroborated rows);
  only the stated *reason* was wrong. Docs corrected in `enrichment.js`,
  `utils/db/queries/incidents.js`, and `docs/incidents-schema.md`.
- Deriving `error_type` from a corroborated category IS possible (the classifier table is a
  category→type map) — it was dismissed on a false premise. Now a tracked follow-up rather
  than an impossibility; it matters to Phase 4, whose rules key off category/error_type.

Method note: this is the third defect in this phase that only surfaced on checking reality
(the transaction-start cursor race, the backtick-in-template-literal, the missing cron `cd`).
Assertions about the data/taxonomy must be verified against the live DB or the source table,
not inferred — the FLOW Step-2 rule exists for exactly this.
- **F2**: a NOTE at the category-refresh guard records the single-category reliance and what
  to do if a future taxonomy ever makes a fingerprint mixed-category.

Problem caught during the fix (self-review of the fixes): the F2 note initially used markdown
backticks inside the SQL **template literal**, which terminated the JS string — `require`
threw at load. The bare `node --test` suite does NOT load `incidents.js` (no DB import), so it
stayed green; the error only surfaced on running the actual `assess` job. Fixed (removed the
backticks) and **re-validated by running the job**, not just the unit tests: `assess` exit 0,
`aggregate_race.js` PASS, `rep_determinism.js` PASS, delta 0, 49/49 unit tests.
