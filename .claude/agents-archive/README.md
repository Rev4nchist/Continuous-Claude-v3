# Archived Agents

Agents retired from the live roster (`.claude/agents/`) — moved here, never deleted, so re-adoption is a one-line `git mv` back.

## 2026-07-25 — rank-3 portfolio prune (proposals 2026-07-02 + 2026-07-14)

Evidence bar: zero output-cache evidence EVER (`.claude/cache/agents/<name>/` absent) AND zero or mention-only references across live skills/rules. Workflow-wired agents with zero usage (plan-agent, sentinel, wizard, etc.) were deliberately KEPT.

| Agent | Why archived |
|---|---|
| braintrust-analyst | 0 refs; duplicate of `session-analyst` |
| memory-extractor | 0 refs; extraction is owned by the hook pipeline (`incremental_extract.py`) |
| agentica-agent | mention-only (model-selection map); Agentica SDK skills stand alone |
| chronicler | mention-only (help/resume_handoff); role covered by `scribe` + memory system |
| agent-factory | mention-only; `sub-agents` + `plugin-dev:agent-creator` cover scaffolding |
| strategic-refactorer | mention-only (ralph reference list); role covered by `phoenix` + `/refactor` |

Note: the proposals' "delete the 16 dead .json twins" recommendation was REJECTED on evidence — all 17 `.json` sidecars pair with live `.md` agents, pass `check-agent-model-drift.mjs`, and are read at spawn by `opc/scripts/claude_spawn.py`.
