# Phase 6 Review Results — rounds 1–4 (Codex)

## Round 4 verdict (F4 still not fully closed — evidence MISCOUNTED)

Round 3's generalized medium verdict accepted as sound, but my evidence count was wrong on
two points (both verified and corrected):

- **8 emitters, not 7.** `grep -rc` confirms: Philips has **four** (MRI/logcurrent,
  CT/eal_parser, CV/eventlog, **CV/lod_eventlog**), GE three, Siemens one = 8. My round-3
  prose said "7 emitters / 6 of 7 share the upsert" while my own table listed 8 rows —
  an internal contradiction the reviewer caught. Correct: **7 of 8 call the upsert**
  (only CV/lod_eventlog does not).
- **CV/eventlog selects the FIRST record, not the last.** [eventlog.js:222](/opt/apps/hhm_rpp_philips/jobs/Philips/CV/eventlog.js:222)
  passes `mappedData[0].host_datetime` to the upsert; the other six pass
  `mappedData[mappedData.length - 1]`. So "last record" was wrong for one path — a null
  in the SELECTED record (first for eventlog, last for the rest) is what breaks the upsert.
- **Fix:** "last record" → "selected record" in the assessor reason, the action string
  (now notes CV/eventlog selects the first), the `engine_regexes.js` entry (full 8-row
  table with per-path selected-record annotations), the taxonomy row, and the PHASE_LOG
  follow-up (now names all eight emitters, including both distinct Philips CV parsers).
  Count corrected to 8 / 7-of-8 everywhere authoritative. 196/196.
- The medium verdict and the deferral are unchanged — only the evidence count/wording
  moved. This is the reviewer's stated condition for accepting the deferral (tracking must
  name all eight emitters), now met.

> Round 3's section below is left as the point-in-time record; its "7 / 6-of-7 / last
> record" numbers are **superseded by round 4** (8 / 7-of-8 / selected record).

---

# Rounds 1–3 record

## Round 3 verdict (F4 partially closed)

- **MRI/CT fix accepted:** the null-last-record upsert failure is correctly rated medium
  with the right producer remedy.
- **Open point (verified real):** the `datetime_parse_null` regex matches the SAME exact
  text from more emitters than my round-2 evidence named, and the branch's reason/action
  claimed *every* match breaks *that specific Philips* upsert. Reviewer: generalize the
  reason/action, or make classification source-aware.
- **Verification (full producer sweep for `datetime object null`):** 7 emitters —
  Philips MRI/logcurrent, CT/eal_parser, CV/eventlog, CV/lod_eventlog; GE MRI/gesys_parser,
  CT/gesys_parser, CV/sysError_parser; Siemens win_10/siemens_cv. **6 of the 7 share the
  identical failure mode** — each feeds the last record's `host_datetime` into
  `build_upsert_str` → `alert.offline_hhm_conn`, and GE's and Siemens' `build_upsert_str`
  quote `'${recent_host_datetime}'` byte-for-byte like Philips'. The **lone exception is
  Philips CV/lod_eventlog**: it persists the null (`data.push` with `host_datetime = null`)
  but makes no upsert call. So my round-2 reason was both too narrow (named only Philips)
  and slightly overclaiming (not *every* match hits an upsert).
- **Fix (generalize, keep medium):** the R7b quality reason now states the cross-vendor
  pattern honestly — "across the Philips/GE/Siemens post-processors that feed the last
  record into the `alert.offline_hhm_conn` upsert (6 of 7 emitters of this message), a null
  last record sends a quoted 'null' to a timestamptz and the offline-health row goes
  stale." The action is pluralized to "the producer(s) … across the Philips/GE/Siemens
  post-processors." Chose GENERALIZE over source-aware: the text is identical and
  `error_category` is not in the fingerprint, so the category cannot honestly distinguish
  emitters — a conservative medium across all matches is the truthful call, and the entry
  comment records the exception explicitly. Entry comment (all 7 sites cited), taxonomy
  row, and PHASE_LOG verdict table updated; 196/196.
- **Deferral condition met:** the cross-app follow-up in PHASE_LOG now explicitly covers
  **all emitters** of `datetime object null` (Philips MRI/CT/CV, GE MRI/CT/CV, Siemens CV),
  not just Philips MRI/CT — the reviewer's stated requirement for accepting the deferral.
- Live: family still dormant (0 events carry the category), so no live rows change now.
  RULES_VERSION stays 2 (within-phase, unreleased).

