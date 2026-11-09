/**
 * fleetops-auto-tick -- the I/O part of the FleetOps timed export (Task Scheduler: CCv3-FleetOps-Auto, every 30 minutes).
 *
 * No model, no claude, no upload. A headless claude -p has no Artifact tool, so this tick only exports and gates.
 * Design: .claudedocs/2026-11-09-fleetops-auto-refresh-design.md (the child, ledger and prompt parts do not apply).
 *
 * One tick, in order:
 *   1. No ~/.claude/state/fleetops-auto/auto-enabled file: exit 0, do nothing (no lock, no state, no log).
 *   2. Take tick.lock (single flight, stale after 10 minutes). Held and fresh: skip.
 *   3. Run export-dash-data.mjs. Exit 1 (Docker down) or "export lock is held": log and skip. Not a failure.
 *   4. Read refresh.json and the 7 dataset files in ~/.claude/state/lane-dash, hash them (flow.json and factory.json are
 *      never read) and ask decide():
 *        clear          same hash as the last upload: run `export-dash-data.mjs --clear-refresh <key>`, then read refresh.json
 *                       AGAIN. The command exits 0 on a key mismatch, so only the re-read proves pending=false.
 *        leave-pending  the data changed: pending stays true. An interactive session uploads (the fleetops-refresh skill),
 *                       then runs `node scripts/coordination/fleetops-auto-tick.mjs --record-upload <copy dir>`, which hashes
 *                       THAT folder (the files it uploaded) after it checks every copy has exportedAt equal to refresh.key.
 *   5. Write latest.json (atomic) and release the lock.
 *
 * Environment overrides, for tests: CCV3_FLEETOPS_AUTO_DIR (state), CCV3_LANE_DASH_DIR (datasets),
 * CCV3_FLEETOPS_AUTO_LOG_DIR (logs), CCV3_FLEETOPS_EXPORT_CMD (JSON array: the export command and its leading args).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, hashSet, SET_IDS, skipReason } from './fleetops-auto-core.mjs';
import { acquireLock, writeState } from './reminder-tick.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPORT_SCRIPT = join(HERE, 'export-dash-data.mjs');
const EXPORT_TIMEOUT_MS = 180_000; // the wrapper limit is 240 s: the export times out first and the tick still logs
const LOG_KEEP_DAYS = 14;

const stateDirOf = (env) => env.CCV3_FLEETOPS_AUTO_DIR || join(homedir(), '.claude', 'state', 'fleetops-auto');
const dashDirOf = (env) => env.CCV3_LANE_DASH_DIR || join(homedir(), '.claude', 'state', 'lane-dash');
const logDirOf = (env) => env.CCV3_FLEETOPS_AUTO_LOG_DIR || join(homedir(), '.claude', 'logs', 'CCv3-FleetOps-Auto');

function exportCmd(env) {
  if (!env.CCV3_FLEETOPS_EXPORT_CMD) return [process.execPath, EXPORT_SCRIPT];
  const cmd = JSON.parse(env.CCV3_FLEETOPS_EXPORT_CMD);
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((a) => typeof a !== 'string')) {
    throw new Error('CCV3_FLEETOPS_EXPORT_CMD must be a JSON array of strings');
  }
  return cmd;
}

// ---------------------------------------------------------------- log

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function makeLog(logDir, now) {
  return (line) => {
    try {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, `${localDay(now())}.log`), `[${now().toISOString()}] ${line}\n`);
    } catch { /* a log error never changes the result */ }
  };
}

