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
                         └── codex-adversary (cross-model)

ORCHESTRATE              DOCS                     DEPLOY
├── maestro              └── scribe               └── deployer
```

**codex-adversary** is a cross-model reviewer: it shells out to OpenAI Codex
(`codex exec`, default `gpt-5.5 @ xhigh`) so a *different* training family
challenges Claude's work. It runs in parallel during `/review` Phase 1
(alongside `critic` and `plan-reviewer`), is the adversarial step in
`/premortem`, and is auto-offered by the `plan-exit-premortem-prompt` hook
after `ExitPlanMode`. Its findings are prefixed `[Codex]` in synthesis so
cross-model agreement is visible at a glance.

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
| Cross-model review | codex-adversary | sonnet | Read, Grep, Glob, Bash (invokes `codex` CLI) |
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
- Never use `model: haiku` - always omit or use sonnet/opus
- Agents inherit parent model by default
- Use parallel spawning for independent tasks

## Spark Hardening (Hook-Source Edits)

`spark` carries extra guardrails for edits to TypeScript hook source
(`.claude/hooks/src/*.ts`), captured in `spark.md`:

- **File Editing Constraints** — use minimal-diff `Edit` (exact
  `old_string`→`new_string`); never regenerate a whole hook file from
  context (that is how prior-phase emits got silently dropped). No linter
  exists on hook source, so a rewrite is not auto-reformatted back.
- **Step 5: Pre-Completion Verification** — spark runs
  `scripts/audit-braintrust-emits.sh` and reports `Audit: PASS/FAIL`.
- **Rules 7/8** — never modify the guard/audit scripts; never edit files
  outside the explicit Files list.

**Orchestrator post-spark audit re-run:** Per
`.claude/rules-ondemand/proactive-delegation.md`, after spark touches
`.claude/hooks/src/*.ts` the orchestrator MUST independently re-run
`bash scripts/audit-braintrust-emits.sh` — do not trust spark's self-report
alone, since spark may have run the audit before its last edit. If the
re-run FAILs, restore from HEAD and escalate (do not re-spawn the same spark).

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
| /review | critic + plan-reviewer + codex-adversary (parallel Phase 1) |
| /premortem | inline failure-mode analysis + codex-adversary cross-model pass |
| /maestro | Coordinates any specialists |

## Deep Dive

For comprehensive agent guide (750 lines) with decision trees and composition patterns:
→ `~/continuous-claude/docs/agents/README.md`
