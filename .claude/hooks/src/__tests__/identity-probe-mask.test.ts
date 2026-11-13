/**
 * identity-probe-mask.test.ts: the probe row never holds the database address (card identity-probe-mask-db-url).
 *
 * Seat ruling 2026-11-12: write the fixed text "[set]" for a non-empty DATABASE_URL and null for an unset or empty one.
 * No scheme, host, port or database name. The row needs presence only.
 *
 * Ways it can fail (one test each):
 *  1. the raw value, its user, its password, its host or its database name reaches the file -> assert none of the four texts
 *  2. the value is not exactly "[set]"
 *  3. an unset variable stops being null
 *  4. an empty variable becomes "[set]" or its own text
 *  5. another key or value changes for a Claude session (keys, order, other env markers) -> compare with a control row
 *  6. the Cursor host still writes nothing (PR 532 guard unchanged)
 *  7. an event outside the four Cursor names (an unknown host event name) writes a row with no secret
 *
 * Mutation (checked by hand): restore `process.env[k] ?? null` for DATABASE_URL -> tests 1 and 2 fail.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { build } from 'esbuild';

const HOOKS_ROOT = resolve(__dirname, '..', '..');
const BANNER = "import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);";
const T = 30000;

const USER = 'maskuser7731';
const PASS = 'maskpass9942';
const HOST = 'maskhost5518.example.invalid';
const DBNAME = 'maskdb6620';
const RAW = `postgres://${USER}:${PASS}@${HOST}:5432/${DBNAME}?sslmode=require`;
const STRIP = /^(VITEST|CCV3_|CLAUDE_|COORDINATION_|BRAINTRUST_|PG|GIT_|CC_TERMINAL_ID)|^(CONTINUOUS_CLAUDE_DB_URL|DATABASE_URL|OPC_POSTGRES_URL|POSTGRES_URL)$/i;

let root: string;
let bundle: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'identity-probe-mask-'));
  bundle = join(root, 'bundle', 'identity-probe.mjs');
  await build({
    entryPoints: [join(HOOKS_ROOT, 'src', 'identity-probe.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile: bundle,
    external: ['better-sqlite3'], banner: { js: BANNER }, logLevel: 'silent',
  });
}, 60000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Run { status: number | null; stdout: string; stderr: string; log: string; rows: any[] }

/** Run the bundled probe in a temp project. `db` undefined leaves DATABASE_URL unset. */
function run(payload: object, db?: string): Run {
  const dir = mkdtempSync(join(root, 'run-'));
  const project = join(dir, 'project');
  for (const d of ['home', 'project', 'temp']) mkdirSync(join(dir, d), { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: join(dir, 'home'), USERPROFILE: join(dir, 'home'), TEMP: join(dir, 'temp'), TMP: join(dir, 'temp'),
    TMPDIR: join(dir, 'temp'), CLAUDE_PROJECT_DIR: project, GIT_CEILING_DIRECTORIES: root, CCV3_HOOK_TRACE: '0',
  });
  if (db !== undefined) env.DATABASE_URL = db;
  const r = spawnSync(process.execPath, [bundle], { input: JSON.stringify(payload), encoding: 'utf-8', env, cwd: project, timeout: 20000 });
  const logPath = join(project, '.claude', 'logs', 'identity-probe.jsonl');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
  const rows = log.trim() ? log.trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', log, rows };
}

const claudeStart = () => ({
  hook_event_name: 'SessionStart', session_id: randomUUID(), source: 'startup', cwd: tmpdir(),
});

describe('identity-probe masks DATABASE_URL', () => {
  it('1. none of user, password, host, database name or the raw value is in the file', () => {
    const r = run(claudeStart(), RAW);
    expect(r.status).toBe(0);
    expect(r.rows).toHaveLength(1);
    for (const text of [USER, PASS, HOST, DBNAME, RAW, 'sslmode']) expect(r.log).not.toContain(text);
  }, T);

  it('2. a non-empty value is written as exactly "[set]"', () => {
    const r = run(claudeStart(), RAW);
    expect(r.rows[0].env.DATABASE_URL).toBe('[set]');
  }, T);

  it('3. an unset variable stays null', () => {
    const r = run(claudeStart());
    expect(r.rows[0].env.DATABASE_URL).toBeNull();
  }, T);

  it('4. an empty variable gives null', () => {
    const r = run(claudeStart(), '');
    expect(r.rows[0].env.DATABASE_URL).toBeNull();
  }, T);

  it('5. every other key and value equals the unset control row', () => {
    const payload = claudeStart();
    const masked = run(payload, RAW).rows[0];
    const control = run(payload).rows[0];
    expect(Object.keys(masked)).toEqual(Object.keys(control));
    expect(Object.keys(masked.env)).toEqual(Object.keys(control.env));
    const strip = (row: any) => {
      const { ts, pid, ppid, project_legacy, ...rest } = row; // time, process ids and temp paths differ per run
      const { DATABASE_URL, CLAUDE_PROJECT_DIR, ...env } = rest.env; // CLAUDE_PROJECT_DIR is the per-run temp folder
      return { ...rest, env };
    };
    expect(strip(masked)).toEqual(strip(control));
  }, T);

  it('6. a Cursor sessionStart still writes no row (PR 532 guard)', () => {
    const r = run({ hook_event_name: 'sessionStart', session_id: randomUUID() }, RAW);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.log).toBe('');
  }, T);

  it('7. an event outside the four Cursor names writes a row with no secret', () => {
    const r = run({ hook_event_name: 'someOtherHostEvent', session_id: randomUUID(), cwd: tmpdir() }, RAW);
    expect(r.status).toBe(0);
    for (const text of [USER, PASS, HOST, DBNAME, RAW]) expect(r.log).not.toContain(text);
    if (r.rows.length) expect(r.rows[0].env.DATABASE_URL).toBe('[set]');
  }, T);
});
