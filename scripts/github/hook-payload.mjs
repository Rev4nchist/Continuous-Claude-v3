#!/usr/bin/env node
// Hook payload gate (card coord-hook-payload-gate). For each changed hook, feed every saved fixture of
// .claude/hooks/fixtures/<hook>/ to .claude/hooks/dist/<hook>.mjs and check the exit code, the output shape and the decision.
// Tests: scripts/github/hook-payload.test.mjs. Design: .claudedocs/coordination/2026-11-22-hook-payload-gate-design.md.
//
// Run:   node scripts/github/hook-payload.mjs [--root <repo>] [--base fork/main | --paths a,b] [--save <dir>]
// Exit:  0 pass (a hook with no fixture is a NOTE), 1 a FAIL line, 2 a usage error.
//
// Rules this file keeps:
// - The payload goes on stdin. Nothing from a fixture goes into argv or a shell string.
// - Every run is isolated: a temp HOME and temp paths for the guard log, the decisions file, the lane registry and the file claims.
//   A fixture env can add keys but never set an isolation key (validateFixture).
// - The live guard log is shared with other sessions, so it is never compared by size or time. Each run uses the session id
//   `fixture-<runId>`; the gate fails only when a row of the live log carries that id.
// - Paths in fixtures use "/" and the node binary is process.execPath, so the same run works on Linux CI.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Guards whose change must come with a fixture (seat ruling 2026-11-22, Q2). The list lands in the same PR as their fixtures. */
export const REQUIRES_FIXTURE = ['decision-gate', 'pre-pr-gate', 'coderabbit-guard', 'destructive-command-guard', 'package-install-guard'];

/** Env keys the runner sets for every run. A fixture env may not name them. */
export const ISOLATION_KEYS = ['CCV3_GUARD_DECISIONS_LOG', 'HOME', 'USERPROFILE', 'CCV3_DECISIONS_FILE', 'LANE_REGISTRY_PATH', 'CCV3_FILE_CLAIMS_STATE_DIR', 'CCV3_HOOK_TRACE'];

export const SHAPES = ['gate', 'inject', 'continue', 'empty'];
const DECISIONS = ['allow', 'deny', 'ask'];
const TIMEOUT_MS = 15000;
const LIVE_LOG_TAIL_BYTES = 4 * 1024 * 1024;
const LIVE_TOKEN = '__LIVE__';

const HOOKS = '.claude/hooks';
const posix = (p) => String(p).replace(/\\/g, '/');

/** The shapes of .claude/hooks/src/shared/output.ts: gate, inject, continue; a hook that prints nothing (or {}) is empty. */
export function classifyOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return 'empty';
  let obj;
  try { obj = JSON.parse(text); } catch { return 'other'; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'other';
  if (Object.keys(obj).length === 0) return 'empty';
  const hso = obj.hookSpecificOutput;
  // shared/output.ts: hookEventName is required in hookSpecificOutput. Claude Code ignores the object without it, so it is not a result.
  if (hasEventName(hso)) {
    if (typeof hso.permissionDecision === 'string') return 'gate';
    if (typeof hso.additionalContext === 'string') return 'inject';
  }
  if (obj.result === 'continue') return 'continue';
  return 'other';
}

const hasEventName = (hso) => !!hso && typeof hso === 'object' && typeof hso.hookEventName === 'string' && hso.hookEventName !== '';

function decisionOf(stdout) {
  try {
    const hso = JSON.parse(stdout)?.hookSpecificOutput;
    return hasEventName(hso) ? hso.permissionDecision ?? null : null;
  } catch { return null; }
}

/**
 * Which fixtures a change set selects.
 * hooks: hook names to run (only those with a fixture folder). missing: a REQUIRES_FIXTURE hook that changed and has no fixture.
 * noFixture: other changed hooks with no fixture (a NOTE).
 */
