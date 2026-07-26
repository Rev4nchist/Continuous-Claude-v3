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
`NOTSET`), competing MSYS runtimes (one `msys-2.0.dll` 3.5.7, one git install),
running AV filter drivers (none; iolo is registered in SecurityCenter2 but has no
service or driver running), and Claude Code's own hooks (**0 of 146 invoke bash** —
they are all node/python). The username contains a period, which some upstream
reports blame, but that cannot be the cause here: bash succeeds the overwhelming
majority of the time and a fundamental incompatibility would not be intermittent.

**Not reproducible on demand.** Synthetic bursts fail all-or-nothing and
sporadically — 48/48 failed, then 64/64 passed minutes later, then 16 consecutive
48-bursts all passed. Treat the JSONL as the evidence base; the `bash_alive` field
at crash time is what tests the cold-start theory against real occurrences.

## Bash tool hangs on git/network ops → use PowerShell [H:8]

Observed repeatedly 2026-07-06: while GitHub was slow, **every** Bash-tool command timed out (2 min) — including *local* ops like `git branch`/`git log`. Root cause: the Bash tool's shell-profile initialization runs a network-dependent step, so a slow remote hangs the whole shell before your command runs (it's not a git lock — verified: no `.git/*.lock`, no stuck `git`/`gh` processes).

**Rule:** when Bash-tool git/network ops hang, **switch to the PowerShell tool** — it doesn't source that profile and runs instantly. Use `git -C <repo> <cmd>` (no `cd`). This applies to any git/`gh`/network op, not just merges.

Caveat: the `destructive-command-guard` is a **Bash-tool** PreToolUse hook, so destructive git ops run via PowerShell are **not** gated — apply the same confirm-first judgment yourself.

## `gh` CLI: interactive by default + `read:org` scope gaps → use the REST API [H:8]

- `gh pr merge` / `gh pr create` are **interactive by default** → they HANG in the non-interactive tool shells. For scripted use, prefer `gh api` (REST): `gh api repos/<O>/<R>/pulls/<N>/merge -X PUT -f merge_method=merge`.
- `gh pr edit` / `gh pr view` (and other porcelain) issue GraphQL that needs `read:org`; the current token lacks it → they error. The **REST API needs no org scope**: `gh api repos/<O>/<R>/pulls/<N> -X PATCH -f title=… -f body="$B"`.
- **A timed-out `gh`/`git` command (exit 143) is NOT proof of failure** — the op often already succeeded server-side. VERIFY (`gh api …/pulls/<N>` → `merged`) before retrying.

Full merge/branch-cleanup workflow using these: `.claude/rules/git-merge-workflow.md`.
