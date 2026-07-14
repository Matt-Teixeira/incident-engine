# Review Results — Phase 1

Decision: **needs fixes before commit**. The app scaffold, owned-schema DDL, and helper
column sets are internally consistent, but the role is not yet proven least-privilege and
successful jobs can hide telemetry-finalization failures.

## Findings

### 1. High — the fail-closed privilege audit is not a database-wide allowlist

- **File + line:** `db/setup-owner-role.sql:110` (related: `:141`, `:169`, `:45`)
- **What & why:** The verification blocks inspect table-level privileges only in
  `util`, `stats`, and `alert`. They therefore cannot prove the documented claim that
  the role has access to nothing else. Read-only inspection of the provisioned role
  found effective `SELECT` on `public.pg_stat_statements` and
  `public.pg_stat_statements_info`, plus `CONNECT` on databases `postgres` and
  `template1` and `TEMP` on `postgres`, all inherited through `PUBLIC`. The scoped
  checks also miss two drift cases inside the named schemas:

  - a column-only grant through `PUBLIC` or an inherited role, because
    `has_table_privilege(...)` is false for a column-only grant; and
  - privileges on sequences, because `REVOKE ... ON ALL TABLES` and the `relkind`
    filters do not cover sequences. `USAGE`/`UPDATE` on an external sequence permits
    `nextval`/`setval`, which is a write outside `incidents`.

  A rollback-only PostgreSQL probe confirmed the column-level false negative. The live
  role currently has no memberships and no external sequence or column ACLs, but the
  script is required to catch future drift, including grants through `PUBLIC`, and does
  not do so.
- **Suggested fix:** Add a final effective-privilege audit over every non-system schema
  and relation in the current database, with an explicit allowlist for owned
  `incidents.*`, `util.app_run_logs` (`SELECT`, `INSERT`), and
  `stats.acquisition_history` (`SELECT`). Include
  `has_any_column_privilege` for column-capable privileges and
  `has_sequence_privilege` for `USAGE`/`SELECT`/`UPDATE`; also revoke direct sequence
  grants in the three external schemas. Remove unwanted `PUBLIC` grants at their source
  and explicitly re-grant the roles that need them. Because PostgreSQL ACLs have no
  per-role deny that overrides `PUBLIC`, restrict cross-database login with a
  role/database-specific `pg_hba.conf` rule, or deliberately revoke `CONNECT` from
  `PUBLIC` and re-grant it after assessing the cluster-wide impact. Keep the existing
  parent/partition table checks; those are sound.

### 2. Medium — run-log persistence failures can still produce exit code 0

- **File + line:** `utils/logger/log.js:226` (related: `index.js:80`,
  `utils/logger/log.js:253`)
- **What & why:** `dbInsertLogEvents` catches an insert failure, appends an in-memory
  error, and resolves. The success path in `onBoot` consequently prints `END` and exits
  0. This was reproduced in an isolated container by pointing `PGPORT` at a closed port:
  `node index.js noop` exited 0 even though no self-log could be stored. Synchronous
  serialization/write errors are also swallowed by `writeLogEvents`; asynchronous
  stream errors have no listener and escape as uncaught events instead of flowing
  through the run lifecycle. `makeAppRunLog` is called before the `try`, while a rejected
  `db.$pool.end()` escapes the un-awaited top-level `onBoot()` call. Thus finalization
  failures are inconsistently either silent-success or uncontrolled process failures.
- **Suggested fix:** Make DB and file persistence return/reject on failure, await the
  stream's `finish`/`error` result, and restructure `onBoot` around one finalization path
  that preserves the first failure, makes a best effort to write the other sink, and
  always sets a non-zero exit code when either required sink fails. Put run-log creation
  inside that lifecycle and terminate with `onBoot().catch(...)`. Avoid calling the same
  failing DB sink a second time from the catch path.

### 3. Medium — the self-log identity is not constrained to `incident-engine`

- **File + line:** `utils/logger/log.js:232` (related:
  `db/setup-owner-role.sql:104`)
