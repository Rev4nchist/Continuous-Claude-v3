/**
 * Spawn tests for the esbuild --inject boot module. Each test bundles a tiny fixture hook with the SAME inject flag
 * the real build uses, runs it as a child process, and reads the trace row it wrote.
 *
 * How the injected tracer can fail, one test each:
 *   no row, or a wrong field (name, event, tool, startupMs, durationMs, code, exitCode, source)
 *   the real exit code is lost when the hook calls process.exit
 *   the session id is lost for one of the three stdin read styles (readFileSync(0), 'data' events, for await)
 *   the boot module builds process.stdin, so a later readFileSync(0) hits EAGAIN on Linux (44 hooks read that way)
 *   the stdout wrap changes bytes, drops a callback, or the writer failing changes stdout or the exit code
 *   a row holds command text or a token (payload, stdout or an error message)
 *   a program outside the hot set writes while the mode is hot; off or CCV3_HOOK_TRACE=0 still writes
 *   a spawned test (VITEST set) writes a row
 *   a run of a bundle outside <home>/.claude/hooks/dist (the repo dist) writes a live row
 *   the readFileSync wrapper shows through: fs.readFileSync.name or .length differs from the plain run
 *   a session_id after the first 64 KB of the payload changes the row from the documented null
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { build } from 'esbuild';

const HOOKS_ROOT = resolve(__dirname, '..', '..');
const BOOT = join(HOOKS_ROOT, 'src', 'lib', 'trace-boot.ts');
const BANNER = "import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);";
const TOKEN = 'gh' + 'p_' + 'FAKEtokenFAKEtokenFAKEtoken0123456789'; // joined at runtime: secret scanners flag literals
const COMMAND = `curl -H "Authorization: ${TOKEN}" https://example.invalid/secret-path`;

const FIXTURES: Record<string, string> = {
  // readFileSync(0) through a named import. Prints what the boot module touched.
  'fx-read0': `import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(0, 'utf8'));
const st = globalThis.__CCV3_HOOK_TRACE_V1__ || {};
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' }, got: p.session_id, stdinTouched: !!st.stdinTouched }));`,
  // The same, through the default fs object.
  'fx-read0-default': `import fs from 'fs';
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify({ got: p.session_id }));`,
  'fx-data': `let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => { console.log(JSON.stringify({ got: JSON.parse(buf).session_id })); });`,
  'fx-forawait': `let buf = '';
for await (const c of process.stdin) buf += c;
console.log(JSON.stringify({ got: JSON.parse(buf).session_id }));`,
  'fx-exit3': `process.stdout.write('{"ok":true}\\n');
process.exit(3);`,
  'fx-sleep': `import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
await new Promise((r) => setTimeout(r, 150));
console.log('{}');`,
  'fx-write': `process.stdout.write('first ');
process.stdout.write(Buffer.from('second '), () => { console.log('callback-ran'); });
console.log('x'.repeat(20000));`,
  'fx-throw': `throw new Error("Command failed: " + ${JSON.stringify(COMMAND)});`,
  'fx-quiet': `console.log('{}');`,
  // What a hook (or a bundled dependency) could read off the wrapped function.
  'fx-fsid': `import fs from 'fs';
import { readFileSync } from 'node:fs';
console.log(JSON.stringify({ name: fs.readFileSync.name, length: fs.readFileSync.length, same: fs.readFileSync === readFileSync }));`,
  // Named like a real hot program, so hot mode keeps it.
  'destructive-command-guard': `console.log('{}');`,
};

let dir: string;
let withTrace: Record<string, string> = {};
let without: Record<string, string> = {};
let liveDist = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'trace-spawn-'));
  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(FIXTURES)) {
    const entry = join(src, `${name}.mjs`);
    writeFileSync(entry, text);
    for (const [target, inject] of [[withTrace, [BOOT]], [without, []]] as const) {
      const out = join(dir, inject.length ? 'traced' : 'plain', `${name}.mjs`);
      await build({
        entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, inject: [...inject],
        banner: { js: BANNER }, logLevel: 'silent',
      });
      target[name] = out;
    }
  }
  // The same traced hot fixture, placed where the live copy lives: <home>/.claude/hooks/dist (HOME is `dir` in every run).
  liveDist = join(dir, '.claude', 'hooks', 'dist', 'destructive-command-guard.mjs');
  await build({
    entryPoints: [join(src, 'destructive-command-guard.mjs')], bundle: true, platform: 'node', format: 'esm', outfile: liveDist, inject: [BOOT],
    banner: { js: BANNER }, logLevel: 'silent',
  });
}, 60000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Run { status: number | null; stdout: string; stderr: string; rows: Array<Record<string, any>>; traceDir: string }
interface Opts { stdin?: string; delayMs?: number; mode?: string | null; env?: Record<string, string | undefined>; bundle?: 'traced' | 'plain' | 'live'; traceDir?: string }

function run(name: string, o: Opts = {}): Promise<Run> {
  const traceDir = o.traceDir ?? mkdtempSync(join(dir, 'tdir-'));
  const modeFile = join(mkdtempSync(join(dir, 'mode-')), 'hook-trace-mode');
  if (o.mode !== null) writeFileSync(modeFile, o.mode ?? 'all');
  // The vitest config sets CCV3_HOOK_TRACE=0 for every test; these tests want rows, so it goes unless a test sets it.
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.VITEST;
  delete base.VITEST_WORKER_ID;
  delete base.CCV3_HOOK_TRACE;
  const env: NodeJS.ProcessEnv = { ...base, HOME: dir, USERPROFILE: dir, CCV3_HOOK_TRACE_DIR: traceDir, CCV3_HOOK_TRACE_MODE_FILE: modeFile, ...o.env };
  for (const [k, v] of Object.entries(o.env ?? {})) if (v === undefined) delete env[k];
  const file = o.bundle === 'live' ? liveDist : (o.bundle === 'plain' ? without : withTrace)[name];
  return new Promise((done) => {
    const child = spawn(process.execPath, [file], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => done({ status, stdout, stderr, rows: readRows(traceDir), traceDir }));
    const payload = o.stdin ?? '';
    if (o.delayMs) setTimeout(() => { child.stdin.end(payload); }, o.delayMs); else child.stdin.end(payload);
  });
}

function readRows(traceDir: string): Array<Record<string, any>> {
  if (!existsSync(traceDir) || !readdirSync(traceDir).length) return [];
  return readdirSync(traceDir).filter((f) => /^hook-trace-.*\.jsonl$/.test(f))
    .flatMap((f) => readFileSync(join(traceDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

const payload = (extra: object = {}) => JSON.stringify({ session_id: 'sess-abc-123', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: COMMAND }, ...extra });

describe('row fields', () => {
  it('writes one row with the payload fields, startupMs, durationMs and source probe', async () => {
    const r = await run('fx-sleep', { stdin: payload() });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row).toMatchObject({ name: 'fx-sleep', event: 'PreToolUse', tool: 'Bash', sessionId: 'sess-abc-123', code: 0, exitCode: 0, source: 'probe', error: null });
    expect(row.startupMs).toBeGreaterThan(0);
    expect(row.startupMs).toBeLessThan(5000);
    expect(row.durationMs).toBeGreaterThanOrEqual(140);
    expect(Object.keys(row).sort()).toEqual(['code', 'durationMs', 'error', 'event', 'exitCode', 'name', 'out', 'sessionId', 'source', 'startupMs', 'tool', 'ts']);
  });
  it('a hook that never reads stdin has sessionId, event and tool null', async () => {
    const quiet = await run('fx-quiet', { stdin: payload() });
    expect(quiet.rows[0]).toMatchObject({ sessionId: null, event: null, tool: null });
  });
});

describe('exit code', () => {
  it('keeps exit code 3 through process.exit, keeps the stdout line, and records code 3 with exitCode 1', async () => {
    const r = await run('fx-exit3', { stdin: payload() });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('{"ok":true}\n');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ code: 3, exitCode: 1 });
  });
  it('an uncaught throw still exits 1 with its message on stderr, and the row has no command text', async () => {
    const r = await run('fx-throw', { stdin: payload() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Command failed');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].exitCode).toBe(1);
    expect(String(r.rows[0].error).startsWith('Error')).toBe(true);
    expect(JSON.stringify(r.rows[0])).not.toContain(TOKEN);
    expect(JSON.stringify(r.rows[0])).not.toContain('example.invalid');
  });
});

describe('session id from every stdin read style', () => {
  for (const name of ['fx-read0', 'fx-read0-default', 'fx-data', 'fx-forawait']) {
    it(`${name} gets the payload session id into the row and still reads the payload`, async () => {
      const r = await run(name, { stdin: payload() });
      expect(JSON.parse(r.stdout.trim()).got).toBe('sess-abc-123');
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].sessionId).toBe('sess-abc-123');
    });
  }
});

describe('lazy stdin', () => {
  it('a hook doing readFileSync(0) with a payload that lands 300 ms late still works, and the boot module never built process.stdin', async () => {
    const r = await run('fx-read0', { stdin: payload(), delayMs: 300 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.got).toBe('sess-abc-123');
    expect(out.stdinTouched).toBe(false);
    expect(r.rows[0].sessionId).toBe('sess-abc-123');
  });
  it('a hook that uses process.stdin builds it through the tapped getter (stdinTouched true after use)', async () => {
    const r = await run('fx-data', { stdin: payload() });
    expect(r.rows[0].sessionId).toBe('sess-abc-123');
  });
});

describe('stdout', () => {
  it('is byte-identical with and without the tracer, callbacks included, and exit code is equal', async () => {
    const a = await run('fx-write', { stdin: payload() });
    const b = await run('fx-write', { stdin: payload(), bundle: 'plain' });
    expect(a.stdout).toBe(b.stdout);
    expect(a.status).toBe(b.status);
    expect(a.stdout).toContain('callback-ran');
  });
  it('the row out is deny for a deny output', async () => {
    const r = await run('fx-read0', { stdin: payload() });
    expect(r.rows[0].out).toBe('deny');
  });
  it('a trace dir that cannot be written leaves stdout and exit code unchanged', async () => {
    const blocker = join(dir, 'blocker-file');
    writeFileSync(blocker, 'x');
    const a = await run('fx-exit3', { stdin: payload(), traceDir: join(blocker, 'sub') });
    const b = await run('fx-exit3', { stdin: payload(), bundle: 'plain' });
    expect(a.stdout).toBe(b.stdout);
    expect(a.status).toBe(b.status);
    expect(a.rows).toHaveLength(0);
  });
});

describe('no secrets', () => {
  it('the trace file holds neither the command nor the token nor the url', async () => {
    const r = await run('fx-read0', { stdin: payload() });
    const text = readdirSync(r.traceDir).map((f) => readFileSync(join(r.traceDir, f), 'utf8')).join('');
    expect(text.length).toBeGreaterThan(0);
    for (const bad of [TOKEN, 'example.invalid', 'curl', 'Authorization']) expect(text).not.toContain(bad);
  });
});

describe('mode and hot set', () => {
  it('a missing mode file means hot: a hot program writes, another program does not', async () => {
    const hot = await run('destructive-command-guard', { stdin: payload(), mode: null });
    expect(hot.rows).toHaveLength(1);
    const cold = await run('fx-quiet', { stdin: payload(), mode: null });
    expect(cold.rows).toHaveLength(0);
  });
  it('mode all writes for any program', async () => {
    expect((await run('fx-quiet', { stdin: payload(), mode: 'all' })).rows).toHaveLength(1);
  });
  it('mode off writes nothing, even for a hot program, and the hook output is unchanged', async () => {
    const r = await run('destructive-command-guard', { stdin: payload(), mode: 'off' });
    expect(r.rows).toHaveLength(0);
    expect(r.stdout).toBe('{}\n');
  });
  it('CCV3_HOOK_TRACE=0 writes nothing even in mode all', async () => {
    expect((await run('fx-quiet', { stdin: payload(), mode: 'all', env: { CCV3_HOOK_TRACE: '0' } })).rows).toHaveLength(0);
  });
  it('a cold program in hot mode never builds process.stdin or wraps fs (the output is the same and no row is written)', async () => {
    const r = await run('fx-read0', { stdin: payload(), mode: 'hot' });
    expect(JSON.parse(r.stdout.trim()).got).toBe('sess-abc-123');
    expect(r.rows).toHaveLength(0);
  });
});

describe('under vitest', () => {
  it('a spawned process with the VITEST key set writes no row', async () => {
    const traceDir = mkdtempSync(join(dir, 'tdir-v-'));
    writeFileSync(join(traceDir, 'mode'), 'all');
    // control: the same bundle and mode without VITEST writes a row
    expect((await run('fx-quiet', { stdin: payload(), mode: 'all' })).rows).toHaveLength(1);
    const child = await new Promise<number | null>((done) => {
      const c = spawn(process.execPath, [withTrace['fx-quiet']], { env: { ...process.env, CCV3_HOOK_TRACE: undefined, VITEST: '', CCV3_HOOK_TRACE_DIR: traceDir, CCV3_HOOK_TRACE_MODE_FILE: join(traceDir, 'mode') }, stdio: 'ignore' });
      c.on('close', done);
    });
    expect(child).toBe(0);
    expect(readRows(traceDir)).toHaveLength(0);
  });
});

describe('source from the script location', () => {
  // No probe env at all: only the path of the script says whether the row is live. HOME is `dir`, so the rows land in <dir>/.claude/cache.
  const noProbeEnv = { CCV3_HOOK_TRACE_DIR: undefined, CCV3_GUARD_DECISIONS_LOG: undefined, CCV3_GUARD_SOURCE: undefined };
  const homeCache = () => join(dir, '.claude', 'cache');

  it('a bundle under <home>/.claude/hooks/dist writes source live (control)', async () => {
    rmSync(homeCache(), { recursive: true, force: true });
    const r = await run('destructive-command-guard', { stdin: payload(), bundle: 'live', traceDir: homeCache(), env: noProbeEnv });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].source).toBe('live');
  });
  it('the same hook run from outside that folder (the repo dist) writes source probe, not live', async () => {
    rmSync(homeCache(), { recursive: true, force: true });
    const r = await run('destructive-command-guard', { stdin: payload(), bundle: 'traced', traceDir: homeCache(), env: noProbeEnv });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].source).toBe('probe');
  });
});

describe('fs.readFileSync identity', () => {
  it('the traced run reports the same name, length and source shape as the plain run', async () => {
    const a = await run('fx-fsid', { stdin: payload() });
    const b = await run('fx-fsid', { stdin: payload(), bundle: 'plain' });
    const t = JSON.parse(a.stdout.trim());
    const p = JSON.parse(b.stdout.trim());
    expect(p.name).toBe('readFileSync');
    expect(p.length).toBe(2);
    expect(t.name).toBe(p.name);
    expect(t.length).toBe(p.length);
    expect(t.same).toBe(true);
  });
});

describe('late session id (documented limit)', () => {
  it('a session_id after the first 64 KB of the payload gives sessionId null, and the hook still reads it', async () => {
    const late = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x'.repeat(70000) }, session_id: 'late-sess-1' });
    const r = await run('fx-read0', { stdin: late });
    expect(JSON.parse(r.stdout.trim()).got).toBe('late-sess-1');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].sessionId).toBeNull();
    expect(r.rows[0]).toMatchObject({ event: 'PreToolUse', tool: 'Bash' });
  });
});
