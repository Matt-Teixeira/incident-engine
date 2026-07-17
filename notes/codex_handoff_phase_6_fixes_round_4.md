# Codex Handoff — Phase 6 FIX ROUND 4 (delta)

Branch: `phase-6-classify-unknowns` — uncommitted. Round 4 verdict: the generalized medium
verdict is sound, but my round-3 evidence was **miscounted**. Both errors verified and
corrected. **Scope: the count/wording only — no severity change.**

## The two miscounts (verified)

1. **8 emitters, not 7.** `grep -rc "datetime object null"` → Philips **4**
   (MRI/logcurrent, CT/eal_parser, CV/eventlog, **CV/lod_eventlog**), GE 3, Siemens 1 = 8.
   My round-3 prose said "7 emitters / 6 of 7" while my own delta TABLE already listed 8
   rows — an internal contradiction. Correct: **7 of 8 call the upsert** (only
   CV/lod_eventlog does not).
2. **CV/eventlog selects the FIRST record.** `eventlog.js:222` →
   `const resent_host_datetime = mappedData[0].host_datetime`. The other six pass
   `mappedData[mappedData.length - 1]`. So "last record" was wrong for that one path.
   A null in the SELECTED record (first for eventlog, last for the rest) is what breaks the
   upsert — the failure mode is unchanged, the wording was.

Corrected 8-row table (emitter → upsert site → selected record):

| repo | site | upsert | selected |
| --- | --- | --- | --- |
| philips | MRI/logcurrent.js:124 | :195-201 | last |
| philips | CT/eal_parser.js:114 | :181-187 | last |
| philips | CV/eventlog.js:166 | :221-224 | **first (`mappedData[0]`)** |
| philips | CV/lod_eventlog.js:190 | — | **NO upsert (the exception)** |
| ge | MRI/gesys_parser.js:114 | :169-175 | last |
| ge | CT/gesys_parser.js:138 | :207-213 | last |
| ge | CV/sysError_parser.js:128 | :189-194 | last |
| siemens | win_10/siemens_cv.js:134 | :170-176 | last |

## Fix

- "last record" → "selected record" and "6 of 7" → "7 of 8" in: the R7b quality reason,
  the action string (now notes CV/eventlog selects the first), the `engine_regexes.js`
  entry (the 8-row table above with per-path annotations), the taxonomy row, and the
  PHASE_LOG cross-app follow-up (all eight emitters named, both distinct Philips CV
  parsers included — your deferral condition).
- Medium verdict and the deferral itself unchanged. 196/196. Family dormant live → no live
  rows change; binds at deploy. RULES_VERSION stays 2.

## Verify

```bash
grep -rc "datetime object null" /opt/apps/hhm_rpp_* --include=*.js | grep -v ':0'  # 8 files
grep -n "mappedData\[0\]" /opt/apps/hhm_rpp_philips/jobs/Philips/CV/eventlog.js     # :222
docker run --rm -v "$PWD":/w -w /w node:lts node --test                            # 196/196
```
