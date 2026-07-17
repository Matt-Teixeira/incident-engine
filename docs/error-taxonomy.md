# Error Taxonomy (deterministic classifier)

This is the deterministic vocabulary `incident-engine` classifies errors into. It **mirrors
the production classifier** at `/opt/apps/data_acquisition/util/tools/connection_regex.js`
(`extractConnectionError(text, connection_regexes)`), so incident-engine reuses a taxonomy
the pipeline already computes onto `stats.acquisition_history.error_category` and
`alert.offline_*_conn.error_category` — rather than inventing one.

> **Source of truth:** the live `connection_regex.js`. This doc is a snapshot for design;
> when Phase 2 copies that file in, re-confirm the entries against it and update here if
> they differ (FLOW Step 2).

## How the classifier is used

- Input text = `err_msg || note.message || note.txt || note.skip_reason || ''` from a
  `warn_error_logs` event. Live-verified 2026-07-14: `err_msg` is sparse (0% on
  `hhm_rpp_ge`, 55% on `data_acquisition`); `note.message` is the primary fallback
  (100% on GE); `note.txt` is a `data_acquisition`-only second fallback (~15% of its
  events, e.g. `{txt: "NO TUNNEL FOUND"}`); `note.skip_reason` (e.g.
  `missing host_ip`, 688 events) is the producer's stated reason when all else is
  empty — the fields are nearly complementary per app.
- `connection_regexes` is an **ordered** array; **first match wins**. Ordering places
  root-cause signals (SSH auth, host-key) above downstream symptoms (generic "connection
  unexpectedly closed"). Patterns are **not** `/g` (stateful `.test()` on shared objects).
- No match → `error_category = 'unknown'` (set by the caller, not the table). Exec-timeout
  → `'hanging_exec'` (caller-set).
- `phase` is **not** derived from the message; it is a caller-supplied constant (e.g.
  `remote_rsync`, `grab`) and is best-effort enriched from `stats.acquisition_history`.

## Categories

Each entry carries: `error_type` (connection | key | credentials | file), `error_category`
(the slug), a human `message`, and flags `manual_intervention` / `successful_acquisition`.

**The vocabulary is TWO LAYERS since Phase 6:**

1. **The production mirror** (`utils/classify/connection_regex.js`, verbatim from
   `data_acquisition`) — **20 distinct `error_category` values** (an earlier "19" was never
   counted and was wrong; corrected Phase 4). Never edited; always consulted first.
2. **The engine layer** (`utils/classify/engine_regexes.js`, engine-owned, Phase 6) —
   **9 categories**, consulted ONLY when the production table returns no match, so it can
   extend but never shadow or reinterpret a production decision. Every entry cites the
   producer code justifying its verdict (the F2 standard). Slugs never collide with the
   production 20 (unit-enforced), and a no-collision sweep proves no engine pattern matches
   any production-covered text. Entries proven here are the future upstreaming proposal to
   `data_acquisition` (tracked open decision).

Plus the two caller-set values (`unknown`, `hanging_exec`) = **31 total**. Category flags
are consistent across a category's multiple entries (verified; first-entry-wins is
well-defined) and `test/assessor-rules.test.js` pins all counts so they cannot drift
silently.

| error_category | error_type | signal (abbrev) | flags |
| --- | --- | --- | --- |
| `connection_timeout` | connection | "Connection timed out"; "Connection to <ip> port <p> timed out"; curl (28) timed out / failed to connect after N ms | |
| `max_retries` | connection | "error: max-retries exceeded" | |
| `session_timeout` | connection | "Timeout, server <ip> not responding" | |
| `partial_transfer_timeout` | connection | curl (28) operation timed out after N ms with N bytes received | |
| `connection_reset` | connection | curl (56) "Recv failure: Connection reset by peer"; rsync "connection unexpectedly closed" / "Broken pipe" | |
| `http2_cancel` | connection | curl (92) HTTP/2 stream not closed cleanly | |
| `host_unreachable` | connection | ssh/scp/rsync "connect to host <ip> port <p>: No route to host" | |
| `connection_refused` | connection | "Connection refused" | |
| `host_key_changed` | key | "remote host identification has changed" | manual_intervention |
| `host_key_new` | key | "Warning: Permanently added '<ip>' ... known hosts" | manual_intervention |
| `key_exchange` | key | "Unable to negotiate with <ip> ..." | manual_intervention |
| `credentials` | credentials | "Login failed" / "Login incorrect"; "Permission denied (publickey" | manual_intervention |
| `rsync_io_timeout` | connection | "rsync error: timeout in data send/receive" | |
| `rsync_protocol_error` | connection | "error in rsync protocol data stream" | |
| `permission_denied_partial` | file | "mget: Access failed: Permission denied" | manual_intervention, successful_acquisition |
| `file_missing_partial` | file | "mget: Access failed: No such file"; "550"; "no files found" | successful_acquisition |
| `mirror_file_skipped` | file | "mirror: ... Access failed: 550" | successful_acquisition |
| `rsync_source_missing` | file | "rsync: [sender] link_stat ... failed: No such file" | |
| `rsync_partial` | file | "rsync error: some files/attrs were not transferred" | successful_acquisition |
| `file_missing` | file | "(scp|tar): No match" | manual_intervention |
| `unknown` | (none) | NEITHER layer matched (caller-set fallback) | |
| `hanging_exec` | (none) | exec timeout (caller-set) | |