/** Delete dated logs (yyyy-MM-dd.log) older than 14 days. Other files are never touched. */
function pruneLogs(logDir, now) {
  try {
    const cutoff = now().getTime() - LOG_KEEP_DAYS * 86_400_000;
    for (const name of readdirSync(logDir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const file = join(logDir, name);
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    }
  } catch { /* nothing to prune */ }
}

// ---------------------------------------------------------------- files

function readJson(file, readFile) {
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') throw new Error(`cannot read ${file}: file is missing`);
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} does not parse: ${e.message}`);
  }
}

/** refresh.json, or null when there is none. */
function readRefresh(dashDir, readFile) {
  const file = join(dashDir, 'refresh.json');
  return existsSync(file) ? readJson(file, readFile) : null;
}

/** One dataset document: an object with an exportedAt string and a rows array. Every error names the file. */
function readSet(file, readFile) {
  const doc = readJson(file, readFile);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.exportedAt !== 'string' || !Array.isArray(doc.rows)) {
    throw new Error(`${file}: not a dataset document (needs an exportedAt string and a rows array)`);
  }
  return doc;
}

/** The 7 sets of a folder, by id. Only these 7 files are opened. */
function readSets(dir, readFile) {
  return Object.fromEntries(SET_IDS.map((id) => [id, readSet(join(dir, `${id}.json`), readFile)]));
}

/** The combined hash of the 7 dataset files in `dir` (default: the lane-dash folder). */
export function currentHash({ env = process.env, dir = dashDirOf(env), readFile = readFileSync } = {}) {
  return hashSet(readSets(dir, readFile));
}

// ---------------------------------------------------------------- state

/**
 * latest.json, or {} when there is none. A file that does not parse (a crash mid-write, a hand edit) is renamed to
 * latest.json.corrupt-<time> and logged, so the evidence stays and the next write does not hide it.
 */
function readLatest(stateDir, now, log) {
  const file = join(stateDir, 'latest.json');
  if (!existsSync(file)) return {};
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
    throw new Error('not an object');
  } catch (e) {
    const moved = `${file}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    try { renameSync(file, moved); } catch { /* another process moved it */ }
    log(`latest.json is corrupt (${e.message}); moved to ${moved}`);
    return {};
  }
}

/** Read latest.json fresh, merge `patch`, write atomically. A fresh read keeps a --record-upload that ran during the tick. */
function patchState(stateDir, patch, now, log) {
  const next = { ...readLatest(stateDir, now, log), ...patch };
  writeState(stateDir, next);
  return next;
}

/** Store lastUploadedHash. The hash must be 64 lowercase hex. */
export function recordUpload(hash, { env = process.env, now = () => new Date() } = {}) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('recordUpload needs a sha256 hash (64 lowercase hex)');
  return patchState(stateDirOf(env), { lastUploadedHash: hash, lastUploadedAt: now().toISOString() }, now, makeLog(logDirOf(env), now));
}

/**
 * The fleetops-refresh skill calls this (CLI --record-upload <dir>) after a good upload. `dir` is the folder the skill uploaded
 * from. Every one of the 7 copies must have exportedAt equal to the key in refresh.json: if a newer export ran, the copy is not
 * what refresh.json describes, and nothing is stored. Returns the hash it stored.
 */
export function recordUploadDir(dir, { env = process.env, now = () => new Date(), readFile = readFileSync } = {}) {
  if (!dir) throw new Error('--record-upload needs a folder: --record-upload <dir>');
  const root = resolve(dir);
  const refresh = readRefresh(dashDirOf(env), readFile);
  if (!refresh || typeof refresh.key !== 'string') throw new Error(`no refresh.json with a key in ${dashDirOf(env)}: cannot check the copy`);
  const sets = readSets(root, readFile);
  for (const id of SET_IDS) {
    if (sets[id].exportedAt !== refresh.key) {
      throw new Error(`${join(root, `${id}.json`)}: exportedAt ${sets[id].exportedAt} is not the refresh key ${refresh.key} (a newer export ran?)`);
    }
  }
  const hash = hashSet(sets);
  recordUpload(hash, { env, now });
  return hash;
}

// ---------------------------------------------------------------- export

