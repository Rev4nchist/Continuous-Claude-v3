/**
 * Engine-run hook files (card engine-run-hook-files; seat words 2026-11-13 06:30, 06:58, 07:20 CST):
 * under cursor-agent no CCv3 hook writes, renames or deletes a file in the project folder (the
 * reviewed tree) and none starts a child process for it. A file there can void an engine run (read
 * audit, run ce2ef934). In Claude Code the guarded hooks keep today's behaviour.
 * Design note: .claudedocs/e2e-engine-run-hook-files/01-design-note.md. Survey: survey-static.md.
 *
 * Each hook is bundled from src with esbuild and run as a child process with a real stdin payload
 * (the pattern of engine-host-session-hooks-b.test.ts). dist is not used: the test must see src.
 * `child_process` is replaced by a stub that logs every spawn, spawnSync, execSync and execFileSync
 * call to a file outside the project and starts nothing. So "no child starts" is a measured count.
 *
 * Child env: VITEST, CCV3_*, LANE_*, CLAUDE_* and DB URL variables removed; PATH is an EMPTY
 * folder; HOME, USERPROFILE, TEMP are one temp folder; CLAUDE_PROJECT_DIR and the cwd are a
 * SEPARATE `proj` folder. The test hashes `proj` before and after the run (created, removed, changed).
 *
 * How the change can fail, one test each (the source change that breaks it):
 *  1. a hook writes, deletes or changes a file in proj for a Cursor event -> remove its isEngineHost call
 *  2. a hook starts a child for a Cursor event -> same (the guard sits before the spawn)
 *  3. a hook prints more than its neutral output for a Cursor event -> same
 *  4. a hook stops working for Claude Code -> the helper matches a PascalCase name (control tests)
 *  5. bus-session-populator and memory-awareness guard only in main() while prompt-submit runs them
 *     in process -> the guard sits inside runBusSessionPopulator and memoryAwarenessJob (source test)
 *  6. a new project writer is registered without the guard -> the registrations test
 *
 * Event names: sessionStart, postToolUse, sessionEnd are MEASURED; preToolUse and userPromptSubmit are
 * by convention, NOT measured (seat ruling 2026-11-13 09:10 CST). The bus-session-populator and
 * memory-awareness guards use userPromptSubmit and are by convention, not proven.
 *
 * tldr-read-enforcer is a deny guard and is NOT changed by this card: under the engine host its main()
 * already returns `{}` before any decision or log write (PR 529). Its table row proves the engine run
 * leaves the project unchanged; its source is the same as main.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { build, type Plugin } from 'esbuild';

const HOOKS_ROOT = resolve(__dirname, '..', '..');
const BANNER = "import{createRequire as __hookCreateRequire}from'module';const require=__hookCreateRequire(import.meta.url);";

const SPAWN_STUB = `
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
const log = (kind, args) => { try { appendFileSync(process.env.SPAWN_STUB_LOG, kind + ' ' + JSON.stringify(args).slice(0, 240) + '\\n'); } catch {} };
export function spawn(cmd, args) {
  log('spawn', [cmd, args]);
  const e = new EventEmitter();
  e.unref = () => {}; e.pid = 1; e.stdout = new EventEmitter(); e.stderr = new EventEmitter(); e.stdin = { write() {}, end() {} };
  setTimeout(() => e.emit('exit', 1), 0);
  return e;
}
export function spawnSync(cmd, args) { log('spawnSync', [cmd, args]); return { status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null }; }
export function execSync(cmd) { log('execSync', [cmd]); return '{"should_extract":true}'; }
export function execFileSync(cmd, args) { log('execFileSync', [cmd, args]); throw new Error('stub: no child starts'); }
export function execFile() { log('execFile', []); }
export function exec() { log('exec', []); }
export default { spawn, spawnSync, execSync, execFileSync, execFile, exec };
`;

const DROP_PREFIXES = ['VITEST', 'CCV3_', 'LANE_', 'CLAUDE_', 'PG', 'COORDINATION_'];
const DROP_KEYS = ['CONTINUOUS_CLAUDE_DB_URL', 'DATABASE_URL', 'OPC_POSTGRES_URL', 'POSTGRES_URL'];

const PROMPT = 'please review this change carefully for bugs and edge cases';
const F = (p: string) => join(p, 'src', 'x.ts');
const BUS = /^\/\.claude\/cache\/session\/[^/]+\/context\.json$/;

interface Delta { created: string[]; removed: string[]; changed: string[] }
interface Spec {
  hook: string;
  neutral: string;
  cursor: Array<(proj: string) => object>;
  claude?: (proj: string) => object;
  seed?: (proj: string, home: string) => void;
  /** Claude control: what must be seen. */
  expect?: { created?: RegExp; removed?: RegExp; changed?: RegExp; spawns?: boolean };
}

