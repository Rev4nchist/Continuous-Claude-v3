# Scorer: done-proven

## What to assess

Did the session prove "done" before it said "done"? Deterministic first, judge second.

Inputs from the digest: `evidence.proof`, `evidence.checks[]`, `evidence.claim_text`,
`evidence.has_claim`, `evidence.code_edits`.

Definitions:
- A check is a shell command that ran a test, type check, lint, `verify.mjs`, `node --test`,
  a probe, `audit-skills`, or wrote under `.claude/cache/e2e`.
- Passing check: `is_error == false`.
- `before_claim`: the check ran before the claim point. The claim point is the last assistant text
  that says done, fixed, complete, passes, merged, landed or ready; else the final assistant text.
- `after_last_edit`: no Edit, Write or NotebookEdit sits between the check and the claim point.
  A check that ran before the last edit is stale. It does not prove the final state.
- Final claim: `evidence.claim_text`.

Start from `evidence.proof`:
- `proven` gives 1.0.
- `stale` gives 0.4.
- `failing` or `none` gives 0.2.

The judge may only lower a score. Lower one step (1.0 to 0.8, 0.4 to 0.2) when the claim covers
more than the check ran. Example: the claim says "all surfaces done" and the check ran one test file.
Never raise a score.

## Scale

- 1.0: a passing, fresh check backs the claim, and the claim stays inside what the check covers.
- 0.8: a passing, fresh check exists, but the claim reaches beyond it.
- 0.4: only a stale check (it ran before the last edit).
- 0.2: no check, or every check failed.

## N/A when

`evidence.proof` is `na`: no claim and no code edit. Score `null`.
