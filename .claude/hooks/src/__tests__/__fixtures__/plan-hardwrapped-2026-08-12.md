# Land `agentic-os` on `main`

## Context

The GitHub landing page renders the **default branch, `main`**, and `main` has not moved since
`3ed0d21`. All 201 commits of the last three weeks live on `agentic-os`.

## Steps

1. **Re-check mergeability immediately before merging.** A peer session (`8896640d`) is active on
   this branch; state can move between now and the merge.
   ```
   gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/29 `
     --jq '"mergeable=\(.mergeable) state=\(.mergeable_state) head=\(.head.sha)"'
   ```
   Proceed only on `mergeable=true` and `state=clean`.

2. **Post the decision record on #29 first.** The PR body says "not proposed for immediate merge";
   the comment is what reconciles that with the merge.

3. **Merge via REST, not `gh pr merge`.** `gh pr merge` is interactive by default and hangs in a
   non-interactive shell.

## Verification

1. **PR closed as merged, with a merge commit:**
   ```
   gh api repos/Rev4nchist/Continuous-Claude-v3/pulls/29
   ```
   Expect `merged=true`.

2. **The SHAs the docs cite are still reachable from `main`** — this is the whole reason for the
   merge-commit strategy, so prove it rather than assume it.

## Recorded, deliberately not done

- **The 86 uncommitted paths stay uncommitted.** They include real work from other sessions, and a
  peer session is active on this branch right now, so that decision is not mine to make.
