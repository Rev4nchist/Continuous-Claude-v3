# Windows Platform Rules

## codegraph (RETIRED 2026-07-24)

The codegraph L3 specialist + /code-intel facade were retired 2026-07-24 (near-zero adoption; index stale since build). The full Windows platform contract (gate results, CVE-2024-27980 spawn findings, WAL requirements) lives in git history of this file and the deleted test .claude/hooks/src/__tests__/codegraph-platform-contract.test.ts if codegraph is ever re-adopted.

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

Git for Windows runs every hook through its bundled MSYS shell. MSYS builds its
mount table in shared memory exactly once per cohort of processes, guarded by a
spinlock in `shared.cc` that **gives up after 15 seconds**. If two MSYS processes
cold-start at roughly the same time and the first is slow inside that critical
section, the second enters anyway, `mountinfo.init()` runs twice, and every
process in that cohort dies:

```
*** fatal error - add_item ("\??\C:\...\Git", "/", ...) failed, errno 1
```

exiting `0xC0000005` (3221225477). The crash is in DLL init, **before** bash reads
the hook script — so a hook cannot retry itself, and git treats the dead
pre-commit hook as a veto and aborts the commit. Measured 2026-07-26: five commits
and one push failed this way in one session, each succeeding later unchanged.

**Rule: run commits and pushes through the wrapper.**

```
pwsh -File scripts/git-safe.ps1 -C <repo> commit -F <msgfile>
```

It retries ONLY on the MSYS signature (verified: a genuine git failure returns in
~1s with its real exit code, never retried), backs off ~6s, bounds at 4 attempts,
and logs every occurrence to `~/.claude/logs/msys-crash.jsonl` with the live
bash/node process counts. Read-only git (`status`, `log`, `rev-parse`) does not
need it — those rarely fire hooks.

**Ruled out as causes, so don't re-chase them:** forced ASLR (all mitigations
`NOTSET`), competing MSYS runtimes (one `msys-2.0.dll` 3.5.7, one git install), and
Claude Code's own hooks (**0 of 146 invoke bash** — they are all node/python). The
username contains a period, which some upstream reports blame, but that cannot be
the cause here: bash succeeds the overwhelming majority of the time and a
fundamental incompatibility would not be intermittent.

**CORRECTION (2026-07-29): "running AV filter drivers (none)" was WRONG — put it
back on the list.** Two Microsoft security minifilters are running and intercepting
file I/O on every volume: `MsSecFlt` (Defender for Endpoint sensor, altitude 385600)
and `WdFilter`. Verified unelevated via `Get-CimInstance Win32_SystemDriver` — both
`State=Running`. What *is* true is the narrower claim: the third-party filters
(`rtp1`/`rtp2`/`BdSentry`, iolo) are gone from the registry, driver list and disk
after the uninstall. Those are different statements, and the file asserted the
stronger one. `fltmc filters` needs elevation, so from an ordinary shell **record
this as unchecked rather than empty** — an access-denied read is not a zero.

**Claude Code's hooks don't invoke bash, but this repo's GIT hooks do — nested.**
Read the ruled-out line above carefully: it is about `.claude/hooks/`, and it
invites the wrong conclusion that "hooks aren't involved". A single `git commit`
here spawns `pre-commit` (bash) → a **nested** `bash scripts/precommit-build-guard.sh`
→ a `grep`×3 / `sed` MSYS pipeline, then `post-commit` (bash) → a **detached,
long-lived** `nohup bash sync-to-active.sh --changed &`. Measured: 3 concurrent
bash from the pre-commit chain alone. That is precisely the shape recorded below as
reproducing the crash — a long-lived MSYS process holding a cohort open while
short-lived nested cold-starts arrive into it — and this repo manufactures it on
every commit, for free, without anyone running `repro.ps1`.

**CORRECTION (2026-07-26): it IS reproducible — the earlier burst shape was wrong.**
A burst of N identical bash processes is not the failing shape and stayed stubbornly
bimodal (48/48 failed, then 64/64 passed, then 16 clean bursts). The shape that
reproduces is the one real hooks actually create: **a long-lived MSYS process holding
a cohort open while short-lived NESTED bash cold-starts arrive into it.** Reproduced
twice on the first attempt, from a plain `bash -c "bash scripts/sync-to-active.sh --changed"`
launched alongside a sampler. Harness: `scripts/msys/repro.ps1`.

