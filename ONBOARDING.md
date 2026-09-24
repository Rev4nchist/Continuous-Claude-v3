# Welcome to AI Enablement Team

## How We Use Claude

Based on usage over the last 30 days:

```
Work Type Breakdown:
  Build Feature    ████████████████████  40%
  Plan Design      ████████████░░░░░░░░  24%
  Debug Fix        ██████████░░░░░░░░░░  20%
  Improve Quality  ████████░░░░░░░░░░░░  16%

Top Skills & Commands:
  /rename  ████████████████████  9x/month
  /resume  ███████░░░░░░░░░░░░░  3x/month
  /ralph   ████░░░░░░░░░░░░░░░░  2x/month
  /mcp     ████░░░░░░░░░░░░░░░░  2x/month
  /plugin  ████░░░░░░░░░░░░░░░░  2x/month

Top MCP Servers:
  playwright            ████████████████████  62 calls
  claude_ai_Notion      █████████░░░░░░░░░░░  27 calls
  serena                ████░░░░░░░░░░░░░░░░  12 calls
  nia                   ██░░░░░░░░░░░░░░░░░░   5 calls
  claude_ai_Excalidraw  █░░░░░░░░░░░░░░░░░░░   3 calls
```

## Your Setup Checklist

### Codebases
- [ ] continuous-claude-v3 — https://github.com/parcadei/continuous-claude-v3 (the shared CCv3 toolkit — hooks, agents, skills, rules)

### MCP Servers to Activate
- [ ] playwright — browser automation for testing, scraping, and visual QA. Install with `claude mcp add playwright -- npx @playwright/mcp@latest`.
- [ ] claude_ai_Notion — Notion integration for the team's Bridge HQ and project docs. Activate via claude.ai → Settings → Connectors.
- [ ] serena — semantic code intelligence (LSP-backed go-to-definition, find-references). Install via `uvx --from git+https://github.com/oraios/serena serena-mcp-server`.
- [ ] nia — search across indexed library docs and source code. Requires `NIA_API_KEY` env var; install with `cmd /c uv tool run nia-mcp-server` on Windows.
- [ ] claude_ai_Excalidraw — collaborative diagramming for architecture sketches. Activate via claude.ai → Settings → Connectors.

### Skills to Know About
- /maestro — multi-step orchestrator that routes work to specialized agents (interview-gated)
- /plan — planning mode for moderate-to-complex tasks before any implementation
- /goal — track project goals and progress against ROADMAP.md
- /compact — manually compact context before it auto-truncates mid-task
- /resume — resume an active task from a previous session via handoff doc

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
