# Agent Subsystem

## Agent Taxonomy

```
RESEARCH                 PLANNING                 IMPLEMENT
├── scout (codebase)     ├── architect (design)   ├── kraken (TDD)
├── oracle (external)    ├── phoenix (refactor)   └── spark (quick)
└── pathfinder (repos)   └── plan-agent

TESTING                  REVIEW                   DEBUG
├── arbiter (unit)       ├── critic (features)    ├── debug-agent
├── atlas (E2E)          ├── judge (refactors)    └── sleuth
└── profiler             ├── liaison (APIs)
                         └── surveyor (migrations)
```

## Agent Selection Guide

| Need | Agent | Model | Tools |
|------|-------|-------|-------|
| Explore codebase | scout | sonnet | Grep, Glob, Read |
| External research | oracle | opus | WebSearch, WebFetch |
| Design feature | architect | opus | All read tools |
| Plan refactor | phoenix | opus | All read tools |
| TDD implementation | kraken | opus | All tools |
| Quick fix | spark | sonnet | Edit, Write, Bash |
| Run tests | arbiter | sonnet | Bash, Read |
| E2E tests | atlas | sonnet | Bash, Read |
| Debug issue | debug-agent | opus | All tools |
| Root cause | sleuth | opus | Grep, Glob, Bash |
| Code review | critic | opus | Read, Grep |
| Security audit | aegis | opus | Read, Bash, Grep |

## Spawning Agents

```typescript
// Via Task tool
{
  "subagent_type": "scout",
  "prompt": "Find all authentication code",
  "description": "Find auth code"
}
```

**Important:**
- Never use `model: haiku` - always omit or use sonnet/opus
- Agents inherit parent model by default
- Use parallel spawning for independent tasks

## Agent Communication

Agents receive:
- `prompt` - The task description
- Full conversation context (if `access to current context` noted)
- Tool access per agent type

Agents return:
- Single message with findings
- Agent ID (for resumption)

## Parallel Patterns

```
Independent tasks → Spawn in single message
        │
        ├── scout (research A)
        ├── oracle (research B)
        └── arbiter (run tests)

Dependent tasks → Sequential spawning
        │
        ├── architect (design) ──→ kraken (implement)
        └── Wait for result before next
```

## Agent Definitions

Located in: `~/.claude/agents/*.md`

Custom agents can be created with:
- Custom system prompts
- Restricted tool access
- Specific model requirements

## When NOT to Use Agents

| Situation | Do Instead |
|-----------|------------|
| Read 1-2 files | Use Read directly |
| Simple grep | Use Grep directly |
| Trivial fix | Edit directly |
| Already have context | Act directly |

Agents add latency. Use directly when task is simple.

## Workflow Integration

| Workflow | Agents Used |
|----------|-------------|
| /fix | debug-agent → spark → arbiter |
| /build | architect → kraken → critic |
| /explore | scout (with depth control) |
| /ralph | MCP tools + kraken + arbiter |
| /maestro | Coordinates any specialists |

## Deep Dive

For comprehensive agent guide (750 lines) with decision trees and composition patterns:
→ `~/continuous-claude/docs/agents/README.md`