const CURSOR_TOOLS = (name: string, input: (p: string) => object, extra: object = {}) => [
  (p: string) => ({ hook_event_name: 'postToolUse', tool_name: name, tool_input: input(p), ...extra }),
  (p: string) => ({ hook_event_name: 'preToolUse', tool_name: name, tool_input: input(p), ...extra }),
];
const CONT = '{"result":"continue"}';

const SPECS: Spec[] = [
  { hook: 'bus-tool-populator', neutral: '{}',
    cursor: [...CURSOR_TOOLS('Read', (p) => ({ file_path: F(p) })), (p) => ({ hook_event_name: 'postToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_response: `${F(p)}:1:x` })],
    claude: (p) => ({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: F(p) } }),
    expect: { created: BUS } },
  { hook: 'bus-session-populator', neutral: CONT,
    cursor: [() => ({ hook_event_name: 'userPromptSubmit', prompt: PROMPT })],
    claude: () => ({ hook_event_name: 'UserPromptSubmit', prompt: PROMPT }),
    expect: { created: BUS } },
  // Seeded compiler stub: the hook starts a child only when it finds typescript/bin/tsc under the project.
  // Without the seed the Claude control spawns nothing on CI (Linux) and the child count proves nothing.
  { hook: 'post-edit-diagnostics', neutral: '{}',
    seed: (proj) => { mkdirSync(join(proj, 'node_modules', 'typescript', 'bin'), { recursive: true }); writeFileSync(join(proj, 'node_modules', 'typescript', 'bin', 'tsc'), '// stub\n'); },
    cursor: [...CURSOR_TOOLS('Write', (p) => ({ file_path: F(p) }), { tool_result: { success: true } }), ...CURSOR_TOOLS('Edit', (p) => ({ file_path: F(p) }), { tool_result: { success: true } })],
    claude: (p) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: F(p) }, tool_result: { success: true } }),
    expect: { created: BUS, spawns: true } },
  { hook: 'session-end-handoff-indexer', neutral: CONT,
    cursor: [() => ({ hook_event_name: 'sessionEnd', reason: 'other' }), () => ({ hook_event_name: 'sessionStart' })],
    claude: () => ({ hook_event_name: 'SessionEnd', reason: 'other' }),
    expect: { created: /^\/\.claude\/logs\/handoff-indexer\.log$/ } },
  { hook: 'post-plan-roadmap', neutral: CONT,
    cursor: CURSOR_TOOLS('ExitPlanMode', () => ({ plan: 'p' })),
    claude: () => ({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } }),
    expect: { created: /^\/ROADMAP\.md$/ } },
  { hook: 'session-start-intel-prune', neutral: '{}',
    cursor: [() => ({ hook_event_name: 'sessionStart', source: 'startup' })],
    seed: (proj) => {
      const f = join(proj, '.claude', 'logs', 'intel-bus.jsonl.1');
      mkdirSync(join(proj, '.claude', 'logs'), { recursive: true });
      writeFileSync(f, 'old\n');
      const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      utimesSync(f, old, old);
    },
    claude: () => ({ hook_event_name: 'SessionStart', source: 'startup' }),
    expect: { removed: /intel-bus\.jsonl\.1$/ } },
  { hook: 'agent-recall-injector', neutral: '{}',
    cursor: CURSOR_TOOLS('Task', () => ({ subagent_type: 'scout', description: 'look', prompt: 'review the authentication flow and list every place a session token is created or checked' })),
    seed: (proj) => { mkdirSync(join(proj, 'opc'), { recursive: true }); },
    claude: () => ({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'scout', description: 'look', prompt: 'review the authentication flow and list every place a session token is created or checked' } }),
    expect: { spawns: true } },
  { hook: 'session-end-extract', neutral: CONT,
    cursor: [() => ({ hook_event_name: 'sessionEnd', reason: 'other' })],
    seed: (_p, home) => {
      const d = join(home, 'continuous-claude', 'opc', 'scripts', 'core');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'lazy_memory.py'), '# stub\n');
    },
    claude: () => ({ hook_event_name: 'SessionEnd', reason: 'other' }),
    expect: { spawns: true } },
  { hook: 'tree-invalidate', neutral: CONT,
    cursor: CURSOR_TOOLS('Write', (p) => ({ file_path: F(p) }), { tool_result: { success: true } }),
    seed: (proj) => { mkdirSync(join(proj, '.claude'), { recursive: true }); writeFileSync(join(proj, '.claude', 'knowledge-tree.json'), '{"a":1}\n'); },
    claude: (p) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: F(p) }, tool_result: { success: true } }),
    expect: { changed: /knowledge-tree\.json$/ } },
  { hook: 'architecture-stats-sync', neutral: '{}',
    cursor: CURSOR_TOOLS('Bash', () => ({ command: 'git commit -m x' })),
    claude: () => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }),
    expect: { spawns: true } },
  { hook: 'prd-roadmap-sync', neutral: CONT,
    cursor: CURSOR_TOOLS('Write', (p) => ({ file_path: join(p, 'docs', 'prd-feature.md'), content: '# PRD\n- [ ] a task\n' }), { tool_result: { success: true } }),
    seed: (proj) => { mkdirSync(join(proj, 'docs'), { recursive: true }); writeFileSync(join(proj, 'docs', 'prd-feature.md'), '# PRD\n- [ ] a task\n'); writeFileSync(join(proj, 'ROADMAP.md'), '# Roadmap\n\n## Current Focus\n\n## Planned\n'); },
    claude: (p) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(p, 'docs', 'prd-feature.md'), content: '# PRD\n- [ ] a task\n' }, tool_result: { success: true } }),
    expect: { changed: /ROADMAP\.md$/ } },
  { hook: 'git-commit-roadmap', neutral: CONT,
    cursor: CURSOR_TOOLS('Bash', () => ({ command: 'git commit -m "feat: x"' }), { tool_response: { stdout: '[main abc1234] feat: x\n 1 file changed, 1 insertion(+)' } }),
    seed: (proj) => { writeFileSync(join(proj, 'ROADMAP.md'), '# Roadmap\n\n## Current Focus\n\n## Planned\n'); },
    claude: () => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "feat: x"' }, tool_response: { stdout: '[main abc1234] feat: x\n 1 file changed, 1 insertion(+)' } }),
    expect: { spawns: true } },
  { hook: 'import-validator', neutral: '{}',
    cursor: CURSOR_TOOLS('Write', (p) => ({ file_path: join(p, 'a.py'), content: 'from os.path import join_foo\n' })),
    claude: (p) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(p, 'a.py'), content: 'from os.path import join_foo\n' } }),
    expect: { spawns: true } },
  { hook: 'pageindex-watch', neutral: CONT,
    cursor: CURSOR_TOOLS('Write', (p) => ({ file_path: join(p, 'docs', 'guide.md') }), { tool_result: { success: true } }),
    // A pending reindex of ANOTHER project in HOME: the hook flushes it with a batch_index child.
    seed: (proj, home) => {
      mkdirSync(join(proj, 'docs'), { recursive: true });
      writeFileSync(join(proj, 'docs', 'guide.md'), '# g\n');
      mkdirSync(join(home, '.claude', 'local-state'), { recursive: true });
      writeFileSync(join(home, '.claude', 'local-state', 'pageindex-pending.json'), JSON.stringify({ files: ['x.md'], timestamp: 0, projectDir: 'elsewhere' }));
    },
    claude: (p) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(p, 'docs', 'guide.md') }, tool_result: { success: true } }),
    expect: { spawns: true } },
  { hook: 'tldr-read-enforcer', neutral: '{}',
    cursor: CURSOR_TOOLS('Read', (p) => ({ file_path: F(p) })),
    seed: (proj) => { mkdirSync(join(proj, '.tldr'), { recursive: true }); writeFileSync(join(proj, '.tldr', 'keep'), 'x'); } },
  // file-claims: only its SHELL branch is silent under the host (card coord-file-claims-all-writers, seat
  // change 2). The exact-path branch (Edit, Write ...) keeps its deny. The unit test
  // file-claims-all-writers.test.ts proves the shell branch asks no database query under the host.
  { hook: 'file-claims', neutral: CONT,
    cursor: [...CURSOR_TOOLS('Bash', () => ({ command: 'echo x > src/x.ts' })), ...CURSOR_TOOLS('PowerShell', () => ({ command: "Set-Content -LiteralPath 'src/x.ts' -Value x" }))] },
  { hook: 'memory-awareness', neutral: CONT,
    cursor: [() => ({ hook_event_name: 'userPromptSubmit', prompt: PROMPT })],
    seed: (proj) => { mkdirSync(join(proj, 'opc'), { recursive: true }); },
    claude: () => ({ hook_event_name: 'UserPromptSubmit', prompt: PROMPT }),
    expect: { spawns: true } },
  // Reads `.claude/smarter-everyday-state.json` in the project and, on a CANDIDATE state, stores a learning
  // through a child and resets that file. Guarded as the 16th hook after the seat's open-writer question.
  { hook: 'user-confirmation-detector', neutral: '{"continue":true}',
    cursor: [() => ({ hook_event_name: 'userPromptSubmit', prompt: 'that worked' })],
    seed: (proj) => {
      mkdirSync(join(proj, '.claude'), { recursive: true });
      writeFileSync(join(proj, '.claude', 'smarter-everyday-state.json'), JSON.stringify({ session_id: 's', state: 'CANDIDATE', tracked_file: 'src/x.ts', attempts: 2, failures: [], candidate_turn: 1, last_edit_content: null, test_command: null, context: null, current_turn: 2 }));
    },
    claude: () => ({ hook_event_name: 'UserPromptSubmit', prompt: 'that worked' }),
    expect: { spawns: true } },
];

