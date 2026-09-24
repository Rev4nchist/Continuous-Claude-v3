#!/usr/bin/env bash
# codex-rollout-audit.sh
# Verify the codex-adversary integration is GLOBAL and free of project-level shadows.
#
# Exit codes:
#   0  - clean (no shadows, no kill-switches)
#   1  - dirty (at least one shadow or kill-switch flag found)
#   2  - tool error (jq / node / find missing)
#
# Scans (under all known project roots, maxdepth 6):
#   - .claude/agents/<file>.md         -> parses YAML `name:` field; flags any
#                                         duplicate of `codex-adversary` outside
#                                         the canonical user-level location
#   - .claude/skills/{review,premortem}/SKILL.md   -> flags any project-level copy
#   - .claude/rules/codex-adversarial.md           -> flags any project-level copy
#   - .claude/hooks/dist/plan-exit-premortem-prompt.mjs -> flags any project-level copy
#   - .claude/settings.json (and .local) -> reads disableAllHooks /
#                                           allowManagedHooksOnly / skillOverrides

# Use -u/pipefail but NOT -e: scan loops legitimately produce non-zero exits
# (find permissions, empty awk matches, etc) — we track failures via DIRTY counter
set -uo pipefail

ROOTS=(
  "$HOME/Projects"
  "$HOME/continuous-claude"
)

# Canonical (user-level) paths - these are EXPECTED to exist, not shadows
CANONICAL_AGENT="$HOME/.claude/agents/codex-adversary.md"
CANONICAL_RULE="$HOME/.claude/rules-ondemand/codex-adversarial.md"
CANONICAL_REVIEW="$HOME/.claude/skills/review/SKILL.md"
CANONICAL_PREMORTEM="$HOME/.claude/skills/premortem/SKILL.md"
CANONICAL_HOOK="$HOME/.claude/hooks/dist/plan-exit-premortem-prompt.mjs"

# Source-of-truth paths in the continuous-claude repo - also expected, not shadows
SOURCE_AGENT="$HOME/continuous-claude/.claude/agents/codex-adversary.md"
SOURCE_RULE="$HOME/continuous-claude/.claude/rules-ondemand/codex-adversarial.md"
SOURCE_REVIEW="$HOME/continuous-claude/.claude/skills/review/SKILL.md"
SOURCE_PREMORTEM="$HOME/continuous-claude/.claude/skills/premortem/SKILL.md"
SOURCE_HOOK="$HOME/continuous-claude/.claude/hooks/dist/plan-exit-premortem-prompt.mjs"

DIRTY=0

is_canonical() {
  local p="$1"
  case "$p" in
    "$CANONICAL_AGENT"|"$CANONICAL_RULE"|"$CANONICAL_REVIEW"|"$CANONICAL_PREMORTEM"|"$CANONICAL_HOOK") return 0 ;;
    "$SOURCE_AGENT"|"$SOURCE_RULE"|"$SOURCE_REVIEW"|"$SOURCE_PREMORTEM"|"$SOURCE_HOOK") return 0 ;;
  esac
  return 1
}

echo "=== Codex rollout audit (2026-05-18 spec, maxdepth 6) ==="
echo "Scan roots: ${ROOTS[*]}"
echo

echo "--- Path-based shadow scan ---"
for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if is_canonical "$f"; then continue; fi
    echo "  SHADOW (by path): $f"
    DIRTY=1
  done < <(find "$root" -maxdepth 6 \
      \( -type d \( -name node_modules -o -name .git -o -name .next -o -name dist -o -name build -o -name venv -o -name __pycache__ \) -prune \) -o \
      \( -type f \( \
        -path "*/.claude/agents/codex-adversary.md" \
        -o -path "*/.claude/skills/review/SKILL.md" \
        -o -path "*/.claude/skills/premortem/SKILL.md" \
        -o -path "*/.claude/rules/codex-adversarial.md" \
        -o -path "*/.claude/hooks/dist/plan-exit-premortem-prompt.mjs" \
      \) -print \) 2>/dev/null)
