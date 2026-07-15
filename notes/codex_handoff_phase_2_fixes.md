# Codex Handoff — incident-engine Phase 2 fix round (re-review)

A briefing for the reviewer who produced `notes/review_results_phase_2.md`. All six
findings were accepted and fixed, and L0 was rebuilt from source under the corrected
identity formula. This is a **delta review**: verify each fix actually closes its
finding, and hunt for regressions the fixes themselves may have introduced. The
Phase 2 base review stands — don't re-review what round 1 already verified clean.

---

## 1. What changed since round 1 (finding → fix)

| # | Finding | Fix |
|---|---|---|
| 1 | 512-char cap merged distinct failures | `domain/normalize.js`: noise-LINE filtering (curl progress header/rows, Node stack frames) before scrubbing; **no length cap** |
| 2 | `note.system_id` dropped; job_id outranked equipment; entity 32 truncated UUIDs | `flatten.js`: validated `note.system_id` authoritative, sme-derivation fallback; `entity.js`: order `sme → system_id → job_id → __global__`; `entity` → VARCHAR(64) |
| 3 | Blocked concurrent tx could move watermark backward | `queries/materialize.js` + `jobs/materialize/index.js`: snapshot via `clock_timestamp()` in a separate statement AFTER the row lock; `GREATEST` guard in the advance |
| 4 | `FP_VERSION` not persisted | `error_events.fp_version SMALLINT NOT NULL` (schema.sql, live ALTER, ColumnSet, flatten) |
| 5 | `note.skip_reason` text discarded | `eventText` chain: `err_msg → note.message → note.txt → note.skip_reason → ''` |
| 6 | Non-array payload advanced silently | `flatten.js`: `skipped` diagnostic (`event_ord: null`), surfaced in the run's WARN log; test updated to require it |

**Rebuild decision to scrutinize:** `FP_VERSION` stays **1**. Rationale: version-1 rows
existed only as an uncommitted backfill on this branch, nothing consumed them, and
source retention still covered the whole window — so L0 was truncated, the watermark
reset, and 185,090 events re-backfilled (22s) instead of shipping a v2 migration for
never-accepted data. Challenge this if you see a hole (e.g. anything outside this
branch that could have observed v1 fingerprints).

---

## 2. Scope of this review

Diff on branch `phase-2-materialize` since round 1 (commit pending; round-1 state is
described in `notes/codex_handoff_phase_2.md` §3):

```
domain/normalize.js               line filter + cap removal  ← finding 1
domain/fingerprint.js             eventText chain + comment  ← finding 5
domain/entity.js                  order + 64 cap             ← finding 2
jobs/materialize/flatten.js       system_id, fp_version, non-array diagnostic
jobs/materialize/index.js         post-lock snapshot wiring  ← finding 3
utils/db/queries/materialize.js   LOCK/SNAPSHOT split + GREATEST
utils/db/sql/pg-helpers.js        fp_version in the ColumnSet
db/schema.sql                     fp_version column; entity VARCHAR(64)
docs/incidents-schema.md          fp_version row, entity row, system_id row, fp formula
docs/error-taxonomy.md            input-chain doc (skip_reason)
markdown/ARCHITECTURE_PRINCIPLES.md  fingerprint formula + per-row version
prompts/prompt_3_aggregate_incidents.txt  entity-order review question fixed
test/normalize.test.js            multiline goldens; cap test inverted
test/fingerprint.test.js          skip_reason + noise-heavy frozen goldens
test/entity.test.js               new order; 64 cap; UUID lossless
test/flatten.test.js              system_id precedence, fp_version, non-array
```

**Out of scope:** everything round 1 verified without findings (scan bounds, allowlist,
`ON CONFLICT` idempotency, classifier copy fidelity, pool singleton), the three items
round 1 explicitly deferred (memory model at 3–5× volume, `dt` skew policy for
Phase 3, `raw_event` storage share), and Phase 1 files.

---

## 3. How to run / verify it

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test    # 41 tests, dependency-free
docker compose run --rm app node index.js materialize      # incremental; exit 0
```

Live state when this handoff was written (all re-verified post-rebuild):

- 185,090 L0 events = exact source parity at the watermark; all `fp_version = 1`.
- **0 fingerprints with >1 error_category** (round 1 found 2); 82 distinct
  fingerprints (was 141 — noise lines had also been over-splitting).
- 5,285 `note.system_id` events now store `system_id`; 690 skip_reason-only events
  fingerprint on `missing host_ip` (2 fps, one per func).
- Watermark-regression proof: watermark forced to now+1h → run exits 0, watermark
  NOT regressed; restored, catch-up advances normally.

Useful re-checks:

```sql
SELECT count(*) FROM (SELECT fingerprint FROM incidents.error_events
  GROUP BY fingerprint HAVING count(DISTINCT error_category) > 1) x;  -- expect 0
