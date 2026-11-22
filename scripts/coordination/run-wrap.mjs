#!/usr/bin/env node
/**
 * run-wrap.mjs: start a long run through the run lock (card coord-run-lock-wrapper-loops).
 *
 * Why: the run lock (run-lock.mjs) counts a run by the pid in its lock file. A loop or a label run that nobody registers is
 * invisible to the V7.3 tiers. A launcher SHELL that holds the lock ends while its child lives on, so the lock frees a slot
 * that is still in use, and the next launcher starts a second run for the same head (2026-11-22: pids 74916 and 76380).
 * This wrapper holds no lock itself. It starts the command, registers the CHILD pid, and removes the lock when the child ends.
 *
 * Usage: node scripts/coordination/run-wrap.mjs --kind loop|label-run|pre-pr [--once-per head] [--head sha] [--holder name]
 *          [--session label] [--minutes N] -- <command> <args...>
 *   loop, label-run  register the child with `register` (the lock takes a slot), renew a loop every 60 minutes, release at the end.
 *   pre-pr           the duplicate guard only: pre-pr takes its own lock. A pre-pr launch line:
 *                    node scripts/coordination/run-wrap.mjs --kind pre-pr --once-per head -- node scripts/github/pre-pr.mjs --body <file> --wait-lock
 *   A loop launch line:
 *                    node scripts/coordination/run-wrap.mjs --kind loop --once-per head --holder <name> -- node <loop script> <args>
 *   --once-per head  refuse when a live lock of the same kind, head and owner (holder or session) exists: print DUPLICATE, exit 75, start nothing.
 *   --head           default: `git rev-parse HEAD` of the current folder. No head: the guard is skipped with one WARN.
 *
 * Rules:
 *   - The only refusal is a duplicate (exit 75). Any other trouble with the lock (a store that cannot be read, a register that fails) prints
 *     ONE `WARN run-wrap:` line and the run goes on. The lock is cooperative and must never stop work because it is broken.
 *   - The command is started directly (no shell): name a real program (node, pwsh, python), not an npm script.
 *   - A signal (SIGINT, SIGTERM, SIGHUP, and SIGBREAK on Windows) stops the child's own tree first, then frees the lock; exit 128 + signal.
 *     Windows: scripts/lib/Stop-ProcessTree.ps1 (one process-table snapshot, a child counts only when it is not older than its parent, each id
 *     read again before its kill, never this shell or its ancestors). Never the taskkill tree switch. Linux: the child leads its own process group.
 *   - The lock row is released only when the child has really ended. A child that outlives the stop keeps its row (one WARN line) until it expires.
 *   - A kill -9 of the wrapper leaves the child and its lock. The lock holds the child pid, so it stays true while the child lives.
 *   - No hook enforces that a run goes through this wrapper. A run that does not is as invisible as before.
 *   - Test seams (env): RUN_WRAP_SELF_SIGNAL_MS (send SIGTERM to itself that long after the register), RUN_WRAP_RENEW_MS (renew interval).
 * Exit: the exit code of the command; 75 duplicate; 1 usage error; 127 the command did not start.
 */
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { list, register, releaseSync } from './run-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STOP_TREE = join(HERE, '..', 'lib', 'Stop-ProcessTree.ps1');
export const EXIT_DUPLICATE = 75;
const KINDS = ['loop', 'label-run', 'pre-pr'];
const RENEW_MS = 60 * 60_000;
const STOP_WAIT_MS = 10_000;
const USAGE = 'usage: run-wrap.mjs --kind loop|label-run|pre-pr [--once-per head] [--head sha] [--holder name] [--session label] [--minutes N] -- <command> <args...>';

const usageError = (msg) => Object.assign(new Error(`${msg}\n${USAGE}`), { usage: true });
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

export function parseWrapArgs(argv) {
  const cut = argv.indexOf('--');
  if (cut < 0 || cut === argv.length - 1) throw usageError('a command after "--" is required');
  const o = { command: argv.slice(cut + 1) };
  const opts = argv.slice(0, cut);
  for (let i = 0; i < opts.length; i += 1) {
    const a = opts[i];
    if (a === '--once-per') { if (opts[++i] !== 'head') throw usageError('--once-per takes: head'); o.oncePer = true; }
    else if (['--kind', '--holder', '--session', '--head', '--minutes'].includes(a)) o[a.slice(2)] = opts[++i];
    else throw usageError(`unknown option ${a}`);
  }
  if (!KINDS.includes(o.kind)) throw usageError(`--kind must be one of: ${KINDS.join(', ')}`);
  if (o.minutes !== undefined) {
    const n = Number(o.minutes);
    if (!Number.isFinite(n) || n <= 0) throw usageError('--minutes must be a finite number above 0');
    o.minutes = n;
  }
  return o;
}

const sessionOf = (env) => { const id = String(env.CLAUDE_CODE_SESSION_ID || ''); return /^[0-9a-f-]{8,}$/i.test(id) ? `#${id.slice(0, 8)}` : null; };
const sameOwner = (rec, me) => Boolean((me.holder && rec.holder === me.holder) || (me.session && rec.session === me.session));

