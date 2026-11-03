#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../../../../../.." && pwd)
empty_home=$(mktemp -d)
empty_proj=$(mktemp -d)
export HOME="$empty_home"
export USERPROFILE="$empty_home"
export CLAUDE_PROJECT_DIR="$empty_proj"
cd "$root"
exec node .claude/hooks/dist/skill-activation-prompt.mjs <<'EOF'
{"prompt":"hello","session_id":"s15","cwd":"/tmp/trex-s15-proj"}
EOF
