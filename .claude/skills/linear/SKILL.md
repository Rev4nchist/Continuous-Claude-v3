---
name: linear
description: "Linear issue tracking: create, search, and manage issues, projects, cycles. Use when the user asks to create a Linear issue, check tickets, or search Linear."
---

# Linear Skill

Linear (`linear.app/minions-lab`) is our issue tracker. Two CLIs and one MCP server provide access.

**Workspace:** `minions-lab` (Name: "The Lab")

## Authentication

| Tool | Auth Method | Setup |
|------|------------|-------|
| linearis CLI | API token | `LINEAR_API_TOKEN` env var (set permanently) |
| linear CLI | OAuth | `linear auth` (browser login, stores credentials) |
| Linear MCP | OAuth | Remote HTTP at `https://mcp.linear.app/mcp` |

## Quick Start

```bash
# List your issues (scripted)
linearis issues list

# List your issues (interactive, paged)
linear issue list

# Search issues
linearis issues search "authentication" --team "The Lab"

# Create an issue
linearis issues create "Fix login redirect" --team "The Lab" --description "Redirect fails on OAuth callback" --priority 2

# View issue details
linearis issues read LIN-42

# Update issue status
linearis issues update LIN-42 --status "In Progress"
```

## CLI vs MCP Routing

| Task | Use | Why |
|------|-----|-----|
| Scripted/batch operations | linearis CLI | JSON output, API key auth, low token cost |
| Interactive git workflow | linear CLI | OAuth, branch integration, `issue start` |
| Conversational issue management | Linear MCP | Natural language, in-session context |
| Issue search from agents | linearis CLI | Structured JSON, filterable |
| Creating PRs linked to issues | linear CLI | `linear issue pr` auto-fills PR details |

## Decision Tree

| Task | Reference |
|------|-----------|
| Create, list, search, update, delete issues | `references/issues.md` |
| Projects, cycles, labels, milestones | `references/projects.md` |
| Status workflows and automations | `references/workflows.md` |
| Git branch linking and GitHub integration | `references/git-integration.md` |

## Branch Naming Convention

Use `dave/LIN-<number>-<slug>` for auto-linking with GitHub:

```bash
git checkout -b dave/LIN-42-fix-login-redirect
```

Linear auto-detects `LIN-<number>` in branch names and transitions the issue to In Progress.

## linearis CLI Global Patterns

All linearis commands output JSON by default. Common patterns:

```bash
linearis issues list --limit 50           # Increase result limit (default: 25)
linearis issues search "query" --team "The Lab" --status "In Progress"
linearis issues create "Title" --team "The Lab" --labels "bug,frontend"
```

## linear CLI Global Flags

```bash
linear -w minions-lab issue list          # Target workspace explicitly
linear issue list --team "The Lab"        # Filter by team
linear issue list --all-states            # Show all states (default: unstarted only)
linear issue list --no-pager              # Disable paging
```

## Anti-Patterns

- **Creating duplicate issues**: Search before creating. `linearis issues search "keyword"` first.
- **Changing status without context**: Always show current issue state before updating.
- **Forgetting the team flag**: linearis requires `--team "The Lab"` on create. linear uses your default team.
- **Not linking branches**: Always include `LIN-<number>` in branch names for auto-tracking.
- **Using linear CLI in scripts**: linear is interactive (pager, prompts). Use linearis for automation.

## When to Use

Trigger keywords: `linear`, `issue`, `ticket`, `backlog`, `sprint`, `cycle`, `LIN-`, `issue tracking`

## Safety

<!-- moved from rules-src/linear-safety.md on 2026-09-23 (Opus 5.5 eval, P20); the rule keeps a 5-line summary -->
## Safe Commands (no confirmation needed)

- `linearis issues list` (all variants)
- `linearis issues read <id>`
- `linearis issues search` (all variants)
- `linearis projects list`
- `linearis cycles list`, `linearis cycles read`
- `linearis teams list`
- `linearis labels list`
- `linearis comments list`
- `linearis documents list`
- `linear issue list`, `linear issue view`, `linear issue id`, `linear issue url`, `linear issue title`
- `linear team list`, `linear project list`, `linear cycle list`
- Any read-only MCP tool (search_issues, get_teams, get_my_issues)

## Dangerous Commands (ALWAYS confirm first)

Before running ANY of these, explain what it does and wait for explicit user approval:

- `linearis issues create` (creates a new issue in the tracker)
- `linearis issues update` (modifies issue fields or status)
- `linearis comments create` (adds a comment)
- `linear issue create` (creates a new issue)
- `linear issue update` (modifies issue fields)
- `linear issue delete` (permanently deletes an issue -- no undo)
- `linear issue start` (transitions issue and creates branch)
- MCP `create_issue` or `update_issue` calls

## Before Modifying Issues

1. Confirm the target issue ID with the user
2. Show current issue state before changes: `linearis issues read <id>`
3. For status transitions: verify the target state is valid for the workflow
4. For deletion: warn that this is permanent and cannot be undone

## Before Creating Issues

1. Search for duplicates first: `linearis issues search "<keywords>" --team "The Lab"`
2. Confirm title, priority, and team with the user
3. Show what will be created before running the command