export function planFixtures(changedPaths, { fixtureHooks = [] } = {}) {
  const have = new Set(fixtureHooks);
  const named = new Set();
  let shared = false;
  for (const raw of changedPaths ?? []) {
    const p = posix(raw);
    let m;
    if (p.startsWith(`${HOOKS}/src/shared/`)) shared = true;
    else if ((m = p.match(new RegExp(`^${HOOKS.replace('.', '\\.')}/src/([^/]+)\\.ts$`)))) named.add(m[1]);
    else if ((m = p.match(new RegExp(`^${HOOKS.replace('.', '\\.')}/dist/([^/]+)\\.mjs$`)))) named.add(m[1]);
    else if ((m = p.match(new RegExp(`^${HOOKS.replace('.', '\\.')}/fixtures/([^/]+)/`)))) named.add(m[1]);
  }
  const hooks = new Set([...named].filter((n) => have.has(n)));
  if (shared) for (const n of have) hooks.add(n);
  const absent = [...named].filter((n) => !have.has(n));
  return {
    hooks: [...hooks].sort(),
    missing: absent.filter((n) => REQUIRES_FIXTURE.includes(n)).sort(),
    noFixture: absent.filter((n) => !REQUIRES_FIXTURE.includes(n)).sort(),
  };
}

const USER_PATH = /[\\/](?:Users|home)[\\/]/;
const DRIVE_PATH = /\b[A-Za-z]:[\\/]/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SECRET = /gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/;

function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsOf(v, out));
  return out;
}

/** The problems of one parsed fixture file. Scrub rules: seat ruling 2026-11-22, changes 2 to 4. [] means valid. */
export function validateFixture(fx, label) {
  const problems = [];
  const bad = (msg) => problems.push(`${label}: ${msg}`);
  if (!fx || typeof fx !== 'object' || Array.isArray(fx)) return [`${label}: fixture is not an object`];
  if (typeof fx.event !== 'string' || !fx.event) bad('event is missing');
  const input = fx.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('input is missing');
  else {
    const sid = input.session_id;
    if (typeof sid !== 'string' || !(sid === 'fixture' || sid.startsWith('fixture-'))) bad('input.session_id must be "fixture" (the runner makes it unique)');
    for (const s of stringsOf(input)) {
      if (s === sid) continue;
      if (USER_PATH.test(s)) bad('a user path (/Users/ or /home/) is in the input');
      if (DRIVE_PATH.test(s)) bad('a drive path is in the input: use / paths that also work on Linux');
      if (/\\[A-Za-z]/.test(s)) bad('a backslash path is in the input: use "/"');
      if (UUID.test(s)) bad('a UUID (a real session id?) is in the input');
      if (SECRET.test(s)) bad('a secret pattern is in the input');
    }
    if (typeof sid === 'string' && UUID.test(sid)) bad('input.session_id is a UUID (a real session id?)');
  }
  const ex = fx.expect;
  if (!ex || typeof ex !== 'object') bad('expect is missing');
  else {
    if (!SHAPES.includes(ex.shape)) bad(`expect.shape must be one of ${SHAPES.join(', ')}`);
    if (ex.exit !== undefined && !(Array.isArray(ex.exit) && ex.exit.length > 0 && ex.exit.every(Number.isInteger))) bad('expect.exit must be a list of integers');
    if (ex.decision !== undefined && !DECISIONS.includes(ex.decision)) bad(`expect.decision must be one of ${DECISIONS.join(', ')}`);
    // A gate result with no stated decision passes on shape alone, so a guard that turned a deny into an allow would still pass.
    if (ex.shape === 'gate' && ex.decision === undefined) bad('expect.decision is required when expect.shape is gate');
  }
  if (fx.env !== undefined) {
    if (!fx.env || typeof fx.env !== 'object' || Array.isArray(fx.env)) bad('env must be an object');
    else for (const [k, v] of Object.entries(fx.env)) {
      if (ISOLATION_KEYS.includes(k)) bad(`env may not set ${k} (an isolation key)`);
      if (typeof v !== 'string') bad(`env ${k} must be a string`);
    }
  }
  return problems;
}

const fixtureDir = (root, hook) => path.join(root, '.claude', 'hooks', 'fixtures', hook);

/** Hook names that have a fixture folder. */
export function listFixtureHooks(root) {
  const dir = path.join(root, '.claude', 'hooks', 'fixtures');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory()).sort();
}

