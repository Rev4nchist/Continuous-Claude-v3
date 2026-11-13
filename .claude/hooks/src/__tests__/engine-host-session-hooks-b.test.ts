/**
 * Engine-run hook silence, Tier B (card engine-run-hook-silence-2, seat word of 16:55 CST):
 * under cursor-agent five SessionStart hooks print their neutral output and add no context.
 * In Claude Code they keep today's behaviour. Contract note:
 * .claudedocs/e2e-engine-run-hook-silence-2/01-contract-note.md.
 *
 * Each hook is bundled from src with esbuild and run as a child process with a real stdin payload
 * (the pattern of engine-host-hooks.test.ts). dist is not used: the test must see src.
 *
 * Child env (T2): VITEST, CCV3_*, LANE_*, CLAUDE_* and the DB URL variables removed; PATH is an
 * EMPTY temp folder, so no docker, git or uv binary can start; TEMP, TMP, TMPDIR, HOME, USERPROFILE,
 * CLAUDE_PROJECT_DIR and the child cwd are a fresh temp folder. So no run touches the live
 * database, the live ~/.claude, docker or the network.
 *
 * Each fixture forces the ORIGINAL hook to print context, so each Cursor test fails on the original
 * (red) and the Claude control asserts the exact original stdout (T1: it passes on red and green).
 *
 * How the change can fail, one test each (the source change that breaks it):
 *  1. session-start-docker prints context for a Cursor payload -> remove its isEngineHost call
 *  2. session-start-docker loses the context for Claude Code -> the helper matches 'SessionStart'
 *  3. session-start-continuity prints a message or prunes the ledger under the engine -> remove its call
 *  4. session-start-continuity loses message or prune for Claude Code -> the helper matches 'SessionStart'
 *  5. roadmap-reconcile prints values.system under the engine -> remove its isEngineHost call
 *  6. roadmap-reconcile loses values.system for Claude Code -> the helper matches 'SessionStart'
 *  7. hook-health-monitor prints the MISSING report under the engine -> remove its isEngineHost call
 *  8. hook-health-monitor loses the report for Claude Code -> the helper matches 'SessionStart'
 *  9. lane-context runs the lease UPDATE under the engine -> remove its isEngineHost call
 * 10. lane-context stops the lease UPDATE for Claude Code -> the helper matches 'SessionStart'
 *
 * lane-context case: the board banner needs a database. The bundle swaps 'pg' for a stub Client
 * that appends each query text to a temp log and returns no rows; a dummy URL makes the hook reach
 * it. Nothing connects. The printing path (a banner with lanes) is NOT reached: the stub has no rows.
 * The proof is the lease UPDATE, the first database write, which the guard must skip.
 *
 * session-start-docker case: only the "Docker not available" print is reached (empty PATH). The
 * start and compose prints need a real docker and are not run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { build, type Plugin } from 'esbuild';

const HOOKS_ROOT = resolve(__dirname, '..', '..');
const BANNER = "import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);";
const HOOKS = [
  'session-start-docker', 'session-start-continuity', 'roadmap-reconcile', 'hook-health-monitor', 'lane-context',
] as const;
type Hook = (typeof HOOKS)[number];

const PG_STUB = `
import { appendFileSync } from 'node:fs';
const log = (line) => appendFileSync(process.env.PG_STUB_LOG, line + '\\n');
export class Client {
  constructor() {}
  on() { return this; }
  async connect() { log('CONNECT'); }
  async query(text) { log(String(text).replace(/\\s+/g, ' ').trim()); return { rows: [], rowCount: 0 }; }
  async end() {}
}
export default { Client };
`;

const DROP_PREFIXES = ['VITEST', 'CCV3_', 'LANE_', 'CLAUDE_', 'PG', 'COORDINATION_']; // PG* and COORDINATION_*: no live database through the env
const DROP_KEYS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL', 'POSTGRES_URL'];

let root: string;
const bundles = {} as Record<Hook, string>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'engine-host-session-b-'));
  const stub = join(root, 'pg-stub.mjs');
  writeFileSync(stub, PG_STUB);
  const stubPg: Plugin = {
    name: 'stub-pg',
    setup(b) {
      b.onResolve({ filter: /^pg$/ }, () => ({ path: stub }));
    },
  };
  for (const hook of HOOKS) {
    const outfile = join(root, 'bundle', `${hook}.mjs`); // lane-context main() runs only when argv[1] holds its name
    await build({
      entryPoints: [join(HOOKS_ROOT, 'src', `${hook}.ts`)],
      bundle: true, platform: 'node', format: 'esm', outfile,
      external: ['better-sqlite3'], banner: { js: BANNER }, logLevel: 'silent',
      plugins: hook === 'lane-context' ? [stubPg] : [],
    });
    bundles[hook] = outfile;
  }
}, 60000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Run { status: number | null; stdout: string; stderr: string; tmp: string }

/** Run a bundled hook with its own temp folder as cwd, tmpdir, home and project dir, and an empty PATH. */
function runHook(hook: Hook, payload: object, tmp: string, extraEnv: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const up = k.toUpperCase();
    if (DROP_PREFIXES.some((p) => up.startsWith(p))) continue;
    if (DROP_KEYS.includes(up) || up === 'PATH') continue; // Windows carries 'Path'
    env[k] = v;
  }
  const emptyBin = join(tmp, 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });
  Object.assign(env, {
    PATH: emptyBin, TEMP: tmp, TMP: tmp, TMPDIR: tmp, HOME: tmp, USERPROFILE: tmp, CLAUDE_PROJECT_DIR: tmp,
    CCV3_HOOK_TRACE: '0', LANE_CONTEXT_ERROR_LOG: join(tmp, 'lane-context-errors.jsonl'),
  }, extraEnv);
  const r = spawnSync(process.execPath, [bundles[hook]], {
    input: JSON.stringify(payload), encoding: 'utf-8', env, cwd: tmp, timeout: 20000,
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '', tmp };
}

