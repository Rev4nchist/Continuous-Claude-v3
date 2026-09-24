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

The `destructive-command-guard` gates the PowerShell tool as well (since 2026-09-23), including `git -C <repo> reset --hard` and `git stash -u`. Override there: start the command with `$env:SKIP_DESTRUCTIVE_GUARD='1';`.

## Deleting a junction from the PowerShell tool [H:7]

`cmd /c rmdir <junction>` is **blocked by Claude Code itself**, not by a CCv3 hook. The PowerShell tool's built-in path guard (the message is compiled into `claude.exe`) reads it as `Remove-Item` on the system path `/c` and refuses the whole command: `Remove-Item on system path '/c' is blocked`. Verified 2026-09-22. It also fires when that text only appears inside a quoted string, such as a commit message built inline, so write such messages to a file with the Write tool. Nothing in `.claude/hooks` can change this, so do not look for the hook.

To remove only the link, never its target:

```powershell
if ((Get-Item $J).LinkType -ne 'Junction') { throw 'not a junction' }
[System.IO.Directory]::Delete($J, $false)
```

Remove any such link before `git worktree remove --force` on a worktree that holds one (e.g. a `node_modules` junction into the main repo), so nothing walks into the target. Count the target's entries before and after.

## `gh` CLI: interactive by default + `read:org` scope gaps → use the REST API [H:8]