done
echo "  (any line above = a project-level copy that may shadow / lag the user-level canonical)"
echo

echo "--- Name-based agent shadow scan (YAML frontmatter name:) ---"
for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r agent_file; do
    [ -z "$agent_file" ] && continue
    if is_canonical "$agent_file"; then continue; fi
    name="$(awk '/^name:[[:space:]]*/{sub(/^name:[[:space:]]*/, ""); gsub(/[[:space:]]/, ""); print; exit}' "$agent_file" 2>/dev/null || true)"
    if [ "$name" = "codex-adversary" ]; then
      echo "  SHADOW (by name): $agent_file (name: codex-adversary)"
      DIRTY=1
    fi
  done < <(find "$root" -maxdepth 6 \
      \( -type d \( -name node_modules -o -name .git -o -name .next -o -name dist -o -name build -o -name venv -o -name __pycache__ \) -prune \) -o \
      \( -type f -path "*/.claude/agents/*.md" -print \) 2>/dev/null)
done
echo "  (any line above = a project file with frontmatter name: codex-adversary that shadows the user-level agent)"
echo

echo "--- Settings kill-switch scan (disableAllHooks / allowManagedHooksOnly / skillOverrides) ---"
SETTINGS_FILES=(
  "$HOME/.claude/settings.json"
  "$HOME/.claude/settings.local.json"
)
for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r sf; do
    [ -z "$sf" ] && continue
    SETTINGS_FILES+=("$sf")
  done < <(find "$root" -maxdepth 6 \
      \( -type d \( -name node_modules -o -name .git -o -name .next -o -name dist -o -name build -o -name venv -o -name __pycache__ \) -prune \) -o \
      \( -type f -path "*/.claude/settings*.json" -print \) 2>/dev/null)
done

for sf in "${SETTINGS_FILES[@]}"; do
  [ -f "$sf" ] || continue
  result="$(node -e "
    try {
      const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const flags = {
        disableAllHooks: s.disableAllHooks,
        allowManagedHooksOnly: s.allowManagedHooksOnly,
        skillOverrides: s.skillOverrides
      };
      const hits = [];
      if (flags.disableAllHooks === true) hits.push('disableAllHooks=true');
      if (flags.allowManagedHooksOnly === true) hits.push('allowManagedHooksOnly=true');
      if (flags.skillOverrides) {
        const so = flags.skillOverrides;
        if (so.review !== undefined) hits.push('skillOverrides.review');
        if (so.premortem !== undefined) hits.push('skillOverrides.premortem');
      }
      console.log(hits.length ? 'HITS:' + hits.join(',') : 'CLEAN');
    } catch (e) {
      console.log('PARSE_ERROR:' + e.message);
    }
  " "$sf" 2>/dev/null || echo "PARSE_ERROR")"

  case "$result" in
    HITS:*)
      echo "  KILL-SWITCH: $sf -> ${result#HITS:}"
      DIRTY=1
      ;;
    PARSE_ERROR*)
      echo "  PARSE_ERROR: $sf (${result#PARSE_ERROR:})"
      ;;
    CLEAN)
      : # silent on clean
      ;;
  esac
done
echo "  (any KILL-SWITCH line above = a settings flag that would silently disable codex integration in that scope)"
echo

echo "--- Canonical file presence + hashes ---"
for f in "$CANONICAL_AGENT" "$CANONICAL_RULE" "$CANONICAL_REVIEW" "$CANONICAL_PREMORTEM" "$CANONICAL_HOOK"; do
  if [ -f "$f" ]; then
    h="$(sha256sum "$f" | cut -c1-16)"
    echo "  OK    ${h}  $f"
  else
    echo "  MISSING       $f"
    DIRTY=1
  fi
done
echo

if [ "$DIRTY" -eq 0 ]; then
  echo "RESULT: CLEAN"
  exit 0
else
  echo "RESULT: DIRTY (see findings above)"
  exit 1
fi
