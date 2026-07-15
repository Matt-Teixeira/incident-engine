# Review Results — Phase 2

Decision: **needs fixes before commit**. The transaction is atomic, source scan is
properly bounded, and the classifier copy is faithful, but two live-data findings would
freeze incorrect incident identities and the concurrent watermark can regress.

## Findings

### 1. High — the 512-character normalization cap merges distinct failures

- **File + line:** `domain/normalize.js:38`
- **What & why:** `normalize()` truncates the normalized message to its first 512
  characters before hashing. Long command failures commonly put curl's actual error
  after a progress preamble, beyond that boundary. The live materialized corpus already
  contains two fingerprints that each combine `connection_timeout` and
  `partial_transfer_timeout`; one affected system (`SME18032`) has both categories under
  each fingerprint. In total, five partial-transfer failures are merged into buckets
  dominated by 3,215 connection failures. Representative raw messages share the same
  normalized progress prefix but end with materially different signals: “Failed to
  connect” versus “Operation timed out ... with ... bytes received.” Phase 3 would
  aggregate these into the same problem for the same equipment, leaving category and
  assessment dependent on sample/aggregation behavior.
- **Suggested fix:** Do not use a blind prefix as the fingerprint input. While version 1
  is still free to change, normalize multiline command output by removing known volatile
  noise (curl progress rows and Node stack frames) while retaining the salient error
  lines, then hash the full remaining normalized text. At minimum, remove the 512 cap;
  however, do that together with progress-noise normalization or equivalent extraction
  so variable progress output does not cause the opposite problem (over-splitting).
  Add golden cases proving variants of the same transfer failure group together and the
  live connection/partial-transfer examples remain distinct. Because version-1 rows
  have already been backfilled live, rebuild them from retained source data (or migrate
  their fingerprints) before accepting the phase.

### 2. High — stable equipment identity is dropped, then job IDs take precedence

- **File + line:** `jobs/materialize/flatten.js:53` (related:
  `domain/entity.js:25`)
- **What & why:** Flattening derives `system_id` only from `note.sme` and ignores a
  directly supplied `note.system_id`. Live data contains 5,270 such events, covering 14
  valid system IDs, all currently stored with `system_id = NULL`. For these events there
  are 4,926 distinct `job_id` values. The entity helper then chooses
  `job_id` before `system_id`, so even after capturing the latter, Phase 3 would create
  close to one incident identity per run instead of one per affected equipment. The
  32-character entity cap also truncates the observed 36-character UUID job IDs.
- **Suggested fix:** Validate and store `note.system_id`, falling back to a system ID
  derived from `sme` when it is absent. Change the stable fallback order to
  `sme -> system_id -> job_id -> __global__` and update the schema contract/tests. If a
  job ID remains a legitimate final fallback, make `entity` large enough to store it
  losslessly (or use an explicitly versioned stable encoding). Rebuild or update the
  existing L0 rows before Phase 3 consumes them.

### 3. Medium — a blocked concurrent transaction can move the watermark backward

- **File + line:** `utils/db/queries/materialize.js:18` (related:
  `jobs/materialize/index.js:58`, `utils/db/queries/materialize.js:36`)
- **What & why:** `now()` is PostgreSQL's transaction-start timestamp, not the time the
  watermark lock is acquired. If transaction A starts first but is delayed, transaction
  B can start later, acquire the row lock first, scan through B's newer timestamp, and
  commit. A then acquires the lock with its older `now_snapshot`, scans an inverted or
  older window, and unconditionally updates `last_inserted_at` backward. The primary key
  prevents double-counting and the next run replays safely, so this does not lose data,
  but it violates the monotonic watermark contract and can cause unexpectedly large
  rescans.
- **Suggested fix:** Lock and read the watermark in one statement without selecting
  `now()`, then obtain `clock_timestamp()` (or a new statement timestamp) in a separate
  query after the lock statement returns. Also make the update defensive with
  `last_inserted_at = GREATEST(last_inserted_at, $2)`. Add a two-connection concurrency
  test where the older transaction deliberately acquires the lock second.

### 4. Medium — `FP_VERSION` is not persisted with materialized rows

