# Codex Handoff — Phase 4 fix round 2 (delta)

Branch: `phase-4-deterministic-assessor` — still uncommitted, nothing pushed.
Chain: round 1 (`codex_handoff_phase_4.md` → 1 high/2 medium, fixed) → round 2
(`codex_handoff_phase_4_fixes.md` → 2 medium/1 low + count correction). This is the round-2
fix delta. **Scope: these deltas only**; per-finding verdict requested
(closed / partially / not closed).

## Finding → fix

**M1 (provenance fails quiet) — both layers, as suggested:**
- `category_source` is now `NOT NULL` + `CHECK IN ('classifier','oracle')`
  (`chk_incidents_category_source`) — in CREATE and as an idempotent UPGRADE after the
  backfill (`db/schema.sql`). Negative-tested live: `SET category_source = NULL` and
  `= 'bogus'` both rejected; re-apply clean.
- R0 now splits **three ways** (`domain/assessor/rules.js`): `'classifier'` → trust;
  `'oracle'` → unknown, quiet (round 1); **anything else → medium @ 0.2, LOUD,
  type-independent** — never info, reasons name the writer/migration gap instead of falsely
  blaming the oracle. Your credentials/WARN quiet-fail case is a verbatim unit test now
  (all five invalid shapes × both types).
- Deliberate deviation from one arm of your suggestion: the job does **not** fail outright —
  one bad row must not block the other 500; instead it counts `invalid_provenance` per run
  and emits a dedicated WARN ("the DB CHECK constraint is missing on this database") if
  non-zero. The constraint is the hard stop. Verdict welcome on that trade.

**M2 (`unknown`+WARN) — decided by the developer (2026-07-16): interim MEDIUM**, your
explicit fallback. Both types now medium @ 0.3; the WARN branch records "interim severity
(review round 2, M2)…" in its reasons; `type` now moves severity **nowhere** (a unit test
sweeps all 22 categories × both types × three blast radii asserting severity equality).
Applied live: 175 rows rewritten → **high 184 / medium 319 / info 1** (the 1 = the
`rsync_partial`); re-run 0. The durable fix — classifying `JOB HALTED` / `NO TUNNEL FOUND` /
the missing-data families out of `unknown` — is a queued follow-up phase (cross-app
vocabulary: `connection_regex.js` is `data_acquisition`-owned; `error_category` is not in
the fingerprint so `FP_VERSION` is unaffected). Count correction applied everywhere
(175/148,429; the 176 had swept in the `rsync_partial`).

**L1 (parity check omitted entity)** — `AND e.entity = i.entity` added to
`category_in_own_l0` (`integration/assess_parity.js`); your premise was live, not
theoretical (9 fingerprints carry mixed categories across entities, since corroboration is
per-entity). The invalid-value check also widened from NULL-only to the full vocabulary.

**Migration-order judgment call** — adopted structurally: migrations live in the single
`db/schema.sql` applied top-to-bottom, so any future error_type-population section
necessarily runs after Phase 4's `SET NOT NULL`; documented at the constraint site.

## Verify

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test            # 114/114
docker exec -i pg_db psql -U postgres -d staging -f - < db/schema.sql
docker compose run --rm app node index.js assess                   # re-run: 0 written
docker compose run --rm app node integration/assess_parity.js     # PASS
```

Expected live: distribution 184/319/0/1; provenance 464/40 (0 invalid — constraint enforced);
exactly-once delta 0; `JOB HALTED` at medium with the interim-M2 reason. The destructive
`rep_determinism.js` TRUNCATE-rebuild reproduces 184/319/1 independently.

## Weak spots in these deltas

1. R0's invalid branch is now unreachable-at-rest by construction — is the medium @ 0.2 +
   dedicated WARN the right degraded mode, or should the job hard-fail as your suggestion's
   other arm had it?
2. The interim-M2 reason string is load-bearing documentation inside data. If the
   classification phase lands and someone forgets this branch, medium persists with a stale
   "interim" claim — is that acceptable drift, or worth a tracked check?
3. `RULES_VERSION` still 1 (nothing committed/deployed yet — your round-2 judgment).
