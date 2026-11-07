# Plan: Git Worktrees Setup Guide

## Problem

You want to work on multiple feature branches simultaneously in different Claude Code terminal sessions, but Git shares branch state across all terminals in the same repository directory.

## Solution: Git Worktrees

Git worktrees let you check out multiple branches simultaneously in separate directories, all sharing the same `.git` database.

---

## How Git Worktrees Work

```
BEFORE (single working directory):
~/continuous-claude/          ← One branch at a time
    .git/                     ← Shared by all terminals
    src/
    ...

AFTER (multiple worktrees):
~/continuous-claude/          ← main branch (primary worktree)
    .git/                     ← Shared database
    src/

~/continuous-claude-feature-a/ ← feature-a branch (linked worktree)
    .git → ../continuous-claude/.git  ← Points to main repo
    src/

~/continuous-claude-feature-b/ ← feature-b branch (linked worktree)
    .git → ../continuous-claude/.git  ← Points to main repo
    src/
```

**Key benefit:** Each worktree has its own HEAD, so switching branches in one terminal doesn't affect others.

---

## Commands Reference

### Create a Worktree

```bash
# From your main repo directory
cd ~/continuous-claude

# Create worktree for existing branch
git worktree add ../continuous-claude-feature-a feature-a

# Create worktree AND new branch (from current HEAD)
git worktree add -b feature-b ../continuous-claude-feature-b

# Create worktree from specific base branch
git worktree add -b feature-c ../continuous-claude-feature-c main
```

### List Worktrees

```bash
git worktree list
# Output:
# /home/user/continuous-claude           abc1234 [main]
# /home/user/continuous-claude-feature-a def5678 [feature-a]
```

### Remove a Worktree

```bash
# When done with a branch (after merging)
git worktree remove ../continuous-claude-feature-a

# Force remove (if has uncommitted changes)
git worktree remove --force ../continuous-claude-feature-a

# Or just delete the directory and prune
rm -rf ../continuous-claude-feature-a
git worktree prune
```

### Move a Worktree

```bash
git worktree move ../continuous-claude-feature-a ../new-location
```

---

## Recommended Workflow for Your Setup

### Step 1: Keep Main Repo Clean

Your primary repo (`~/continuous-claude/`) stays on `main`:

```bash
cd ~/continuous-claude
git checkout main
```

### Step 2: Create Worktrees for Features

For each feature branch, create a sibling directory:

```bash
# Feature branch 1
git worktree add ../cc-status-system status-system

# Feature branch 2
git worktree add -b hook-improvements ../cc-hook-improvements
```

### Step 3: Open Separate Claude Code Sessions

- **Terminal 1:** `cd ~/continuous-claude` → work on main
- **Terminal 2:** `cd ~/cc-status-system` → work on status-system branch
- **Terminal 3:** `cd ~/cc-hook-improvements` → work on hook-improvements branch

Each session is isolated - branch changes don't affect others.

### Step 4: Merge and Cleanup

```bash
# From main repo
cd ~/continuous-claude
git checkout main
git merge status-system

# Remove worktree
git worktree remove ../cc-status-system

# Delete branch if fully merged
git branch -d status-system
```

---

## Important Rules

| Rule | Reason |
|------|--------|
| Cannot checkout same branch in two worktrees | Git prevents this to avoid conflicts |
| Worktrees share reflog, stash, and config | They're linked to the same `.git` |
| Each worktree has own index and working directory | Changes are isolated |
| Run `git worktree prune` periodically | Cleans up stale worktree references |

---

## Packages in a worktree (shared store link)

A worktree has no `node_modules`. Only the primary checkout has an install, in `<primary>/.claude/hooks/node_modules`.

- A worktree under `<primary>/.claude/worktrees/<name>` gets its packages through one link: `<primary>/.claude/worktrees/node_modules`. Node finds it by walking up the parent folders.
- Check the link from any worktree: `node scripts/worktree/shared-deps.mjs --check`. It prints one `STORE <state>` line.
- Make or remove the link only in the primary, with Dave's yes: `--apply` or `--unlink`. The script refuses to run in a worktree.
- A worktree outside the primary gets only the resolver (`scripts/lib/resolve-deps.mjs`) for `pg` and similar packages. For vitest and the hooks build, link by hand. See the Testing section in `.claude/skills/hooks/SKILL.md`. `land-pr` unlinks that hand junction.
- Never make a link inside a worktree. Never delete a link recursively: `git worktree remove --force` follows a junction and empties the primary install.

---

## Windows-Specific Notes

On Windows, use forward slashes or escape backslashes:

```bash
# From C:\Users\david.hayes\continuous-claude
git worktree add ../cc-feature-a feature-a
# Creates: C:\Users\david.hayes\cc-feature-a
```

Or with full paths:

```bash
git worktree add "C:/Users/david.hayes/cc-feature-a" feature-a
```

---

## Quick Start for Your Current Situation

```bash
# 1. Go to your main repo
cd C:/Users/david.hayes/continuous-claude

# 2. Ensure you're on main
git checkout main

# 3. Create a worktree for the status-system feature
git worktree add ../cc-status-system status-system

# 4. Open a NEW Claude Code terminal in that directory
# cd C:/Users/david.hayes/cc-status-system
# Now you can work on status-system independently

# 5. List your worktrees anytime
git worktree list
```

---

## Verification

After setup, verify:

```bash
# In main repo
cd ~/continuous-claude
git branch --show-current  # → main

# In worktree
cd ~/cc-status-system
git branch --show-current  # → status-system

# Both show different branches simultaneously!
```

---

## Cleanup Checklist

When done with a feature:

1. [ ] Merge the branch: `git merge feature-branch`
2. [ ] Remove worktree: `git worktree remove ../worktree-dir`
3. [ ] Delete branch: `git branch -d feature-branch`
4. [ ] Prune stale refs: `git worktree prune`

---

*This plan provides guidance for using Git Worktrees to work on multiple branches simultaneously in separate Claude Code sessions.*
