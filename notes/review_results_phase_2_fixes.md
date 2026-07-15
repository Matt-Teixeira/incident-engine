# Re-review Results — Phase 2 Fix Round

Decision: **needs fixes before commit**. The live rebuild and runtime fixes close the
original data defects, but the repository cannot reproduce two required schema upgrades
on an existing Phase 1 database, and the new noise filter is broad enough to erase
salient non-curl diagnostics.

## Findings

### 1. High — the tracked schema cannot upgrade a Phase 1 database

- **File + line:** `db/schema.sql:19` (related: `db/schema.sql:52`)
- **What & why:** The file adds `fp_version` and widens `entity` only inside
  `CREATE TABLE IF NOT EXISTS` definitions. On the normal upgrade path, both tables
  already exist from Phase 1, so reapplying `db/schema.sql` changes neither table.
  Materialize then fails because `error_events.fp_version` is absent, and Phase 3 still
  has a 32-character entity column. The live database is correct only because manual
  `ALTER TABLE` commands were run outside the tracked deployment surface; a fresh
  install is also correct, but an existing environment is not reproducibly upgradeable.
- **Suggested fix:** Add a tracked, idempotent Phase 2 migration (or explicit idempotent
  `ALTER` section in `schema.sql`) that:

  1. adds `fp_version`, backfills existing Phase 2 preview rows as version 1, then sets
     it `NOT NULL` without leaving an unintended default; and
  2. alters `incidents.incidents.entity` to `VARCHAR(64)`.

  Record that migration in the deployment runbook and Phase Log. Test both paths: an
  empty/fresh schema and an existing Phase 1 schema. Until this exists, original
  findings 2 and 4 are only partially closed at repository/deployment level.

### 2. Medium — noise matching still removes plausible diagnostic lines

- **File + line:** `domain/normalize.js:30`
- **What & why:** The filters are applied globally rather than within a recognized curl
  progress block. Three rules are semantically over-broad:

  - `/--:--:--/` removes any line containing that token;
  - the completed-row rule removes any line beginning with three numeric-ish columns;
  - `/^\s+at\s/` also matches indented prose beginning with “at”, not just JavaScript
    stack frames.

  Focused probes demonstrate the resulting information loss:

  - `Error summary:\n  404 10 2 files missing` normalizes to `error summary:`;
  - `Error summary:\n    at least 3 files failed` also normalizes to
    `error summary:`; and
  - `Time parser failed on --:--:-- sentinel` normalizes to the empty string.

  The current live matches are all genuine curl progress or Node frames, and no current
  message is fully erased, but the v1 contract would silently merge a future tabular or
  indented diagnostic with unrelated events.
- **Suggested fix:** Make curl filtering stateful: enter a progress block only after the
  exact two-line curl header, then remove rows matching the complete curl row shape until
  a non-progress line is reached. Do not use `--:--:--` as a standalone global rule.
  Tighten the stack rule to JavaScript frame syntax (for example a trailing source
  location or recognized `<anonymous>`/`index N` form), accepting an occasional retained
  frame rather than deleting ordinary prose. Add preservation goldens for the three
  examples above alongside the existing curl regression goldens.

### 3. Low — the guarded watermark update leaves misleading/regressing metadata

- **File + line:** `utils/db/queries/materialize.js:46` (related:
  `jobs/materialize/index.js:90`)
- **What & why:** `GREATEST` correctly prevents `last_inserted_at` from moving backward,
  but the run summary always reports `$2` as `watermark_after`, not the value actually
  stored. The handoff's future-watermark proof therefore logs an apparent regression
  even though PostgreSQL preserves the future value. Also, `updated_at = now()` uses the
  transaction-start clock; an older transaction that acquires the lock second can move
  `updated_at` backward even though its post-lock snapshot advances the real watermark.
  This does not cause skipped or duplicated events, but makes audit metadata inaccurate.
- **Suggested fix:** Set `updated_at = clock_timestamp()`, add
  `RETURNING last_inserted_at`, consume the returned value with `t.one`, and report that
  value in `watermark_after`.