- **What & why:** The inserted `app_name` is taken directly from `APP_NAME`, while the
  credential has unrestricted `INSERT` on the shared base table. Setting
  `APP_NAME=data_acquisition` makes this app write a row attributed to that app. It
  cannot modify existing rows, so the impact is monitoring/history pollution rather
  than destructive mutation, but it violates the explicit write-isolation contract and
  is not enforced at the credential layer.
- **Suggested fix:** Replace direct base-table `INSERT` with a narrowly owned database
  interface that enforces the value, such as an automatically updatable view filtered to
  `app_name = 'incident-engine'` with `WITH CHECK OPTION`; grant the app `INSERT` on that
  view and revoke its base-table `INSERT`. Point the self-log `TableName` at the view.
  Also use a code constant and fail boot if an optional `APP_NAME` does not match, as a
  defense against configuration mistakes.

### 4. Medium — TLS verification modes silently downgrade, and the deployed default does not authenticate PostgreSQL

- **File + line:** `utils/db/pg-pool.js:13` (related: `:19`, `.env.example:17`)
- **What & why:** `PG_SSLMODE=require` returns `rejectUnauthorized: false`, so traffic is
  encrypted but the server certificate is not authenticated; the supplied
  `PG_SSL_PATH` is unused. More importantly, requesting `verify-ca` or `verify-full`
  silently falls back to the same unauthenticated mode when the CA path is missing or
  invalid. A mount/configuration error therefore weakens security while allowing the job
  to run, exposing the DB credential and telemetry to a network MITM. The current
  deployment also uses `require` even though the certificate directory is mounted.
- **Suggested fix:** Make `verify-ca`/`verify-full` fail closed when `PG_SSL_PATH` is
  absent, unreadable, or invalid, and reject unsupported mode strings. After confirming
  the mounted certificate and hostname, make `verify-full` the deployment/example
  default. Keep `require` only as an explicit, documented trust-boundary exception.

### 5. Medium — an invalid job name is reported as success

- **File + line:** `index.js:55`
- **What & why:** The default switch branch only appends a warning and returns. A typo in
  a cron command therefore runs no pipeline stage, writes a nominally successful run
  summary, and exits 0. The scheduler cannot distinguish this from a completed batch.
- **Suggested fix:** Throw an `Error` for unknown jobs (after optionally adding the
  warning), so the existing lifecycle records the failure and sets exit code 1. Keep
  `noop` as the explicit successful no-op.

### 6. Low — error logging can throw while handling a non-Error rejection

- **File + line:** `utils/logger/log.js:55`
- **What & why:** For an `ERROR` event, `err.stack` dereferences `err` unconditionally.
  JavaScript permits `throw null` and rejected promises may carry `null`, strings, or
  other non-Error values. A null value causes the logger itself to throw and can skip the
  run summary and both persistence attempts. Current call sites normally supply an
  `Error`, but this logger is the template for later phases.
- **Suggested fix:** Normalize defensively, for example
  `err?.stack ?? (err == null ? "Unknown error" : String(err))`, without changing the
  positional logger API.

## Verified without findings

- `db/schema.sql` matches `docs/incidents-schema.md` for columns, types, keys, and index
  shapes. The composite `(run_id, event_ord)` key is sufficient for the planned
  idempotent materialization and does not need a surrogate ID.
- The `error_events` and `incidents` ColumnSets match the DDL; both JSONB values carry
  explicit casts, and no unintended write table is declared.
- No source query exists in Phase 1, and there is no read of `verbose_log`. Its presence
  in the self-log insert is expected.
- The module-level logger stream is safe under the current one-call-per-process entrypoint;
  `makeAppRunLog` has only one call site.
- The role currently has safe attributes, no inherited memberships, and owns the
  `incidents` schema/relations. The schema-wide `REVOKE` statements affect only this
  grantee and do not alter other roles or default privileges.
- `.env` is ignored, no secret was found in tracked/phase files, and the compose model
  validates with `docker compose config -q`.
- The documented container test passed: 1 test, 1 pass. The single enums smoke is
  proportionate to the domain-free phase, but the lifecycle/TLS fixes above should add
  focused tests rather than remain covered only by smoke runs.
- Passing the provisioning password through `psql -v` remains briefly process-visible.
  Given the documented one-time trusted-host operation, this is a low residual risk, not
  a commit-blocking finding; use an interactive/secured input channel if that trust
  assumption changes.
