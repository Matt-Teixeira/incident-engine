# Integration Brief — ops-dashboard consuming the `incidents` schema

Audience: the developer (and Claude instance) working in `/opt/apps/ops-dashboard`.
Author: the `incident-engine` app, which OWNS and produces the `incidents` schema.
Written 2026-07-21. This is a durable read-contract + kickoff, versioned alongside the
app that owns the data.

## The one-paragraph picture

`incident-engine` is the writer/brain: it reads the suite's raw error firehose
(`util.app_run_logs`) and deterministically collapses it into a small, classified,
severity-assessed, self-resolving set of **incidents**, writing only the `incidents`
schema. `ops-dashboard` is the reader/window: strictly read-only, it should SELECT from
that schema and present it to an operator. Nothing about this integration changes
`incident-engine` — it just publishes a stable schema. All the work is in ops-dashboard.

## Read contract

Full column semantics: `/opt/apps/incident-engine/docs/incidents-schema.md` (read it —
several columns are subtle). Two tables matter:

- **`incidents.incidents`** — the rollup, one row per `(fingerprint, entity)` = one
  distinct problem per affected equipment. ~528 rows today. **This is the view's primary
  source.**
- **`incidents.error_events`** — the raw L0 layer (~345k rows). Only needed if you want
  per-incident drill-down (the individual events behind an incident). Optional.

`incidents.pipeline_state` is the engine's internal watermark table — **not** for display.

### `incidents.incidents` columns (authoritative — from the live DB)

Display-relevant, in rough priority order:

| column | type | what to show / know |
| --- | --- | --- |
| `severity` | varchar(16) | `high` / `medium` / `low` / `info` (`critical` reserved, unused). Primary sort/filter. |
| `state` | varchar(16) | `open` / `recurring` / `resolved` / `acknowledged` / `suppressed`. `recurring` = resolved then came back (the interesting signal). |
| `category` | varchar(64) | the classified problem family (e.g. `input_file_missing`, `rsync_io_timeout`, `unknown`). |
| `category_source` | varchar(16) NOT NULL | **`classifier` or `oracle` — ALWAYS show this next to `category`.** `oracle` = the category is a *corroborated hint about the equipment's recent past*, NOT a diagnosis of this incident. A view that renders an oracle category as if diagnosed is misleading. See the schema doc. |
| `entity` | varchar(64) | the affected equipment (`system_id`; or `__global__`). |
| `occurrence_count` | bigint | how many raw events rolled into this incident (retry chattiness — NOT severity). |
| `first_seen` / `last_seen` | timestamptz | producer-clock span of the problem. |
| `assessment` | jsonb | `{ reasons[], recommendedAction? }` — the human-readable rationale + suggested fix. The detail-panel payload. |
| `confidence` | numeric(3,2) | 0..1, the assessor's confidence in the severity. |
| `type` | varchar(8) | `WARN` / `ERROR` — the producer's own label. **Does NOT mean success/failure** (see schema doc); informational only. |
| `sample_message` | text | a representative raw message for the incident. |
| `func` | varchar(64) | the producing function, when known. |
| `resolved_at` / `resolved_reason` | timestamptz / varchar | when + why it closed (`auto_recovery` or `stale`). |
| `assessor_kind` / `assessor_version` | varchar / smallint | provenance of the severity (`rules`, v2 today). Debug/footnote, not headline. |
| `apps` / `systems` | text[] | contributing app(s) / affected system(s). Structurally ≤1 app. |
| `id`, `fingerprint`, `sample_run_id` | — | identity/joins; not headline display. |
| `action_state` / `action_ref` | — | **reserved, always empty** — future L4. Ignore. |

Useful indexes already exist — build list queries to use them:
`(severity, last_seen DESC)`, `(state, last_seen DESC)`, BRIN on `last_seen`.

## Step 1 — the DB grant (the boundary artifact; do this FIRST)

Nothing else works until `ops_dashboard_ro` can read the schema. Add to
`ops-dashboard/db/setup-readonly-role.sql` — the single fail-closed allowlist for that
role — mirroring exactly how it already grants `util` / `alert` / `stats`:

```sql
GRANT USAGE  ON SCHEMA incidents          TO ops_dashboard_ro;
GRANT SELECT ON incidents.incidents       TO ops_dashboard_ro;
GRANT SELECT ON incidents.error_events    TO ops_dashboard_ro;  -- only if drill-down
```

Also add `incidents` to the script's REVOKE/audit sweep so the allowlist stays a complete
picture of what `ops_dashboard_ro` can touch. The script runs as superuser, so it can
grant on tables `incident_engine_rw` owns — identical to how it already grants `stats` /
`alert` tables it doesn't own.

**Do NOT put this grant in `incident-engine`.** ops-dashboard owns its own role's read
surface; splitting it across two repos would break the single-allowlist audit and the two
scripts could fight (a hazard incident-engine hit in Phase 5 and deliberately avoids).

