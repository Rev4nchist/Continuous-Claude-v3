/**
 * Engine-run hook silence, session hooks part A: under cursor-agent (the review engine) four
 * session hooks print `{}` (identity-probe prints nothing) and do NO side effect. In Claude Code
 * they keep today's behaviour. Contract: .claudedocs/e2e-engine-run-hook-silence-2/01-contract-note.md;
 * seat ruling: .claudedocs/re-execution/contracts/engine-run-hook-silence-2-seat-ruling.md (T1, T2, T4).
 *
 * Each hook is bundled from src with esbuild (the flags of `npm run build`, minus the trace inject)
 * and run as a child process with a real stdin payload. dist is not used: the test must see src.
 *
 * Child env (T2): VITEST, every DB URL variable, PG*, CCV3_*, CLAUDE_*, COORDINATION_* and the
 * BRAINTRUST_* ids removed. HOME, USERPROFILE, TEMP, TMP, TMPDIR, CLAUDE_PROJECT_DIR, CLAUDE_OPC_DIR
 * and the child cwd point into a fresh temp folder. PATH holds only a temp shim folder, so no real
 * tldr, uv or git can start. No run touches the live DB, the live ~/.claude or the real global id file.
 *
 * Cursor shape: the keys cursor-agent sends at sessionStart (inferred from run d7e5b3f1): only
 * hook_event_name and session_id. No source, no cwd.
 *
 * Side effects are checked by a recursive listing of the run folder before and after the run.
 * Cursor runs: the listing does not change. Claude controls: the files the original writes appear.
 * DB touch: with no URL, the pg client prints one stderr WARN ("... unset; skipping database work")
 * before any query. That line is the observable for "the hook tried the DB".
 *
 * How the change can fail, one test each (the source change that breaks it):
 *  1. session-register registers a Cursor sessionStart (banner, name file, id file, activity
 *     file, DB attempt) -> remove its isEngineHost call, or move it below writeSessionId
 *  2. session-register runs the start path at a Cursor sessionEnd (finding F1) -> remove its call
 *  3. session-register loses the banner or the files for Claude Code -> the helper matches 'SessionStart'
 *  4. session-register stops stamping endedAt at a Claude SessionEnd -> the helper matches 'SessionEnd'
 *  5. init-check warms tldr, runs uv lazy_tree.py or prints context for Cursor -> remove its call
 *  6. init-check loses its output or the tree step for Claude Code -> the helper matches 'SessionStart'
 *  7. memory-loaders tries the DB, writes the marker or the print-state file, or prints for Cursor
 *     -> remove its call
 *  8. memory-loaders runs its guard after the ~/.claude project check (T4) -> stdin read moved back
 *  9. memory-loaders loses the health line or the marker for Claude Code -> the helper matches 'SessionStart';
 *     or its ~/.claude project skip changes with the stdin read moved first -> the skip moved below a side effect
 * 10. identity-probe writes a row (with the raw DB URL) for Cursor -> remove its call
 * 11. identity-probe stops writing its row for Claude Code -> the helper matches 'SessionStart'
 *
 * Not observable here (said, not faked):
 *  - The memory-loaders backup spawn: it needs DB rows (probe kind ok, rows > 0). No DB in a test.
 *  - The DB upsert itself and the pg SELECT: only the WARN before them is observable.
 *  - The tldr daemon warm on Windows is seen only as the spawn-hidden relay's "cannot start" record
 *    (tldr.exe is not on the shim PATH); on other platforms a `tldr` shim records the call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve } from 'path';
import { build } from 'esbuild';

const HOOKS_ROOT = resolve(__dirname, '..', '..');
const BANNER = "import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);";
const HOOKS = ['session-register', 'session-start-init-check', 'session-start-memory-loaders', 'identity-probe'] as const;
type Hook = (typeof HOOKS)[number];
const IS_WIN = process.platform === 'win32';
const DB_WARN = 'skipping database work';

/** Records each call of a shimmed command; for uv it also writes the tree file lazy_tree.py writes. */
const SHIM_JS = `
const fs = require('fs'); const path = require('path');
const [name, ...args] = process.argv.slice(2);
if (process.env.EH_SHIM_LOG) fs.appendFileSync(process.env.EH_SHIM_LOG, JSON.stringify({ name, args }) + '\\n');
const i = args.indexOf('--project');
if (name === 'uv' && i >= 0 && args[i + 1]) {
  const dir = path.join(args[i + 1], '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge-tree.json'), JSON.stringify({ shim: true }));
}
`;