### 4. Low — canonical phase documentation still describes the rejected behavior

- **File + line:** `markdown/PHASE_LOG.md:38` (related:
  `prompts/prompt_2_materialize.txt:13`,
  `markdown/ARCHITECTURE_PRINCIPLES.md:64`)
- **What & why:** The Phase Log's primary “Built” section still says normalization has a
  512-character cap, the text chain ends at `note.txt`, entity order is
  `sme -> job_id -> system_id`, entity width is 32, and the snapshot uses `now()`.
  The original Phase 2 prompt repeats those rejected contracts. Later review notes and
  the fingerprint-specific architecture section contain the corrected design, leaving
  the canonical record internally contradictory. The Architecture Data-Contract summary
  also omits `note.skip_reason` even though its fingerprint section includes it.
- **Suggested fix:** Update the Phase Log's final built/decision/validation summaries and
  the Phase 2 prompt (or clearly mark the old clauses as superseded by the fix handoff).
  Add `note.skip_reason` and producer `note.system_id` to the Architecture Data-Contract
  summary so future phases do not rediscover conflicting contracts.

## Original finding disposition

| Original finding | Status | Evidence |
| --- | --- | --- |
| 1. Prefix cap merged distinct failures | **Closed**, with new regression above | The cap is gone; live L0 has zero fingerprints spanning multiple categories; curl same-cause/different-cause goldens pass. The overly global replacement filter is Finding 2 of this re-review. |
| 2. Equipment identity dropped/job ID preferred | **Partially closed** | Flattening now stores all live `note.system_id` values; entity order and 64-character behavior pass tests; live dropped count is zero. The existing-database width upgrade is not tracked (Finding 1). |
| 3. Concurrent watermark regression | **Closed** | Snapshot is a separate post-lock `clock_timestamp()` statement and the advance uses `GREATEST`. The remaining summary/`updated_at` issue is metadata-only (Finding 3). |
| 4. Fingerprint version not persisted | **Partially closed** | Code, ColumnSet, clean-install DDL, and the live table persist version 1 on every row. The existing-database column upgrade is not tracked (Finding 1). |
| 5. `skip_reason` discarded | **Closed** | The fallback chain, literal SHA golden, docs, and 690 rebuilt live events show two reason-bearing fingerprints. |
| 6. Non-array payload silent | **Closed** | Flatten returns a skipped diagnostic and the materialize summary promotes it to a WARN; focused test passes. |

## Additional verification

- The documented suite passed: **41 tests, 41 passes**.
- Live L0 has **185,090** rows, all `fp_version = 1`, zero mixed-category
  fingerprints, and zero rows where a supplied `note.system_id` was dropped.
- The live schema has `fp_version SMALLINT NOT NULL` and `entity VARCHAR(64)`; the issue
  is reproducibility of that state, not the current database state.
- `incidents.incidents` is empty and no external grantee has privileges on
  `incidents.*`, so keeping `FP_VERSION = 1` after truncating the uncommitted preview
  backfill is sound. Nothing downstream could have consumed the rejected identities.
- Every line matching the new filters in the current corpus is transfer progress or a
  Node stack frame, and no current distinct message is fully removed. Tightening the
  filters is a pre-freeze robustness correction, not evidence that the rebuilt live
  counts are presently wrong.
- Producer self-logs use single autocommit inserts (`db.none`), so the default five-second
  overlap is reasonable for ordinary commit skew. Retain it as configurable and monitor
  for DB/lock stalls longer than the overlap.
- `note.system_id` format validation without an existence lookup is appropriate at L0;
  Phase 3's best-effort LEFT JOIN can distinguish IDs absent from the reference table.
- `note.skip_reason` does not need a dedicated column in Phase 2 because `raw_event`
  retains it and Phase 3 can reconstruct the documented text chain.
- The uncapped regex pipeline is linear for the current rules and live messages are
  small; no catastrophic-backtracking path was found.
