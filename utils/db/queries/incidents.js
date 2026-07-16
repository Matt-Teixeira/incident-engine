// utils/db/queries/incidents.js — the Phase 3 aggregate: roll new
// incidents.error_events rows up into incidents.incidents, one row per
// (fingerprint, entity), idempotently.
//
// HOUSE-STYLE NOTE: unlike the per-row inserts elsewhere (pgp.helpers ColumnSet
// from JS objects), this is a set-based INSERT ... SELECT ... GROUP BY ...
// ON CONFLICT, as the phase prompt directs ("prefer SQL-side aggregation —
// fingerprint/category are already on error_events"). The intent behind the
// ColumnSet rule (no injection, no dynamic SQL) still holds: the statement is
// fully static and parameterized — only $1/$2 (the watermark window bounds)
// are values, everything else is fixed text.
//
// IDEMPOTENCY (the correctness core of this phase):
//   - occurrence_count is ADDITIVE (+= EXCLUDED). An additive counter is only
//     exactly-once if every error_events row falls in EXACTLY ONE aggregate
//     window. There is therefore NO overlap lookback here (unlike materialize's
//     source scan): the window is the strict half-open (watermark, snapshot].
//   - Exactly-once needs TWO guarantees together (Phase 3 review, high finding
//     — the lock ALONE is not enough):
//       (a) The aggregate takes its snapshot and advances its watermark while
//           holding the materialize watermark row lock, so no materialize tx is
//           COMMITTING concurrently (MVCC-visible mid-flight rows can't slip in
//           between the read and the advance). See jobs/aggregate/index.js.
//       (b) error_events.inserted_at — the cursor — is stamped at INSERT time
//           via DEFAULT clock_timestamp(), NOT transaction-start NOW(). A
//           materialize tx can START before the aggregate (fixing its NOW()),
//           be descheduled before it acquires the lock, and commit AFTER the
//           aggregate advanced its watermark; with NOW() its rows would carry a
//           timestamp below that watermark and be skipped forever. Because the
//           inserts run only after materialize holds the lock, clock_timestamp()
//           is always later than any watermark the aggregate set while
//           materialize was still waiting — so the cursor orders with the lock.
//     CLOCK ASSUMPTION (Phase 3 re-review, medium): (b) holds only under a
//     NONDECREASING database clock. clock_timestamp() is a wall clock; if the
//     server clock steps backward in the sub-second window between the aggregate
//     advancing its watermark and a pre-lock materialize inserting, that row can
//     land at inserted_at <= the watermark and be skipped — a silent UNDERCOUNT
//     (never a double-count/corruption). This matches the assumption the rest of
//     the pipeline's timestamp watermarks already make. An unconditional
//     guarantee would swap the timestamp cursor for a monotonic logical one (a
//     post-lock BIGSERIAL/batch sequence); recorded as the upgrade path in
//     PHASE_LOG, not built now (proportionate to the residual risk).
//   - The idempotent fields (first/last_seen = LEAST/GREATEST, apps/systems =
//     set-union) would tolerate re-scan; only the additive count cannot, which
//     is why overlap is dropped for the whole statement.
//   - Re-run with no new rows → empty window → no-op. Crash mid-batch → tx
//     rollback (watermark unadvanced, no partial upsert) → next run recounts
//     the window from scratch, which is its first successful count. Exactly
//     once. (A deliberate watermark REWIND after a committed batch is NOT
//     idempotent for an additive counter — that is operator action, out of the
//     Idempotency Rule's re-run/crash scope; documented in PHASE_LOG.)
"use strict";

const { SYS_ENRICH_CTE, FINAL_CATEGORY_EXPR } = require("./enrichment");

