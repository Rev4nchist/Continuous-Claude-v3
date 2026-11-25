#!/usr/bin/env node
/**
 * dev-server-notice-check.mjs: does `next dev` of this app print the Next.js security-upgrade notice?
 * (card agentic-os-next-security-upgrade). Plain Node, no dependency.
 *
 *   node scripts/dev-server-notice-check.mjs [appDir] [outFile]
 *
 * It starts `next dev` ONCE on port 3013 (127.0.0.1) in appDir (default: the current folder), makes two requests to
 * /api/mission-control, waits 24 seconds, records everything the server printed, then STOPS the dev server it started
 * and checks that port 3013 is free again. It never runs `next upgrade` and never touches another process.
 * The database url is a closed port on purpose (127.0.0.1:1): the readers answer with an error row and nothing connects.
 *
 * Exit code: 1 when the notice appeared (the check FAILS), 0 when it did not. The last line says which, and names the port
 * and the stop. outFile (optional) gets the full timed record.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';

const appDir = resolve(process.argv[2] ?? process.cwd());
const outFile = process.argv[3] ?? null;
const PORT = 3013;
const NOTICE = /upgrade recommendation|known security vulnerability|next upgrade/i;
const lines = [];
const note = (text) => lines.push(`[${new Date().toISOString()}] ${text}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', AGENTIC_OS_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' };
for (const name of ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL']) delete env[name];

const portOpen = () => new Promise((done) => {
  const s = net.connect({ port: PORT, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});

async function hit(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(20_000) });
    note(`GET ${path} -> ${res.status}`);
  } catch (error) {
    note(`GET ${path} failed: ${error.name}`);
  }
}

if (await portOpen()) {
  console.log(`port ${PORT} is busy: stop. This check never stops a process it did not start.`);
  process.exit(2);
}

const nextBin = join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: appDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
note(`started next dev, pid ${child.pid}, port ${PORT}`);
let exitedEarly = null;
child.stdout.on('data', (d) => note(`out: ${String(d).trimEnd()}`));
child.stderr.on('data', (d) => note(`err: ${String(d).trimEnd()}`));
child.on('exit', (code, signal) => { exitedEarly ??= { code, signal }; note(`dev server exit code=${code} signal=${signal}`); });

await wait(12_000);
await hit('/api/mission-control');
await wait(6_000);
await hit('/api/mission-control');
await wait(6_000);

const stoppedBefore = exitedEarly !== null;
if (!stoppedBefore) {
  exitedEarly = { code: null, signal: 'by this check' }; // the exit event after kill() must not read as an early stop
  child.kill();
  await wait(2_000);
}
const noticeSeen = lines.some((l) => NOTICE.test(l));
const free = !(await portOpen());
note(`notice present: ${noticeSeen}; dev server stopped before the end: ${stoppedBefore}; port ${PORT} free after stop: ${free}`);
if (outFile) writeFileSync(outFile, `${lines.join('\n')}\n`);
console.log(`notice present: ${noticeSeen}; port ${PORT}; dev server (pid ${child.pid}) stopped by this check: ${!stoppedBefore}; port free after: ${free}`);
process.exit(noticeSeen ? 1 : 0);
