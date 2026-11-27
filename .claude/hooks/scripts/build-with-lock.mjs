#!/usr/bin/env node
/**
 * Hook build wrapper (card hook-build-run-lock). The `build` script of .claude/hooks runs through this file.
 *
 * It registers a `hook-build` run lock (pid of this process, head of the checkout, session label) while the build runs, then removes it. A lock file
 * and the start and end lines of runs.jsonl are how the /wrap-all table and the seat see a running build: no lane note word is needed.
 *
 * Rules:
 *  - It never stops a build and delays it by a few seconds at most. `register` takes no slot and has no queue. Its wait for the store gate ends after
 *    REGISTER_BUDGET_MS (seat ruling B, item 4). A broken lock store, a missing run-lock.mjs (an active copy of this folder has no scripts/coordination
 *    next to it), a gate that stays held or any throw is fail-open: one `hook-build-lock:` line on stderr, none when CI is set. A register that ends
 *    after the budget still counts: the lock is released with the others.
 *  - The exit code of the build is the exit code of this process.
 *  - The lock record names the session as run-wrap does (item 3): `holder` and `session` are "#<sid8>" from CLAUDE_CODE_SESSION_ID. With no session id
 *    the holder is the fixed text "hook build" and the session is null.
 *  - The release goes by pid (releaseSync), never by expiry: a build longer than its ten minutes still removes its own lock. A SIGINT or SIGTERM stops the
 *    build child first, waits for it, and only then releases the lock and exits (130 or 143). An 'exit' handler covers the other ways out. A crash is
 *    covered by the expiry and the dead-pid sweep.
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
/** The longest the wrapper waits for the run lock store before it runs the build with no lock. */
const REGISTER_BUDGET_MS = 3000;
/** After a signal the child gets this long to end before it is killed. */
const CHILD_STOP_MS = 10_000;
const SIGNALS = [['SIGINT', 130], ['SIGTERM', 143]];

function parse(argv) {
  const out = { minutes: undefined, cmd: [] };
  let i = 0;
  if (argv[i] === '--minutes') { out.minutes = Number(argv[i + 1]); i += 2; }
  if (argv[i] === '--') i += 1;
  out.cmd = argv.slice(i);
  return out;
}

const warn = (msg) => { if (!process.env.CI) process.stderr.write(`hook-build-lock: ${msg}\n`); };

/** "#<sid8>" from the session id in the environment, as scripts/coordination/run-wrap.mjs writes it; null when there is none. */
function sessionOf(env) {
  const id = String(env.CLAUDE_CODE_SESSION_ID || '');
  return /^[0-9a-f-]{8,}$/i.test(id) ? `#${id.slice(0, 8)}` : null;
}

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
  if (!cmd.length && !process.env.npm_execpath) {
    // Run by hand, there is no npm cli script to start: refuse at once, with no lock and no build.
    process.stderr.write('hook-build-lock: run the build through npm: cd .claude/hooks && npm run build (this file needs npm_execpath, which npm sets)\n');
    process.exitCode = 1;
    return;
  }
  const command = cmd.length ? cmd : [process.execPath, process.env.npm_execpath, 'run', 'build:raw'];
  const pid = process.pid;
  const started = Date.now();
  let RL = null;
  let head = null;
  let held = false;
  let ended = false;
  let child = null;
  let stopCode = null;
  const finish = (result) => {
    if (ended) return;
    ended = true;
    if (!RL || !held) return;
    try { RL.releaseSync({ pid, kind: 'hook-build' }); } catch (e) { warn(`release failed (${e.message})`); }
    try { RL.logRun({ event: 'end', kind: 'hook-build', pid, head, result, minutes: Number(((Date.now() - started) / MIN).toFixed(1)) }); } catch { /* a log problem never stops the build */ }
  };
  // A signal stops the child first and waits for it: the exit of the child ends the wrapper (below). With no child yet, the wrapper ends at once.
  const onSignal = (code) => {
    if (stopCode !== null) return;
    stopCode = code;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, CHILD_STOP_MS).unref();
      return;
    }
    finish('ERROR');
    process.exit(code);
  };
  process.on('exit', () => finish('ERROR'));
  for (const [sig, code] of SIGNALS) process.on(sig, () => onSignal(code));

  RL = await loadLock();
  head = headOf();
  if (RL) {
    const session = sessionOf(process.env);
    const opts = { kind: 'hook-build', pid, head, holder: session || 'hook build', session };
    if (Number.isFinite(minutes) && minutes > 0) opts.minutes = minutes;
    // The register is bounded: after REGISTER_BUDGET_MS the build starts with no lock. A late success still sets `held`, so the lock is released.
    const registering = RL.register(opts).then(() => {
      held = true;
      if (!ended) RL.logRun({ event: 'start', kind: 'hook-build', pid, head });
      else { try { RL.releaseSync({ pid, kind: 'hook-build' }); } catch { /* the dead-pid sweep removes it */ } }
    });
    let timer;
    const outcome = await Promise.race([
      registering.then(() => 'ok', (e) => `not recorded (${e.message}); the build goes on`),
      new Promise((resolve) => { timer = setTimeout(() => resolve(`not recorded (the lock store did not answer in ${REGISTER_BUDGET_MS / 1000} s); the build goes on`), REGISTER_BUDGET_MS); }),
    ]);
    clearTimeout(timer);
    if (outcome !== 'ok') { warn(outcome); registering.catch(() => {}); }
  }
  if (stopCode !== null) { finish('ERROR'); process.exit(stopCode); }
  const code = await new Promise((resolve) => {
    try { child = spawn(command[0], command.slice(1), { stdio: 'inherit', windowsHide: true }); } catch (e) { warn(`cannot start the build: ${e.message}`); resolve(1); return; }
    child.on('error', (e) => { warn(`cannot start the build: ${e.message}`); resolve(1); });
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  if (stopCode !== null) { finish('ERROR'); process.exit(stopCode); }
  finish(code === 0 ? 'PASS' : 'FAIL');
  // An explicit exit: a register that is still waiting for the gate must not keep the process alive.
  process.exit(code);
}

main().catch((e) => { warn(`wrapper error (${e.message})`); process.exit(1); });