/** Reads and validates the fixture files of the named hooks. fixtures: [{ hook, label, caseName, fixture }]. */
export function loadFixtures(root, names) {
  const fixtures = [];
  const problems = [];
  for (const hook of names) {
    const dir = fixtureDir(root, hook);
    if (!existsSync(dir)) continue;
    if (!existsSync(path.join(root, '.claude', 'hooks', 'src', `${hook}.ts`))) problems.push(`${hook}: fixture folder has no source file .claude/hooks/src/${hook}.ts`);
    const before = fixtures.length;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const caseName = file.slice(0, -'.json'.length);
      const label = `${hook}/${caseName}`;
      let fixture;
      try { fixture = JSON.parse(readFileSync(path.join(dir, file), 'utf8')); } catch (e) { problems.push(`${label}: fixture is not valid JSON (${e.message})`); continue; }
      const p = validateFixture(fixture, label);
      if (p.length) problems.push(...p);
      else fixtures.push({ hook, label, caseName, fixture });
    }
    // A folder alone is not coverage: a guard that must have fixtures and loads none would pass with nothing checked.
    if (REQUIRES_FIXTURE.includes(hook) && fixtures.length === before) problems.push(`${hook}: requires a fixture (REQUIRES_FIXTURE) and its folder has no fixture file that passed the checks`);
  }
  return { fixtures, problems };
}

function isolatedEnv(tmp, fixtureEnv, liveLogPath) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE_CODE_') && v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(fixtureEnv ?? {})) env[k] = v === LIVE_TOKEN ? String(liveLogPath ?? '') : v;
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  Object.assign(env, {
    CCV3_GUARD_DECISIONS_LOG: path.join(tmp, 'guard-decisions.jsonl'),
    HOME: home, USERPROFILE: home,
    CCV3_DECISIONS_FILE: path.join(tmp, 'decisions.jsonl'),
    LANE_REGISTRY_PATH: path.join(tmp, 'lane-registry.json'),
    CCV3_FILE_CLAIMS_STATE_DIR: path.join(tmp, 'claims'),
    CCV3_HOOK_TRACE: '0',
  });
  return env;
}

/**
 * Some guards judge a command against the git state of their working folder (decision-gate ran `git remote -v` and said it
 * could not verify the tap in a plain folder). The hook runs in a throwaway repo with a `fork` remote: no network, no checkout.
 */
