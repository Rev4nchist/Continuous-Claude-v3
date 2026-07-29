# Dev Server Cleanup Pattern

## Convention

Projects use `scripts/dev-start.mjs` + `scripts/dev-cleanup.mjs` for dev server management.
This prevents zombie processes when restarting dev servers during development sessions.

## How It Works

1. `npm run dev` calls `scripts/dev-start.mjs`
2. `dev-start.mjs` imports `dev-cleanup.mjs` first (kills old processes)
3. Then spawns the dev server with explicit port from `DEV_PORT` env var
4. Writes PID to `.dev-server.pid` for tracking
5. Cleans up PID file on shutdown

## Rules

- Always use `npm run dev` to start dev servers (NOT raw `next dev` or `vite`)
- Each project declares its port via `DEV_PORT` in `.env.local`
- PID is tracked in `.dev-server.pid` (gitignored)
- Cleanup kills previous process tree before starting new server

## Port Registry

**Source of truth: `~/continuous-claude/.claude/project-registry.json`** (repo-canonical, mirrored to `~/.claude/`). Derive used ports from it at run time — do not maintain a table here (a hardcoded copy rotted and nearly caused a double-assignment). Examples of the convention (illustrative only): Fourth Connect → 3000 / fourth-connect.localhost; NorthStar → 3002 / northstar.localhost. MCP servers use 8xxx; new web projects take the next free 3xxx.

Note: `import.meta.dirname` requires Node 21.2+. Current machine runs Node 24.4.1.

## Manual Cleanup

To kill a project's dev server without restarting:
```bash
npm run dev:cleanup
```

## Adding to New Projects

1. Copy `scripts/dev-cleanup.mjs` and `scripts/dev-start.mjs` from NorthStar
2. Set `DEV_PORT=<port>` in `.env.local`
3. Update `package.json`: `"dev": "node scripts/dev-start.mjs"`
4. Add `.dev-server.pid` to `.gitignore`
5. Add the project (with its port) to the repo `project-registry.json` — see the project-registry skill