let root: string;
let binDir: string;
let opcDir: string;
const bundles = {} as Record<Hook, string>;

function writeShim(name: string, shimJs: string): void {
  if (IS_WIN) {
    writeFileSync(join(binDir, `${name}.cmd`), `@"${process.execPath}" "${shimJs}" ${name} %*\r\n`);
  } else {
    const file = join(binDir, name);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${shimJs}" ${name} "$@"\n`);
    chmodSync(file, 0o755);
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'engine-host-session-a-'));
  binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const shimJs = join(root, 'shim.cjs');
  writeFileSync(shimJs, SHIM_JS);
  writeShim('uv', shimJs);
  if (!IS_WIN) writeShim('tldr', shimJs); // Windows spawns tldr.exe with no shell: a .cmd shim is never found
  opcDir = join(root, 'opc');
  mkdirSync(join(opcDir, 'scripts', 'core'), { recursive: true });
  writeFileSync(join(opcDir, 'scripts', 'core', 'lazy_tree.py'), '# fixture: the uv shim stands in for the run\n');
  for (const hook of HOOKS) {
    const outfile = join(root, 'bundle', `${hook}.mjs`); // init-check main() runs only when argv[1] holds its name
    await build({
      entryPoints: [join(HOOKS_ROOT, 'src', `${hook}.ts`)],
      bundle: true, platform: 'node', format: 'esm', outfile,
      external: ['better-sqlite3'], banner: { js: BANNER }, logLevel: 'silent',
    });
    bundles[hook] = outfile;
  }
}, 60000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Dirs { run: string; home: string; project: string; temp: string }

function makeDirs(): Dirs {
  const run = mkdtempSync(join(root, 'run-'));
  const dirs = { run, home: join(run, 'home'), project: join(run, 'project'), temp: join(run, 'temp') };
  for (const d of [dirs.home, dirs.project, dirs.temp]) mkdirSync(d, { recursive: true });
  return dirs;
}

const STRIP = /^(VITEST|CCV3_|CLAUDE_|COORDINATION_|BRAINTRUST_|PG|GIT_)|^(CONTINUOUS_CLAUDE_DB_URL|DATABASE_URL|OPC_POSTGRES_URL|POSTGRES_URL|CC_TERMINAL_ID|PATH)$/i;

interface Run { status: number | null; stdout: string; stderr: string; parsed: any }

/** Run a bundled hook in the temp dirs. `projectDir` overrides CLAUDE_PROJECT_DIR and the cwd. */
function runHook(hook: Hook, payload: object, dirs: Dirs, projectDir = dirs.project): Run {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  Object.assign(env, {
    PATH: binDir, HOME: dirs.home, USERPROFILE: dirs.home, TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp,
    CLAUDE_PROJECT_DIR: projectDir, CLAUDE_OPC_DIR: opcDir, GIT_CEILING_DIRECTORIES: root,
    CCV3_AUTONAME: '1', CCV3_HOOK_TRACE: '0', CCV3_GUARD_DECISIONS_LOG: join(dirs.run, 'guard-decisions.jsonl'),
    CCV3_SPAWN_HIDDEN_LOG: join(dirs.run, 'spawn-hidden.log'), EH_SHIM_LOG: join(dirs.run, 'shim.jsonl'),
  });
  const r = spawnSync(process.execPath, [bundles[hook]], {
    input: JSON.stringify(payload), encoding: 'utf-8', env, cwd: projectDir, timeout: 20000,
  });
  let parsed: any;
  try { parsed = JSON.parse((r.stdout || '').trim()); } catch { /* leave undefined */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', parsed };
}

/** Every file and folder under `dir`, as sorted relative paths (folders end in '/'). */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p).replace(/\\/g, '/');
      if (statSync(p).isDirectory()) { out.push(`${rel}/`); walk(p); } else out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

/** A uuid, as both hosts send: session-identity refuses a non-hex id as a file name. */
const sid = (_tag: string) => randomUUID();
const cursorPayload = (event: string, sessionId: string) => ({ hook_event_name: event, session_id: sessionId });
const claudeStart = (sessionId: string, cwd: string) => ({
  hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup', cwd,
  transcript_path: join(cwd, 'no-transcript.jsonl'),
});

