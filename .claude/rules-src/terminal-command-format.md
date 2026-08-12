# Terminal Command Format

When giving Dave terminal commands to copy-paste, default to formats that survive markdown rendering and copy-paste reliably. Dave is not a terminal expert; the goal is "paste, press Enter, see the success line" with no edits needed.

## Why this rule exists

On 2026-05-28, a single-line `az containerapp registry set --name ca-mcp-salesforce --resource-group rg-agent-architecture --server agentarchacr.azurecr.io --identity system` failed because the rendered markdown injected a newline at `--server `, splitting the paste into two halves. PowerShell ran the first half (errored on missing `--server` value), then tried to execute `agentarchacr.azurecr.io` as a command. The recovery was the same command re-formatted as a PowerShell backtick line-continuation block — that parsed correctly even when pasted across visual lines, because PowerShell ate the continuations.

## Default format

For any command longer than ~80 characters: **PowerShell backtick (`` ` ``) line continuation, one flag per line.**

```
az containerapp registry set `
  -n ca-mcp-salesforce `
  -g rg-agent-architecture `
  --server agentarchacr.azurecr.io `
  --identity system
```

Tell Dave to paste the whole block in one selection.

For genuinely short commands (single line, comfortably under ~80 chars), a one-liner is fine.

For bash / git-bash, use backslash (`\`) continuation only when the shell is explicitly bash. **Default is PowerShell** on this machine.

## Required elements

1. **One command per fenced code block.** Never combine multiple commands in the same block.
2. **Use short flags** (`-n`, `-g`, `-o`) where available to compress.
3. **Always include a "You should see"** sentence after the command describing the success indicator — a JSON property, an `[OK]` line, an HTTP status, an exit phrase. So Dave can recognize success without parsing raw output.
4. **Note idempotency** when relevant — e.g., "safe to re-run; `already exists` errors are fine."
5. **Pair destructive or large-blast-radius commands with a read-side verification** the user can run first if uncertain.

## Anti-patterns

- Heredocs or interactive prompts requiring keyboard input.
- Multiple commands chained with `;` or `&&` in a single block (give each its own block).
- Single-line commands over ~80 chars without backtick continuation (markdown will wrap them at paste time).
- Bash-only constructs (`$(...)`, backtick subshells, `[[...]]`) when running in PowerShell.
- Telling Dave to "edit the command to fit your environment" — give him the working form for the shell he's in.