## Step 2 — verify the boundary (before any UI)

```sql
SET ROLE ops_dashboard_ro;
SELECT count(*) FROM incidents.incidents;                 -- ~528, read works
INSERT INTO incidents.incidents(fingerprint,entity,category_source)
  VALUES ('x','y','classifier');                          -- MUST be: permission denied
RESET ROLE;
```

## Step 3 — query layer

Add incident queries to `db/queries.js`:
- **Rollup for tiles:** `SELECT severity, state, count(*) FROM incidents.incidents GROUP BY 1,2`.
- **List:** filterable by severity/state/category, ordered `severity, last_seen DESC`
  (hits `idx_incidents_severity_last_seen`).
- **Detail:** one incident by `id`, surfacing `assessment` (reasons + recommendedAction).

## Step 4 — route + view

Mirror an existing read-only ops-dashboard view. Suggested shape:
- A tile row: severity counts (high/medium/info) + open/recurring/resolved.
- A list: severity chip · state · category (+ `category_source` badge) · entity ·
  last_seen · occurrence_count.
- A detail panel: `assessment.reasons`, `assessment.recommendedAction`, `sample_message`,
  first/last seen, confidence, resolved_at/reason.

## Live data to test against (snapshot 2026-07-21 ~12:00 — DRIFTS every 30 min)

Treat these as live-query oracles, not constants. The dashboard's aggregates should
reproduce the equivalent SELECTs at query time.

- **Totals:** 528 incidents · 345,232 error_events · span 2026-07-07 → 07-21.
- **Severity:** high 209 · medium 269 · info 50.
- **State:** open ~361 · resolved 136 · recurring 31.
- **Top categories:** `rsync_io_timeout` 170 (+16 oracle) · `unknown` 79 ·
  `input_file_missing` 74 · `no_new_data` 49 · `connection_reset` 36 ·
  `unhandled_type_error` 26 · `credentials` 20 · `host_key_changed` 14 ·
  `job_halted` 1 (but 45k events) · `tunnel_not_found` 1 (21k events).
- **Provenance:** mostly `classifier`; ~16 `rsync_io_timeout` rows are `oracle`.

Good first targets / correctness checks:
- The **severity×state rollup** is both the top-of-page tile row AND a self-check: tile
  numbers must equal the GROUP BY.
- **`recurring` (31)** — resolved-then-returned; the most operationally interesting view.
- **`oracle`-provenance rows** — the one place a naive view misleads; a good test that the
  UI respects `category_source`.

## Follow-ups back to incident-engine (schema owner) — from the integration

Recorded here so they survive outside chat. Status as of 2026-07-21, post-integration
(ops-dashboard branch `phase-19-incidents-view`, close-out `9c2b93b`).

### FU-1 — `error_events (fingerprint, entity, dt DESC)` composite index (ACCEPTED, pending a cycle)

The dashboard's per-incident drill-down (`WHERE fingerprint=$1 AND entity=$2 ORDER BY dt
DESC LIMIT n`) is served today only by `idx_error_events_fingerprint_dt (fingerprint, dt
DESC)`, which forces a bitmap scan that fetches ALL matching rows then sorts — ignoring the
LIMIT. Measured on the worst-case incident (45,509 events): **1,748 ms cold**. Adding
`(fingerprint, entity, dt DESC)` turns it into an ordered index scan that stops at the
limit: **3.4 ms** (verified in a rolled-back tx). ~500×.

- **Add vs replace:** the existing index has ~37k scans from an as-yet-unidentified
  consumer (the engine's own representative-selection runs over the in-flight batch CTE,
  not persisted `error_events`, so it is NOT that). The new composite serves everything the
  old one does EXCEPT a hypothetical `WHERE fingerprint=? ORDER BY dt DESC` with no entity.
  **ops-dashboard confirmed it is indifferent** (its drill-down always filters both
  columns), so the decision is purely engine-internal: identify the 37k consumer, then add
  (if it needs fingerprint-only dt ordering) or replace (if not).
- **Discipline:** DDL into `db/schema.sql` idempotently → apply live → deploy-worktree
  checkout. Not an ad-hoc live `ALTER`. Small, its own verify cycle.

### FU-2 / FU-3 — carried from Phase 6 review (unchanged by the integration)

- Cross-app producer fixes: the offline-health upsert null-handling across all 8
  `datetime object null` emitters; disambiguating the two ambiguous texts
  (`No new monitoring data found.`, bare `File not found`). Both live in the producer repos.
- Upstreaming the 9 proven `engine_regexes.js` entries into `data_acquisition`'s
  `connection_regex.js` (standing open decision).

## Free confidence check (already true)

`incident-engine` self-logs 308 runs into `util.app_run_logs` under
`app_name='incident-engine'`, so it ALREADY appears in ops-dashboard's existing app-run
grid — you can confirm the producer is alive there before the incidents view exists.