const newTmp = () => mkdtempSync(join(root, 'run-'));
const sid = (tag: string) => `ehb-${tag}-${process.pid}-${Date.now()}`;

/** Cursor-shaped: the keys cursor-agent sends at sessionStart (trace of run d7e5b3f1), nothing else. */
const cursorStart = (sessionId: string) => ({ hook_event_name: 'sessionStart', session_id: sessionId });
/** Claude-shaped: PascalCase event, source, cwd, transcript path. */
const claudeStart = (sessionId: string, tmp: string, source = 'startup') => ({
  hook_event_name: 'SessionStart', session_id: sessionId, source, cwd: tmp,
  transcript_path: join(tmp, 'transcript.jsonl'),
});

const CONTINUE = '{"result":"continue"}';
const T = 30000;

describe('session-start-docker (empty PATH: docker absent)', () => {
  it('Cursor payload: prints the neutral output, no additionalContext', () => {
    const r = runHook('session-start-docker', cursorStart(sid('dk-cursor')), newTmp());
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(CONTINUE);
  }, T);

  it('Claude payload: prints the original "Docker not available" context', () => {
    const tmp = newTmp();
    const r = runHook('session-start-docker', claudeStart(sid('dk-claude'), tmp), tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Docker not available - memory system will use SQLite fallback' },
    }));
  }, T);
});

describe('session-start-continuity (legacy ledger fixture)', () => {
  const LEDGER = [
    '# Continuity', '## Goal', 'Ship the demo', '## State', '- Now: write tests', '',
    '### Session Ended (2026-11-01 10:00)', '- Reason: clear', '', '## Notes', 'none', '',
  ].join('\n');

  function seed(tmp: string): string {
    const dir = join(tmp, 'thoughts', 'ledgers');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'CONTINUITY_CLAUDE-demo.md');
    writeFileSync(file, LEDGER);
    return file;
  }

  it('Cursor payload: prints the neutral output and does not prune the ledger', () => {
    const tmp = newTmp();
    const ledger = seed(tmp);
    const r = runHook('session-start-continuity', cursorStart(sid('sc-cursor')), tmp);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(CONTINUE);
    expect(readFileSync(ledger, 'utf-8')).toBe(LEDGER);
  }, T);

  it('Claude payload (resume): prints the original message and prunes the ledger', () => {
    const tmp = newTmp();
    const ledger = seed(tmp);
    const r = runHook('session-start-continuity', claudeStart(sid('sc-claude'), tmp, 'resume'), tmp);
    expect(r.status).toBe(0);
    const message = '[resume] Loaded: CONTINUITY_CLAUDE-demo.md | Goal: Ship the demo | Focus: write tests';
    expect(r.stdout).toBe(JSON.stringify({ result: 'continue', message, systemMessage: message }));
    // Control for the Cursor test: the prune runs here, so "ledger unchanged" there is not vacuous.
    expect(readFileSync(ledger, 'utf-8')).not.toContain('### Session Ended');
  }, T);
});

