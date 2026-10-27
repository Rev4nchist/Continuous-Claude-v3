# Multi-agent communication

[Back to the README](../../README.md) · [All harness pages](README.md)

*Moved from the README on 2026-10-26. The text is unchanged except where a line starts with "Status on 2026-10-26" or names PR #165.*

Agents and sessions exchange work through typed channels, not chat copy-paste.

| Channel | Between | Mechanism | Where |
|---|---|---|---|
| Subagent spawn | A session and a subagent | Agent tool, pinned model, memory brief | `.claude/agents/`, `agent-recall-injector` hook |
| Workflows | An orchestrator and its workers | Parallel research, synthesis, adversarial check | `/maestro`, `/build`, `/premortem` skills |
| Lanes and messages | Parallel sessions | Lanes, leases and direct messages in PostgreSQL | `scripts/coordination/lane.mjs` |
| File claims | Parallel sessions | A lock checked before each edit | `file-claims` hook |
| Cross-model review | Claude and Grok | A second model family reviews diffs and plans | `grok-adversary` agent, `/premortem --grok` |
| Handoffs | A session and the next session | Typed record with an outcome | `/create_handoff`, `/resume_handoff` skills |
| Assistant bridge | A Claude.ai work assistant and Claude Code | Rows in a shared Notion database | `notion-bridge` skill |

**Two-tier model policy.** Each subagent pins `opus` or `sonnet` in its frontmatter. Judgment
work (planning, review, orchestration, forensics) goes to `opus`. Execution goes to `sonnet`.
The drift gate and the `no-haiku-enforcer` hook hold the policy.

**Workflows.** A workflow runs independent read-only investigations in parallel. A synthesis step
merges them. Adversarial reviewers then attack the result. In July 2026 this pattern decided to
repair the harness rather than rebuild it. Two investigations were refuted by their own
adversary before the plan shipped (`docs/harness-strategy/2026-07-28-plan-repair-with-ratchet.md`,
from the handoff in commit `b8f24d3`).

**Lanes and file claims.** Several Claude Code sessions work on one branch at once. Each session
claims a lane before it starts work. `lane.mjs` takes the session identity from `--as`, or else from `CLAUDE_CODE_SESSION_ID`. Each
session has its own `CLAUDE_CODE_SESSION_ID`, so identities stay separate unless two sessions pass the
same `--as` value. An `--as` override must be unique across live sessions. `lane.mjs say` and `lane.mjs inbox` carry direct
messages between live sessions. The `file-claims` hook blocks edits that collide.

**Cross-model review.** Grok reviews a diff or a plan from a different training family.
`grok-worker` builds. `/premortem --grok` is the optional adversarial pass. The Codex
integration was removed in PR #146 (2026-10-23).

**Typed handoffs.** A session that cannot finish writes a handoff. Each handoff records an
outcome: `SUCCEEDED`, `PARTIAL_PLUS`, `PARTIAL_MINUS` or `FAILED`. `/resume_handoff` restores the
context in a new session. The `session-end-handoff-indexer` hook indexes handoffs into memory.

**Assistant bridge.** A Claude.ai work assistant and Claude Code share one Notion database of
handoff rows (PR #55). Each row has `From`, `To`, `Status`, `Priority` and `Outcome`. The sender
writes the row. The receiver changes its status. A database view cannot miss a row, so no
handoff depends on a manual step.
