# Agent Picker

## By Task Type

> **Note on Model column:** Values shown reflect historical pinning. Per `.claude/rules/agent-model-selection.md` and `.claude/rules/no-haiku.md`, the convention is to **omit the `model` parameter** when spawning (the agent inherits from the parent — usually Opus). The column is a hint about typical use, not enforcement. See [Model Rules](#model-rules) below.

| Need | Agent | Model | Notes |
|------|-------|-------|-------|
| **Research** |
| Explore codebase | scout | sonnet | Internal code only |
| External docs/APIs/Exa/OpenCLI | oracle | opus | 7-tool research stack (Context7, Nia, Exa, OpenCLI, GitHub, WebSearch, WebFetch) |
| GitHub repos | pathfinder | opus | Clone and analyze |
| Symbol navigation | TLDR CLI | CLI | `tldr impact` (callers), `tldr importers` (reverse imports) |
| **Planning** |
| Feature design | architect | opus | Before implementing |
| Refactor plan | phoenix | opus | Migration planning |
| Implementation plan | plan-agent | opus | From conversation |
| **Implementation** |
| TDD workflow | kraken | opus | Tests first |
| Quick fix (<50 loc) | spark | sonnet | Fast, focused |
| **Testing** |
| Unit/integration | arbiter | sonnet | Run test suites |
| E2E tests | atlas | sonnet | Full system tests |
| Performance | profiler | opus | Bottlenecks, memory |
| **Review** |
| Feature code | critic | opus | Implementation review |
| Refactoring | judge | opus | Transformation review |
| APIs/integration | liaison | opus | Interface review |
| Migrations | surveyor | opus | Upgrade review |
| Architecture | principal-reviewer | opus | High-level audit |
| Cross-model adversarial review | codex-adversary | sonnet | Invokes OpenAI Codex (gpt-5.5 @ xhigh) — used in /review Phase 1 (parallel with critic) and /premortem |
| Validate a plan | plan-reviewer | sonnet | Reviews architect/phoenix plans before implementation |
| **Debug** |
| Investigation | debug-agent | opus | Find root cause |
| Complex bugs | sleuth | opus | Multi-file tracing |
| Security issues | aegis | opus | Vulnerability analysis |
| **Deployment** |
| Vercel deploy/monitor | deployer | sonnet | Deploy, verify, debug deployments |
| **Orchestration & Docs** |
| Multi-step orchestration | maestro | opus | Coordinates specialists; interview-gated phases |
| Docs/handoffs/summaries | scribe | sonnet | Handoffs, continuity ledgers, session summaries |

## Quick Decision

```
Simple task? ──→ spark
Need tests? ──→ kraken
Need to understand code first? ──→ scout
Need external info? ──→ oracle
Don't know where bug is? ──→ debug-agent
Need to deploy? ──→ deployer
```

## Parallel Combinations

| Goal | Agents (parallel) |
|------|-------------------|
| Full research | scout + oracle |
| Implement + test | kraken, then arbiter |
| Multi-review | critic + judge + liaison |

## Model Rules

- **Never use haiku** - always omit model (inherits) or use sonnet/opus
- **Research agents** - need accuracy, use sonnet minimum
- **Planning/debug** - need judgment, prefer opus

## Spawning

```json
{
  "subagent_type": "scout",
  "prompt": "Find authentication patterns",
  "description": "Find auth patterns"
}
```

## When NOT to Spawn

| Situation | Do Instead |
|-----------|------------|
| Read 1-2 known files | Read tool directly |
| Simple grep search | Grep tool directly |
| Obvious one-line fix | Edit tool directly |
| Already have full context | Act directly |
