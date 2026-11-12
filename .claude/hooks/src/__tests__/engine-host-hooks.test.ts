/**
 * Engine-run hook silence: under cursor-agent (the review engine) three hooks print `{}` and add
 * no context. In Claude Code they keep today's behaviour. Design note:
 * .claudedocs/e2e-engine-run-hook-silence/01-design-note.md, seat ruling C1 to C4.
 *
 * Each hook is bundled from src with esbuild (the flags of `npm run build`, minus the trace inject)
 * and run as a child process with a real stdin payload. dist is not used: the test must see src.
 *
 * Child env: VITEST and the three DB URL variables removed; TEMP, TMP, TMPDIR, HOME, USERPROFILE
 * and CLAUDE_PROJECT_DIR point at a fresh temp folder; the guard-decisions log goes to a temp file.
 * So no run touches the live DB, the live logs or the real tmpdir.
 *
 * How the change can fail, one test each (the source change that breaks it):
 *  1. epistemic-reminder still injects for a Cursor payload -> remove its isEngineHost call
 *  2. epistemic-reminder writes the session flag under the engine -> move the check after the flag write
 *  3. epistemic-reminder loses the reminder for Claude Code -> the helper matches 'PostToolUse'
 *  4. periodic-extract prints values.system under the engine -> remove its isEngineHost call
 *  5. periodic-extract touches the DB or writes state under the engine -> move the check after line 186
 *  6. periodic-extract loses the checkpoint for Claude Code -> the helper matches 'PostToolUse'
 *  7. tldr-read-enforcer denies for a Cursor-shaped payload -> remove its isEngineHost call
 *  8. tldr-read-enforcer stops denying for Claude Code -> the helper matches 'PreToolUse'
 *
 * tldr-read-enforcer case: the daemon answer is INJECTED. The bundle swaps ./lib/daemon-client.js
 * for a stub (daemon up, extract returns ten functions). The live daemon is never used, so the
 * test does not depend on whether a daemon runs on the machine.
 *
 * Design conflict (pinned below): tldr-read-enforcer is a PreToolUse hook. 'preToolUse' is not in
 * the helper's set because no run has proven that name. So for a real cursor-agent PreToolUse event
 * the new check is a no-op. The Cursor-shaped tldr test uses 'postToolUse', the only proven
 * camelCase tool-event name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { build, type Plugin } from 'esbuild';

const HOOKS_ROOT = resolve(__dirname, '..', '..');
// .claude/cache is gitignored. The tldr fixture must NOT sit under os.tmpdir(): on Linux that path
// holds '/tmp/', which the hook's ALLOWED_DIRS prefilter lets through, so no deny could happen.
const CACHE_ROOT = resolve(HOOKS_ROOT, '..', 'cache');
const BANNER = "import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);";
const HOOKS = ['epistemic-reminder', 'periodic-extract', 'tldr-read-enforcer'] as const;
type Hook = (typeof HOOKS)[number];

const DAEMON_STUB = `
export const probeDaemonFast = async () => true;
export const isDaemonUnreachableCached = () => false;
export const cacheDaemonUnreachable = () => {};
export const extractDaemon = async () => ({
  functions: Array.from({ length: 10 }, (_, i) => ({
    name: 'engineHostFixtureFunction' + i, params: ['a', 'b'], line_number: i * 10 + 1,
    docstring: 'Fixture function number ' + i + ' for the engine-host test.',
  })),
  classes: [],
});
export const contextDaemon = async () => null;
export const cfgDaemon = async () => null;
export const dfgDaemon = async () => null;
export const sliceDaemon = async () => null;
`;

let root: string;
let fixtureDir: string;
let bigFile: string;
const bundles = {} as Record<Hook, string>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'engine-host-hooks-'));
  const stub = join(root, 'daemon-client-stub.mjs');
  writeFileSync(stub, DAEMON_STUB);
  const stubDaemon: Plugin = {
    name: 'stub-daemon-client',
    setup(b) {
      b.onResolve({ filter: /[/\\]daemon-client(\.js)?$/ }, () => ({ path: stub }));
    },
  };
  for (const hook of HOOKS) {
    const outfile = join(root, 'bundle', `${hook}.mjs`); // tldr main() runs only when argv[1] holds its name
    await build({
      entryPoints: [join(HOOKS_ROOT, 'src', `${hook}.ts`)],
      bundle: true, platform: 'node', format: 'esm', outfile,
      external: ['better-sqlite3'], banner: { js: BANNER }, logLevel: 'silent',
      plugins: hook === 'tldr-read-enforcer' ? [stubDaemon] : [],
    });
    bundles[hook] = outfile;
  }
  mkdirSync(CACHE_ROOT, { recursive: true });
  fixtureDir = mkdtempSync(join(CACHE_ROOT, 'engine-host-fx-'));
  bigFile = join(fixtureDir, 'engine_host_fixture.ts');
  writeFileSync(bigFile, `// fixture\n${'export const x = 1;\n'.repeat(600)}`); // ~11 KB, above the 8000-byte floor
}, 60000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

interface Run { status: number | null; stdout: string; stderr: string; parsed: any; tmp: string }

/** Run a bundled hook with its own temp folder as tmpdir, home and project dir. */
function runHook(hook: Hook, payload: object, tmp = mkdtempSync(join(root, 'run-'))): Run {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('VITEST')) continue;
    if (['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL'].includes(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    TEMP: tmp, TMP: tmp, TMPDIR: tmp, HOME: tmp, USERPROFILE: tmp, CLAUDE_PROJECT_DIR: tmp,
    CCV3_GUARD_DECISIONS_LOG: join(tmp, 'guard-decisions.jsonl'), CCV3_HOOK_TRACE: '0',
  });
  const r = spawnSync(process.execPath, [bundles[hook]], {
    input: JSON.stringify(payload), encoding: 'utf-8', env, timeout: 20000,
  });
  let parsed: any;
  try { parsed = JSON.parse((r.stdout || '').trim()); } catch { /* leave undefined */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', parsed, tmp };
}

