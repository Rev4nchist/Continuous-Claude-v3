# CodeRabbit CLI and plugin (advisory only)

CodeRabbit returns as a **label-gated PR bot** on CCv3 (`review:coderabbit`, `review:deep` in
`.coderabbit.yaml`). Only **`coderabbitai[bot]` PR reviews on the current head** count toward READY,
alongside Greptile. A CLI or plugin run **never** grants READY.

## Run budget and timeouts

- At most **2** `cr review --agent` runs per PR (per repo + branch). Run 3 is blocked by
  `coderabbit-guard`. Failed, rate-limited, or incomplete runs **still consume** a slot.
- Background review timeout: **≥15 minutes** (team default **35 minutes** on long PRs).
- Treat incomplete outcomes as incomplete: do not claim the PR was reviewed.
- Stop and report when the CLI ends in `awaiting_confirmation` or `action_required`; do not
  auto-confirm billing or destructive follow-ups.

## Findings are advisory

CLI/plugin output is for the agent's own triage. Fix real issues on the branch, but **never** call a
PR ready based on CLI output alone. READY comes only from `review-status.mjs` (PR bots on the head).

## Forbidden (hard block via coderabbit-guard)

- `--use-credits` and `--api-key` on any CodeRabbit command.
- `cr code new`, `cr code push`, `coderabbit code new`, `coderabbit code push`.
- Skill **`coderabbit:autofix`** (writes/autofix mode).
- Skill installs: `npx skills add coderabbitai/skills`, `coderabbit skills`, or any install of
  CodeRabbit-packaged skills.

## Allowed

- Plain **`cr review --agent`** (runs 1–2), with no forbidden flags.
- A **read-only autofix subagent** (Task/Agent) when the prompt is explicitly read-only review/fix
  planning — no `coderabbit:autofix` skill, no `code new`/`code push`, no credits/API key.

## Never

- Read, mint, echo, or pass CodeRabbit API keys in chat, commits, or hook state.
- Buy on-demand reviews or enable usage billing without Dave's explicit yes.
