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
| `unknown` | (none) | no pattern matched (caller-set fallback) | |
| `hanging_exec` | (none) | exec timeout (caller-set) | |

## How incident-engine consumes it

- **classify** (`domain/classify.js`) wraps `extractConnectionError` and returns
  `{ error_category, error_type, manual_intervention, successful_acquisition }`, defaulting
  to `unknown`.
- **fingerprint** does **not** use the category directly; it hashes
  `src_app_name | func | tag | type | normalize(text)` (see the Fingerprint-Stability Rule).
  Category is a **classification attribute** on the event/incident, not part of the grouping
  key — so a re-classification never re-buckets history.
- **assess** (`domain/assessor/rules.js`) maps category + flags + blast radius to severity
  (e.g. `credentials`/`host_key_changed`/`manual_intervention` → high; `*_partial`
  (`successful_acquisition`) → low/info; `unknown` → medium, low confidence, flagged for a
  human).
- `successful_acquisition=true` categories are the ones the recovery oracle
  (`stats.acquisition_history.successful_acquisition`) is expected to clear quickly.