let root: string;
const bundles: Record<string, string> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'engine-run-hook-files-'));
  const stub = join(root, 'spawn-stub.mjs');
  writeFileSync(stub, SPAWN_STUB);
  const stubChild: Plugin = {
    name: 'stub-child-process',
    setup(b) {
      b.onResolve({ filter: /^(node:)?child_process$/ }, () => ({ path: stub }));
    },
  };
  for (const s of SPECS) {
    const outfile = join(root, 'bundle', `${s.hook}.mjs`);
    await build({
      entryPoints: [join(HOOKS_ROOT, 'src', `${s.hook}.ts`)],
      bundle: true, platform: 'node', format: 'esm', outfile,
      external: ['better-sqlite3'], banner: { js: BANNER }, logLevel: 'silent', plugins: [stubChild],
    });
    bundles[s.hook] = outfile;
  }
}, 120000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function snap(dir: string, base = dir, acc: Record<string, string> = {}): Record<string, string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) snap(p, base, acc);
    else acc[p.slice(base.length).split('\\').join('/')] = createHash('sha1').update(readFileSync(p)).digest('hex');
  }
  return acc;
}

interface Run { status: number | null; stdout: string; delta: Delta; spawns: string[] }

/** Run a bundled hook. cwd and CLAUDE_PROJECT_DIR are `proj`; HOME and TEMP are the parent temp folder. */
function runHook(spec: Spec, build: (proj: string) => object): Run {
  const tmp = mkdtempSync(join(root, 'run-'));
  const proj = join(tmp, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'x.ts'), 'export const x: number = 1;\n');
  writeFileSync(join(proj, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}\n');
  spec.seed?.(proj, tmp);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const up = k.toUpperCase();
    if (DROP_PREFIXES.some((p) => up.startsWith(p))) continue;
    if (DROP_KEYS.includes(up) || up === 'PATH') continue;
    env[k] = v;
  }
  const emptyBin = join(tmp, 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });
  const spawnLog = join(tmp, 'spawn-stub.log');
  Object.assign(env, { PATH: emptyBin, TEMP: tmp, TMP: tmp, TMPDIR: tmp, HOME: tmp, USERPROFILE: tmp, CLAUDE_PROJECT_DIR: proj, CCV3_HOOK_TRACE: '0', SPAWN_STUB_LOG: spawnLog });
  const before = snap(proj);
  const r = spawnSync(process.execPath, [bundles[spec.hook]], {
    input: JSON.stringify({ session_id: `erhf-${process.pid}-${Date.now()}`, cwd: proj, ...build(proj) }),
    encoding: 'utf-8', env, cwd: proj, timeout: 30000,
  });
  const after = snap(proj);
  const delta: Delta = {
    created: Object.keys(after).filter((k) => !(k in before)),
    removed: Object.keys(before).filter((k) => !(k in after)),
    changed: Object.keys(after).filter((k) => k in before && before[k] !== after[k]),
  };
  const spawns = existsSync(spawnLog) ? readFileSync(spawnLog, 'utf-8').split('\n').filter(Boolean) : [];
  return { status: r.status, stdout: (r.stdout || '').trim(), delta, spawns };
}

