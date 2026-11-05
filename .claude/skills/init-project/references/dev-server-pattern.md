# Dev Server Cleanup Pattern

For web projects (Next.js, Vite, Express, etc.), scaffold managed dev server scripts that prevent zombie processes.

## When to Scaffold

Only scaffold when the project:
1. Has a `package.json`
2. Has a `dev` script in package.json
3. Is a web project (serves on a port)

Skip for libraries, CLI tools, or projects without a dev server.

## Files to Create

### scripts/dev-cleanup.mjs

```javascript
// Dev server cleanup - kills previous dev server before starting new one
import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = dirname(import.meta.dirname);
const PID_FILE = join(ROOT, '.dev-server.pid');

if (existsSync(PID_FILE)) {
  try {
    const pid = readFileSync(PID_FILE, 'utf8').trim();
    if (pid) {
      console.log(`Cleaning up previous dev server (PID ${pid})...`);
      try {
        if (process.platform === 'win32') {
          // One explicit pid. Never use the taskkill tree switch (pid reuse kills live shells).
          // A dev server that spawns children should kill them itself on exit.
          process.kill(Number(pid), 'SIGKILL');
        } else {
          execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
        }
      } catch { /* process already dead */ }
    }
    unlinkSync(PID_FILE);
  } catch { /* ignore cleanup errors */ }
}
```

### scripts/dev-start.mjs

**The spawn command MUST be derived from the project's ORIGINAL `package.json` `dev` script** (captured BEFORE you rewrite it to point at `dev-start.mjs`) — this template works for Next.js, Vite, Express, or anything else. Fill `{{DEV_COMMAND_ARGS}}` from the original dev script, appending the framework's port flag (`next dev -p`, `vite --port`, etc.; Express apps usually read `PORT` from env instead).

```javascript
// Managed dev server start - cleanup + start + PID tracking
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Cleanup previous
await import('./dev-cleanup.mjs');

const ROOT = dirname(import.meta.dirname);
const PID_FILE = join(ROOT, '.dev-server.pid');
const PORT = process.env.DEV_PORT || '{{DEV_PORT}}';

console.log(`Starting dev server on port ${PORT}...`);

// Derived from the project's original package.json dev script -- e.g.
//   Next.js: spawn('npx', ['next', 'dev', '-p', PORT], ...)
//   Vite:    spawn('npx', ['vite', '--port', PORT], ...)
//   Express: spawn('node', ['server.js'], ...)  // reads PORT from env
const child = spawn('npx', [{{DEV_COMMAND_ARGS}}], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, PORT }
});

writeFileSync(PID_FILE, String(child.pid));

child.on('exit', () => {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
});

process.on('SIGINT', () => {
  child.kill('SIGTERM');
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  process.exit(0);
});
```

## package.json Changes

Replace the `dev` script:
```json
{
  "scripts": {
    "dev": "node scripts/dev-start.mjs",
    "dev:cleanup": "node scripts/dev-cleanup.mjs"
  }
}
```

## .env.local

```
DEV_PORT={{PORT_NUMBER}}
```

## .gitignore Addition

```
.dev-server.pid
```

## Port Assignment

**Derive used ports from the registry at run time — never from a hardcoded list** (hardcoded mirrors rot; one already caused a double-assignment risk). Read `~/continuous-claude/.claude/project-registry.json` (canonical) and collect ALL `port` values, including non-web entries (MCP servers use 8xxx). Assign the next free 3xxx port.

## Caddy Setup (Optional, for HTTPS localhost)

If the project needs HTTPS (auth cookies, OAuth), create a `Caddyfile`:

```
{{project}}.localhost {
    reverse_proxy localhost:{{PORT}}
}
```

Then the dev URL becomes `https://{{project}}.localhost/` instead of `http://localhost:{{PORT}}`.
