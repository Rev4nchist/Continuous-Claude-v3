# On-demand rules

These rules live in `~/.claude/rules-ondemand/`. The `rule-router` hook
loads each one at the first matching tool call in a session. A **block** rule refuses
that call and gives the rule as the reason: read it, then re-issue the call or change course.
An **inject** rule arrives as context and the call runs.

**Read the file yourself before you PLAN work in its area** (a Grok run, a commit
message, a page design, a CMA job). The hook fires at the tool call, too late for a plan.

| Rule file | Area | Mode |
|---|---|---|
| `grok-worker-safety.md` | Grok runs | block |
| `cma-safety.md` | Claude Managed Agents (CMA, `ant`) | block |
| `pr-and-commit-style.md` | commits and PR creation | inject |
| `design-work.md` | design, deck and chart skills; paid kie.ai images block | inject / block |
| `browser-automation.md` | browser automation; claude-in-chrome blocks | inject / block |
| `opencli-first.md` | web fetch and search | inject |
| `harness-update.md` | updates to the Grok CLI or its models | inject |
| `git-merge-workflow.md` | merges and branch cleanup | inject |
| `pr-review-loop.md` | opening PRs; landing; the `pr_checkpoint` tool and `ship-ask.mjs`; Greptile | inject |
| `coderabbit-cli.md` | CodeRabbit CLI (`cr`, `coderabbit`) | inject |
| `cross-terminal-db.md` | local Postgres (sessions, claims) | inject |
| `headless-claude-mcp.md` | headless `claude -p` | inject |
| `notion-cli-safety.md`, `railway-deploy.md`, `neonctl-safety.md`, `kusto-cli-safety.md`, `sentry-safety.md`, `linear-safety.md` | that CLI, its MCP or its skill | inject |
| `lane-board.md` | lane commands, `kanban-sync` | block |
| `review-engine.md`, `seat-role.md` | claim of a `re-` lane, `force-high-security-tier` or `hf-judge-precheck`; `adopt` | block |
| `fabric-playbook.md` | Microsoft Fabric, OneLake, Power BI | inject |
| `proactive-delegation.md` | delegating to agents | inject |

Decisions these rules shape before any tool call:
- Write runs through Grok, CMA creates and sends, kie.ai generation, and any deploy or delete are confirm-first.
- CMA bills Dave's API key, not the subscription. Grok is parked on this machine.
- Fabric: run the project preflight first; stop all load on the first capacity error; never pause or resize a capacity.
- Never merge a PR without Dave's explicit yes. Land CCv3 PRs with `scripts/github/land-pr.ps1`.
- Never raise the Greptile review tier without Dave's yes.
- Headless `claude -p` that needs a claude.ai connector: clear `ANTHROPIC_API_KEY` and pass `--allowedTools`.

## Folded into skills

- New platform access: prefer a native CLI, then OpenCLI, then MCP; browser automation last. Detail: `cli-integration` skill.
- Structural code questions (who calls X, what breaks): run `tldr`, then Read the 2-4 files it names. Detail: `tldr-code` skill.
- Project paths, ports and commands: read `.claude/project-registry.json` (repo copy is canonical). Detail: `project-registry` skill.

A fired rule not about the call is a false fire: record it at once in `~/.claude/logs/rule-router-false-fires.jsonl`.
