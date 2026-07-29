# Spawn Dangerous Claude Session

Opens a new terminal window and launches Claude Code in dangerously-skip-permissions mode.

## What this does:
- Opens a new Command Prompt window
- Sets required environment variables
- Launches Claude Code with dangerous skip permissions
- Keeps the current Claude session running

## Safety Warning:
⚠️ **EXTREME CAUTION REQUIRED** ⚠️
- New session will bypass ALL permission prompts
- File operations execute immediately
- Commands run without confirmation
- Use only in isolated, safe environments

## Execute this command:

```bash
start cmd /k "set CLAUDE_CODE_GIT_BASH_PATH=C:\Users\david.hayes\AppData\Local\Programs\Git\bin\bash.exe && echo. && echo 🚨 DANGEROUS MODE ACTIVE - All operations execute without prompts && echo 📁 Working Directory: %CD% && echo. && claude --dangerously-skip-permissions"
```

This will:
1. Open a new command prompt window
2. Set the git bash path for Claude Code
3. Display warning messages
4. Launch Claude in dangerous mode
5. Keep the window open with `/k` flag