# Codex Handoff — Phase 6 FIX ROUND (delta)

Branch: `phase-6-classify-unknowns` — uncommitted, nothing pushed. Round 1:
`codex_handoff_phase_6.md` → `review_results_phase_6.md` (1 high, 2 medium, 2 low; **all
five verified real** against producer code — two were worse than reported). **Scope: the
fixes only**; per-finding verdict requested (closed / partially / not).

## Finding → fix

**F1 (high, "No new monitoring data found." ≠ normal inactivity) — fixed, your suggested
arm:** the `monitoring data found\.` alternative is REMOVED from `no_new_data`; the text
drops to `unknown` (residual medium — conservatively actionable) until the producer
distinguishes "all unchanged" from failed inputs. My verification sharpened your evidence:
`matchAll` never returns falsy, so `insert_jsonb_data.js`'s `!matches` branch is dead code
and the ONLY paths leaving `jsonData` empty are the three `continue`s (absent file, stale
redis cache, `undefined` from a catch-all read error) — the message is structurally
inseparable from failure. Deliberate non-match recorded at the entry + taxonomy doc +
a unit pin.

**F2 (medium, NON-CONFORMANT config is a gate, not a halt) — fixed as suggested:** a
second `config_missing` entry (`/^JOB HALTED -> NON-CONFORMANT config$/`,
manual_intervention → high via R5) ordered ABOVE the generic `^JOB HALTED`; the generic
entry's citation corrected to the real halt site (`mmb/index.js:74-82`,
`fileSizeAfterRsync === null`); `job_halted`'s action no longer mentions non-conformant
config. The flipped unit case IS the ordering test (first match wins). Counts unchanged:
9 engine categories, now 10 entries; both count pins dedupe by slug.

**F3 (medium, input_file_missing completeness/truth) — fixed, both arms:**
- GE's explicit thrown message now matches: `^File not found in directory: `
  (`GE_CT_CV_MRI.js:139-144`).
- Bare `^File not found$` REMOVED — and my verification found it is worse than
  "may be permissions/IO": the exact text is emitted by `lod_eventlog.js:66-75` on a
  genuine `existsSync` miss AND by `insert_jsonb_data.js:91-102` as a relabel of ANY
  caught read/exec error. Same text, two truth values → text-only classification cannot
  preserve truth; stays `unknown` (severity coincidentally still medium; the category and
  "check the upstream pull" action no longer overclaim).
- Self-caught while verifying: the entry had cited `eal_parser.js:56-64` — an INFO-level
  site that never reaches `warn_error_logs`. Wrong citation, removed.

**F4 (low, datetime_parse_null "skipped" claim) — fixed:** both parsers `data.push(...)`
the record with `host_datetime = null` (`logcurrent.js:117-139`, `eal_parser.js:109-137`).
Entry comment/message + assessor action now say "record stored with null host_datetime".
Low/quality verdict retained on the corrected rationale — flag if you think accumulating
null-datetime rows changes the severity call.

**F5 (low, stale interim-policy docs) — fixed:** `docs/error-taxonomy.md` (assessor bullet)
and `docs/incidents-schema.md` (`type` row) now state the permanent residual-medium policy,
interim history kept as history. Your handoff-priority-5 prediction ("wrong claims in
docs — every phase has had one") is now 6 for 6.

## The oscillation is total — §5.2's "not categories" claim corrected

Round-1 self-caught correction (recorded in `review_results_phase_6.md` and as a bracketed
note in the original handoff): between deploys the pinned cron reverts CATEGORIES too, not
just assessments — each tick stamps the new burst's events `unknown` (v1 classifier) and
newest-representative refresh flips actively-recurring incidents back. Measured 17:39: all
213 back to `unknown`, all 509 at v1 — the §5.2/§5.3 numbers were a transient post-dev-run
snapshot. True convergence lands at deploy (first post-deploy burst re-converges every
active family; dormant stragglers keep pre-fix stamps until recurrence or 7-day
stale-close — self-limiting, and the only pre-fix stamps that assessed differently than
the fixed rules would are the `no_new_data`-stamped monitoring-text incidents at info,
which correct on their first post-deploy event).

## Corrected live snapshot (timed 17:51 post-burst run, fixed classifier)

The honest post-fix distribution — the two reverted texts cost the pretty numbers, as they
should:

| | round-0 snapshot (pre-fix) | round-1 snapshot (fixed) |
| --- | --- | --- |
| `unknown` | 7 incidents / 426 events | **79 / 38,742** (the two reverted families moved in) |
| `input_file_missing` | 121 / 98,328 | **74 / 72,900** (bare "File not found" share left) |
| `no_new_data` | 86 / 41,368 | **49 / 23,809** (GE-delta + rmmu shapes only) |
| severity | medium 225 / high 197 / info 87 | **medium 262 / high 197 / info 50** |

Unchanged: `job_halted` 1 / 31,700; `tunnel_not_found` 1 / 15,114; `unhandled_type_error`
26 / 12,636; `credential_decrypt_error` 6 / 2,916; `config_missing` 2 / 972 (the
NON-CONFORMANT text is not currently recurring — its entry waits for its next event).
Cross-check on the reverted families: 75 incidents `unknown`/`classifier`/medium + 12
`rsync_io_timeout`/`oracle`/medium (the R0 provenance gate assessing them as unknown —
Phase 4 contract, not a leak). Interim-reason sweep: 0. **37 incidents that round 0 rated
info are now medium** — that is F1's real-world size, and the reason this round mattered.
(Snapshot semantics apply — the next pinned-cron tick reverts it all until deploy.)

## Verify

```bash
docker run --rm -v "$PWD":/w -w /w node:lts node --test          # 196/196
docker compose run --rm app node index.js run                    # dev-tree run, fixed classifier
docker compose run --rm app node index.js assess                 # REQUIRED before parity (v1 half-cycle)
docker compose run --rm app node integration/assess_parity.js    # PASS
```

```sql
-- the two reverted texts must never carry their old categories again:
SELECT category, severity, count(*) FROM incidents.incidents
 WHERE sample_message LIKE '%No new monitoring data found%' OR sample_message = 'File not found'
 GROUP BY 1,2;   -- expect unknown/medium (classifier rows) + oracle-corroborated rows
                 -- R0-gated to medium; NEVER info, NEVER input_file_missing
SELECT count(*) FROM incidents.incidents WHERE assessment::text ILIKE '%interim%';  -- 0
```

## Weak spots in these fixes

1. `^File not found in directory: ` is unanchored at the end (the path varies) — check the
   prefix can't collide with a production pattern or another producer's message.
2. The two deliberately-unknown texts are now permanent residents of the residual-medium
   bucket (medium queue grows by their incident count). The durable fix is upstream
   (producers distinguishing their cases) — tracked with the upstreaming decision. Verdict
   welcome on whether that tracking is enough.
3. F4 keeps low severity on corrected evidence ("kept with null datetime" vs "skipped") —
   a judgment call, explicitly offered for challenge.