- `gh pr merge` / `gh pr create` are **interactive by default** → they HANG in the non-interactive tool shells. For scripted use, prefer `gh api` (REST): `gh api repos/<O>/<R>/pulls/<N>/merge -X PUT -f merge_method=merge`.
- `gh pr edit` / `gh pr view` (and other porcelain) issue GraphQL that needs `read:org`. **RESOLVED 2026-08-05 — GraphQL porcelain works now** (`gh pr list` verified returning results). The REST fallback is still the right choice for *scripted* use because it is non-interactive, but it is no longer a workaround for a broken scope: `gh api repos/<O>/<R>/pulls/<N> -X PATCH -f title=… -f body="$B"`.
- **The old remediation in this file was impossible, and that is why it never worked.** It said "run `gh auth refresh -h github.com`" — which `gh auth status` also suggests. On this machine that was a dead end: `gh` had **no stored credential at all** (no `%APPDATA%\GitHub CLI\`, no `hosts.yml` anywhere), and a User-scope `GITHUB_TOKEN` classic PAT outranked stored credentials anyway (precedence: `GH_TOKEN` > `GITHUB_TOKEN` > stored). `gh auth refresh` refreshes gh's *own OAuth* credential; with none stored there was nothing to refresh, and a classic PAT's scopes live on github.com, not in gh. **Do not suggest `gh auth refresh` against an env-var token.**
- **The actual fix** was to bootstrap the per-account OAuth logins that `scripts/github/gh-for.ps1` was written for but which had never been created:
  - `~/.config/gh-personal` → `Rev4nchist`, `~/.config/gh-work` → `david-hayes44`, both keyring-stored, both with `read:org`.
  - User-scope `GITHUB_TOKEN` removed (the PAT is orphaned — revoke it at github.com/settings/tokens).
  - User-scope `GH_CONFIG_DIR` now defaults to `gh-personal`, because **without a default, bare `gh` has no credential at all** — gh falls back to `%APPDATA%\GitHub CLI\`, which does not exist. `gh-for.ps1` still overrides per-invocation for repos whose remote owner routes elsewhere.
  - Caveat when logging in: `--web` stores whichever account the **browser session** holds, not the one you intended. The work credential initially landed in `gh-personal` for exactly this reason. Always verify with `GH_CONFIG_DIR=<dir> gh api user --jq .login` (ambient tokens cleared) rather than trusting the login's own success message.
- **`verify-github-accounts.ps1` layer 2 could hang the whole verifier** (fixed 2026-08-05). `git credential fill` asks Git Credential Manager, whose default on a MISS is a **GUI prompt** — which blocks forever in a tool/scheduled shell, at 0% CPU, producing ZERO output on kill. It now passes `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and `-c credential.interactive=false` so a miss FAILS instead of asking. A verifier that can hang is a verifier nobody runs — which is how all four identity layers stayed unverified while the setup was misconfigured.
- **A timed-out `gh`/`git` command (exit 143) is NOT proof of failure** — the op often already succeeded server-side. VERIFY (`gh api …/pulls/<N>` → `merged`) before retrying.

### Plain `git` and bare `gh` now route themselves (2026-08-11)

The wrappers are no longer the only correct path. Three changes, all verified by a
64-remote sweep (`scripts/github/sweep-remotes.ps1`) that went from **25 failures to 1**:

- **`~/.gitconfig` picks the account.** `credential."https://github.com".username = Rev4nchist`
  gives GCM the tiebreak it lacked, and `url."https://david-hayes44@github.com/fourth/".insteadOf`
  rewrites work URLs at transport time. All 9 `fourth/*` remotes match that prefix — verified by
  `scripts/github/audit-remotes.ps1`, not assumed.
- **The global `wincred` helper and the ambiguous `git:https://github.com` credential are gone.**
  That pair was the real defect: with no username GCM could not choose, and wincred answered from a
  host-level entry mapping to **david-hayes44**, so every *personal* repo silently authenticated as
  the *work* account and 404'd. That is what "Repository not found" on a repo you own means here.
  Removing wincred was safe because **every** `git:` entry in Credential Manager was github.com —
  no other host depended on it.
- **Bare `gh` routes by directory** via `scripts/github/gh-shim.ps1`, dot-sourced from both
  PowerShell profiles. It shares `accounts-lib.ps1` with the wrappers rather than copying the
  mapping. A function only affects profile-loading shells, so scripts calling `gh` directly are
  unchanged — those should still use `gh-for.ps1`.

Corrections to what was believed before:

- **`gh-for.ps1` could not run any gh command in either of its documented forms** until 2026-08-11.
  `[CmdletBinding()]` with `$Path` first made `$Path` positional 0, so `gh-for.ps1 api …` bound
  `api` to `-Path` and failed with `cannot determine an account for 'api'` — an argument-binding
  bug wearing a routing-config error message. A `--` separator does not help: `pwsh -File` hands
  `--` to its own binder. Fixed with `PositionalBinding = $false`, which `git-for.ps1` had all along.
- **`git remote -v` does NOT stay clean** under an `insteadOf` rule — it prints the rewritten URL.
  The *stored* config is untouched (`git config --get remote.origin.url` shows the original), which
  is the property that actually matters.
- **A no-username `git credential fill` still returns a credential, and should.** Once
  `credential.<url>.username` is set it resolves to the default account deterministically. The
  invariant worth guarding is *which* account answers, not whether one does — `verify-github-accounts.ps1`
  layer 5 asserts exactly that, plus a single-helper chain and a firing URL rewrite.
- **`gh-for.ps1 api …` for ad-hoc queries works now**, so the "no remote, no matching route" refusal
  is no longer a reason to reach for plain `gh`.
- **Deleting the ambiguous `git:https://github.com` entry does NOT stay done.** GCM recreates it on
  the next successful auth — observed the same day. That is fine, and it is why the ordering matters:
  **`credential.<url>.username` is the load-bearing fix**, because git then never asks without a
  username and the host-level entry is never consulted. Treat the deletion as hygiene, not as the
  control. Layer 5 checks the property that actually matters (which account answers a bare probe).

### Re-authenticating an account after revoking its OAuth grant

Revoking **GitHub CLI** under Settings → Applications → Authorized OAuth Apps kills a `gho_` token
that BOTH `gh` and Git Credential Manager may be holding, so `gh` and *plain git push* break
together for that account. Verified 2026-08-11 on `david-hayes44`: `gh api user` returned
`Bad credentials` and plain git returned `Invalid username or token`, while the other account was
untouched.

There is **no "reissue" button in the GitHub UI** — a revoked OAuth grant is recreated by re-running
the client's own login flow, which re-prompts for authorization:

1. Sign the browser into github.com **as the account being restored**. `--web` stores whichever
   account the BROWSER session holds, not the one you intended — this trap has already put the work
   credential in the personal config dir once.
2. `$env:GH_CONFIG_DIR="$HOME\.config\gh-work"; gh auth login --hostname github.com --git-protocol https --web`
3. In an **interactive** terminal, run a fetch in any work repo (`git -C <fourth repo> fetch origin`)
   and complete GCM's browser prompt. Because the `insteadOf` rule puts `david-hayes44@` in the URL,
   GCM is asked for that account specifically — no picker, no ambiguity.
4. Confirm with `pwsh -File scripts/github/verify-github-accounts.ps1` and
   `pwsh -File scripts/github/sweep-remotes.ps1`. A dead work credential shows up as exactly 9
   failures, one per `fourth/*` remote.

Rollback, credentials untouched throughout:
`git config --global credential.helper wincred`,
`git config --global --unset credential.https://github.com.username`,
`git config --global --unset url.https://david-hayes44@github.com/fourth/.insteadOf`.

Full merge/branch-cleanup workflow using these: `.claude/rules/git-merge-workflow.md`.