---

# Rounds 1–2 record

## Round 2 verdict (on the fix delta)

- Prefix `^File not found in directory: ` — **accepted** (anchored at start, variable
  path suffix intentional, no production-pattern collision).
- Permanent-medium `unknown` for the two ambiguous texts — **accepted**; upstream producer
  disambiguation (not another engine regex) is the durable fix, and tracking upstream is
  sufficient because the fallback is conservative.
- **F4 escalated to MEDIUM (verified real, again worse than my fix):** two parts. (a) My
  round-1 fix corrected the ACTIONS string but MISSED the R7b quality branch's REASON
  string, which still said "skipped" — reviewer caught it at `rules.js:589`. (b) New
  downstream evidence, verified against all three files: both parsers interpolate the LAST
  record's `host_datetime` into the offline-health upsert
  (`logcurrent.js:195-201`, `eal_parser.js:181-187` → `util/upsertHostDatatime.js`:
  `'${resent_host_datetime}'`). A null becomes the QUOTED STRING `'null'`, which
  PostgreSQL rejects for `timestamptz` (22007); the whole upsert fails into the catch, and
  `alert.offline_hhm_conn.rpp_host_datetime` goes stale for that system whenever the last
  parsed record is a null-datetime one. NOT absorbed quality noise — a real per-system
  monitoring gap.
- **Fix:** R7b quality → **medium @ 0.7** (was low @ 0.6), reason rewritten with the
  downstream evidence; action now directs the producer fix (skip/null-handle or last VALID
  timestamp); entry comment, taxonomy row, PHASE_LOG verdict table, and the severity-table
  test all updated. 196/196 after. The PRODUCER fix itself is cross-app (this repo never
  edits the other apps) — tracked as a follow-up alongside upstreaming.
- Live footprint today: dormant — 0 events carry the category; the 2 incidents with that
  sample message (138 events) sit at `unknown`/medium via the residual policy, so the
  round-2 rating changes no live rows now and binds at deploy on the family's next
  recurrence.
- RULES_VERSION stays 2: within-phase, unreleased (the Phase 4 precedent — versions bump
  per released phase, not per review iteration).

---

# Round 1 record

Verdict: **needs changes** — 1 high, 2 medium, 2 low. Reviewer's framing: "the 196 tests
pass, but they encode several unsupported producer assumptions." **All five findings
verified real against producer code before fixing** (the standing pattern), and two were
worse than reported. This round is the strongest validation yet of the F2 standard the
phase claimed to follow: three of the five are places where I cited a producer file but
mis-read (or under-read) what it DOES.

## F1 (HIGH): `no_new_data` matched "No new monitoring data found." — unsupported

- **Claim reviewed:** the engine table rated that text info/status ("normal
  between-acquisition state"), citing `insert_jsonb_data.js:133-141`.
- **Verified — the reviewer is right.** `phil_mri_monitor` emits it whenever `jsonData`
  stayed empty after the per-file loop, and `matchAll` never returns falsy (the
  `!matches` branch is dead code), so the ONLY paths that leave `jsonData` empty are the
  three `continue`s: file absent, stale redis cache (`file_data === null`), and
  `file_data === undefined` — which `Philips_MRI_Monitor.js`'s catch blocks return on ANY
  fs/exec error with no `error.code` check. The message is emitted after failed inputs as
  well as quiet ones. **Not proof of normal inactivity.**
- **Fix:** the `monitoring data found\.` alternative removed from `no_new_data`'s regex;
  the text drops to `unknown` (residual medium — conservatively actionable) until the
  producer distinguishes "all unchanged" from failed reads. Rationale recorded at the
  entry; unit pin added ("ambiguous producer texts deliberately stay unknown").

## F2 (MEDIUM): `JOB HALTED -> NON-CONFORMANT config` is a config gate, not a halt

- **Verified.** `mmb/index.js:37-45`: the config array lacks
  sme/mmbScript/pgTable/machineRegexTags → WARN + `return` BEFORE any acquisition is
  attempted. Same semantics as `config_missing` (a human fixes the system row), not
  "investigate a failed run".
- **Fix:** a second `config_missing` entry (`/^JOB HALTED -> NON-CONFORMANT config$/`,
  manual_intervention → high) ordered ABOVE the generic `^JOB HALTED` entry; the generic
  entry's citation corrected to the real halt site (`mmb/index.js:74-82`,
  `fileSizeAfterRsync === null`); `job_halted`'s action string no longer mentions
  non-conformant config. Unit case flipped to pin the ordering (first-match-wins makes
  the case itself the ordering test). Slug/category counts unchanged (9 engine categories,
  10 entries; both count pins dedupe by slug).