const T = 40000;
const EMPTY: Delta = { created: [], removed: [], changed: [] };

describe('Cursor payloads: nothing in the project folder changes, no child starts, neutral output only', () => {
  for (const spec of SPECS) {
    it(`${spec.hook}: every Cursor event leaves proj unchanged and prints ${spec.neutral}`, () => {
      for (const build of spec.cursor) {
        const r = runHook(spec, build);
        expect(r.status).toBe(0);
        expect(r.delta).toEqual(EMPTY);
        expect(r.spawns).toEqual([]);
        expect(r.stdout).toBe(spec.neutral);
      }
    }, T);
  }
});

describe('Claude Code payloads: the hook still does its work (control)', () => {
  for (const spec of SPECS.filter((s) => s.claude && s.expect)) {
    it(`${spec.hook}: a Claude payload still ${Object.keys(spec.expect!).join(' and ')}`, () => {
      const r = runHook(spec, spec.claude!);
      expect(r.status).toBe(0);
      const e = spec.expect!;
      if (e.created) expect(r.delta.created.some((f) => e.created!.test(f))).toBe(true);
      if (e.removed) expect(r.delta.removed.some((f) => e.removed!.test(f))).toBe(true);
      if (e.changed) expect(r.delta.changed.some((f) => e.changed!.test(f))).toBe(true);
      if (e.spawns) expect(r.spawns.length).toBeGreaterThan(0);
    }, T);
  }
});