/** The live lock record of a run with the same kind, head and owner, or null. No head: no guard. Pure. */
export function findDuplicate(live, me) {
  if (!me.head) return null;
  return (live || []).find((r) => r.kind === me.kind && r.head === me.head && sameOwner(r, me)) || null;
}

function headOf() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? String(r.stdout).trim() || null : null;
}

/** Stop the tree of one pid. Windows: the approved helper (no taskkill). Elsewhere: the process group the child leads. Returns true when the stop call itself worked. */
export function stopTree(pid, deps = {}) {
  const platform = deps.platform || process.platform;
  const run = deps.spawnSync || spawnSync;
  if (platform === 'win32') {
    const helper = STOP_TREE.replaceAll("'", "''");
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `. '${helper}'; $null = Stop-ProcessTree -RootId ${Number(pid)}`], { windowsHide: true, timeout: 30_000 });
    return !r.error && r.status === 0;
  }
  try { process.kill(-pid, 'SIGTERM'); return true; } catch { /* not a group leader */ }
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

export async function runWrap(o, deps = {}) {
  const d = { list, register, releaseSync, spawn, stopTree, headOf, env: process.env, out: (l) => console.log(l), platform: process.platform, ...deps };
  const session = o.session || sessionOf(d.env);
  const me = { kind: o.kind, head: o.head ?? d.headOf(), holder: o.holder || session || 'unknown', session };
  let warned = false;
  const warn = (msg) => { if (!warned) { warned = true; d.out(`WARN run-wrap: ${msg}; the run goes on`); } };

  if (o.oncePer) {
    if (!me.head) warn('no head (not a git folder and no --head), so the duplicate guard is off');
    else {
      try {
        const dup = findDuplicate((await d.list()).live, me);
        if (dup) { d.out(`DUPLICATE: ${dup.kind} pid ${dup.pid} already runs for head ${String(me.head).slice(0, 8)} (holder ${dup.holder}); nothing started`); return EXIT_DUPLICATE; }
      } catch (e) { warn(`the lock store could not be read (${firstLine(e)})`); }
    }
  }

  const [cmd, ...args] = o.command;
  let child;
  try { child = d.spawn(cmd, args, { stdio: 'inherit', windowsHide: true, detached: d.platform !== 'win32' }); } catch (e) { d.out(`run-wrap: cannot start ${cmd}: ${firstLine(e)}`); return 127; }

  let signalExit = null;
  let finished = false;
  let finish;
  const closed = new Promise((res) => { finish = (code) => { if (!finished) { finished = true; res(code); } }; });
  let childGone = false; // true only when the child has really ended: a stop that failed must not free its slot
  child.once('error', (e) => { childGone = true; d.out(`run-wrap: cannot start ${cmd}: ${firstLine(e)}`); finish(127); });
  child.once('close', (code, sig) => { childGone = true; finish(code ?? (sig ? 128 + (os.constants.signals[sig] || 0) : 1)); });

  const regOpts = () => ({ kind: o.kind, pid: child.pid, head: me.head, holder: me.holder, session: me.session, minutes: o.minutes });
  let registered = false;
  const regDone = (async () => {
    if (o.kind === 'pre-pr' || !child.pid) return;
    try { await d.register(regOpts()); registered = true; } catch (e) { warn(`the run lock could not register pid ${child.pid} (${firstLine(e)})`); }
  })();

  const onSignal = (sig) => {
    if (signalExit !== null) return;
    signalExit = 128 + (os.constants.signals[sig] || 15);
    if (child.pid) { try { d.stopTree(child.pid); } catch { /* the child may be gone */ } }
    setTimeout(() => finish(signalExit), Number(d.env.RUN_WRAP_STOP_WAIT_MS) || STOP_WAIT_MS).unref(); // a child that outlives the stop must not hold the wrapper
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(d.platform === 'win32' ? ['SIGBREAK'] : [])];
  for (const s of signals) process.on(s, onSignal);

  let renew = null;
  regDone.then(() => {
    if (registered && o.kind === 'loop') {
      renew = setInterval(() => { if (!finished && signalExit === null) d.register(regOpts()).catch(() => {}); }, Number(d.env.RUN_WRAP_RENEW_MS) || RENEW_MS);
      renew.unref();
    }
    const self = Number(d.env.RUN_WRAP_SELF_SIGNAL_MS);
    if (self > 0) setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), self).unref();
  });

  const code = await closed;
  if (renew) clearInterval(renew);
  for (const s of signals) process.off(s, onSignal);
  await regDone;
  if (o.kind !== 'pre-pr' && child.pid) {
    if (childGone) { try { d.releaseSync({ pid: child.pid, kind: o.kind }); } catch { /* the store is gone */ } }
    else if (registered) d.out(`WARN run-wrap: child pid ${child.pid} outlived the stop; its lock row stays until it expires`);
  }
  return signalExit ?? code;
}

async function main(argv) {
  let o;
  try { o = parseWrapArgs(argv); } catch (e) { console.error(e.message); return 1; }
  return runWrap(o);
}

const canon = (p) => { try { return realpathSync.native(p).toLowerCase(); } catch { return String(p).toLowerCase(); } };
if (process.argv[1] && canon(process.argv[1]) === canon(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`run-wrap: ${firstLine(e)}`); process.exitCode = 1; });
}
