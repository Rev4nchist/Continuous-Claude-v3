# Plan: Add `--dry-run` to the worktree GC script

## Context

`scripts/codex/gc-worktrees.sh` reclaims stale, CONFIRMED-clean Codex worktrees older than
`$CODEX_WT_GC_DAYS` (default 7). Operators want to preview what a run would reclaim before
letting it act. This adds a read-only `--dry-run` flag.

## Goals

- `--dry-run` prints the exact set of worktrees the run WOULD remove, and removes nothing.
- Default behavior (no flag) is byte-for-byte unchanged.

## Design

1. Parse `--dry-run` into a boolean `DRY_RUN` (default false). Unknown flags still error as today.
2. The enumeration + eligibility checks (age filter, `git status --porcelain` clean-check,
   registered-vs-orphan classification) are unchanged and already read-only.
3. At the single removal site, branch: if `DRY_RUN`, print `WOULD REMOVE <path> (age Nd)` and
   continue; else run the existing `git worktree remove --force <path>`. No other code path changes.
4. Dirty/unreadable worktrees are still skipped and reported in both modes (the skip logic is
   shared and untouched). Orphans are still reported-never-deleted in both modes.
5. `--dry-run` exits 0 with a summary line (`DRY-RUN: N would be removed, M skipped`).

## Rollout

- Unit-test the flag: dry-run over a fixture with one clean-eligible + one dirty worktree asserts
  zero removals and the correct `WOULD REMOVE` line; a non-dry run over the same fixture asserts
  the clean one is removed and the dirty one survives.
- No settings/hook/registration changes — the script is invoked manually.

## Backout

Delete the flag-parse line and the `DRY_RUN` branch at the removal site; the script returns to
its current behavior. No state is written by dry-run.

## Acceptance

- Dry-run removes nothing and lists the eligible set correctly on the fixture.
- Non-dry-run behavior is identical to the pre-change baseline on the same fixture.
