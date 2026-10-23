---
name: sync-drift
description: Compare repo vs active ~/.claude and list drift. Use when the user says "sync drift", "check sync", "what's out of sync", "drift check".
allowed-tools: [Bash, Read]
metadata:
  keywords: [sync drift, check sync, drift check, out of sync, sync status, repo drift, active drift]
---

# Sync Drift Detector

Detects what is out of sync between the continuous-claude repo and the active `~/.claude/` directory. Answers "what's out of sync?" in one command.

**Triggers:** "sync drift", "what's out of sync", "check sync", "drift check"

**References:**
- Known local-only files and exclusion rationale: `references/drift-categories.md`

## Paths

On this Windows system:

| Label | Path |
|-------|------|
| Repo | `~/continuous-claude/.claude/` |
| Active | `~/.claude/` |

Set these variables before running commands:

```bash
REPO="$HOME/continuous-claude/.claude"
ACTIVE="~/.claude"
```

## Procedure

### Step 1: Compare Synced Directories

Compare each directory that the forward sync covers. For each, run a recursive diff to find differences.

#### 1a. hooks/src/ (source files) — NOT a drift check

`hooks/src` is intentionally **NOT** forward-synced (`sync-to-active.sh` excludes it — `dist/*.mjs` is what runs, and copying src stomps mtimes / breaks build-freshness). So `$ACTIVE/hooks/src` is expected to be stale/absent and a repo-vs-active diff produces meaningless noise. **Do not diff hooks/src across repo↔active.** The only correctness check for hooks is build-freshness (1b), run entirely inside the repo.

#### 1b. hooks/dist/ (built output)

The dist directory IS synced by `sync-to-active.sh` -- the repo's pre-built `hooks/dist/*.mjs` are copied to active. The meaningful check is whether the **repo's** committed dist is built from the **repo's** committed src (compare REPO src → REPO dist, never the stale active src). Skip non-entrypoint modules (`shared/`, `patterns/`, `lib/`, `__tests__/`) — they are imported by entry hooks, not compiled to standalone dist.

```bash
# Check if any repo src file is newer than its repo dist counterpart
STALE=0
for src_file in $(find "$REPO/hooks/src" -maxdepth 1 -name "*.ts" -type f 2>/dev/null); do
  base=$(basename "$src_file" .ts)
  dist_file="$REPO/hooks/dist/${base}.mjs"
  if [[ -f "$dist_file" ]]; then
    if [[ "$src_file" -nt "$dist_file" ]]; then
      echo "STALE BUILD: $base.mjs (src newer than dist)"
      STALE=$((STALE + 1))
    fi
  else
    echo "MISSING DIST: $base.mjs (no built output for $base.ts)"
    STALE=$((STALE + 1))
  fi
done
[[ $STALE -eq 0 ]] && echo "hooks/dist: builds are current"
```

#### 1c. rules/

```bash
diff -rq "$REPO/rules/" "$ACTIVE/rules/" 2>/dev/null || echo "rules: in sync"
```

#### 1d. skills/ (SKILL.md and references/ only)

```bash
# Compare SKILL.md files across all skills
for skill_dir in "$REPO/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  # Skip internal directories
  [[ "$skill_name" == _* ]] && continue

  repo_skill="$skill_dir/SKILL.md"
  active_skill="$ACTIVE/skills/$skill_name/SKILL.md"

  if [[ -f "$repo_skill" ]]; then
    if [[ ! -f "$active_skill" ]]; then
      echo "MISSING IN ACTIVE: skills/$skill_name/SKILL.md"
    else
      diff -q "$repo_skill" "$active_skill" 2>/dev/null || echo "DIFFERS: skills/$skill_name/SKILL.md"
    fi
  fi

  # Compare references/ if present
  if [[ -d "$skill_dir/references" ]]; then
    diff -rq "$skill_dir/references/" "$ACTIVE/skills/$skill_name/references/" 2>/dev/null || true
  fi
done
echo "skills: comparison complete"
```

#### 1e. agents/

```bash
diff -rq "$REPO/agents/" "$ACTIVE/agents/" 2>/dev/null || echo "agents: in sync"
```

### Step 2: Check Hook Root Files

The sync script also copies hook root files (build scripts, config). Check these individually.

```bash
for pattern in "hooks/build.sh" "hooks/build.ps1" "hooks/package.json" "hooks/tsconfig.json"; do
  repo_file="$REPO/$pattern"
  active_file="$ACTIVE/$pattern"
  if [[ -f "$repo_file" ]]; then
    if [[ ! -f "$active_file" ]]; then
      echo "MISSING IN ACTIVE: $pattern"
    else
      diff -q "$repo_file" "$active_file" 2>/dev/null || echo "DIFFERS: $pattern"
    fi
  fi
done
```

### Step 3: Filter Known Local-Only Files

The following files are expected to differ or only exist in the active directory. Do NOT report these as drift. See `references/drift-categories.md` for rationale.

**Known local-only (ignore):**
- `settings.json` -- machine-specific MCP server config, model prefs
- `settings.local.json` -- local overrides
- `CLAUDE.md` -- global user instructions (private, not in repo)
- `RULES.md` -- global rules (private, not in repo)
- `extraction-state.json` -- hook extraction state, per-machine
- `knowledge-tree.json` -- auto-generated per-project, not synced
- `.env` -- secrets, environment variables
- `.credentials.json` -- auth tokens
- `history.jsonl` -- session history