function makeThrowawayRepo(dir, home) {
  mkdirSync(home, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' } });
  try {
    git(['init', '-q']);
    git(['remote', 'add', 'fork', 'https://github.com/Rev4nchist/Continuous-Claude-v3.git']);
    // Guards read decisions.enforce from review-router.config.json found from the working folder upward. With no file decision-gate only warns.
    writeFileSync(path.join(dir, 'review-router.config.json'), JSON.stringify({ decisions: { enforce: true, enforcePush: true } }) + '\n');
  } catch { /* a missing git leaves a plain folder: the guards then say so in their own output and the fixture fails with a clear shape */ }
}

/** Runs one fixture against dist/<hook>.mjs. Never throws. Returns { ok, problems, exit, shape, decision, stdout, stderr }. */
export async function runFixture({ root, hook, label, fixture, runId, liveLogPath }) {
  const dist = path.join(root, '.claude', 'hooks', 'dist', `${hook}.mjs`);
  if (!existsSync(dist)) return { ok: false, problems: [`${label}: dist file missing (.claude/hooks/dist/${hook}.mjs): build the hooks`], exit: null, shape: null, decision: null, stdout: '', stderr: '' };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hookpayload-'));
  try {
    const input = { ...fixture.input, session_id: `fixture-${runId}` };
    const work = path.join(tmp, 'work');
    mkdirSync(work, { recursive: true });
    makeThrowawayRepo(work, path.join(tmp, 'home'));
    const res = await new Promise((resolve) => {
      let stdout = ''; let stderr = ''; let timedOut = false; let spawnError = null;
      const child = spawn(process.execPath, [dist], { cwd: work, env: isolatedEnv(tmp, fixture.env, liveLogPath), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, TIMEOUT_MS);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { spawnError = e; });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, spawnError }); });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
    const problems = [];
    const want = fixture.expect;
    const shape = classifyOutput(res.stdout);
    const decision = decisionOf(res.stdout);
    if (res.spawnError) problems.push(`${label}: could not start node (${res.spawnError.message})`);
    else if (res.timedOut) problems.push(`${label}: timed out after ${TIMEOUT_MS / 1000} s`);
    else {
      const exits = want.exit ?? [0];
      if (!exits.includes(res.code)) problems.push(`${label}: exit ${res.code}, expected ${exits.join(' or ')}${res.stderr.trim() ? ` (stderr: ${res.stderr.trim().split('\n')[0].slice(0, 120)})` : ''}`);
      if (shape !== want.shape) problems.push(`${label}: shape ${shape}, expected ${want.shape}${shape === 'other' ? ' (output is not JSON, or a shape the harness ignores)' : ''}`);
      else if (want.decision && decision !== want.decision) problems.push(`${label}: decision ${decision}, expected ${want.decision}`);
    }
    return { ok: problems.length === 0, problems, exit: res.code, shape, decision, stdout: res.stdout, stderr: res.stderr };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** True when a row of the live guard log carries this run's session id. Reads only the tail. A missing file is false. */
export function liveLogHasRun(liveLogPath, runId) {
  try {
    const size = statSync(liveLogPath).size;
    const len = Math.min(size, LIVE_LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(liveLogPath, 'r');
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    return buf.toString('utf8').includes(`fixture-${runId}`);
  } catch { return false; }
}

export function defaultLiveLog() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return process.env.CCV3_GUARD_DECISIONS_LOG || path.join(home, '.claude', 'logs', 'guard-decisions.jsonl');
}

/** The whole gate. Returns { failed, lines, summary, count, hooks }. lines hold FAIL and NOTE lines only. */
export async function runPayloadGate({ root, changed, runId = randomUUID().slice(0, 8), liveLogPath = defaultLiveLog(), saveDir = null, today = new Date().toISOString().slice(0, 10) }) {
  const started = Date.now();
  const lines = [];
  const fixtureHooks = listFixtureHooks(root);
  const plan = planFixtures(changed, { fixtureHooks });
  for (const n of plan.missing) lines.push(`FAIL ${n}: requires a fixture (REQUIRES_FIXTURE) and has none in .claude/hooks/fixtures/${n}/`);
  for (const n of plan.noFixture) lines.push(`NOTE ${n}: no fixture in .claude/hooks/fixtures/${n}/ (add one when you touch this hook)`);
  const { fixtures, problems } = loadFixtures(root, plan.hooks);
  for (const p of problems) lines.push(`FAIL ${p}`);
  let failed = plan.missing.length > 0 || problems.length > 0;
  if (saveDir && fixtures.length) mkdirSync(saveDir, { recursive: true });
  for (const f of fixtures) {
    const r = await runFixture({ root, hook: f.hook, label: f.label, fixture: f.fixture, runId, liveLogPath });
    for (const p of r.problems) lines.push(`FAIL ${p}`);
    if (!r.ok) failed = true;
    if (saveDir) {
      const out = path.join(saveDir, `${today}-hook-payload-${f.hook}-${f.caseName}.json`);
      writeFileSync(out, JSON.stringify({ hook: f.hook, case: f.caseName, ok: r.ok, exit: r.exit, shape: r.shape, decision: r.decision, stdout: r.stdout }, null, 2) + '\n');
    }
  }
  if (fixtures.length && liveLogHasRun(liveLogPath, runId)) {
    failed = true;
    lines.push(`FAIL live guard log has a row with session id fixture-${runId}: a fixture run reached the live log (isolation broke)`);
  }
  const summary = `hook-payload: ${fixtures.length} fixtures run for ${new Set(fixtures.map((f) => f.hook)).size} hooks in ${Date.now() - started} ms`;
  return { failed, lines, summary, count: fixtures.length, hooks: plan.hooks };
}

/** Committed (base...HEAD), staged, unstaged and untracked paths. A staged-only file is in none of the other three. */
export function changedFromGit(root, base) {
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...run(['diff', '--name-only', `${base}...HEAD`]), ...run(['diff', '--name-only', '--cached']), ...run(['diff', '--name-only']), ...run(['ls-files', '--others', '--exclude-standard'])])];
}

async function main(argv) {
  const opt = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), base: 'fork/main', paths: null, save: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opt.root = path.resolve(argv[++i] ?? '');
    else if (a === '--base') opt.base = argv[++i] ?? '';
    else if (a === '--paths') opt.paths = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--save') opt.save = path.resolve(argv[++i] ?? '');
    else { console.error(`hook-payload: unknown argument ${a}`); return 2; }
  }
  let changed;
  try { changed = opt.paths ?? changedFromGit(opt.root, opt.base); } catch (e) { console.error(`hook-payload: git failed (${e.message.split('\n')[0]})`); return 2; }
  const r = await runPayloadGate({ root: opt.root, changed, saveDir: opt.save ?? path.join(opt.root, '.claude', 'cache', 'e2e') });
  for (const l of r.lines) console.log(l);
  console.log(r.summary);
  return r.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