describe('roadmap-reconcile (ROADMAP with 2 missing files)', () => {
  function seed(tmp: string): void {
    writeFileSync(join(tmp, 'ROADMAP.md'), '# Roadmap\n\n**Files:** missing-a.ts, missing-b.ts\n');
  }

  it('Cursor payload: prints {}, no values.system', () => {
    const tmp = newTmp();
    seed(tmp);
    const r = runHook('roadmap-reconcile', cursorStart(sid('rr-cursor')), tmp);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('{}');
  }, T);

  it('Claude payload: prints the original values.system', () => {
    const tmp = newTmp();
    seed(tmp);
    const r = runHook('roadmap-reconcile', claudeStart(sid('rr-claude'), tmp), tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(JSON.stringify({
      values: {
        system: 'ROADMAP Reconciliation (2 issues):\n'
          + '- Referenced file "missing-a.ts" does not exist\n- Referenced file "missing-b.ts" does not exist',
      },
    }));
  }, T);
});

describe('hook-health-monitor (settings.json names a missing dist)', () => {
  function seed(tmp: string): void {
    const dir = join(tmp, '.claude');
    mkdirSync(dir, { recursive: true });
    const dist = join(tmp, 'x', 'hooks', 'dist', 'gone.mjs').replace(/\\/g, '/');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: [dist] }] }] },
    }));
  }

  it('Cursor payload: prints the neutral output, no MISSING report', () => {
    const tmp = newTmp();
    seed(tmp);
    const r = runHook('hook-health-monitor', cursorStart(sid('hm-cursor')), tmp);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(CONTINUE);
  }, T);

  it('Claude payload: prints the original MISSING report', () => {
    const tmp = newTmp();
    seed(tmp);
    const r = runHook('hook-health-monitor', claudeStart(sid('hm-claude'), tmp), tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(JSON.stringify({
      result: 'continue',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Hook Health: 0/1 healthy, 1 issue found\n- MISSING: gone.mjs (fix: npm run build)',
      },
    }));
  }, T);
});

describe('lane-context (pg stubbed: query log, no connection)', () => {
  // A dummy URL: the stub Client never opens a socket. 'stub.invalid' cannot resolve in any case.
  const pgEnv = (tmp: string) => ({ DATABASE_URL: 'postgres://stub@stub.invalid:5432/stub', PG_STUB_LOG: join(tmp, 'pg-queries.log') });

  it('Cursor payload: prints {} and sends no query (no lease UPDATE, no watermark write)', () => {
    const tmp = newTmp();
    const r = runHook('lane-context', cursorStart(sid('lc-cursor')), tmp, pgEnv(tmp));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('{}');
    expect(existsSync(join(tmp, 'pg-queries.log'))).toBe(false);
  }, T);

  it('Cursor postToolUse payload: prints {} and sends no query (no mid-turn DM read)', () => {
    const tmp = newTmp();
    const payload = { hook_event_name: 'postToolUse', session_id: sid('lc-cursor-post'), tool_name: 'Shell' };
    const r = runHook('lane-context', payload, tmp, pgEnv(tmp));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('{}');
    expect(existsSync(join(tmp, 'pg-queries.log'))).toBe(false);
  }, T);

  it('Claude PostToolUse control: prints {} and does reach the database stub', () => {
    const tmp = newTmp();
    const payload = { hook_event_name: 'PostToolUse', session_id: sid('lc-claude-post'), tool_name: 'Bash', cwd: tmp };
    const r = runHook('lane-context', payload, tmp, pgEnv(tmp));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{}');
    // Control for the Cursor case above: the stub log exists, so "no query" there is not vacuous.
    expect(existsSync(join(tmp, 'pg-queries.log'))).toBe(true);
  }, T);

  it('Claude payload: prints the original {} and runs the lease UPDATE', () => {
    const tmp = newTmp();
    const r = runHook('lane-context', claudeStart(sid('lc-claude'), tmp), tmp, pgEnv(tmp));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{}');
    // Control for the Cursor test: the stub log exists and holds the lease renewal.
    expect(readFileSync(join(tmp, 'pg-queries.log'), 'utf-8')).toContain('UPDATE agentic_os.lane SET lease_expires_at');
  }, T);
});
