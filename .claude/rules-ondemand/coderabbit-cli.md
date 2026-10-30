# CodeRabbit CLI and plugin (advisory only)

CodeRabbit returns as a **label-gated PR bot** on CCv3 (`review:coderabbit`, `review:deep` in
`.coderabbit.yaml`). Only **`coderabbitai[bot]` PR reviews on the current head** count toward READY,
alongside Greptile. A CLI or plugin run **never** grants READY.

## Run budget and timeouts

- There is no cap of 2 `cr review --agent` runs per PR (Dave, 2026-10-30: use CLI reviews as needed).
  `pre-pr.mjs` still counts its own runs and stops at 2 per branch. Runs of `scripts/github/cr-fix.mjs`
  count separately. Run `cr-fix.mjs` after the push of each batch of fix commits (see `pr-review-loop.md`).
- `coderabbit-guard` is **not registered** (live settings or template) until DW-80 brings a vetted shell
  parser. Its run cap of 2 and its `--use-credits` block do not match this file. Change them before you register it.
  Until then, you enforce every rule in this file.
- Background review timeout: **≥15 minutes** (team default **35 minutes** on long PRs).
- Treat incomplete outcomes as incomplete: do not claim the PR was reviewed.
- Stop and report when the CLI ends in `awaiting_confirmation` or `action_required`; do not
  auto-confirm billing or destructive follow-ups. `cr-fix.mjs` prints `incomplete` and exits 1 then.

## Billing facts (CodeRabbit docs and the account, 2026-10-30)

- The CLI has its own hourly allowance, apart from PR reviews. `cr usage` shows 10 per hour for this repo.
- Past it, in On demand mode, `cr review --agent` returns `awaiting_confirmation`. It charges nothing unless `--use-credits` is passed.
- Dave has $25 of CLI and IDE credit. It does not pay for PR reviews.
- PR reviews have usage billing On demand with a $50 monthly cap. Past the included limit a review waits for a seat holder to consent. It then costs $0.25 per reviewed file.
- These each count as 1 PR review: marking a draft ready, each `@coderabbitai review`, each push with incremental review on, and GitHub's "Update branch" button.

## Findings are advisory

CLI/plugin output is for the agent's own triage. Fix real issues on the branch, but **never** call a
PR ready based on CLI output alone. READY comes only from `review-status.mjs` (PR bots on the head).

## Forbidden (coderabbit-guard blocks these once registered)

- `--api-key` on any CodeRabbit command.
- `--use-credits` on a PR comment (`@coderabbitai review --use-credits`). Never post it.
- `--use-credits` on the CLI, except in the one case under "Allowed".
- `cr code new`, `cr code push`, `coderabbit code new`, `coderabbit code push`.
- Skill **`coderabbit:autofix`** (writes/autofix mode).
- Skill installs: `npx skills add coderabbitai/skills`, `coderabbit skills`, or any install of
  CodeRabbit-packaged skills.

## Allowed

- Plain **`cr review --agent`**, and `cr review --agent --committed --base-commit <sha>` (the `cr-fix.mjs` run),
  with no forbidden flags. `cr-fix.mjs` never passes `--use-credits` or `--api-key`.
- `--use-credits` on one CLI run, only when both are true: that run returned `awaiting_confirmation`,
  and the PR is on the risk list (a PR file matches `checkpoint.critical` or `checkpoint.parser` in
  `review-router.config.json`, or the router class is r3; same list as `pr-review-loop.md`). On any
  other PR, ask Dave first. Spend from the $25 CLI credit only.
- **Read-only commands**, which never count as a run: `cr doctor`, `cr usage` (also
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

A raw check on the unstripped command denies `--use-credits` or `--api-key` next to a `cr` or
`coderabbit` word (also `.cmd`, `.bat`, `.ps1` shims), in comments and in `grep`, `echo` or
`Set-Content` text too, unless every `cr` word is inside a leading `git` or `gh` command's commit or PR
text. To build a test payload that names these flags, write it with the Write tool, not a shell command.
Known limit: the run key follows the last `cd` in a command, so the key only moves a count between
branches; the cap never unlocks paid use. Help and version are free only for a plain one-line call;
any wrapped, commented, continued or embedded review call counts as a run. The `git` and `gh` text
exemption holds only for text that is not executed: `$( )`, backticks and shell payloads are always
checked. Run-cap counting inside quoted heredocs is a known best-effort limit, and the guard stays
unregistered in live settings and in `settings.json.template` until a vetted shell parser replaces the
hand lexer (DW-80).

The guard stops accidents, not evasion. These are out of scope: a variable or `$( )` holding the flag,
aliases or functions, git or gh aliases, a rebase exec step, a script file run later, quote-split
flags, and encoded commands. Usage billing set to Off on the account is the real billing control.

## Override

`SKIP_CODERABBIT_GUARD=1` is **Dave-only**. An agent never sets it, never suggests it as a fix for a
block, and never copies it from a deny message. Ask Dave instead. It works only as a leading
assignment (`SKIP_CODERABBIT_GUARD=1 cr ...`, or `$env:SKIP_CODERABBIT_GUARD=1;` in PowerShell), and
each use writes an `override` line to the guard decision log.

## Never

- Click or tick CodeRabbit's **Autofix** or autopilot checkbox in the PR walkthrough, and never post
  `@coderabbitai autopilot`. It publishes commits and follow-up fixes without per-patch approval.

- Read, mint, echo, or pass CodeRabbit API keys in chat, commits, or hook state.
- Buy on-demand PR reviews or enable usage billing without Dave's explicit yes. Never click the "Review with credits" button.
