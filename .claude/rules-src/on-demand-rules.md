# On-demand rules

These rules are NOT always loaded. They live in `~/.claude/rules-ondemand/`. The `rule-router` hook
loads each one at the first matching tool call in a session. A **block** rule refuses
that first call and gives the rule as the reason: read it, then re-issue the call or change course.
An **inject** rule arrives as context and the call runs.

**Read the file yourself before you PLAN work in its area** (before you propose a Codex run, write a
commit message, design a page, or plan a CMA job). The hook fires at the tool call, too late for a plan.

| Rule file | Loads on | Mode |
|---|---|---|
| `codex-worker-safety.md`, `codex-adversarial.md` | `codex` command, `codex-*` agent, `codex` skill | block |
| `grok-worker-safety.md` | `grok` command, `grok-*` agent, `grok` skill | block |
| `cma-safety.md` | `ant` command, CMA API URL, `cma-operator` agent, `cma` / `launch-your-agent` / `wrap-up` skill | block |
| `pr-and-commit-style.md` | `git commit`, a `commit` through `git-safe.ps1`, `gh pr create`, `POST .../pulls` | block |
| `design-work.md` | a design skill (frontend-design, scroll-craft, landing-page-builder, impeccable, dataviz, artifact-design, the deck skills, ...); `kie.mjs still/shot` blocks (paid) | inject / block |
| `browser-automation.md` | Playwright MCP, `playwright`, `cdp.mjs`, `browser-dev-cycle` / `qa-test`; any `claude-in-chrome` tool blocks (deprecated) | inject / block |
| `opencli-first.md` | WebFetch, WebSearch, `opencli` | inject |
| `harness-update.md` | `/harness-update`, a global Codex install, `grok update` | inject |
| `git-merge-workflow.md` | `git merge`, `gh pr merge`, `gh api .../merge`, `land-pr.ps1` | inject |
| `pr-coderabbit-loop.md` | PR create, `coderabbit-status.mjs`, `land-pr.ps1` | inject |
| `cross-terminal-db.md` | `psql`, `pg_dump`, `docker exec ... postgres` | inject |
| `headless-claude-mcp.md` | `claude -p` / `--print` | inject |
| `notion-cli-safety.md`, `railway-deploy.md`, `neonctl-safety.md`, `kusto-cli-safety.md`, `sentry-safety.md`, `linear-safety.md` | that CLI, its MCP tools, or its skill | inject |
| `fabric-playbook.md` | skill `fabric*`, Fabric/OneLake calls, `fab`, `az fabric`, `sqlcmd` to a Fabric host | inject |
| `proactive-delegation.md` | the first Agent spawn (spark scope, post-spark checks, kraken waves) | inject |

Decisions these rules shape before any tool call:
- Codex and Grok write runs, CMA creates and sends, kie.ai generation, and any deploy or delete are confirm-first.
- CMA bills Dave's API key, not the subscription. Grok is parked on this machine.
- Fabric: run the project preflight first; stop all load on the first capacity error; never pause or resize a capacity.
- Never merge a PR without Dave's explicit yes. Land CCv3 PRs with `scripts/github/land-pr.ps1`.
- Never request the paid CodeRabbit on-demand review.
- Headless `claude -p` that needs a claude.ai connector: clear `ANTHROPIC_API_KEY` and pass `--allowedTools`.

## Folded into skills

- New platform access: prefer a native CLI, then OpenCLI, then MCP; browser automation last. Detail: `cli-integration` skill.
- Structural code questions (who calls X, what breaks): run `tldr`, then Read the 2-4 files it names. Detail: `tldr-code` skill.
- Project paths, ports and commands: read `.claude/project-registry.json` (repo copy is canonical). Detail: `project-registry` skill.

A fired rule not about the call is a false fire: record it at once in `~/.claude/logs/rule-router-false-fires.jsonl`.
Triggers, logs and the weekly audits: `every-surface-checklist.md` (loads with harness files).
