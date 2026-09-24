# On-demand rules

These rules are NOT always loaded. They live in `~/.claude/rules-ondemand/`. The `rule-router` hook
loads each one the first time a matching tool call happens in a session. A **block** rule refuses
that first call and gives the rule as the reason: read it, then re-issue the call or change course.
An **inject** rule arrives as context and the call runs.

**Read the file yourself before you PLAN work in its area** (before you propose a Codex run, write a
commit message, or design a CMA job). The hook fires at the action, which is after the plan.

| Rule file | Loads on | Mode |
|---|---|---|
| `codex-worker-safety.md`, `codex-adversarial.md` | `codex` command, `codex-*` agent, `codex` skill | block |
| `grok-worker-safety.md` | `grok` command, `grok-*` agent, `grok` skill | block |
| `cma-safety.md` | `ant` command, CMA API URL, `cma-operator` agent, `cma` / `launch-your-agent` / `wrap-up` skill | block |
| `pr-and-commit-style.md` | `git commit`, a `commit` through `git-safe.ps1`, `gh pr create`, `POST .../pulls` | block |
| `harness-update.md` | `/harness-update`, a global Codex install, `grok update` | inject |
| `git-merge-workflow.md` | `git merge`, `gh pr merge`, `gh api .../merge`, `land-pr.ps1` | inject |
| `pr-coderabbit-loop.md` | PR create, `coderabbit-status.mjs`, `land-pr.ps1` | inject |
| `cross-terminal-db.md` | `psql`, `pg_dump`, `docker exec ... postgres` | inject |
| `headless-claude-mcp.md` | `claude -p` / `--print` | inject |
| `notion-cli-safety.md`, `railway-deploy.md`, `neonctl-safety.md`, `kusto-cli-safety.md`, `sentry-safety.md`, `linear-safety.md` | that CLI, its MCP tools, or its skill | inject |

Decisions these rules shape before any tool call (keep them in mind without loading):
- Codex and Grok write runs, CMA creates and sends, and any deploy or delete are confirm-first.
- CMA bills Dave's API key, not the subscription. Grok is parked on this machine.
- Never merge a PR without Dave's explicit yes. Land CCv3 PRs with `scripts/github/land-pr.ps1`.
- When a PR opens, start the CodeRabbit loop in the same turn. Never request the paid on-demand review.
- Headless `claude -p` that needs a claude.ai connector: clear `ANTHROPIC_API_KEY` and pass `--allowedTools`.

Triggers: `~/.claude/rules-ondemand/manifest.json`. Fires: `~/.claude/logs/rule-router.jsonl`.
