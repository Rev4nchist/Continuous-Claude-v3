# Windows Platform Rules

## Never Edit `.claude.json` with the Edit tool [C:10]

Claude Code writes to `~/.claude.json` continuously (session stats, tip counters, feature flag caches, timestamps). The Edit tool will almost always fail with "File has been modified since read."

**Use Node.js atomic read-modify-write instead:**

```bash
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/david.hayes/.claude.json', 'utf8'));
// ... modify data ...
fs.writeFileSync('C:/Users/david.hayes/.claude.json', JSON.stringify(data, null, 2) + '\n');
"
```

This reads, modifies, and writes in a single process — no race window.

## Scripted exact-string edits fail silently on CRLF [H:8]

This tree mixes CRLF and LF files, so a script's `.replace(anchor, …)` with an LF anchor can match
nothing and still "succeed". Use `node scripts/tools/safe-replace.mjs <file> --old … --new …`: it
matches either ending, keeps the file's own, and exits 1 when the anchor count is wrong (P30).

## Python is not `python3` on Windows [H:8]

Windows does not have `python3` on PATH. The `python3` command triggers the Microsoft Store alias and fails.

| Platform | Command |
|----------|---------|
| Linux/macOS | `python3` |
| Windows | `python` or `node` (preferred) |

**Rule:** For cross-platform scripts, prefer `node` (always available in Claude Code). For Python specifically, use `python` not `python3`, or use `uv run python` which handles this correctly.

## MCP Servers: `npx` requires `cmd /c` wrapper [H:8]

