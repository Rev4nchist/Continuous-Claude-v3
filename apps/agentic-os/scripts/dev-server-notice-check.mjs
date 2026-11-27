#!/usr/bin/env node
/**
 * dev-server-notice-check.mjs: does `next dev` of this app print the Next.js security-upgrade notice?
 * (card agentic-os-next-security-upgrade; fixes: card agentic-os-notice-check-fixes). Plain Node, no dependency.
 *
 *   node scripts/dev-server-notice-check.mjs [appDir] [outFile]
 *
 * It starts `next dev` ONCE on port 3013 (127.0.0.1) in appDir (default: the current folder), makes two requests to
 * /api/mission-control, waits 24 seconds, records everything the server printed, then STOPS the dev server it started
 * and checks that port 3013 is free again. It never runs `next upgrade` and never touches another process.
 * The database url is a closed port on purpose (127.0.0.1:1): the readers answer with an error row (HTTP 503) and nothing connects.
 *
 * Why ANY HTTP status counts as an answer (not only 200): the database url is closed on purpose, so the real route answers 503. That
 * answer still proves the dev server ran and served the route. A request that fails (no answer at all) proves nothing.
 *
 * Exit codes (the last line says which, and names the port and the stop):
 *   0  no notice, and the pass is PROVEN: the dev server ran to the end and at least one request got an HTTP answer
 *   1  the notice appeared (the check FAILS)
 *   2  port 3013 was busy: nothing started
 *   3  no notice, but the pass is NOT proven: the dev server stopped before the end, or no request got an HTTP answer
 * outFile (optional) gets the full timed record.
 *
 * Scope: this detects the agent-environment notice only, the text that `next dev` prints on a piped (non-TTY) stdout. The human
 * reminder that Next.js prints only on a TTY is NOT seen here (stdio is a pipe): SKIP, by decision of card agentic-os-notice-check-fixes.
 * The notice is matched on one joined buffer per stream, so a phrase split across two data chunks is found. It is matched per stream:
 * the halves of a phrase on stdout and on stderr are not one notice. A phrase broken by a line break is not matched.
 *
 * Test seam (the rows of dev-server-notice-check.test.mjs): only when NOTICE_CHECK_ALLOW_ENV is exactly 1, NOTICE_CHECK_PORT
 * sets the port and NOTICE_CHECK_WAIT_SCALE (a number above 0) multiplies every wait. Without it both keep the values above.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';

const appDir = resolve(process.argv[2] ?? process.cwd());
const outFile = process.argv[3] ?? null;
const SEAM = process.env.NOTICE_CHECK_ALLOW_ENV === '1';
const PORT = SEAM && Number(process.env.NOTICE_CHECK_PORT) > 0 ? Number(process.env.NOTICE_CHECK_PORT) : 3013;
const SCALE = SEAM && Number(process.env.NOTICE_CHECK_WAIT_SCALE) > 0 ? Number(process.env.NOTICE_CHECK_WAIT_SCALE) : 1;
const NOTICE = /upgrade recommendation|known security vulnerability|next upgrade/i;
const lines = [];
const note = (text) => lines.push(`[${new Date().toISOString()}] ${text}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms * SCALE));

const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', AGENTIC_OS_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' };
for (const name of ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL']) delete env[name];

const portOpen = () => new Promise((done) => {
  const s = net.connect({ port: PORT, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});

let answered = 0; // requests that got an HTTP status back: the dev server served them
async function hit(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(20_000) });
    answered += 1;
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
const joined = { out: '', err: '' }; // one buffer per stream: a phrase can arrive in two chunks
child.stdout.on('data', (d) => { joined.out += String(d); note(`out: ${String(d).trimEnd()}`); });
child.stderr.on('data', (d) => { joined.err += String(d); note(`err: ${String(d).trimEnd()}`); });
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
const noticeSeen = NOTICE.test(joined.out) || NOTICE.test(joined.err);
const free = !(await portOpen());
const missing = stoppedBefore ? 'dev server stopped before the end' : (answered === 0 ? 'no request got an HTTP answer' : null);
const proof = missing ? `missing: ${missing}` : 'ok';
note(`notice present: ${noticeSeen}; dev server stopped before the end: ${stoppedBefore}; requests answered: ${answered}; port ${PORT} free after stop: ${free}`);
if (outFile) writeFileSync(outFile, `${lines.join('\n')}\n`);
console.log(`notice present: ${noticeSeen}; port ${PORT}; dev server (pid ${child.pid}) stopped by this check: ${!stoppedBefore}; port free after: ${free}; proof: ${proof}`);
process.exit(noticeSeen ? 1 : (missing ? 3 : 0));