// $1 = watermark (exclusive lower bound), $2 = snapshot (inclusive upper).
const UPSERT_INCIDENTS_SQL = `
WITH batch AS (
  SELECT
    fingerprint,
    entity,
    src_app_name,
    system_id,
    run_id,
    event_ord,
    error_category,
    error_type,
    func,
    -- lifecycle clock: the event's own dt (when it actually happened), with
    -- L0 inserted_at as the fallback only for the (currently zero) null-dt
    -- rows. inserted_at is a poor proxy after a backfill, but bounds a
    -- null-dt row to a real instant rather than dropping it from first/last.
    COALESCE(dt, inserted_at) AS ts,
    -- human-readable representative message = the eventText chain
    -- (err_msg → note.message → note.txt → note.skip_reason), reconstructed
    -- from the stored columns + raw_event. NOT the normalized hash input.
    -- Mirrors domain/fingerprint.js:eventText (nonEmptyString semantics): each
    -- candidate is trimmed and a whitespace-only value is treated as absent, and
    -- a non-string JSON txt/skip_reason is ignored (jsonb_typeof guard) — so SQL
    -- and JS pick the same candidate (Phase 3 review, low finding).
    -- btrim's DEFAULT set is spaces only; JS String.trim() also strips tab/LF/CR/
    -- FF/VT, so we pass the explicit ASCII-whitespace set (re-review, low). Exotic
    -- Unicode whitespace (NBSP, …) is not covered — never present in these ASCII
    -- log messages; persisting the computed eventText on L0 is the exact-parity
    -- upgrade if that ever changes.
    COALESCE(
      NULLIF(btrim(err_msg, E' \t\n\r\f\v'), ''),
      NULLIF(btrim(note_message, E' \t\n\r\f\v'), ''),
      NULLIF(btrim(CASE WHEN jsonb_typeof(raw_event #> '{note,txt}') = 'string'
                        THEN raw_event #>> '{note,txt}' END, E' \t\n\r\f\v'), ''),
      NULLIF(btrim(CASE WHEN jsonb_typeof(raw_event #> '{note,skip_reason}') = 'string'
                        THEN raw_event #>> '{note,skip_reason}' END, E' \t\n\r\f\v'), ''),
      ''
    ) AS msg
  FROM incidents.error_events
  WHERE inserted_at > $1 AND inserted_at <= $2
),
agg AS (
  SELECT
    fingerprint,
    entity,
    count(*)::bigint AS occurrence_count,
    min(ts) AS first_seen,
    max(ts) AS last_seen,
    array_agg(DISTINCT src_app_name ORDER BY src_app_name)
      FILTER (WHERE src_app_name IS NOT NULL) AS apps,
    array_agg(DISTINCT system_id ORDER BY system_id)
      FILTER (WHERE system_id IS NOT NULL) AS systems
  FROM batch
  GROUP BY fingerprint, entity
),
rep AS (
  -- one representative event per (fingerprint, entity): the GLOBAL total order
  -- (ts DESC, run_id DESC, event_ord DESC). All-DESC so it matches the ON
  -- CONFLICT refresh guard below, which compares (last_seen, sample_run_id):
  -- rep.ts == the group's max ts == last_seen, so (last_seen, sample_run_id) IS
  -- this sort key's leading pair, and incremental aggregation converges to the
  -- same representative a single-batch full rebuild would pick. Events sharing
  -- (ts, run_id) always co-materialize in one batch, so the event_ord tiebreak
  -- never needs to cross batches (Phase 3 review, low finding).
  SELECT DISTINCT ON (fingerprint, entity)
    fingerprint, entity, run_id, system_id, msg,
    error_category, error_type, func
  FROM batch
  ORDER BY fingerprint, entity, ts DESC, run_id DESC, event_ord DESC
),
${SYS_ENRICH_CTE},
enriched AS (
  SELECT
    rep.*,
    ${FINAL_CATEGORY_EXPR} AS final_category
  FROM rep
  LEFT JOIN sys_enrich se USING (system_id)
)
INSERT INTO incidents.incidents AS inc (
  fingerprint, entity, occurrence_count, first_seen, last_seen,
  apps, systems, sample_run_id, sample_message,
  category, error_type, phase, func
)
SELECT
  a.fingerprint, a.entity, a.occurrence_count, a.first_seen, a.last_seen,
  COALESCE(a.apps, '{}'::text[]), COALESCE(a.systems, '{}'::text[]),
  e.run_id, e.msg,
  e.final_category,         -- may be oracle-corroborated (enrichment.js)
  e.error_type,             -- classifier's only; NOT corroborated ('' when the
                            -- category was corroborated — no category→type
                            -- lookup here; see enrichment.js)
  '',                       -- phase: not enriched in Phase 3 (see enrichment.js)
  e.func
FROM agg a
JOIN enriched e USING (fingerprint, entity)
ON CONFLICT (fingerprint, entity) DO UPDATE SET
  occurrence_count = inc.occurrence_count + EXCLUDED.occurrence_count,
  first_seen = LEAST(inc.first_seen, EXCLUDED.first_seen),
  last_seen  = GREATEST(inc.last_seen, EXCLUDED.last_seen),
  apps = COALESCE(
    (SELECT array_agg(DISTINCT x ORDER BY x)
       FROM unnest(COALESCE(inc.apps, '{}'::text[]) || COALESCE(EXCLUDED.apps, '{}'::text[])) x),
    '{}'::text[]),
  systems = COALESCE(
    (SELECT array_agg(DISTINCT x ORDER BY x)
       FROM unnest(COALESCE(inc.systems, '{}'::text[]) || COALESCE(EXCLUDED.systems, '{}'::text[])) x),
    '{}'::text[]),
  -- representative-derived fields refresh only when THIS batch's representative
  -- outranks the stored one in the global total order (ts, run_id) — i.e. a
  -- strictly newer event, or an equal-ts event with a higher run_id. This makes
  -- the chosen sample INDEPENDENT of batch arrival order, so incremental
  -- aggregation and a full rebuild land on the same representative for identical
  -- L0 data (Phase 3 review, low finding). last_seen == the representative's ts
  -- (see rep), so (last_seen, sample_run_id) is exactly that sort key.
  -- NOTE (re-review, low): refreshing category on the newest representative
  -- means a newer 'unknown'-classified event of the SAME fingerprint could
  -- overwrite a confident category. Safe in practice only because a fingerprint
  -- is single-category (Phase 2: 0 mixed-category fingerprints live -- classify
  -- is deterministic on eventText and the category keywords survive normalize).
  -- If a future taxonomy change ever makes a fingerprint mixed-category, prefer a
  -- confident category over 'unknown' here.
  sample_run_id  = CASE WHEN EXCLUDED.last_seen > inc.last_seen OR (EXCLUDED.last_seen = inc.last_seen AND EXCLUDED.sample_run_id > inc.sample_run_id) THEN EXCLUDED.sample_run_id  ELSE inc.sample_run_id  END,
  sample_message = CASE WHEN EXCLUDED.last_seen > inc.last_seen OR (EXCLUDED.last_seen = inc.last_seen AND EXCLUDED.sample_run_id > inc.sample_run_id) THEN EXCLUDED.sample_message ELSE inc.sample_message END,
  category       = CASE WHEN EXCLUDED.last_seen > inc.last_seen OR (EXCLUDED.last_seen = inc.last_seen AND EXCLUDED.sample_run_id > inc.sample_run_id) THEN EXCLUDED.category       ELSE inc.category       END,
  error_type     = CASE WHEN EXCLUDED.last_seen > inc.last_seen OR (EXCLUDED.last_seen = inc.last_seen AND EXCLUDED.sample_run_id > inc.sample_run_id) THEN EXCLUDED.error_type     ELSE inc.error_type     END,
  func           = CASE WHEN EXCLUDED.last_seen > inc.last_seen OR (EXCLUDED.last_seen = inc.last_seen AND EXCLUDED.sample_run_id > inc.sample_run_id) THEN EXCLUDED.func            ELSE inc.func            END,
  updated_at = clock_timestamp()
-- xmax = 0 on a freshly inserted tuple, non-zero on a conflict-updated one:
-- lets the job report inserted vs updated without a second query.
RETURNING (xmax = 0) AS inserted`;

module.exports = { UPSERT_INCIDENTS_SQL };
