# On-demand rules

These rules are NOT always loaded. They live in `~/.claude/rules-ondemand/`. The `rule-router` hook
loads each one at the first matching tool call in a session. A **block** rule refuses
that first call and gives the rule as the reason: read it, then re-issue the call or change course.
An **inject** rule arrives as context and the call runs.

**Read the file yourself before you PLAN work in its area** (before you propose a Grok run, write a
commit message, design a page, or plan a CMA job). The hook fires at the tool call, too late for a plan.

| Rule file | Area (exact triggers: `manifest.json`) | Mode |
|---|---|---|
| `grok-worker-safety.md` | Grok runs | block |
| `cma-safety.md` | Claude Managed Agents (CMA, `ant`) | block |
| `pr-and-commit-style.md` | commits and PR creation | block |
| `design-work.md` | design, deck and chart skills; paid kie.ai images block | inject / block |
| `browser-automation.md` | browser automation; claude-in-chrome blocks | inject / block |
| `opencli-first.md` | web fetch and search | inject |
| `harness-update.md` | Grok CLI or model updates | inject |
| `git-merge-workflow.md` | merges and branch cleanup | inject |
| `pr-review-loop.md` | opening PRs; Greptile | inject |
| `cross-terminal-db.md` | local Postgres (sessions, claims) | inject |
| `headless-claude-mcp.md` | headless `claude -p` | inject |
| `notion-cli-safety.md`, `railway-deploy.md`, `neonctl-safety.md`, `kusto-cli-safety.md`, `sentry-safety.md`, `linear-safety.md` | that CLI, its MCP or its skill | inject |
| `fabric-playbook.md` | Microsoft Fabric, OneLake, Power BI | inject |
| `proactive-delegation.md` | delegating to agents | inject |

Decisions these rules shape before any tool call:
- Grok write runs, CMA creates and sends, kie.ai generation, and any deploy or delete are confirm-first.
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
Triggers, logs and the weekly audits: `every-surface-checklist.md` (loads with harness files).