const sid = (tag: string) => `eh-${tag}-${process.pid}-${Date.now()}`;

/** Cursor-shaped: the fields cursor-agent sent in run d7e5b3f1 (camelCase event, null transcript). */
const cursorPayload = (event: string, tool: string, sessionId: string, toolInput: object) => ({
  session_id: sessionId, hook_event_name: event, tool_name: tool, tool_input: toolInput,
  transcript_path: null, cwd: process.cwd(),
});
/** Claude-shaped: PascalCase event, a transcript path. */
const claudePayload = (event: string, tool: string, sessionId: string, toolInput: object) => ({
  session_id: sessionId, hook_event_name: event, tool_name: tool, tool_input: toolInput,
  transcript_path: '/home/u/.claude/projects/x/s.jsonl', cwd: process.cwd(), permission_mode: 'default',
});

const T = 30000;

describe('epistemic-reminder', () => {
  const grep = { pattern: 'try.*catch', path: 'src/' };

  it('Cursor payload (postToolUse, fresh session): prints {} and writes no flag file', () => {
    const s = sid('er-cursor');
    const r = runHook('epistemic-reminder', cursorPayload('postToolUse', 'Grep', s, grep));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(existsSync(join(r.tmp, `claude-epistemic-reminder-${s}.flag`))).toBe(false);
  }, T);

  it('Claude payload (PostToolUse, fresh session): injects the reminder and writes the flag', () => {
    const s = sid('er-claude');
    const r = runHook('epistemic-reminder', claudePayload('PostToolUse', 'Grep', s, grep));
    expect(r.status).toBe(0);
    expect(r.parsed?.hookSpecificOutput?.additionalContext).toContain('EPISTEMIC REMINDER');
    // Control: the flag lands in the temp folder, so the Cursor test's "no flag" is not vacuous.
    expect(existsSync(join(r.tmp, `claude-epistemic-reminder-${s}.flag`))).toBe(true);
  }, T);
});

describe('periodic-extract', () => {
  /** Seed the counter at 49 so the next call is call 50, the checkpoint. */
  function seed(tmp: string, s: string): string {
    const file = join(tmp, `claude-periodic-extract-${s}.json`);
    writeFileSync(file, JSON.stringify({ count: 49, lastExtract: 0, tools: Array(49).fill('Read') }));
    return file;
  }

  it('Cursor payload at call 50: prints {}, no state write, no DB touch', () => {
    const s = sid('pe-cursor');
    const tmp = mkdtempSync(join(root, 'run-'));
    const stateFile = seed(tmp, s);
    const before = readFileSync(stateFile, 'utf-8');
    const r = runHook('periodic-extract', cursorPayload('postToolUse', 'Read', s, { file_path: 'a.ts' }), tmp);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    // No state write: the seeded file is byte-identical. No state read is shown indirectly: a read
    // of count 49 would reach 50 and print values.system.
    expect(readFileSync(stateFile, 'utf-8')).toBe(before);
    // No DB touch: touchSessionActivity writes this throttle file BEFORE its query.
    expect(existsSync(join(tmp, `claude-session-touch-${s}.json`))).toBe(false);
  }, T);

  it('Claude payload at call 50: prints values.system, writes count 50, reaches the DB touch', () => {
    const s = sid('pe-claude');
    const tmp = mkdtempSync(join(root, 'run-'));
    const stateFile = seed(tmp, s);
    const r = runHook('periodic-extract', claudePayload('PostToolUse', 'Read', s, { file_path: 'a.ts' }), tmp);
    expect(r.status).toBe(0);
    expect(r.parsed?.values?.system).toContain('50 tool uses');
    expect(JSON.parse(readFileSync(stateFile, 'utf-8')).count).toBe(50);
    // Control for the Cursor test: the touch path runs and leaves its throttle file (DB vars unset).
    expect(existsSync(join(tmp, `claude-session-touch-${s}.json`))).toBe(true);
  }, T);
});

describe('tldr-read-enforcer (daemon answer injected by stub)', () => {
  const read = () => ({ file_path: bigFile });

  it('Claude payload (PreToolUse): denies with the TLDR summary', () => {
    const r = runHook('tldr-read-enforcer', claudePayload('PreToolUse', 'Read', sid('tl-claude'), read()));
    expect(r.status).toBe(0);
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('TLDR Context');
    expect(r.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain('engineHostFixtureFunction0');
  }, T);

  it('Cursor-shaped payload (postToolUse, the proven camelCase name): prints {} and allows the Read', () => {
    const r = runHook('tldr-read-enforcer', cursorPayload('postToolUse', 'Read', sid('tl-cursor'), read()));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
  }, T);

  it('DESIGN CONFLICT pin: preToolUse (not proven) still denies; the check is a no-op until the probe proves the name', () => {
    const r = runHook('tldr-read-enforcer', cursorPayload('preToolUse', 'Read', sid('tl-pre'), read()));
    expect(r.parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
  }, T);
});
