---
allowed-tools: Bash(npx:*)
description: Launch mobile-first chats web interface (user)
argument-hint: [--tunnel]
---

# /chats - Claude Code Chats Viewer

Launch the mobile-first web interface for viewing and managing Claude Code conversations.

## Task

Run the chats interface:

```bash
npx claude-code-templates@latest --chats $ARGUMENTS
```

## What This Does

Launches a web server at http://localhost:9876 that provides:
- Real-time conversation viewer
- Mobile-optimized interface
- Conversation history browser
- Session management

## Options

- `/chats` - Launch locally at localhost:9876
- `/chats --tunnel` - Enable Cloudflare tunnel for remote access

Execute the npx command above to launch the interface.