- **File + line:** `domain/fingerprint.js:17` (related:
  `jobs/materialize/index.js:117`)
- **What & why:** Version 1 exists only as a code constant and a run-summary field.
  `incidents.error_events` stores no fingerprint version. After a future version bump,
  old and new fingerprints will coexist but a query cannot identify which algorithm
  produced an individual row, despite the source comment saying the constant makes a
  mixed table detectable. That makes targeted rebuilds, compatibility checks, and
  version-aware aggregation unreliable.
- **Suggested fix:** Add a non-null `fingerprint_version` (or `fp_version`) column to
  `error_events`, include it in the Phase 2 ColumnSet/flattened row, and set it from
  `FP_VERSION`. Backfill the existing live rows as version 1 and update the schema
  contract. Keep the version out of the category logic; its purpose is provenance and
  controlled migration.

### 5. Medium — the text chain discards a live message-like field

- **File + line:** `domain/fingerprint.js:23`
- **What & why:** There are 688 live `data_acquisition` warning events for which
  `err_msg`, `note.message`, and `note.txt` are all empty, but
  `note.skip_reason = 'missing host_ip'` is populated. `eventText()` returns an empty
  string, so classification receives no signal and the fingerprint contains only
  app/function/tag/type. The two current functions happen to have only one skip reason,
  but a new reason under either function would silently merge with the existing problem
  after the identity contract is frozen.
- **Suggested fix:** Add non-empty `note.skip_reason` as the next documented fallback,
  with golden fingerprint and flatten tests. It may still classify as `unknown` under
  the copied taxonomy, but the fingerprint will retain the producer's stated reason.

### 6. Low — malformed non-array payloads advance silently

- **File + line:** `jobs/materialize/flatten.js:22`
- **What & why:** A non-null `warn_error_logs` value that is valid JSON but not an array
  is converted to an empty array and returns no rows and no `skipped` entry. The
  transaction then advances the watermark with no warning, contrary to the defensive
  contract that malformed source data is skipped and logged. The current test at
  `test/flatten.test.js:103` locks in the silent behavior.
- **Suggested fix:** Return a row-level skipped diagnostic (for example with
  `event_ord: null`) whenever a scanned non-null payload is not an array, and update the
  test to require that diagnostic. Continuing to advance is reasonable once the defect
  is visible; otherwise one poison row could block the pipeline indefinitely.

## Verified without findings

- The source query selects `warn_error_logs`, never `verbose_log`, and bounds
  `inserted_at` on both sides. The `:csv` allowlist is safely formatted by pg-promise.
- The current producer check still supports the exact allowlist:
  `data_acquisition`, `hhm_rpp_ge`, and `hhm_rpp_philips`. `acquisition-v2` remains
  silent, while `incident-engine` has emitted events and is correctly excluded.
- `ON CONFLICT (run_id, event_ord) DO NOTHING` and the single transaction make replay
  idempotent and roll back inserts plus watermark together on ordinary failures.
- The copied `connection_regex.js` is byte-for-byte identical to the production source;
  the wrapper preserves ordered, first-match-wins behavior. The two pg-promise helper
  roots do not create a second DB pool; `utils/db/pg-pool.js` remains the singleton pool.
- The documented test command passed: 35 tests, 35 passes.
- The single-transaction memory model is proportionate to the measured workload today:
  184k events completed successfully; their raw JSON occupies about 101 MB and the
  largest source run contains 121 events. It should be revisited before retention or
  event volume grows roughly 3–5x, because parsed source objects, flattened rows, and
  generated insert strings can expand well beyond raw JSON size. Recording peak RSS and
  imposing a maximum backfill/window size would make that threshold evidence-based.
- `raw_event` currently accounts for about 101 MB of a 230 MB total L0 relation. That is
  defensible for the short retained source window and future forensic value; retention
  can remain parked until sustained growth data exists.
- Live events currently have valid `dt` values, so source-clock use is not causing a
  Phase 2 loss. Before Phase 3 relies on it for lifecycle time, define and test a fallback
  or skew policy using the source row's database `inserted_at`; L0's own `inserted_at` is
  materialization time and is a poor fallback after a backfill.
