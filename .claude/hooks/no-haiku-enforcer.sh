#!/bin/bash
# No Haiku Enforcer Hook
# Blocks Task tool calls with model: haiku
# Rule: ~/.claude/CLAUDE.md ("Agents and delegation")
set -euo pipefail

read -r input
tool_name=$(echo "$input" | jq -r '.tool_name // empty')
model=$(echo "$input" | jq -r '.tool_input.model // empty')

if [[ "$tool_name" == "Task" && "$model" == "haiku" ]]; then
  cat << 'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "BLOCKED: model='haiku' not allowed.\n\nPer ~/.claude/CLAUDE.md ("Agents and delegation"):\n- Haiku is unreliable for agent tasks\n- REMOVE the model parameter (inherits Opus from parent)\n- Or use model='sonnet' if you need a specific model"
  }
}
EOF
else
  echo '{}'
fi
