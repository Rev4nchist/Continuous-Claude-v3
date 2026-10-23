# Contract — <feature name>

**Room:** `<room-id>` · **Status:** draft | gate1-approved · **Gate 1:** <date or pending>

> This file is the single source of truth for this feature. Every session restart —
> any model — loads THIS file plus `status.json`, not prior chat. Keep it current;
> stale contracts are worse than none.

## 1. Goal

What ships, in one paragraph. What "done" means at Gate 2.

## 2. Non-goals

Explicitly out of scope for this room.

## 3. Requirements

Numbered, testable. Each requirement should be traceable to a milestone.

1. R1 —
2. R2 —

## 4. Design decisions (locked at Gate 1)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | | |

## 5. Milestones

| ID | Scope (one line) | Requirements | Builder | Status |
|----|------------------|--------------|---------|--------|
| M1 | | R1 | grok | pending |

Milestone detail lives in `milestones/M<N>-scope.md`; results + hub smoke evidence in
`milestones/M<N>-result.md`.

## 6. Verification plan

How the hub smokes each milestone (exact commands + expected exit codes), and what the
review booth grades against.

## 7. File scopes

Paths milestones may touch (mirror of ROOM.yaml `file_scopes`).

## 8. CCv3 mechanics footer (do not delete)

- Builder implement runs are worktree-isolated: `../.grok-worktrees/` (Grok) or
  Worktree paths recorded in `status.json.worktrees`.
- Grok dispatches: ≥300s external timeout. Prompts via `--prompt-file`.
- Patches are review-gated: human applies via `git apply --3way` — never auto-merged.
- Telemetry jsonl row per run is part of milestone completion evidence.