describe('registrations: every project writer is guarded', () => {
  const settings = JSON.parse(readFileSync(join(HOOKS_ROOT, '..', 'settings.json.template'), 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command?: string; args?: string[] }> }>>;
  };
  const registered = new Set<string>();
  for (const groups of Object.values(settings.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = `${(h.args || []).join(' ')} ${h.command || ''}`.match(/([\w-]+)\.mjs/);
        if (m) registered.add(m[1]);
      }
    }
  }
  const src = (name: string) => readFileSync(join(HOOKS_ROOT, 'src', `${name}.ts`), 'utf-8');
  const PROMPT_SUBMIT_JOBS = ['bus-session-populator', 'memory-awareness', 'user-confirmation-detector'];

  it('every guarded hook is registered, directly or through prompt-submit', () => {
    for (const s of SPECS) {
      if (PROMPT_SUBMIT_JOBS.includes(s.hook)) {
        expect(registered.has('prompt-submit')).toBe(true);
        expect(src('prompt-submit'), s.hook).toContain(`from './${s.hook}.js'`);
      } else {
        expect(registered.has(s.hook), s.hook).toBe(true);
      }
    }
  });

  it('every guarded hook calls isEngineHost', () => {
    for (const s of SPECS) expect(src(s.hook), s.hook).toMatch(/isEngineHost\(/);
  });

  it('prompt-submit jobs guard inside the job function, not only in main()', () => {
    const bsp = src('bus-session-populator');
    const bspFn = bsp.slice(bsp.indexOf('export async function runBusSessionPopulator'));
    expect(bspFn.slice(0, bspFn.indexOf('\nfunction main'))).toMatch(/isEngineHost\(/);
    const ma = src('memory-awareness');
    const maFn = ma.slice(ma.indexOf('async function memoryAwarenessJob'));
    expect(maFn.slice(0, 1200)).toMatch(/isEngineHost\(/);
    const ucd = src('user-confirmation-detector');
    const ucdFn = ucd.slice(ucd.indexOf('async function detectConfirmation'));
    expect(ucdFn.slice(0, ucdFn.indexOf('\nasync function main'))).toMatch(/isEngineHost\(/);
  });

  it('every registered hook that imports the context bus or the intel bus is guarded, or is on the reviewed list', () => {
    // Reviewed in survey-static.md: none of these writes into the project.
    const REVIEWED_NO_PROJECT_WRITE = new Set<string>([]);
    for (const name of registered) {
      if (!existsSync(join(HOOKS_ROOT, 'src', `${name}.ts`))) continue;
      const text = src(name);
      if (!/shared\/(context-bus|intel-bus)/.test(text) || REVIEWED_NO_PROJECT_WRITE.has(name)) continue;
      expect(text, `${name} imports a bus and must call isEngineHost`).toMatch(/isEngineHost\(/);
    }
  });
});