const T = 30000;

describe('session-register', () => {
  const regFiles = (dirs: Dirs, s: string) => ({
    identity: join(dirs.home, '.claude', 'state', 'identity', `${s}.json`),
    idFile: join(dirs.home, '.claude', '.coordination-session-id'),
    activity: join(dirs.home, '.claude', 'cache', 'session-activity', `${s}.json`),
  });

  it('Cursor sessionStart: prints {}, no DB attempt, no identity, id or activity file', () => {
    const dirs = makeDirs();
    const before = listing(dirs.run);
    const r = runHook('session-register', cursorPayload('sessionStart', sid('sr-cursor')), dirs);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.stderr).not.toContain(DB_WARN);
    expect(listing(dirs.run)).toEqual(before);
  }, T);

  it('Cursor sessionEnd (F1): prints {} and does not run the start path', () => {
    const dirs = makeDirs();
    const before = listing(dirs.run);
    const r = runHook('session-register', cursorPayload('sessionEnd', sid('sr-cursor-end')), dirs);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.stderr).not.toContain(DB_WARN);
    expect(listing(dirs.run)).toEqual(before);
  }, T);

  it('Claude SessionStart control: banner and sessionTitle, DB attempt, identity, id and activity files', () => {
    const dirs = makeDirs();
    const s = sid('sr-claude');
    const r = runHook('session-register', claudeStart(s, dirs.project), dirs);
    expect(r.status).toBe(0);
    expect(r.parsed?.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(r.parsed?.hookSpecificOutput?.additionalContext).toContain('MULTI-SESSION COORDINATION ACTIVE');
    expect(typeof r.parsed?.hookSpecificOutput?.sessionTitle).toBe('string');
    expect(r.stderr).toContain(DB_WARN);
    const f = regFiles(dirs, s);
    expect(readFileSync(f.idFile, 'utf-8')).toBe(s);
    expect(JSON.parse(readFileSync(f.identity, 'utf-8')).endedAt).toBeNull();
    expect(existsSync(f.activity)).toBe(true);
  }, T);

  it('Claude SessionEnd control: prints {}, stamps endedAt, writes no id or activity file', () => {
    const dirs = makeDirs();
    const s = sid('sr-claude-end');
    const r = runHook('session-register', { hook_event_name: 'SessionEnd', session_id: s, reason: 'other' }, dirs);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    const f = regFiles(dirs, s);
    expect(typeof JSON.parse(readFileSync(f.identity, 'utf-8')).endedAt).toBe('string');
    expect(existsSync(f.idFile)).toBe(false);
    expect(existsSync(f.activity)).toBe(false);
  }, T);
});

describe('session-start-init-check (uv and tldr through PATH shims)', () => {
  const seed = (dirs: Dirs) => writeFileSync(join(dirs.project, 'package.json'), '{"name":"eh-fixture"}\n');
  const tldrSeen = (dirs: Dirs) => {
    const relay = join(dirs.run, 'spawn-hidden.log');
    const shim = join(dirs.run, 'shim.jsonl');
    return (IS_WIN && existsSync(relay) && readFileSync(relay, 'utf-8').includes('tldr'))
      || (existsSync(shim) && readFileSync(shim, 'utf-8').includes('"tldr"'));
  };

  it('Cursor sessionStart (code project): prints {}, no tldr warm, no uv run, no tree file', async () => {
    const dirs = makeDirs();
    seed(dirs);
    const before = listing(dirs.run);
    const r = runHook('session-start-init-check', cursorPayload('sessionStart', sid('ic-cursor')), dirs);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.stderr).not.toContain('warming tldr daemon');
    expect(r.stderr).not.toContain('Generating knowledge tree');
    await sleep(1500); // the warm is detached: give a stray relay time to leave its record
    expect(tldrSeen(dirs)).toBe(false);
    expect(listing(dirs.run)).toEqual(before);
  }, T);

  it('Claude SessionStart control: warms tldr, runs uv lazy_tree.py, prints additionalContext', async () => {
    const dirs = makeDirs();
    seed(dirs);
    const r = runHook('session-start-init-check', claudeStart(sid('ic-claude'), dirs.project), dirs);
    expect(r.status).toBe(0);
    expect(r.parsed?.hookSpecificOutput?.additionalContext).toContain('Missing: ROADMAP.md');
    expect(r.stderr).toContain('warming tldr daemon');
    expect(r.stderr).toContain('[ok] Knowledge tree generated');
    const shim = readFileSync(join(dirs.run, 'shim.jsonl'), 'utf-8');
    expect(shim).toContain('lazy_tree.py');
    expect(existsSync(join(dirs.project, '.claude', 'knowledge-tree.json'))).toBe(true);
    expect(await waitFor(() => tldrSeen(dirs))).toBe(true);
  }, T);
});

