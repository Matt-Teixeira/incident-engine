# Phase 2 Re-evaluation (pre-implementation) — 2026-07-14

FLOW Step 3 pass over `prompts/prompt_2_materialize.txt` after Phase 1 completed
(including the Codex review fixes). Verdict: **implement as revised** — the phase's
shape (watermark → scan → flatten/fingerprint/classify → ON CONFLICT insert) is
unchanged; four live facts required prompt/contract updates before implementation.

## Live measurements (superuser, `staging`)

Producers, 3-day window (rows / rows-with-events / total events):

| app_name | rows | rows w/ events | events |
| --- | --- | --- | --- |
| hhm_rpp_philips | 2448 | 2448 | 32334 |
| data_acquisition | 3370 | 2880 | 30249 |
| hhm_rpp_ge | 432 | 432 | 13248 |
| incident-engine | 7 | **1** | **2** |
| ops-dashboard | 864 | 0 | 0 |
| acquisition-v2 | 86 | 0 | 0 |

Event text-field presence, 1-day window (~25k events/day total):

| app_name | err_msg | note.message | note.txt | note.sme | note.job_id |
| --- | --- | --- | --- | --- | --- |
| data_acquisition | 55.4% | 28.9% | 14.8% | 46.1% | 81.9% |
| hhm_rpp_ge | 0% | 100% | 0% | 57.6% | 100% |
| hhm_rpp_philips | 31.6% | 68.4% | 0% | 84.4% | 100% |

## Changes made (docs-only; no code)

1. **Self-log exclusion is now explicit.** Phase 1's failure-path tests proved
   incident-engine's own WARN/ERROR events land in `util.app_run_logs` (1 row / 2
   events above). An unfiltered scan would ingest our own errors — a feedback loop.
   `PRODUCING_APPS` is an explicit allowlist constant and the prompt/principles forbid
   `'incident-engine'` in it. Deliberate self-ingestion is parked as a future decision.
2. **`acquisition-v2` stays excluded.** It writes run rows but zero warn/error events;
   its event shape is unverified. Step 2 of Phase 2 re-checks; if it has begun emitting,
   implementation stops and the allowlist decision comes back to the developer. Parked
   in PROMPTS.md "Not decided yet".
3. **Fingerprint text chain extended: `err_msg || note.message || note.txt || ''`.**
   The three fields are nearly complementary on `data_acquisition` (55/29/15) and
   `note.txt` is its only text on ~15% of events (e.g. `{txt: "NO TUNNEL FOUND"}`) —
   without it those events fingerprint on `func|tag` alone. Changed NOW, before any
   fingerprint ships, so it costs nothing (`FP_VERSION` stays 1). Updated:
   `docs/error-taxonomy.md`, `docs/incidents-schema.md`, Fingerprint-Stability +
   Data-Contract rules in `markdown/ARCHITECTURE_PRINCIPLES.md`. The `note_message`
   *column* still stores `note.message` only; the chain is the fingerprint/classify
   input.
4. **Phase 1 conventions folded into the prompt:** batch failure throws → exit 1 with
   the watermark unadvanced (and the Phase-1-deferred failure-exit smoke moves into
   Phase 2 validation); `domain/` + `test/` stay dependency-free (bare `node:lts` test
   runner); reuse the existing `pg_column_sets.incidents.error_events` from Phase 1;
   `raw_event` JSONB storage made explicit; first-run scan is bounded by ~7-day source
   retention (~175k events); codex handoff required per FLOW Step 7.

## Not changed

- Fingerprint fields (`app|func|tag|type|normalize(TEXT)`), `FP_VERSION=1`, entity
  fallback (`sme → job_id → system_id → __global__`) — presence stats support them
  (sme 46–84%, job_id 82–100%).
- Watermark/overlap/ON CONFLICT idempotency design — unchanged.
- Env contract — `MATERIALIZE_OVERLAP_MS` / `MATERIALIZE_BATCH_ROWS` already reserved.
