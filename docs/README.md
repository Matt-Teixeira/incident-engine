# docs/

Domain and contract documents `incident-engine` is built against.

This app's **own** contracts live here:

- `error-taxonomy.md` — the deterministic classifier vocabulary (reused from the production
  `connection_regex.js`) that maps raw error text to a stable `error_category`.
- `incidents-schema.md` — the `incidents` schema this app owns and writes.

The **shared suite** domain docs are NOT duplicated here — they live in `ops-dashboard` and
are the source of truth for the data this app reads:

- `/opt/apps/ops-dashboard/docs/logging-schema.md` — the `util.app_run_logs` data contract
  (columns, event shape, enums). **Verify against the live DB before relying on it.**
- `/opt/apps/ops-dashboard/docs/apps-suite.md` — inventory of the apps + their jobs.
- `/opt/apps/ops-dashboard/docs/infra-conventions.md` — deploy / compose / DB house style.
- `/opt/apps/ops-dashboard/docs/connectivity-schema.md`,
  `/opt/apps/ops-dashboard/docs/proposed-architecture.md` — related context.

Per the FLOW Step-2 rule, treat every schema fact as a hypothesis until confirmed against
the live DB in the phase that first uses it.
