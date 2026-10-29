# Project CLAUDE.md Template

Use this template when generating a project-level CLAUDE.md. Replace all `{{PLACEHOLDER}}` values with project-specific information gathered during the interview phase. Delete sections that don't apply (e.g., Local Dev for a library with no server).

Also create `AGENTS.md` at the project root with a `## Testing` section: the end-to-end check (command + the artifact it saves), or "none yet" plus the smoke check to build first. Keep the `@AGENTS.md` line in CLAUDE.md: Claude Code reads AGENTS.md only through that import when a CLAUDE.md exists.

---

```markdown
# {{PROJECT_NAME}}

{{ONE_LINE_DESCRIPTION}}

## Status

| Field | Value |
|-------|-------|
| Status | {{active / planning / maintenance}} |
| Started | {{YYYY-MM-DD}} |
| Stack | {{PRIMARY_STACK}} |

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | {{e.g., Next.js <version>, React <version>}} | {{notes}} |
| Styling | {{e.g., Tailwind CSS v4, shadcn/ui}} | {{notes}} |
| Backend | {{e.g., Express, Hono, Next.js API routes}} | {{notes}} |
| Database | {{e.g., PostgreSQL via Neon + Drizzle ORM}} | {{notes}} |
| Auth | {{e.g., Clerk, NextAuth, custom JWT}} | {{notes}} |
| Deployment | {{e.g., Vercel, Azure SWA, Docker}} | {{notes}} |

## Local Dev

| Setting | Value |
|---------|-------|
| Port | {{DEV_PORT}} |
| URL | {{https://project.localhost/ or http://localhost:PORT}} |
| Dev command | `{{npm run dev}}` |
| Reverse proxy | {{Caddy / none}} |

## Project Structure

```
{{PROJECT_ROOT}}/
├── src/                # Source code
│   ├── app/            # {{Pages / routes}}
│   ├── components/     # {{UI components}}
│   ├── lib/            # {{Utilities, helpers}}
│   └── db/             # {{Database schema, client}}
├── scripts/            # {{Dev scripts, tooling}}
├── public/             # {{Static assets}}
└── {{OTHER_DIRS}}      # {{Description}}
```

## Conventions

- {{Coding conventions, naming patterns}}
- {{Import ordering, file organization}}
- {{Component patterns (server vs client, etc.)}}

## Commands

| Task | Command |
|------|---------|
| Dev server | `{{npm run dev}}` |
| Build | `{{npm run build}}` |
| Test | `{{npm test}}` |
| Lint | `{{npm run lint}}` |
| DB push | `{{npx drizzle-kit push}}` |
| DB studio | `{{npx drizzle-kit studio}}` |
| Deploy | `{{vercel --prod}}` |

## Testing

What "done" means here (E2E command, artifact path, when an isolated test is allowed): @AGENTS.md

## Git Workflow

| Remote | Repository | Push? |
|--------|-----------|-------|
| `origin` | {{upstream/repo}} | {{NEVER / YES}} |
| `fork` | {{your-fork/repo}} | {{ALWAYS}} |

Branch strategy: {{feature branches off main, PR to merge}}

## Key Files

| File | Purpose |
|------|---------|
| `{{path}}` | {{description}} |
| `{{path}}` | {{description}} |

## CCv3 Integration

This project is managed by Continuous Claude v3.

| Capability | How to Use |
|------------|-----------|
| Global config | `~/.claude/CLAUDE.md` and `~/.claude/rules/` |
| Memory | `/recall "<topic>"` to search past learnings |
| Workflows | `/explore`, `/build`, `/fix` for orchestrated development |
| Code intelligence | TLDR CLI (`tldr impact`, `tldr structure`) + ast-grep for AST rewrites |
| Tri-model features | `/game-plan <feature>` + `/workroom` for multi-milestone builds |
| Cross-model workers | `/grok` (xAI) executes tasks in isolated worktrees |
| Research | Oracle agent with Nia, Exa, Context7, OpenCLI |
| Reporting | `/log-work` when a unit of work is reportable (weekly tracker) |
| System health | `/health-check` for full-stack diagnostics |

Hooks auto-run on every session: ROADMAP sync, post-edit diagnostics, knowledge tree updates, memory extraction.
```