function runExport(env, extraArgs) {
  const [cmd, ...lead] = exportCmd(env);
  const r = spawnSync(cmd, [...lead, '--out', dashDirOf(env), ...extraArgs], { env, encoding: 'utf8', windowsHide: true, timeout: EXPORT_TIMEOUT_MS });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`;
  return { exit: r.status, output: output.trim(), lockHeld: /export lock is held/i.test(output) };
}

// ---------------------------------------------------------------- the tick

/** Run the clear command, then re-read refresh.json: only pending=false is a success. */
function clearAndConfirm({ env, dashDir, key, readFile, log }) {
  const c = runExport(env, ['--clear-refresh', key]);
  log(`clear ${key}: exit ${c.exit}${c.output ? `, ${c.output.split('\n')[0]}` : ''}`);
  const after = readRefresh(dashDir, readFile);
  return after?.pending === false;
}

async function tickBody({ env, now, readFile, stateDir, dashDir, log, lockHeld }) {
  const prev = readLatest(stateDir, now, log);
  const base = { switchOn: true, lockHeld };
  const early = skipReason({ ...base, exportExit: 0, exportLockHeld: false });
  if (early) { log(`skip: ${early}`); return { code: 0, action: 'skip', reason: early }; }

  const ex = runExport(env, []);
  const stamp = { lastTickAt: now().toISOString() };
  if (ex.exit !== 0 || ex.lockHeld) {
    const d = decide({ ...base, exportExit: ex.exit, exportLockHeld: ex.lockHeld });
    log(`skip: ${d.reason}${ex.output ? ` | ${ex.output.split('\n').slice(-2).join(' / ')}` : ''}`);
    patchState(stateDir, { ...stamp, lastResult: `skip: ${d.reason}` }, now, log);
    return { code: 0, ...d };
  }

  const refresh = readRefresh(dashDir, readFile);
  const newHash = hashSet(readSets(dashDir, readFile));
  const d = decide({ ...base, exportExit: 0, exportLockHeld: false, refresh, lastUploadedHash: prev.lastUploadedHash, newHash });
  const patch = { ...stamp, lastExportKey: refresh?.key ?? null, lastHash: newHash };
  if (d.action === 'clear') {
    const ok = clearAndConfirm({ env, dashDir, key: refresh.key, readFile, log });
    patch.lastResult = ok ? 'cleared' : 'clear-mismatch';
  } else {
    patch.lastResult = d.action === 'leave-pending' ? 'changed-pending' : `skip: ${d.reason}`;
  }
  log(`${d.action}: ${d.reason} -> ${patch.lastResult} (hash ${newHash.slice(0, 12)}, key ${patch.lastExportKey})`);
  patchState(stateDir, patch, now, log);
  return { code: 0, ...d, result: patch.lastResult, hash: newHash };
}

/**
 * One tick. Returns {code, action, reason, ...}; code is the process exit code (0 for every skip, 1 for an error).
 * Seams for tests: `env`, `now`, `readFile`.
 */
export async function runTick({ env = process.env, now = () => new Date(), readFile = readFileSync } = {}) {
  const stateDir = stateDirOf(env);
  const dashDir = dashDirOf(env);
  if (!existsSync(join(stateDir, 'auto-enabled'))) {
    return { code: 0, action: 'skip', reason: skipReason({ switchOn: false }) };
  }
  const logDir = logDirOf(env);
  const log = makeLog(logDir, now);
  pruneLogs(logDir, now);
  const lock = acquireLock(stateDir, now());
  try {
    return await tickBody({ env, now, readFile, stateDir, dashDir, log, lockHeld: !lock.ok });
  } catch (e) {
    const reason = e?.message ?? String(e);
    log(`ERROR: ${reason}`);
    if (lock.ok) {
      try { patchState(stateDir, { lastTickAt: now().toISOString(), lastResult: `error: ${reason}` }, now, log); } catch { /* keep the first error */ }
    }
    return { code: 1, action: 'error', reason };
  } finally {
    if (lock.ok) lock.release();
  }
}

// ---------------------------------------------------------------- command line

export async function main(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--record-upload');
  if (i >= 0) {
    const dir = argv[i + 1];
    if (!dir || dir.startsWith('--')) throw new Error('--record-upload needs a folder: --record-upload <dir>');
    const hash = recordUploadDir(dir, { env });
    console.log(`recorded lastUploadedHash ${hash} from ${resolve(dir)}`);
    return 0;
  }
  return (await runTick({ env })).code;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`fleetops-auto-tick: ${e.message}`);
    process.exit(1);
  });
}