describe('session-start-memory-loaders', () => {
  const stateDir = (dirs: Dirs) => join(dirs.home, '.claude', 'state');
  /** A recent doctor report with one FAIL, so the hook writes its print-state file. */
  const seedReport = (dirs: Dirs) => {
    const dir = join(stateDir(dirs), 'health');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'latest.json'), JSON.stringify({
      ts: new Date().toISOString(), summary: { fail: 1, warn: 0 },
      checks: [{ section: 'fixture', check: 'eh', status: 'FAIL', detail: 'engine-host fixture' }],
    }));
  };

  it('Cursor sessionStart: prints {}, no DB attempt, no marker, no print-state file', () => {
    const dirs = makeDirs();
    seedReport(dirs);
    const before = listing(dirs.run);
    const r = runHook('session-start-memory-loaders', cursorPayload('sessionStart', sid('ml-cursor')), dirs);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(r.stderr).not.toContain(DB_WARN);
    expect(listing(dirs.run)).toEqual(before);
  }, T);

  it('T4: Cursor sessionStart with the project inside ~/.claude: the guard runs first and prints {}', () => {
    const dirs = makeDirs();
    const inHome = join(dirs.home, '.claude', 'x');
    mkdirSync(inHome, { recursive: true });
    const before = listing(dirs.run);
    const r = runHook('session-start-memory-loaders', cursorPayload('sessionStart', sid('ml-home')), dirs, inHome);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(listing(dirs.run)).toEqual(before);
  }, T);

  it('Claude SessionStart control with the project inside ~/.claude: {"result":"continue"}, no DB attempt, no file', () => {
    const dirs = makeDirs();
    const inHome = join(dirs.home, '.claude', 'x');
    mkdirSync(inHome, { recursive: true });
    const before = listing(dirs.run);
    const r = runHook('session-start-memory-loaders', claudeStart(sid('ml-home-claude'), inHome), dirs, inHome);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{"result":"continue"}');
    expect(r.stderr).not.toContain(DB_WARN);
    expect(listing(dirs.run)).toEqual(before);
  }, T);

  it('Claude SessionStart control: health line in additionalContext and systemMessage, DB attempt, marker, print-state', () => {
    const dirs = makeDirs();
    seedReport(dirs);
    const r = runHook('session-start-memory-loaders', claudeStart(sid('ml-claude'), dirs.project), dirs);
    expect(r.status).toBe(0);
    expect(r.parsed?.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(r.parsed?.hookSpecificOutput?.additionalContext).toMatch(/memory/i);
    expect(r.parsed?.systemMessage).toContain('harness: 1 fail');
    expect(r.stderr).toContain(DB_WARN);
    expect(existsSync(join(stateDir(dirs), 'memory-health-last-session'))).toBe(true);
    expect(existsSync(join(stateDir(dirs), 'health', 'last-session-print.txt'))).toBe(true);
  }, T);
});

describe('identity-probe', () => {
  const probeLog = (dirs: Dirs) => join(dirs.project, '.claude', 'logs', 'identity-probe.jsonl');

  it('Cursor sessionStart: prints nothing and writes no identity-probe.jsonl row', () => {
    const dirs = makeDirs();
    const before = listing(dirs.run);
    const r = runHook('identity-probe', cursorPayload('sessionStart', sid('ip-cursor')), dirs);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(probeLog(dirs))).toBe(false);
    expect(listing(dirs.run)).toEqual(before);
  }, T);

  it('Claude SessionStart control: prints nothing and appends one row', () => {
    const dirs = makeDirs();
    const s = sid('ip-claude');
    const r = runHook('identity-probe', claudeStart(s, dirs.project), dirs);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const rows = readFileSync(probeLog(dirs), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('SessionStart');
    expect(rows[0].payload_session_id).toBe(s);
    expect(rows[0].env.DATABASE_URL).toBeNull(); // T2: the child never sees the live URL
  }, T);
});
