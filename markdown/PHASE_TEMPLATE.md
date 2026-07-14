# Phase Log Entry Template

Copy this template into `markdown/PHASE_LOG.md` (newest entry at the top) after a phase is
implemented, validated, and ready to commit.

---

# Phase X — Short Phase Name

Date:
YYYY-MM-DD

Status:
Completed / Deferred / Partially completed

Prompt:
`prompts/prompt_X_name.txt`

Git Commit:
Pending / commit SHA

Review Artifacts:

- Codex handoff: `notes/codex_handoff_phase_X.md` (mandatory for implementation phases)
- Review results: `notes/review_results_phase_X.md`

## Goals

- Goal 1
- Goal 2

## Built

- Change 1
- Change 2

## Schema Facts Confirmed (live DB)

- Fact verified this phase against `util.app_run_logs` / `stats.acquisition_history` /
  `incidents.*` (e.g. column type, which apps write, `note` key presence, index behavior).
  "None" if the phase touched no queries.

## Important Decisions

### Decision Name

Decision:

Reason:

Tradeoff:

## Architecture Notes

- Write-isolation / least-privilege impact (writes confined to `incidents`? self-log only?):
- Idempotency / watermark impact (re-run safe? `ON CONFLICT` keys?):
- Classifier / fingerprint stability impact (`FP_VERSION`? `normalize.js` touched?):
- Determinism impact (assessor still pure? no LLM in critical path?):
- Data-contract impact (`warn_error_logs`-only? source query partition-pruned?):
- Deployment impact (batch cadence, schema/role changes needing a superuser step):

## Validation

Commands run:

```bash
# command
```

Results:

- Passed:
- Failed:
- Not run:

Manual / smoke tests:

- Test 1
- Test 2

## Review Notes

Source:

- `notes/review_results_phase_X.md`

Critical issues:

- None / issue list

Accepted fixes:

- None / fix list

Deferred findings:

- None / deferred list with reason

## Problems Encountered

- Problem:
  Resolution:

## Follow-Up Tasks

- Task 1

## Commit Readiness

- Requirements implemented:
- Write-isolation / least-privilege rules hold:
- Jobs idempotent (watermark + ON CONFLICT):
- Assessment deterministic (no LLM in critical path):
- Source queries read warn_error_logs only, partition-pruned:
- Schema assumptions confirmed live:
- Review findings addressed or deferred:
- Validation recorded:
- Ready to commit:
