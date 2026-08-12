# Git & Deletion Safety Rules

**NEVER run destructive commands without explicit user confirmation.**

## Now ENFORCED by a hook (not just advisory)

The `destructive-command-guard` PreToolUse:Bash hook (`.claude/hooks/src/destructive-command-guard.ts`) enforces this rule mechanically:
- **Interactive** (permission_mode default/acceptEdits/plan) → destructive commands return `permissionDecision: 'ask'` so the human is prompted.
- **Unattended** (bypassPermissions, a subagent `CLAUDE_AGENT_ID`, or CI) → destructive commands `deny` (fail-closed; an interactive prompt would hang a headless/autonomous run).
- Scope = UNQUOTED shell ops, curated HIGH blast radius + LOW false-positive: recursive `rm` (incl. `sudo rm -rf`), `git reset --hard`/force-push/`clean -f`/`checkout --`/`branch -D`/`rebase`/`reflog expire`/`gc --prune`/`filter-branch`, `find -delete`/`-exec rm`, `dd`/`mkfs`/`shred`/`truncate -s 0`, write-to-block-device, `docker prune`/`volume rm`/force-rm. Compound `X && rm -rf Y` is caught; single-file `rm -f file` is NOT gated.
- It scans the command AFTER stripping quoted strings, so destructive keywords inside a commit message / echo / diagnostic do NOT false-trigger. Consequence: DB `DROP`/`TRUNCATE` and PowerShell `Remove-Item` (whose payload is inherently quoted, e.g. `psql -c "DROP TABLE"`) are deliberately NOT gated here — they stay covered by the `neonctl *delete*` deny rule, the per-tool safety rules (neonctl/kusto/databases), and the confirm-first convention. Known gap: a destructive op wrapped in `bash -c "rm -rf /"` is not seen.
- Fail-OPEN on any error (a guard bug never bricks Bash). **Override** for a known-good run: prefix `SKIP_DESTRUCTIVE_GUARD=1 <command>` (detected in the command string — a PreToolUse hook does not inherit the command's inline env).

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
