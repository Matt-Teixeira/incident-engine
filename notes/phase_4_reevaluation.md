# Phase 4 Re-evaluation (pre-implementation) — 2026-07-16

FLOW Step 3 pass over `prompts/prompt_4_deterministic_assessor.txt` after Phase 3
completed (incl. three review rounds and a doc correction). Verdict: **implement as
revised** — the phase's shape (pure `assess(dossier)` behind an `ASSESSOR_KIND` seam,
rules impl, no LLM, no state/auto-close) is unchanged and correct. But **four of the
prompt's rule clauses do not survive contact with what Phase 3 actually produced**: one
is dead code, one is blind to the strongest available signal, one names a flag as a
category, and one omits the biggest real category. All four are prompt bugs, not
architecture problems.

## Live measurements (superuser, `staging`, 2026-07-16)

The pipeline is cron-live (`25,55`), so these move. Snapshot: 504 incidents / ~228k L0
events / 82 fingerprints.

Incident `type` split (via `error_events.type`, joined on fingerprint):

| type | incidents | fingerprints |
| --- | --- | --- |
| ERROR | 329 | 66 |
| WARN | 175 | 16 |

Fingerprints carrying **both** types: **0** — `type` is part of the fingerprint
(`sha1(app|func|tag|type|normalize(text))`), so a fingerprint has exactly one type and an
incident's type is well-defined and lossless to store.

The `unknown` bucket (213 incidents), split by type:

| unknown × type | incidents | events | what they are |
| --- | --- | --- | --- |
| WARN | 143 | 133,845 | pipeline-status noise: `JOB HALTED`, `No new file data. Delta: 0`, `NO TUNNEL FOUND`, `No new monitoring data found.`, `File Not Present` |
| ERROR | 70 | 29,890 | genuine unclassified errors: `Error: ENOENT: no such file or directory, scan` |

Category × type (top):

| category | type | incidents |
| --- | --- | --- |
| rsync_io_timeout | ERROR | 160 |
| unknown | WARN | 143 |
| unknown | ERROR | 70 |
| connection_reset | ERROR | 35 |
| rsync_io_timeout | WARN | 27 |
| credentials | ERROR | 20 |
| connection_timeout | ERROR | 17 |
| host_key_changed | ERROR | 14 |
| partial_transfer_timeout | ERROR | 7 |
| credentials | WARN | 4 |
| host_unreachable | ERROR | 4 |
| rsync_partial | ERROR | 1 |

Real blast radius — distinct entities sharing one fingerprint (top): **59** (rsync_io_timeout,
12,586 events), 46, 42, 42, 40, 27, 22, 17, 15. Within a single incident row,
`array_length(apps,1)` and `array_length(systems,1)` are **always ≤ 1**.

## Changes made to `prompt_4_deterministic_assessor.txt`

### 1. Blast radius: dead clause → fingerprint-level `entity_count` (developer-approved)

The prompt keyed severity on "`host_unreachable`/`connection_timeout` with large `systems[]`
→ high else medium". **That branch can never fire**: `src_app_name` is part of the
fingerprint so `apps[]` is structurally single-element, and the entity *is* the system, so
`systems[]` is ≤1 (empty for `__global__`). Blast radius exists one level up — *entities per
fingerprint* (top: 59). The `assess` job assembles `entity_count` (one GROUP BY over
`incidents.incidents`) into the dossier; `assess()` stays pure.

### 2. Severity becomes type-aware; `type` added to `incidents.incidents` (developer-approved)

`incidents.incidents` had no `type`, so the assessor could not tell 143 WARN noise incidents
from 70 real unclassified ERRORs. Since `type` is inside the fingerprint (0 mixed
fingerprints), storing it per incident is lossless. Phase 4 adds `type VARCHAR(8)` (CREATE +
idempotent UPGRADE + backfill from `error_events`, mirroring the Phase 3 `entity` precedent)
and `docs/incidents-schema.md` is updated to match.

### 3. `unknown` → type-split, not a flat medium (developer-approved)

The prompt's `unknown → medium, confidence ~0.3` would rate all 213 unknowns medium — 143 of
them known pipeline noise — recreating the firehose this app exists to collapse. Revised:

- `unknown` + **WARN** → **info** (low confidence, reason "unclassified pipeline status")
- `unknown` + **ERROR** → **medium**, confidence ~0.3, reason "unclassified — needs pattern"

Operator's actionable medium queue: ~70, not ~213.

### 4. `manual_intervention` is a FLAG, not a category

The prompt listed it as one ("credentials/host_key_changed/manual_intervention → high").
It is a boolean field on each `utils/classify/connection_regex.js` entry. Revised to the
stronger, data-driven rule: **any category whose taxonomy entry has
`manual_intervention: true` → high (needs a human)** — looked up from the classifier table,
keeping `connection_regex.js` the single source of truth instead of a hand-listed subset.

### 5. Rules must cover the whole taxonomy, not a subset

The prompt never mentions **`rsync_io_timeout` (187 incidents — the #2 category)**, nor
`connection_reset` (35) nor ~12 other classifier categories. Revised: the rules table must
cover all 19 categories (or derive from the taxonomy with a principled, reasoned default);
every branch still pushes a reason.

### 6. Assessment scope: `touched OR severity IS NULL`

The prompt says "a dossier per **touched** incident". The 504 existing incidents are not
touched by an aggregate whose window is empty, so they would never be assessed. Revised: the
assess step selects incidents **touched this run OR with `severity IS NULL`**, so the
existing backlog is picked up on the first Phase 4 run and stays idempotent afterwards.

### 7. Known-input note carried from the Phase 3 review

`error_type` is `''` on ~39 oracle-corroborated incidents. **A rules table keyed on
`error_type` misfires there — key on `category`.** (Populating those is a tracked follow-up;
the oracle's vocabulary IS our classifier's, so `connection_regex.js` is a usable
category→type map. See PHASE_LOG Phase 3 §Follow-Up and §CORRECTION.)

## Not changed

- The phase's core shape: `domain/assessor/{contract,rules,index}.js`, pure async
  `assess(dossier)`, `ASSESSOR_KIND` seam defaulting to `rules`, `assessor_kind` stamped.
- **No LLM implementation** — seam only; advisory-only if ever added; never drives state.
- The assessor **must not** set `state` or auto-close (stays deterministic, Phase 5).
- Writes confined to the assessment columns on `incidents.incidents`; no writes outside
  `incidents`; `stats.acquisition_history` SELECT-only; never `verbose_log`.
- `recommendedAction` still maps from category.

## Open question for the implementer (not decided here)

Rules are versioned only by `assessor_kind` today. If the rules table changes, already-assessed
incidents keep a stale severity (scope rule #6 only re-assesses `severity IS NULL` or touched
rows). An `ASSESSOR_VERSION` stamped per row — mirroring the `FP_VERSION` precedent — would
make a rules change detectable and re-assessable. Raise it in the Phase 4 plan; there is no
column for it yet (`assessor_kind` is VARCHAR(16)).
