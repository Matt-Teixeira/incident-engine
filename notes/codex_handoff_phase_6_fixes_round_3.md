# Codex Handoff — Phase 6 FIX ROUND 3 (delta)

Branch: `phase-6-classify-unknowns` — uncommitted. Round 3 verdict: F4 **partially closed**
— MRI/CT medium accepted; the reason/action must be generalized because the same exact text
has more emitters than round 2 named, and not all provably hit that one Philips upsert.
**Scope: the generalization only.**

## Verification (I swept all emitters before generalizing)

`grep -rn "datetime object null"` across all producer repos → **7 emitters**:

| repo | site | feeds `build_upsert_str` → `offline_hhm_conn`? |
| --- | --- | --- |
| hhm_rpp_philips | MRI/logcurrent.js:124 | yes (:195-201) |
| hhm_rpp_philips | CT/eal_parser.js:114 | yes (:181-187) |
| hhm_rpp_philips | CV/eventlog.js:166 | yes (:221-224) |
| hhm_rpp_philips | CV/lod_eventlog.js:190 | **NO upsert** (persists null, no call) |
| hhm_rpp_ge | MRI/gesys_parser.js:114 | yes (:169-175) |
| hhm_rpp_ge | CT/gesys_parser.js:138 | yes (:207-213) |
| hhm_rpp_ge | CV/sysError_parser.js:128 | yes (:189-194) |
| hhm_rpp_siemens | win_10/siemens_cv.js:134 | yes (:170-176) |

GE's and Siemens' `build_upsert_str` (in each repo's `jobs/tooling`) quote
`'${recent_host_datetime}'` byte-for-byte like Philips `util/upsertHostDatatime.js`, so the
failure mode is genuinely cross-vendor — **6 of 7**. So your caution was right AND the
generalized claim is evidence-backed: it's not Philips-specific, but it also isn't
universal (lod_eventlog is the counterexample).

## Fix (generalize, keep medium — I did NOT make it source-aware, and why)

- R7b quality reason rewritten to the cross-vendor statement: "…across the Philips/GE/
  Siemens post-processors that feed the last record into the `alert.offline_hhm_conn`
  upsert (6 of 7 emitters of this message), a null last record sends a quoted 'null' to a
  timestamptz and the offline-health row goes stale for that system." Action pluralized.
- **Generalize over source-aware:** the matched text is identical and `error_category` is
  not in the fingerprint, so the category genuinely cannot distinguish emitters without a
  new signal — a conservative medium across all matches is the honest call, not a
  per-source severity the data can't support. The entry comment records the lod_eventlog
  exception explicitly so the "6 of 7" is auditable.
- Entry comment cites all 7 sites; taxonomy row and PHASE_LOG verdict table updated.
- **Deferral condition met:** the PHASE_LOG cross-app follow-up now covers ALL emitters
  (Philips MRI/CT/CV, GE MRI/CT/CV, Siemens CV), per your stated requirement.
- 196/196. Family dormant live (0 events carry the category) → no live rows change now;
  binds at deploy. RULES_VERSION stays 2 (within-phase, unreleased).

## Verify

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test           # 196/196
grep -rn "datetime object null" /opt/apps/hhm_rpp_* --include=*.js # the 7 emitters above
```

## Open question for you

Is generalize-to-conservative-medium the right call over source-awareness, given the
category can't honestly tell the 6 from the 1 without a new fingerprint input? I judged
yes (the exception is also medium-worthy — a persisted null datetime is a data defect
regardless of the upsert), but flag it if you'd rather see `func`-based source-splitting.