### Engine layer (`engine_regexes.js`, Phase 6 — producer-evidence verdicts)

| error_category | error_type | producer evidence (file cited at the entry) | severity |
| --- | --- | --- | --- |
| `tunnel_not_found` | config | failing IP has no tunnel row → auto-reset impossible (`get-tunnels-by-ip.js`) | high (manual_intervention) |
| `config_missing` | config | system row lacks host_ip/credentials_group/acquisition_script → skipped "so ops can fix the row" (`_shared.js`) | high (manual_intervention) |
| `credential_decrypt_error` | credentials | stored credential fails AES-GCM decrypt → cannot authenticate (`_configs.js`/`decrypt.js`) | high (manual_intervention) |
| `job_halted` | halt | rsync produced nothing → job returns (`demo_systems`, `mmb`) | medium |
| `input_file_missing` | file | expected upstream file absent → run yields nothing for that SME (GE + Philips, incl. GE's explicit "File not found in directory: <path>" and the unguarded ENOENT variant) | medium (developer-decided 2026-07-17) |
| `unhandled_type_error` | crash | TypeError reaches a CATCH — parser code defect | medium |
| `datetime_parse_null` | quality | datetime parses null → record stored with null `host_datetime`; a null in the SELECTED record breaks the `alert.offline_hhm_conn` upsert (quoted `'null'` rejected by timestamptz → offline-health stale) across 7 of 8 emitters — Philips MRI/CT/CV-eventlog/CV-lod_eventlog, GE MRI/CT/CV, Siemens CV; Philips CV/lod_eventlog is the exception (null persisted, no upsert), and CV/eventlog selects the FIRST record (`mappedData[0]`) where the rest select the last. Not source-aware → conservative medium | medium (round-2 review — was low; generalized round 3) |
| `no_new_data` | status | nothing new to process — normal between-acquisition state (GE delta + rmmu shapes only) | info |
| `counter_reset_reread` | status | file shrank (log rotated) → producer re-reads whole file, continues | info |

The `config_missing` row also covers `JOB HALTED -> NON-CONFORMANT config`
(`mmb/index.js:37-45` — a pre-acquisition invalid-config gate despite the halt-shaped
label; its entry is ordered above the generic `^JOB HALTED` pattern. Round-1 review).

Deliberately still `unknown` (round-1 review confirmed two more): the generic
`Error: Command failed: ...rsync_mmb.sh` wrapper (root cause unreadable from the message —
inconclusive families are not guessed); `No new monitoring data found.`
(`insert_jsonb_data.js:134-141` emits it whenever the per-file loop added nothing,
including after absent files and catch-all read errors — not proof of normal inactivity);
and the bare `File not found` (same text emitted both by a genuine `existsSync` miss in
`lod_eventlog.js` and by `insert_jsonb_data.js`'s relabel of ANY caught read error — a
text-only classifier cannot preserve truth across them). Residual
`unknown` policy (developer-decided 2026-07-17, replacing the interim-M2 rule): **medium,
both types, permanently** — an unrecognized message is conservatively actionable until a
pattern or verdict exists.

## How incident-engine consumes it

- **classify** (`domain/classify.js`) runs the two layers in order — production mirror
  first, engine table only on a miss — and returns
  `{ error_category, error_type, manual_intervention, successful_acquisition }`, `unknown`
  only when BOTH miss.
- **fingerprint** does **not** use the category directly; it hashes
  `src_app_name | func | tag | type | normalize(text)` (see the Fingerprint-Stability Rule).
  Category is a **classification attribute** on the event/incident, not part of the grouping
  key — so a re-classification never re-buckets history.
- **assess** (`domain/assessor/rules.js`, Phase 4) maps **category + blast radius** to
  severity; `type` (WARN/ERROR) feeds **confidence and reasons only, never severity**
  (round-2 M2 — see "What `type` does NOT mean" below). It dispatches on THIS TABLE'S OWN
  FIELDS (`manual_intervention`,
  `successful_acquisition`, `error_type`) rather than a hand-listed set of category slugs, so
  `connection_regex.js` stays the single source of truth and a category added here inherits a
  reasoned severity by construction. It keys on `category`, **never** on an incident's stored
  `error_type` (that column is `''` on 253 of 504 live incidents — every `unknown` plus every
  oracle-corroborated row — so a rules table keyed on it misfires on half the table).
  The ordered rules (**R0 first**: a category whose `incidents.category_source` is not
  `classifier` came from the recovery oracle and is **not evidence about that incident** — it
  is assessed as `unknown`, with the discarded category recorded in the reasons. Phase 4
  review, HIGH finding):
  - `successful_acquisition: true` → **info** (data was acquired), or **low** if the category
    also flags `manual_intervention`. This precedence is deliberate:
    `permission_denied_partial` is the only category carrying BOTH flags, and "data was
    acquired" must win over "a human is needed" for SEVERITY (nothing was lost) while the
    human still drives the recommended action.
  - `manual_intervention: true` → **high** on both types (WARN lowers confidence to 0.75, not
    severity — see "What `type` does NOT mean" below).
  - `error_type: connection` (10 categories — every transport fault, not just the four the
    prompt named) → escalates on blast radius: **high** at ≥22 entities sharing the fingerprint
    (~10% of the live fleet), else **medium**. Both types; WARN only lowers confidence.
  - `error_type: file` without flags (`rsync_source_missing`) → **medium**.
  - `unknown` → **medium @ 0.3 for BOTH types, PERMANENTLY** ("unclassified — needs
    pattern"). History: review round 2 (M2, developer 2026-07-16) set this as an *interim*
    rule because the WARN half contained confirmed hard failures (`JOB HALTED`,
    `NO TUNNEL FOUND`), so WARN must not reduce it to info + "No action" — that closed the
    last place `type` moved severity. Phase 6 then delivered the promised durable fix (the
    engine layer classified those messages out of `unknown` — `error_category` is not in
    the fingerprint, so adding patterns never touched `FP_VERSION`) and the developer made
    the residual policy **permanent** (2026-07-17): an unrecognized message is
    conservatively actionable until a pattern or producer-evidence verdict exists. The
    "interim" language is retired and unit-swept absent from every reason string.
  - `hanging_exec` → **medium** (both types); anything unrecognized → a documented
    **medium @ 0.2** default that names itself in its reasons.
- `successful_acquisition=true` categories are the ones the recovery oracle
  (`stats.acquisition_history.successful_acquisition`) is expected to clear quickly.

## What `type` (WARN/ERROR) does NOT mean

**A WARN does not mean the operation succeeded.** Phase 4's first cut capped severity on WARN,
asserting "the run continued, so the fault was absorbed". That was never checked against the
producers and is **false** (Phase 4 review, MEDIUM finding):

- `data_acquisition/read/exec-hhm_data_grab.js:146` — a `connection_error` is logged **WARN**,
  then the function `return false`s on both branches; the ip_reset path records
  `successful_acquisition: false`. The WARN path *is* the failure path — the success path is
  the one that passes `successful_acquisition: true`.
- `data_acquisition/jobs/demo_systems/index.js:124` — `JOB HALTED` is logged **WARN** when the
  rsync produced nothing (`fileSizeAfterRsync === null`) and the job returns. ~28k live events:
  a real acquisition failure, not status noise.

So repeated **failed** acquisitions can carry WARN indefinitely. In `domain/assessor/rules.js`
WARN therefore costs **confidence, never severity**. The genuine recovery signal is
`stats.acquisition_history.successful_acquisition` (time-correlated) — Phase 5's oracle, which
the pure assessor deliberately cannot reach.
