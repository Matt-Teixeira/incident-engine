# Codex Review Handoff — Phase 3 FIX ROUND (delta)

Delta briefing for the re-review of the Phase 3 fixes. Round-1 findings + fix
detail: `notes/review_results_phase_3.md`. **Fix-only scope** — please do not
re-litigate what round 1 verified clean (rewind policy, deadlock-free lock order,
write-isolation/grants, injection-safety); verify the four fixes closed their
findings and look only for defects introduced BY the fixes.

## Finding → fix → please-verify

| # | Sev | Fix (files) | Please verify |
|---|-----|-------------|---------------|
| F1 | High | `error_events.inserted_at DEFAULT clock_timestamp()` (was `NOW()`); corrected exactly-once comments in `utils/db/queries/incidents.js` + `jobs/aggregate/index.js`; `db/schema.sql` UPGRADE `ALTER … SET DEFAULT`. | That a post-lock `clock_timestamp()` cursor + the existing lock is now genuinely exactly-once. Can any interleaving still skip or double-count a row? Is per-row `clock_timestamp()` (vs `statement_timestamp()`) a problem for the BRIN correlation or the `<= snapshot` upper bound? Any remaining reliance on wall-clock monotonicity across the lock handoff, and is that acceptable (same envelope as the existing watermark)? |
| F2 | Med | `flatten.js` derives both stored `sme` and `entity()` from `sme_stored = cap(sme,16)`. | flatten `entity` == the `schema.sql` backfill expression for ALL sme inputs (trim/empty/cap/non-string). |
| F3 | Low | `rep` sort key → `ts DESC, run_id DESC, event_ord DESC`; ON CONFLICT refresh guarded by `(last_seen, sample_run_id)` total order. | rebuild == incremental for the representative in adversarial orderings; that `last_seen` really always equals the stored representative's `ts` (the invariant the guard relies on). |
| F4 | Low | `msg`: `btrim` each candidate + `jsonb_typeof(...) = 'string'` guard on the `raw_event` extractions. | SQL now matches `domain/fingerprint.js:eventText` (`nonEmptyString`) for whitespace-only and non-string `note.txt`/`skip_reason`. |

## New tests (run in the app container; not in bare `node --test`)

```
docker compose run --rm app node integration/aggregate_race.js    # F1 — RACE TEST: PASS
docker compose run --rm app node integration/rep_determinism.js   # F3 — REP DETERMINISM: PASS
docker run --rm -v "$PWD":/w -w /w node:lts node --test                # 49/49 (incl. F2 long-sme)
```

`aggregate_race.js` is the integration test round 1 asked for: it forces
materialize-starts-first / aggregate-locks-first / materialize-resumes and asserts
the `clock_timestamp()` row is caught while a `transaction_timestamp()` (old-default)
row in the same commit is skipped — isolating the timestamp source, not the lock, as
the fix. Both integration tests TRUNCATE/restore `incidents.incidents` (app-owned, no
live consumer) and clean up synthetic rows.

## Known weak spots to still scrutinize (unchanged from round 1)

- The exactly-once argument end-to-end now rests on BOTH the lock AND the post-lock
  cursor stamp — please attack the combination, not each in isolation.
- Watermark rewind remains deliberately non-idempotent for the additive counter
  (operator-recovery only) — confirm that framing still holds after the cursor change.

## Output format

Per finding: severity · `path:line` · what & why · suggested fix. Bias to fewer,
high-confidence findings; prioritize any residual in F1.

---

## Round-2 addendum (re-review delta)

The re-review confirmed F2/F3 closed and raised two items against F1/F4; both addressed.

- **R1 (medium) — clock-monotonicity of the exactly-once cursor.** No mechanism change:
  the guarantee is now **explicitly documented** as "exactly-once under a nondecreasing
  database clock," and the stale "no materialize tx in flight" comments were corrected (the
  lock excludes *committing* tx's; the post-lock `inserted_at` stamp — guarantee (b) — is
  what orders a pre-lock tx's rows). Comments updated in `jobs/aggregate/index.js`,
  `utils/db/queries/incidents.js`, `db/schema.sql`. The unconditional fix (a monotonic
  post-lock `BIGSERIAL`/batch cursor, ideally pipeline-wide) is recorded as an upgrade path,
  not built — deliberately proportionate (the whole pipeline already assumes a nondecreasing
  clock; the failure is a rare silent undercount, never corruption). **If you want the
  unconditional guarantee built now, say so** — it's a scoped follow-up, not a Phase-3 blocker.
- **R2 (low) — SQL whitespace parity.** `msg` now uses `btrim(x, E' \t\n\r\f\v')` on every
  candidate so tab/newline-only values are treated as absent (matches JS `String.trim()` for
  ASCII; verified live). Exotic Unicode whitespace stays uncovered (never in these messages);
  persisting `eventText` on L0 is the noted exact-parity upgrade.

Please verify: (R1) the documented assumption + corrected comments are accurate and the
residual is correctly characterized as undercount-only; (R2) the trim set closes the
tab/newline case without over-trimming legitimate content.
