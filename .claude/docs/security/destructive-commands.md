# Git & Deletion Safety Rules

**NEVER run destructive commands without explicit user confirmation.**

## Now ENFORCED by a hook (not just advisory)

The `destructive-command-guard` PreToolUse hook (Bash and PowerShell) (`.claude/hooks/src/destructive-command-guard.ts`) enforces this rule mechanically:
- **Interactive** (permission_mode default/acceptEdits/plan) → destructive commands return `permissionDecision: 'ask'` so the human is prompted.
- **Unattended** (bypassPermissions, a subagent `CLAUDE_AGENT_ID`, or CI) → destructive commands `deny` (fail-closed; an interactive prompt would hang a headless/autonomous run).
- Scope = UNQUOTED shell ops, curated HIGH blast radius + LOW false-positive: recursive `rm` (incl. `sudo rm -rf`), `git reset --hard`/force-push/`clean -f`/`checkout --`/`branch -D`/`rebase`/`reflog expire`/`gc --prune`/`filter-branch`, `find -delete`/`-exec rm`, `dd`/`mkfs`/`shred`/`truncate -s 0`, write-to-block-device, `docker prune`/`volume rm`/force-rm. Compound `X && rm -rf Y` is caught; single-file `rm -f file` is NOT gated.
- It scans the command AFTER stripping quoted strings, so destructive keywords inside a commit message / echo / diagnostic do NOT false-trigger. Consequence: DB `DROP`/`TRUNCATE`, and `Remove-Item` reached through the Bash tool (whose payload is inherently quoted, e.g. `psql -c "DROP TABLE"`), are deliberately NOT gated here — they stay covered by the `neonctl *delete*` deny rule, the per-tool safety rules (neonctl/kusto/databases), and the confirm-first convention. A destructive op wrapped in `bash -c "..."` or a command substitution IS seen: the classifier recurses into those payloads.
- Fail-OPEN on any error (a guard bug never bricks Bash). **Override** for a known-good run: prefix `SKIP_DESTRUCTIVE_GUARD=1 <command>` (detected in the command string — a PreToolUse hook does not inherit the command's inline env).
- **PowerShell tool too (2026-09-23).** The guard is also registered on the `PowerShell` matcher. There it also catches `Remove-Item -Recurse` (and aliases) and `[IO.Directory]::Delete(x, $true)`. On both tools it catches `git stash -u` / `--include-untracked` / `--all` (a stash that sweeps untracked files emptied a FourthBot demo folder on 2026-09-17), and git's global options no longer hide the subcommand: `git -C <repo> reset --hard` is gated like `git reset --hard`. PowerShell override: start the command with `$env:SKIP_DESTRUCTIVE_GUARD='1';`. `permission-auto-allow` leaves destructive PowerShell to the human and auto-allows the rest. The per-surface picture is in `docs/security/authorization-matrix.md`.

- **Fabric (2026-10-02).** Two "never" items from `fabric-playbook.md` are hard guards on both tools. (1) Capacity suspend, resume, resize or delete: `az fabric capacity suspend|resume|update|delete`; the Az.Fabric cmdlets `Suspend|Resume|Update|Remove-AzFabricCapacity`; `az resource delete|update|create|invoke-action` on `Microsoft.Fabric/capacities`; Fabric CLI `fab stop|start|set|rm|create` on a `.capacities/<name>.Capacity` path; REST `.../capacities/<name>/suspend|resume`; and PATCH, PUT or DELETE on `.../capacities/<name>` (with or without a host, trailing slash allowed). The REST forms go through `az rest`, `curl`, `Invoke-RestMethod`, `Invoke-WebRequest`, `Invoke-AzRestMethod`, `irm`, `iwr` or `fab api`; PowerShell method spellings `-Method:Put`, `-CustomMethod` and `-Meth` count. (2) Bulk `PUT .../dataAccessRoles`, which replaces ALL OneLake roles, `DefaultReader` too. A REST URL sits inside quotes, so these patterns (`SEGMENT_PATTERNS` in `shared/destructive-classifier.ts`) test each command segment with quotes kept. The segment must START with the command, after lead-ins (`VAR=x`, `$x =`, `[void](`, `(`, `{`, `try {`, `if (...) {`, `ForEach-Object {`) and after a line break: an `echo`, a commit message or a `grep` that only names the URL is allowed. The body of `cat|tee ... <<'EOF'` (quoted delimiter) and of a PowerShell `$x = @'` here-string is literal text and is skipped. An unquoted `<<EOF` body and a `$x = @"` body are skipped too, except for their `$(...)` and (Bash) backtick substitutions, which the shell runs and the guard checks. `bash <<EOF` and `cat <<EOF | bash` still run their whole body. In PowerShell a backtick before a letter or digit is an escape that keeps the letter (`` del`ete `` is checked as `delete`). Read-only calls are allowed: `az fabric capacity show|list`, `Get-AzFabricCapacity`, GET on a capacity or on `dataAccessRoles`, `fab get|ls` on a capacity, and a PUT to one named role (`.../dataAccessRoles/<name>`). A backtick or backslash line continuation is joined first. Accepted gaps: a URL built in a variable, a Python or Node HTTP client, `curl -T`, `Invoke-Expression` on a here-string, `New-AzFabricCapacity` (creating costs money but removes nothing; `fab create` of a capacity IS gated), and `az -o json fabric capacity ...` (a global flag before the group).

The lists below remain the authoritative human rule; the hook is the backstop that makes it actually fire.

## Deletion Commands (ALWAYS ASK FIRST)

Before running ANY of these, ask the user:
- `rm` / `rm -rf` (delete files/directories)
- `rmdir` (remove directories)
- `unlink` (remove files)
- `trash` (move to trash)

### Example

WRONG:
```
"Let me clean that up"
rm -rf /tmp/old-cache/
```

RIGHT:
```
"I can delete /tmp/old-cache/. Should I run `rm -rf /tmp/old-cache/`?"
[wait for explicit "yes"]
```

### Archive vs Delete

When user says "archive X":
- MOVE to archive folder (e.g., `mv X opc/archive/`)
- Do NOT delete

---

## Git Commands (ALWAYS ASK FIRST)

## Commands that require confirmation:
- `git checkout` (can overwrite uncommitted changes)
- `git reset` (can lose commits)
- `git clean` (deletes untracked files)
- `git stash` (hides changes)
- `git rebase` (rewrites history)
- `git merge` (modifies branches)
- `git push` (affects remote)
- `git commit` (creates commits)

## Safe commands (no confirmation needed):
- `git status`
- `git log`
- `git diff`
- `git branch` (list only)
- `git show`
- `git blame`

## Before any state-modifying git command:

1. Explain what the command will do
2. Ask: "Should I run this?"
3. Wait for explicit "yes" or approval

## Example

WRONG:
```
"Let me restore that file"
git checkout HEAD -- file.ts
```

RIGHT:
```
"I can restore file.ts from git. This will overwrite any uncommitted changes. Run `git checkout HEAD -- file.ts`?"
[wait for user confirmation]
```
