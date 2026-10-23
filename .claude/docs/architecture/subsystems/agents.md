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
                         ├── surveyor (migrations)
                         ├── plan-reviewer (plans)
                         └── grok-adversary (cross-model)

ORCHESTRATE              DOCS                     DEPLOY
├── maestro              └── scribe               └── deployer
```

**Cross-model review** is Grok (`grok-adversary`) plus Claude `critic`. The
other CLI reviewer and its receipt line were removed in CCV3-2. Do not call
that runner. The `plan-exit-premortem-prompt` hook offers `/premortem` after
`ExitPlanMode`, with Grok or Skip.

## Agent Selection Guide

> **Note on Model column:** Values shown are typical pinning, not enforcement. Per `.claude/rules/agent-model-selection.md`, the convention is to **omit the `model` parameter** when spawning agents (inherit from parent — usually Opus). The column documents what each agent is *typically* used as.

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
| Cross-model review | grok-adversary | sonnet | Read-only Grok review |
| Validate a plan | plan-reviewer | sonnet | Read, Grep, Glob |
| Security audit | aegis | opus | Read, Bash, Grep |
| Multi-step orchestration | maestro | opus | Read, Bash, Task, Skill |
| Docs/handoffs | scribe | sonnet | Read, Write, Glob, Grep |

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
- Never use `model: haiku` - set `model:` explicitly (sonnet or opus)
- Every agent also sets `effort: high`
- Use parallel spawning for independent tasks

## Spark Hardening (Hook-Source Edits)

`spark` carries extra guardrails for edits to TypeScript hook source
(`.claude/hooks/src/*.ts`), captured in `spark.md`:

- **File Editing Constraints** — use minimal-diff `Edit` (exact
  `old_string`→`new_string`); never regenerate a whole hook file from
  context (that is how prior-phase emits got silently dropped). No linter
  exists on hook source, so a rewrite is not auto-reformatted back.
- **Step 5: Pre-Completion Verification** — RETIRED 2026-09-30. Spark no
  longer runs `audit-braintrust-emits.sh`. The script is in
  `archive/braintrust-2026-10/`. Run `npm run build` and `npm test` in
  `.claude/hooks` instead.
- **Rules 7/8** — never modify the guard/audit scripts; never edit files
  outside the explicit Files list.

**Orchestrator post-spark check:** After spark touches
`.claude/hooks/src/*.ts`, the orchestrator runs `npm run build` and
`npm test` in `.claude/hooks`. Do not trust spark's self-report alone. If the
check fails, restore from HEAD and escalate (do not re-spawn the same spark).
The old `audit-braintrust-emits.sh` step is RETIRED 2026-09-30 (see
`archive/braintrust-2026-10/`).

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
| /fix | sleuth → spark or kraken → arbiter |
| /build | architect → kraken → critic |
| /explore | scout (with depth control) |
| /review | critic and plan-reviewer, in parallel during Phase 1, in the background |
| /premortem | inline failure-mode analysis, then a Grok pass when the user picks Grok |
| /maestro | Coordinates any specialists |

## Deep Dive

For comprehensive agent guide (750 lines) with decision trees and composition patterns:
→ `~/continuous-claude/docs/agents/README.md`