SELECT count(*) FILTER (WHERE fp_version IS DISTINCT FROM 1) FROM incidents.error_events;  -- expect 0
```

---

## 4. Constraints that must still hold after the fixes

1. **Frozen-contract discipline:** `normalize.js`, `fingerprint.js`, and the golden
   tests are now the frozen v1 contract. Confirm the goldens are strong enough to
   catch accidental drift (literal sha1s, multiline noise cases, idempotence).
2. **No behavior change outside the six findings** — the fixes must not have altered
   scan bounds, allowlist, chunking, write isolation, or exit-code semantics.
3. **Docs = code:** the fingerprint formula, entity order/width, `system_id`
   derivation, and `fp_version` must read identically in `docs/incidents-schema.md`,
   `docs/error-taxonomy.md`, `ARCHITECTURE_PRINCIPLES.md`, and the code comments.

---

## 5. Fix-specific weak spots — please scrutinize

1. **Noise-line regexes may over-drop** (`domain/normalize.js` `NOISE_LINE_RES`).
   The completed-progress rule `/^\s*\d+\s+[\d.]+[kMG]?\s+\d+\s/` drops any line
   opening with three numeric-ish columns, and the `--:--:--` rule drops any line
   containing that token anywhere. Could a *salient* error line match either (e.g.
   rsync stats lines, tabular tool output that IS the error)? An over-dropped salient
   line silently degrades a fingerprint to func/tag-only. Propose tighter anchors if
   you find a realistic collision.
2. **Stack-frame rule keeps only the first line** (`/^\s+at\s/` drops the frames but
   the `Error: ...` head line stays). Multi-error stacks ("caused by") — does
   anything real survive that shouldn't, or vice versa?
3. **No cap at all**: a pathological single-line message (MBs, no newlines) now runs
   all 8 scrub regexes over its full length inside the batch loop. The RULES are
   linear-time, but confirm none of them can backtrack pathologically (e.g. the path
   rule `(?:\/[\w.+-]+){2,}\/?` on adversarial input).
4. **`clock_timestamp()` reasoning** (finding 3): the snapshot is post-lock, but the
   *scan* then runs at some later instant in the same transaction — rows committed by
   producers between snapshot and scan with `inserted_at <= snapshot` could be
   invisible to this scan yet inside its claimed window. The overlap lookback is the
   designed absorber. Confirm `MATERIALIZE_OVERLAP_MS=5000` (default) comfortably
   covers producer commit latency, or recommend a bound.
5. **`skip_reason` is hashed but not stored as a column** — it lives only inside
   `raw_event`. Phase 3's `sample_message` derives from the text chain, so verify
   nothing in the contract needs a dedicated column now (adding one later is cheap;
   changing the CHAIN later is an FP_VERSION bump).
6. **`note.system_id` trust**: flatten validates format (`^SME\d{5}$`) but not
   existence. A producer emitting a well-formed but bogus system_id becomes an entity.
   Acceptable at L0 (we mirror the producer's claim), or does Phase 3 need a guard?
7. **Entity fallback reachability**: with system_id now derived from sme, the
   `system_id`-only branch of `entity()` is nearly unreachable from L0 rows (any
   stored system_id implies sme or note.system_id existed). Confirm the order still
   behaves when Phase 3 feeds it L0 columns (sme NULL + system_id present is real:
   the 5,285 note.system_id events).

---

## 6. What is intentionally NOT addressed in this round

- Round 1's deferred items (memory model, `dt` skew policy, `raw_event` share) — all
  tracked in `markdown/PHASE_LOG.md` Phase 2 Review Notes with their revisit triggers.
- Anything Phase 3+ (aggregation grain, enrichment join, `sample_message` selection).

---

## 7. Output format requested

Per finding: **Severity** / `path:line` / **What & why** / **Suggested fix**.
Also state explicitly, per original finding 1–6: **closed / partially closed / not
closed**, with evidence. Prioritize: (1) any original finding not actually closed,
(2) regressions introduced by the fixes (especially over-dropping in the noise
filter), (3) doc/code divergence. Bias toward fewer, high-confidence findings. File
results as `notes/review_results_phase_2_fixes.md`.