On Windows, MCP server configs using `npx` directly will fail. Wrap with `cmd /c`:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "package-name@latest"]
}
```

NOT:

```json
{
  "command": "npx",
  "args": ["package-name@latest"]
}
```

Claude Code diagnostics will warn about this — fix immediately when seen.

## Git Bash paths require drive letter [H:9]

`/Users/david.hayes/...` does NOT work on Windows Git Bash — it resolves to `C:\Program Files\Git\Users\...` which doesn't exist.

Always use one of these formats:
- `/c/Users/david.hayes/...` (Git Bash native)
- `C:/Users/david.hayes/...` (Windows forward-slash)

| Wrong | Right |
|-------|-------|
| `cd /Users/david.hayes/project` | `cd /c/Users/david.hayes/project` |
| `cd "$HOME/project"` (if HOME unset) | `cd C:/Users/david.hayes/project` |

This is the #1 cause of `Exit code 1` errors across sessions. The `$HOME` variable works when set, but literal paths MUST include the drive letter.

## Parallel Bash commands: verify directory first [H:8]

When running multiple Bash commands in parallel that depend on a directory existing, verify access in a standalone command first. Otherwise one bad path cascades "Sibling tool call errored" to all parallel siblings.

**Pattern:**
1. First call: `ls C:/Users/david.hayes/project` (verify it exists)
2. Then parallel calls that use that directory

**Anti-pattern:** Launching 3 parallel `cd /Users/david.hayes/project && ...` commands — if the path is wrong, all 3 fail with cascade errors, tripling the noise.

## The MSYS "fork storm" — use `git-safe.ps1` for commits and pushes [H:9]

Git for Windows runs hooks through MSYS bash. When two MSYS processes cold-start at once, a
process can crash (`*** fatal error - add_item (...) failed, errno 1`, exit `0xC0000005`) or hang
at ~0 CPU. A crashed pre-commit hook aborts the commit. This repo's own git hooks spawn nested
bash, so every commit can hit it.

- **Commit and push through the wrapper:** `pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>`.
  It retries only on the MSYS signature (up to 4 attempts, ~6 s apart), never on a real git error,
  and logs to `~/.claude/logs/msys-events.jsonl`. Read-only git does not need it.
- **When the Bash tool hangs, use the PowerShell tool** (next section).
- **Never `taskkill /T` and never `scripts/msys/reap.ps1 -Force`.** Both have been shown to kill
  live peer-session shells (PIDs are reused; low CPU does not mean stuck). To look for stuck MSYS
  processes, census by path, read-only:
  ```powershell
  $g=(Split-Path (Split-Path (Get-Command git).Source)).TrimEnd('\') + '\'   # the active Git root, with a trailing \
  Get-CimInstance Win32_Process | ? { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($g,'OrdinalIgnoreCase') } |
    Select ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Format-List
  ```
  Reclaim only a leaf orphan: no children, no live `claude`/`pwsh`/`node` ancestor, older than
  600 s, and two samples 60 s apart agree. Kill it by explicit PID.
- **Measure a rate, not a count.** `msys-events.jsonl` logs Bash-tool calls and git-safe runs
  (`ok:1` rows included; an ordinary git error in git-safe is not logged). On 2026-09-23 it showed
  1 failure in 18,297 logged calls since 2026-08-19. The file rotates (one previous generation
  kept), so compute a rate only over an interval both files still cover.
- `bash` on PATH is WSL, not MSYS. `pwsh -File scripts/msys/spawn-latency.ps1` measures Git bash
  cold starts; check that its `git bash:` line names a path under `Git\bin`.

Full investigation (causes ruled out, the AV minifilters, the repro harness `scripts/msys/repro.ps1`
and why it storms the machine, the corrections of 2026-07-26/29 and 2026-08-17/19):
`docs/windows/msys-fork-storm-investigation.md`.


## Bash tool hangs on git/network ops → use PowerShell [H:8]

Observed repeatedly 2026-07-06: while GitHub was slow, **every** Bash-tool command timed out (2 min) — including *local* ops like `git branch`/`git log`. Root cause: the Bash tool's shell-profile initialization runs a network-dependent step, so a slow remote hangs the whole shell before your command runs (it's not a git lock — verified: no `.git/*.lock`, no stuck `git`/`gh` processes).

**Rule:** when Bash-tool git/network ops hang, **switch to the PowerShell tool** — it doesn't source that profile and runs instantly. Use `git -C <repo> <cmd>` (no `cd`). This applies to any git/`gh`/network op, not just merges.

The `destructive-command-guard` gates the PowerShell tool as well (since 2026-09-23), including `git -C <repo> reset --hard` and `git stash -u`. Override there, only after Dave says yes to that exact command: start the command with `$env:SKIP_DESTRUCTIVE_GUARD='1';`.

## Deleting a junction from the PowerShell tool [H:7]

`cmd /c rmdir <junction>` is **blocked by Claude Code itself**, not by a CCv3 hook. The PowerShell tool's built-in path guard (the message is compiled into `claude.exe`) reads it as `Remove-Item` on the system path `/c` and refuses the whole command: `Remove-Item on system path '/c' is blocked`. Verified 2026-09-22. It also fires when that text only appears inside a quoted string, such as a commit message built inline, so write such messages to a file with the Write tool. Nothing in `.claude/hooks` can change this, so do not look for the hook.

**The same guard blocks regex text.** The guard is part of Claude Code. It is in `claude.exe`, it is not a CCv3 hook, and its `decisionReason.type` is `safetyCheck`. It reads a regex token in a command, such as `\w+` or `\s*=`, as a `Remove-Item` target path. For example, it reads `\w+` as `/w+` under the drive root. It then blocks the WHOLE command, not only the `Remove-Item` part. Two workarounds:

- Run `Remove-Item` as its own call, with no regex in that command.
- Put regex-heavy code in a `.ps1` file. Run it with `pwsh -File <script>.ps1`.

To remove only the link, never its target:

```powershell
if ((Get-Item $J).LinkType -ne 'Junction') { throw 'not a junction' }
[System.IO.Directory]::Delete($J, $false)
```

Remove any such link before `git worktree remove --force` on a worktree that holds one (e.g. a `node_modules` junction into the main repo), so nothing walks into the target. Count the target's entries before and after.

## `gh` CLI and GitHub auth [H:8]

- `gh pr merge` / `gh pr create` are **interactive by default** and HANG in tool shells. Script with REST:
  `gh api repos/<O>/<R>/pulls/<N>/merge -X PUT -f merge_method=merge`; edit a PR with `gh api ... -X PATCH`.
- **A timed-out `gh`/`git` command (exit 143) is NOT proof of failure.** Verify (`gh api .../pulls/<N>` → `merged`) before retrying.
- Plain `git` and bare `gh` pick the right account by themselves (`~/.gitconfig` username + a `fourth/` `insteadOf`
  rewrite; `scripts/github/gh-shim.ps1` in the PowerShell profiles). Scripts that call `gh` directly use `gh-for.ps1`.
- **Do not suggest `gh auth refresh`**: it cannot fix an env-var token. "Repository not found" on a repo you own
  means the wrong account answered. Check with `pwsh -File scripts/github/verify-github-accounts.ps1`.
- `--web` login stores the account the BROWSER holds. Verify with the same script; it clears `GH_TOKEN`/`GITHUB_TOKEN` first.

History, the corrections of 2026-08-05/11, rollback, and re-authenticating after a revoked OAuth grant:
`docs/github/auth-routing.md`.

Full merge/branch-cleanup workflow using these: `.claude/rules-ondemand/git-merge-workflow.md`.
