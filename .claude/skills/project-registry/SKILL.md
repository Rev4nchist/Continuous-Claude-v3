---
name: project-registry
description: "Query or update the project registry for ports, URLs, stack, and dev commands. Use when the user asks \"what port does X use\", \"project registry\", or \"which project\"."
allowed-tools: [Read, Write, Bash]
metadata:
  triggers: ["project registry", "what port", "project info", "which project", "project list"]
---

# Project Registry

Centralized registry of all managed projects with stack, port, URL, and status information.

## Registry Location

`.claude/project-registry.json` in the continuous-claude repo — **this is the canonical copy**. `~/.claude/project-registry.json` is a sync mirror maintained by `scripts/sync-to-active.sh` (full and `--changed` modes, JSON-validated). Read from either; **write ONLY to the repo copy**, then let the sync propagate.

## Write Discipline (atomic, single-process)

Registry updates MUST be a single Node read-modify-write process with a temp-file + rename — never the Edit tool, never separate read and write calls (concurrent sessions + the sync script race on this file):

```bash
node -e "
const fs = require('fs');
const p = require('os').homedir() + '/continuous-claude/.claude/project-registry.json';
const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
// ... modify reg ...
const tmp = p + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
JSON.parse(fs.readFileSync(tmp, 'utf8'));  // validate before replacing
fs.renameSync(tmp, p);
"
```

## When to Use

- User asks "what port does X use?" or "what's the URL for Y?"
- User asks "which projects use Next.js?" or similar stack queries
- User asks "list all projects" or "show active projects"
- User wants to add a new project or update project info
- Session needs to resolve project paths, dev commands, or ports

## Query Operations

### Lookup by Name

Read `.claude/project-registry.json` and find the entry where `name` matches (case-insensitive partial match).

Example user asks: "What port does NorthStar use?"
1. Read `.claude/project-registry.json`
2. Find entry with name containing "northstar"
3. Return: port 3002, URL https://northstar.localhost/, dev command `npm run dev`

### List All Active Projects

Read the registry and filter where `status === "active"`.

Present as a table:

| Project | Port | URL | Stack |
|---------|------|-----|-------|
| continuous-claude | -- | -- | TypeScript, Node.js, PostgreSQL, esbuild |
| NorthStar Transformation | 3002 | https://northstar.localhost/ | Next.js, TypeScript, Tailwind, Drizzle, Neon |
| Fourth Connect | 3000 | https://fourth-connect.localhost/ | Next.js, TypeScript, Tailwind |
| agent-factory | 3001 | -- | Next.js, AI SDK v6, OpenRouter, Docker |

### Filter by Stack

Read the registry and filter where `stack` array includes the queried technology.

Example: "Which projects use TypeScript?" returns all projects with "TypeScript" in their stack array.

### Find by Port

Read the registry and find the entry where `port` matches the queried number.

Example: "What's on port 3000?" returns Fourth Connect.

## Update Operations

### Add a New Project

Append a new entry to the `projects` array in `.claude/project-registry.json`:

```json
{
  "name": "new-project",
  "path": "~/Projects/new-project",
  "stack": ["React", "TypeScript"],
  "description": "What this project does",
  "port": null,
  "url": null,
  "devCommand": null,
  "status": "active"
}
```

Required fields: `name`, `path`, `stack`, `description`, `status`.
Optional fields (nullable): `port`, `url`, `devCommand`, `e2e`.
`e2e` is the project's end-to-end check (CLAUDE.md "Testing standard"). Two forms:
`{ "command": "<shell command, run in the project path>", "artifact": "<path the run writes, relative to the repo root; <stamp> allowed>" }`
or `{ "none": "<reason there is no surface>" }`. `artifact` is optional. It defaults to `.claude/cache/e2e/<stamp>-verify-<project slug>.log` in the project repo. `node ~/.claude/scripts/verify.mjs` runs it and writes `<artifact>.json`.
The command runs under `cmd.exe` on Windows (`shell: true`): use `&&`, no POSIX quoting, no `$VAR`, no `;`. Keep it under 600 s.
The project's testing rules (AGENTS.md "Testing", or docs/testing-standard.md) state the same values.

### Update Project Info

Read the registry, modify the target entry, write the full file back.

Common updates:
- Change `status` to `"inactive"` when archiving a project
- Update `port` or `url` when dev setup changes
- Add stack entries when new dependencies are adopted

### Mark Inactive

Set `status` to `"inactive"`. Do not remove the entry -- inactive projects remain in the registry for reference.

## Schema

```json
{
  "version": "1.0",
  "projects": [
    {
      "name": "string (required, unique)",
      "path": "string (absolute Windows path with forward slashes)",
      "stack": ["string array of technologies"],
      "description": "string (short description)",
      "port": "number | null",
      "url": "string | null (local dev URL)",
      "devCommand": "string | null (e.g. 'npm run dev')",
      "e2e": "{ command, artifact } | { none: reason } | null (end-to-end check; verify.mjs runs it)",
      "status": "'active' | 'inactive'"
    }
  ]
}
```

## Notes

- Paths use forward slashes for cross-platform compatibility
- The registry is the single source of truth for project metadata
- The `dev-server-cleanup.md` rule has a port registry table that should stay in sync
- When adding projects with dev servers, also update the port registry in that rule
