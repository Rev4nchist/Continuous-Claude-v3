# Enable Skip Permissions Mode

Switch the current Claude Code session to dangerously-skip-permissions mode.

## ⚠️ CRITICAL WARNING ⚠️
This will restart Claude Code in the current directory with ALL permission checks disabled:
- File operations execute immediately
- Commands run without confirmation  
- No safety prompts for destructive operations
- USE ONLY IN SAFE ENVIRONMENTS

## Execute this to restart in dangerous mode:

```bash
echo 🚨 RESTARTING CLAUDE IN DANGEROUS MODE...
set CLAUDE_CODE_GIT_BASH_PATH=~\AppData\Local\Programs\Git\bin\bash.exe
claude --dangerously-skip-permissions
```

## Alternative - Spawn New Window:
```bash
start cmd /k "set CLAUDE_CODE_GIT_BASH_PATH=~\AppData\Local\Programs\Git\bin\bash.exe && echo 🚨 DANGEROUS MODE ACTIVE && claude --dangerously-skip-permissions"
```

Choose the first option to replace current session, or second to open a new dangerous session window.