## F3 (MEDIUM): `input_file_missing` neither complete nor truth-preserving — verified, worse than reported

- **Under-match (verified):** GE's `checkFileExists` (`GE_CT_CV_MRI.js:139-144`) THROWS
  `File not found in directory: <path>` (logged E) — my anchored `^File not found$`
  missed it, leaving a genuine missing-input signal in `unknown`. Fixed: new alternative
  `^File not found in directory: `.
- **Over-claim (verified, and sharper than the review stated):** the bare WARN text
  `File not found` is emitted by TWO producers with DIFFERENT truth values —
  `lod_eventlog.js:66-75` on a genuine `existsSync` miss, but `insert_jsonb_data.js:91-102`
  as a relabel of `file_data === undefined`, i.e. ANY caught read/exec error (permissions,
  I/O — no ENOENT check). Same text, two meanings → a text-only classifier cannot preserve
  truth. **Also self-caught while verifying: my entry had cited `eal_parser.js:56-64` as
  evidence — that site logs at INFO and never reaches `warn_error_logs` at all.** Wrong
  citation, now removed.
- **Fix:** `^File not found$` removed (drops to `unknown`/residual medium — severity
  happens to be unchanged, but the category and the "check the upstream pull" action no
  longer overclaim); the deliberate non-match and its reason are recorded at the entry, in
  the taxonomy doc, and in a unit pin.

## F4 (LOW): `datetime_parse_null` evidence said "skipped" — the records are kept

- **Verified.** Both parsers (`logcurrent.js:117-139`, `eal_parser.js:109-137`) log the
  WARN and then `data.push(...)` the record with `host_datetime = null` — the line is
  APPENDED, not skipped.
- **Fix:** entry comment/message and the assessor action corrected ("records stored with
  a null host_datetime"). Verdict retained at low/quality with the corrected rationale:
  null-datetime rows accumulating in stored data is a data-quality defect, not a run
  failure.

## F5 (LOW): superseded interim-unknown policy still in current-contract docs

- **Verified.** `docs/error-taxonomy.md` (the assessor-consumption bullet) and
  `docs/incidents-schema.md` (`type` row) still described `unknown` as "interim medium…
  pending classification". Fixed: both now state the Phase 6 permanent-medium policy, with
  the interim history kept as history. (The unit sweep only guards REASON STRINGS — docs
  drifted exactly as the reviewer predicted in the handoff's priority 5.)

## Self-caught while responding (recorded here because it corrects the round-1 handoff)

The handoff §5.2 claimed between-deploys flap affects "counts, not categories". **False.**
Measured 17:39 (two hours after the §5.2 snapshot): all 213 previously-converged incidents
were back to `unknown` and all 509 assessments at v1 — every pinned-cron tick that
processes a producer burst stamps the new events `unknown` (v1 classifier has no engine
table) and newest-representative refresh flips the incidents' CATEGORIES back. The §5.2/
§5.3 numbers are a transient post-dev-run snapshot; the oscillation is total (categories +
assessments) for actively-recurring incidents, and true convergence lands only at deploy.
The original handoff carries a bracketed correction pointing at the fix-round delta.

## Post-fix validation

- 196/196 unit (net count unchanged: 2 cases removed, 1 case + 1 two-assert pin added).
- Timed 17:51 post-burst dev-tree run (fixed classifier): `unknown` 79 / 38,742 (the two
  reverted families moved in, as they must), `input_file_missing` 74 / 72,900,
  `no_new_data` 49 / 23,809 (GE-delta + rmmu shapes only); severity **medium 262 /
  high 197 / info 50** — F1's real-world size is 37 incidents moved info → medium.
  Cross-check: the reverted-text families are 75 `unknown`/`classifier`/medium + 12
  `rsync_io_timeout`/`oracle`/medium (R0 gate — Phase 4 contract, not a leak).
  Interim-reason sweep: 0. Full table in `codex_handoff_phase_6_fixes.md`.
- Parity over the corrected table: **PASS** — 509 checked, severity distribution
  {high:197, medium:262, info:50}, provenance {classifier:494, oracle:15}, state
  {open:363, resolved:143, recurring:3}, action_* leaks 0.
