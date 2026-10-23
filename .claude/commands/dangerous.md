# Dangerous Mode Launcher

Launch a new Claude Code session in dangerously-skip-permissions mode for rapid development.

## What this does:
- Opens a new terminal/command prompt
- Launches Claude Code with `--dangerously-skip-permissions` flag
- Bypasses all permission prompts for file operations and commands
- Shows warning about dangerous mode activation

## Usage:
This command will:
1. Display a warning about dangerous mode
2. Open a new command prompt window
3. Launch Claude Code in the current directory with skip permissions
4. All subsequent operations will execute without confirmation

## Safety Notice:
⚠️ **DANGEROUS MODE ACTIVE** ⚠️
- File operations execute immediately without confirmation
- Commands run without permission prompts
- Use only in safe, isolated environments
- Never use on production systems or with sensitive data

## Implementation:
```bash
# Set git bash path for Claude Code
set CLAUDE_CODE_GIT_BASH_PATH=~\AppData\Local\Programs\Git\bin\bash.exe

# Show warning
echo.
echo 🚨 WARNING: Launching Claude Code in DANGEROUS SKIP PERMISSIONS mode
echo 📁 Directory: %CD%
echo ⚡ All operations will execute WITHOUT permission prompts
echo.

# Launch Claude Code with dangerous flag
claude --dangerously-skip-permissions
```

Execute this by running the commands above in sequence.