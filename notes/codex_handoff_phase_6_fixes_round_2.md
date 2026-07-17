# Codex Handoff — Phase 6 FIX ROUND 2 (delta)

Branch: `phase-6-classify-unknowns` — uncommitted. Round 2 verdict: prefix + permanent-
unknown handling accepted; **F4 escalated to medium** — verified real (the upsert
interpolation is exactly as you said: `util/upsertHostDatatime.js` quotes the value, so a
null last record sends the string `'null'` to a `timestamptz` and the offline-health row
goes stale). **Scope: the F4 fix only.**

## Fix

- R7b `quality` → **medium @ 0.7** (was low @ 0.6). The reason string you caught at
  `rules.js:589` ("skipped") is rewritten with the verified downstream evidence — my
  round-1 fix had corrected the ACTIONS text but missed the reason string; both now agree.
- Action string directs the producer remedy you specified (skip/null-handle invalid
  timestamps or select the last VALID one). The producer change itself is cross-app —
  this repo never edits the other apps — so it is tracked with the upstreaming follow-up,
  not made on this branch. Flag if you think that boundary call is wrong.
- Evidence recorded at the `engine_regexes.js` entry (with the three file citations),
  the taxonomy row, and the PHASE_LOG verdict table.
- Tests: severity-table pin flipped LOW → MEDIUM; 196/196.
- Live: the family is dormant (0 events carry the category; its 2 incidents / 138 events
  sit at `unknown`/medium via the residual policy), so this changes no live rows today —
  it binds at deploy on the next recurrence. RULES_VERSION stays 2 (within-phase,
  unreleased — the Phase 4 precedent).

## Verify

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test    # 196/196
grep -n "skipped" domain/assessor/rules.js                  # no quality-branch hit
```
