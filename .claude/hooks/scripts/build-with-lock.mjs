#!/usr/bin/env node
/**
 * Hook build wrapper (card hook-build-run-lock). The `build` script of .claude/hooks runs through this file.
 *
 * It registers a `hook-build` run lock (pid of this process, head of the checkout, session label) while the build runs, then removes it. A lock file
 * and the start and end lines of runs.jsonl are how the /wrap-all table and the seat see a running build: no lane note word is needed.
 *
 * Rules:
 *  - It never delays or stops a build. `register` takes no slot and has no wait. A broken lock store, a missing run-lock.mjs (an active copy of this
 *    folder has no scripts/coordination next to it) or any throw is fail-open: one `hook-build-lock:` line on stderr, none when CI is set.
 *  - The exit code of the build is the exit code of this process.
 *  - The release goes by pid (releaseSync), never by expiry: a build longer than its ten minutes still removes its own lock. It also runs on 'exit'
 *    and on SIGINT and SIGTERM, so a failed or interrupted build leaves no lock. A crash is covered by the expiry and the dead-pid sweep.
 *  - The child has stdio inherited and no detached flag (no console window on Windows). With no command given it runs `npm run build:raw` through
 *    npm's own cli script (process.env.npm_execpath), so no shell and no .cmd file is needed.
 *
 * Usage: node scripts/build-with-lock.mjs [--minutes N] [--] [command args...]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_LOCK = join(HERE, '..', '..', '..', 'scripts', 'coordination', 'run-lock.mjs');
const MIN = 60_000;

function parse(argv) {
  const out = { minutes: undefined, cmd: [] };
  let i = 0;
  if (argv[i] === '--minutes') { out.minutes = Number(argv[i + 1]); i += 2; }
  if (argv[i] === '--') i += 1;
  out.cmd = argv.slice(i);
  return out;
}

const warn = (msg) => { if (!process.env.CI) process.stderr.write(`hook-build-lock: ${msg}\n`); };

function headOf() {
  const r = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

async function loadLock() {
  try {
    if (!existsSync(RUN_LOCK)) throw new Error(`no ${RUN_LOCK}`);
    return await import(pathToFileURL(RUN_LOCK).href);
  } catch (e) {
    warn(`not recorded (${e.message}); the build goes on`);
    return null;
  }
}

async function main() {
  const { minutes, cmd } = parse(process.argv.slice(2));
  const command = cmd.length ? cmd : [process.execPath, process.env.npm_execpath || 'npm', 'run', 'build:raw'];
  const RL = await loadLock();
  const pid = process.pid;
  const head = headOf();
  const started = Date.now();
  let held = false;
  let ended = false;
  const finish = (result) => {
    if (ended) return;
    ended = true;
    if (!RL || !held) return;
    try { RL.releaseSync({ pid, kind: 'hook-build' }); } catch (e) { warn(`release failed (${e.message})`); }
    try { RL.logRun({ event: 'end', kind: 'hook-build', pid, head, result, minutes: Number(((Date.now() - started) / MIN).toFixed(1)) }); } catch { /* a log problem never stops the build */ }
  };
  if (RL) {
    try {
      const opts = { kind: 'hook-build', pid, head, holder: 'hook build' };
      if (Number.isFinite(minutes) && minutes > 0) opts.minutes = minutes;
      await RL.register(opts);
      held = true;
      RL.logRun({ event: 'start', kind: 'hook-build', pid, head });
    } catch (e) {
      warn(`not recorded (${e.message}); the build goes on`);
    }
  }
  process.on('exit', () => finish('ERROR'));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { finish('ERROR'); process.exit(130); });
  const code = await new Promise((resolve) => {
    let child;
    try { child = spawn(command[0], command.slice(1), { stdio: 'inherit', windowsHide: true }); } catch (e) { warn(`cannot start the build: ${e.message}`); resolve(1); return; }
    child.on('error', (e) => { warn(`cannot start the build: ${e.message}`); resolve(1); });
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  finish(code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
}

main().catch((e) => { warn(`wrapper error (${e.message})`); process.exitCode = 1; });
