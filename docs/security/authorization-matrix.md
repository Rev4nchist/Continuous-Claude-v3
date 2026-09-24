# Authorization matrix: who may run a destructive operation, on which surface

Written 2026-09-23 (Opus 5.5 eval, P42). The FourthBot demo folder (45 files) was lost on
2026-09-17 to `git stash -u` and later orphaned by `reset --hard origin/main`. Both ran through
surfaces nothing gated. This page lists every surface that can run a command on this machine and
what stops a destructive operation on each. Keep it current when a guard or surface changes.

**ask** = the human is prompted. **deny** = blocked (fail-closed; an unattended prompt would hang).
**allow** = runs with no gate. **sandbox** = contained by the tool's own sandbox, not by CCv3.

## Surfaces

| Surface | What gates it |
|---|---|
| Claude Code, Bash tool | `destructive-command-guard` (PreToolUse, matcher `Bash`) |
| Claude Code, PowerShell tool | `destructive-command-guard` (PreToolUse, matcher `PowerShell`, since this change). Also Claude Code's own built-in PowerShell path guard, which blocks `Remove-Item` and `rmdir` on system paths, even inside quoted strings. |
| Headless `claude -p` (scheduled jobs) | Same hooks; `permission_mode` is bypass or the run has no human, so the guard **denies** |
| Subagents / workflow agents | Same hooks; `CLAUDE_AGENT_ID` marks them unattended, so the guard **denies** |
| `codex exec` (`/codex`, codex-adversary) | `--sandbox read-only` or `workspace-write` in a sibling worktree (`codex-worker-safety.md`). No CCv3 hook can see inside. |
| Codex Desktop app | **Nothing in CCv3.** Its own sandbox setting only. 47 of its sessions ran with the live repo as the working directory, 21+ with full access. |
| Git hooks, Task Scheduler scripts | None at run time. They are code; review happens at commit and PR time. |

## Operations x surfaces (after this change)

| Operation | Bash tool (interactive) | PowerShell tool (interactive) | Unattended (bypass, `claude -p`, subagent) | codex exec | Codex Desktop |
|---|---|---|---|---|---|
| `git stash -u` / `--include-untracked` / `--all` | ask | ask | deny | sandbox | allow |
| `git reset --hard` (incl. `git -C repo reset --hard`) | ask | ask | deny | sandbox | allow |
| `git clean -f`, `git checkout -- .`, `git restore --worktree .` | ask | ask | deny | sandbox | allow |
| `git branch -D`, `git push --force` / `--delete` | ask | ask | deny | sandbox (no network) | allow |
| Recursive delete: `rm -r`, `rd /s`, `del /s` | ask | ask | deny | sandbox | allow |
| Recursive delete: `Remove-Item -Recurse`, `[IO.Directory]::Delete(x,$true)` | not gated (quoted payload) | ask | deny (PowerShell tool) | sandbox | allow |
| Plain `git stash`, `git stash pop`, single-file `Remove-Item` | allow | allow | allow | sandbox | allow |

The PowerShell "ask" reaches the human because `permission-auto-allow` now leaves destructive
PowerShell to the human (it still auto-allows every other PowerShell call, so there is no new
prompt for safe commands). Bash is left to the human by that hook as before, and granted by the
`permissions.allow` "Bash" rule when the guard stays silent.

## Known gaps (not closed here)

- **Codex Desktop.** CCv3 cannot gate it. Dave chooses its sandbox default (workspace-write with
  on-request approval is the recommendation) and whether it may use the live repo as its working
  directory. Tracked as P10.
- **Dynamic payloads** (`iex`, `-EncodedCommand`, `bash <<<`, `printf ... | sh`): accepted limits,
  listed in the guard's header and its test file.
- **Scheduled scripts** run their own code with no guard. A script that deletes must be reviewed
  like any other code.

## Tests

`.claude/hooks/src/__tests__/destructive-command-guard.test.ts` covers every "ask" and "allow"
row above for both tools, plus the unattended "deny". `permission-auto-allow.test.ts` covers the
hand-off. Run: `cd .claude/hooks && npx vitest run src/__tests__/destructive-command-guard.test.ts src/__tests__/permission-auto-allow.test.ts`.