If diff output includes any of these files, exclude them from the drift report.

### Step 4: Present Results

Format the output as a table:

| File Path | Status | Fix Command |
|-----------|--------|-------------|
| `hooks/src/example.ts` | Content differs | `bash scripts/sync-to-active.sh` |
| `hooks/dist/example.mjs` | Stale build | `cd ~/.claude/hooks && npm run build` |
| `rules/new-rule.md` | Missing in active | `bash scripts/sync-to-active.sh` |
| `skills/new-skill/SKILL.md` | Missing in active | `bash scripts/sync-to-active.sh` |
| `agents/new-agent.md` | Content differs | `bash scripts/sync-to-active.sh` |

**Status values:**
- **Missing in active** -- file exists in repo but not in `~/.claude/`
- **Missing in repo** -- file exists in `~/.claude/` but not in repo (may be local creation)
- **Content differs** -- file exists in both but content doesn't match
- **Stale build** -- dist file is older than its source (needs rebuild)

**Fix commands:**
- For source/config drift: `bash ~/continuous-claude/scripts/sync-to-active.sh`
- For stale builds: `cd ~/.claude/hooks && npm run build`
- For missing in repo: `bash ~/continuous-claude/scripts/sync-claude.sh --to-repo`

### Step 5: Summary

After the table, provide a summary line:

```
Drift check complete: X files drifted, Y stale builds, Z known local-only (ignored)
```

If everything is in sync:

```
All synced directories are in sync. No drift detected.
```

## All-in-One Command

For a quick check, run all comparisons in sequence:

```bash
REPO="$HOME/continuous-claude/.claude"
ACTIVE="~/.claude"

# Known local-only files (do not report as drift)
LOCAL_ONLY="settings.json|settings.local.json|CLAUDE.md|RULES.md|extraction-state.json|knowledge-tree.json|\.env|\.credentials.json|history.jsonl"

echo "=== Sync Drift Report ==="
echo ""

echo "--- hooks/src/ (repo-only; NOT synced — no drift check) ---"
echo "  skipped: hooks/src is intentionally repo-only; build-freshness below is the real check"

echo ""
echo "--- hooks/dist/ (build freshness: REPO src -> REPO dist) ---"
STALE=0
# -maxdepth 1 skips non-entrypoint modules (shared/ patterns/ lib/ __tests__/) that
# are imported by entry hooks, not compiled to standalone dist.
for src_file in $(find "$REPO/hooks/src" -maxdepth 1 -name "*.ts" -not -path "*/node_modules/*" -type f 2>/dev/null); do
  base=$(basename "$src_file" .ts)
  dist_file="$REPO/hooks/dist/${base}.mjs"
  if [[ -f "$dist_file" ]]; then
    if [[ "$src_file" -nt "$dist_file" ]]; then
      echo "  STALE: ${base}.mjs"
      STALE=$((STALE + 1))
    fi
  else
    echo "  MISSING: ${base}.mjs"
    STALE=$((STALE + 1))
  fi
done
[[ $STALE -eq 0 ]] && echo "  All builds current"

echo ""
echo "--- rules/ ---"
diff -rq "$REPO/rules/" "$ACTIVE/rules/" 2>/dev/null | grep -vE "$LOCAL_ONLY" || echo "  In sync"

echo ""
echo "--- skills/ ---"
SKILL_DRIFT=0
for skill_dir in "$REPO/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  [[ "$skill_name" == _* ]] && continue
  if [[ -f "$skill_dir/SKILL.md" ]]; then
    if [[ ! -f "$ACTIVE/skills/$skill_name/SKILL.md" ]]; then
      echo "  MISSING: skills/$skill_name/SKILL.md"
      SKILL_DRIFT=$((SKILL_DRIFT + 1))
    elif ! diff -q "$skill_dir/SKILL.md" "$ACTIVE/skills/$skill_name/SKILL.md" > /dev/null 2>&1; then
      echo "  DIFFERS: skills/$skill_name/SKILL.md"
      SKILL_DRIFT=$((SKILL_DRIFT + 1))
    fi
  fi
done
[[ $SKILL_DRIFT -eq 0 ]] && echo "  In sync"

echo ""
echo "--- agents/ ---"
diff -rq "$REPO/agents/" "$ACTIVE/agents/" 2>/dev/null | grep -vE "$LOCAL_ONLY" || echo "  In sync"

echo ""
echo "=== End Drift Report ==="
```

## When to Run

- After `git pull` in continuous-claude (before syncing)
- When hooks behave unexpectedly (may be running old code)
- At session start if something feels off
- Before starting hook development (verify clean state)

## Related

| Resource | Purpose |
|----------|---------|
| `scripts/sync-to-active.sh` | Forward sync: repo to active |
| `scripts/sync-claude.sh --to-repo` | Reverse sync: active to repo |
| `.claude/rules/git-sync-workflow.md` | Full sync workflow documentation |
| `.claude/rules/every-surface-checklist.md` | Two-copy surfaces and what syncs |
