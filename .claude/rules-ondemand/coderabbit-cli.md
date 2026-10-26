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

- Plain **`cr review --agent`** (runs 1–2), with no forbidden flags. Every `cr review --agent` in a
  chained command counts: `cr review --agent && cr review --agent` is 2 runs.
- **Read-only commands**, which never count toward the run cap: `cr doctor`, `cr usage` (also
  `cr usage --agent`), `cr auth login`, `cr auth status`, `cr --help`, `cr <subcommand> --help`,
  `cr --version`, and the `coderabbit` equivalents.
- A **read-only autofix subagent** (Task/Agent) when the prompt is explicitly read-only review/fix
  planning — no `coderabbit:autofix` skill, no `code new`/`code push`, no credits/API key.

The guard treats a command as a CodeRabbit call only when its program is `cr` or `coderabbit`
(also `.exe`, with a path, or behind `npx`, `sudo`, `xargs`, `eval`, `iex`, `Start-Process`, `cmd /c`,
`bash -c`, `pwsh -c`, or a shell keyword such as `then` or `do`). Commands that only name it, such as
`git push` of a `cr` branch or `cat .coderabbit.yaml`, are not affected. Text inside quotes, heredocs
and PowerShell here-strings is data, so a commit message or PR body that talks about CodeRabbit is
allowed. A `$( )` substitution inside double quotes is still scanned.

A loop counts as one run, because the guard cannot see the iteration count. Never run `cr review`
inside a loop, `xargs` or `ForEach-Object`.

## Override

`SKIP_CODERABBIT_GUARD=1` is **Dave-only**. An agent never sets it, never suggests it as a fix for a
block, and never copies it from a deny message. Ask Dave instead. It works only as a leading
assignment (`SKIP_CODERABBIT_GUARD=1 cr ...`, or `$env:SKIP_CODERABBIT_GUARD=1;` in PowerShell), and
each use writes an `override` line to the guard decision log.

## Never

- Click or tick CodeRabbit's **Autofix** or autopilot checkbox in the PR walkthrough, and never post
  `@coderabbitai autopilot`. It publishes commits and follow-up fixes without per-patch approval.

- Read, mint, echo, or pass CodeRabbit API keys in chat, commits, or hook state.
- Buy on-demand reviews or enable usage billing without Dave's explicit yes.