**The crash is not the worst outcome — the hang is.** The documented `add_item` fatal
error is loud, exits immediately, and `git-safe.ps1` already retries it. What the repro
surfaced is different and unlogged: affected bash processes **block instead of dying**,
at ~0 CPU, and never exit. One trial that should have created ~9 processes left **51
live**, 46 of them descendants nothing had a handle on, still present ten minutes later.
`Stop-Process` on the tracked pids sails straight past the descendants — the same
spawn-tree leak already recorded for `spawnSync`; only `taskkill /T /F` clears them.

**Recovery:** `pwsh -File scripts/msys/reap.ps1` (dry-run) then `-Force`. It kills only
processes that are BOTH older than 120s AND under 2s CPU, so a bash doing real work is
never touched. Verified: cleared 3 stuck leftovers, bash healthy immediately after.

**Not yet established, do not assume:** that this hang is what broke the Bash *tool* in
the 2026-07-26 session. The Bash tool was probed three times during the storm, including
with 48 stuck processes alive, and worked every time. The stuck-process pile-up and the
Bash-tool failure are so far two separate observations, not one causal chain. The
warm-keeper mitigation is still untested — but now there is a repro to test it against,
which is what the earlier zero-failures-in-both-arms A/B lacked.

**Crashes come in WINDOWS, and the load hypothesis is still open (2026-07-29).** Across
18 commits in one day: every `git-safe` commit crashed between 08:28 and 11:29, then
**five consecutive commits 11:33–12:21 crashed zero times**, then crashing resumed from
14:30. Concurrency was not visibly different across those windows, so "two processes
happened to collide" does not explain the clustering on its own. The live candidate is
that the 15-second `shared.cc` spinlock is only *reachable* when the machine is slow
inside the critical section, i.e. **degraded process-spawn latency manufactures the
race** — consistent with the separately-measured spawn pathology on this box (p50 814ms
and later 2,167ms against a healthy 30–80ms).

Measure it, don't assume it: `pwsh -File scripts/msys/spawn-latency.ps1`. Strictly
serial, no bursts, **safe to run at any time including inside a crash window** — unlike
`repro.ps1`, which deliberately storms the machine. It samples `node`, `bash` and
`git rev-parse` cold starts and prints a HEALTHY/ELEVATED/DEGRADED verdict against the
30–80ms reference.

Two measurement traps this lane already fell into, both worth avoiding:

- **`msys-crash.jsonl` only sees `git-safe`-wrapped git.** Every Bash-*tool* crash is
  invisible to it — on 2026-07-29 that included two `claude -p` launches fired in
  parallel which both died instantly, the single most concurrency-shaped evidence of
  the day, recorded nowhere. A concurrency hypothesis tested only against a log that
  cannot see the concurrent cases is unfalsifiable. Weigh the log accordingly.
- **`bash_alive` in that log is sampled AFTER the failing command returns**, so a
  crashed cohort has already died and it reads 0. It is not a count at crash time, and
  the many `bash_alive=0` failure rows are not evidence against a concurrency cause.

`git-safe.ps1` now also records `node_spawn_ms` (one sample, crash path only) and
`hooks_expected` per crash, so the next occurrence can settle both questions from its
own row instead of from a probe run after the window has closed.

⚠️ `repro.ps1` deliberately storms the machine. It has a circuit breaker (`-MaxBashAlive`,
default 25) that aborts and reaps; the first two versions did not, and both left the
machine with dozens of blocked processes.

## Bash tool hangs on git/network ops → use PowerShell [H:8]

Observed repeatedly 2026-07-06: while GitHub was slow, **every** Bash-tool command timed out (2 min) — including *local* ops like `git branch`/`git log`. Root cause: the Bash tool's shell-profile initialization runs a network-dependent step, so a slow remote hangs the whole shell before your command runs (it's not a git lock — verified: no `.git/*.lock`, no stuck `git`/`gh` processes).

**Rule:** when Bash-tool git/network ops hang, **switch to the PowerShell tool** — it doesn't source that profile and runs instantly. Use `git -C <repo> <cmd>` (no `cd`). This applies to any git/`gh`/network op, not just merges.

Caveat: the `destructive-command-guard` is a **Bash-tool** PreToolUse hook, so destructive git ops run via PowerShell are **not** gated — apply the same confirm-first judgment yourself.

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

Rollback, credentials untouched throughout:
`git config --global credential.helper wincred`,
`git config --global --unset credential.https://github.com.username`,
`git config --global --unset url.https://david-hayes44@github.com/fourth/.insteadOf`.

Full merge/branch-cleanup workflow using these: `.claude/rules/git-merge-workflow.md`.
