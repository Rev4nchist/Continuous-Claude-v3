#!/usr/bin/env bash
# Continuous Claude - Setup Verification
# Run after wizard to verify everything is working

PASS=0
FAIL=0
WARN=0

check() {
    local name="$1"
    local cmd="$2"
    if eval "$cmd" > /dev/null 2>&1; then
        echo "  [PASS] $name"
        ((PASS++))
    else
        echo "  [FAIL] $name"
        ((FAIL++))
    fi
}

warn_check() {
    local name="$1"
    local cmd="$2"
    if eval "$cmd" > /dev/null 2>&1; then
        echo "  [PASS] $name"
        ((PASS++))
    else
        echo "  [WARN] $name"
        ((WARN++))
    fi
}

echo "=== Continuous Claude Setup Verification ==="
echo ""

echo "1. Prerequisites"
check "Docker installed" "docker --version"
check "Node.js installed" "node --version"
check "Python installed" "python --version || python3 --version"
check "uv installed" "uv --version"
check "Git installed" "git --version"

echo ""
echo "2. Docker Services"
check "Docker daemon running" "docker info"
check "PostgreSQL container running" "docker ps | grep continuous-claude-postgres"

echo ""
echo "3. Claude Code Configuration"
check "~/.claude directory exists" "test -d $HOME/.claude"
check "settings.json exists" "test -f $HOME/.claude/settings.json"
check "settings.json has no foreign paths" "! grep -qi 'david.hayes' $HOME/.claude/settings.json 2>/dev/null || whoami | grep -qi 'david.hayes'"
check "CLAUDE.md exists" "test -f $HOME/.claude/CLAUDE.md"
check "RULES.md exists" "test -f $HOME/.claude/RULES.md"
# The skill router only sees descriptions within these limits; without them skills silently drop out (P24).
check "settings.json sets skillListingMaxDescChars and skillListingBudgetFraction" "grep -q '\"skillListingMaxDescChars\"' $HOME/.claude/settings.json && grep -q '\"skillListingBudgetFraction\"' $HOME/.claude/settings.json"
# Third-party skills installed outside this repo (see BOOTSTRAP.md "Third-party skills").
check "archify skill installed (design-work.md routes diagrams to it)" "test -f $HOME/.claude/skills/archify/SKILL.md"
warn_check "browser-automation skill installed (CodeGPT seed)" "test -f $HOME/.claude/skills/browser-automation/SKILL.md"
warn_check "game-development skill installed (CodeGPT seed)" "test -f $HOME/.claude/skills/game-development/SKILL.md"

echo ""
echo "4. Hooks"
check "hooks/dist directory exists" "test -d $HOME/.claude/hooks/dist"
check "Hook bundles present (70+)" "test $(ls $HOME/.claude/hooks/dist/*.mjs 2>/dev/null | wc -l) -ge 70"
check "node_modules installed" "test -d $HOME/.claude/hooks/node_modules"

echo ""
echo "5. Environment"
check "CLAUDE_OPC_DIR is set" "test -n \"\$CLAUDE_OPC_DIR\""
check "CLAUDE_OPC_DIR points to valid directory" "test -d \"\$CLAUDE_OPC_DIR\""
warn_check "PYTHONUTF8 is set (Windows)" "test -n '$PYTHONUTF8' || test $(uname -o 2>/dev/null) != 'Msys'"

echo ""
echo "6. Git Hooks"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
warn_check "Post-commit hook installed" "test -f '$REPO_ROOT/.git/hooks/post-commit'"

echo ""
echo "7. Python Dependencies"
warn_check "opc venv exists" "test -d '$CLAUDE_OPC_DIR/../.venv' || test -d '$CLAUDE_OPC_DIR/.venv'"


# DevOps CLIs (optional — warn but don't fail)
echo ""
echo "=== DevOps Integration ==="
if command -v linearis &>/dev/null; then
  echo "  [OK] linearis CLI found"
else
  echo "  [WARN] linearis not installed (npm install -g linearis)"
fi

if command -v sentry-cli &>/dev/null; then
  echo "  [OK] sentry-cli found"
else
  echo "  [WARN] sentry-cli not installed (npm install -g @sentry/cli)"
fi

if command -v playwright-cli &>/dev/null; then
  echo "  [OK] @playwright/cli found"
else
  echo "  [WARN] @playwright/cli not installed (npm install -g @playwright/cli@latest)"
fi

# DevOps env vars (optional — warn)
if [ -n "$LINEAR_API_TOKEN" ]; then
  echo "  [OK] LINEAR_API_TOKEN set"
else
  echo "  [WARN] LINEAR_API_TOKEN not set (Linear CLI won't authenticate)"
fi

if [ -n "$SENTRY_AUTH_TOKEN" ]; then
  echo "  [OK] SENTRY_AUTH_TOKEN set"
else
  echo "  [WARN] SENTRY_AUTH_TOKEN not set (Sentry CLI won't authenticate)"
fi

echo ""
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Warnings: $WARN"
echo ""

if [ $FAIL -eq 0 ]; then
    echo "Setup looks good!"
    exit 0
else
    echo "$FAIL check(s) failed. Review above and fix."
    exit 1
fi
