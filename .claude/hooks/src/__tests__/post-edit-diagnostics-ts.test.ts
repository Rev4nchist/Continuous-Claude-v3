/**
 * TypeScript path of post-edit-diagnostics (lane post-edit-ts-diagnostics-fix, 2026-11-05).
 *
 * Root cause of the bug: the hook ran `tsc --noEmit` in CLAUDE_PROJECT_DIR with no `-p`.
 * The CCv3 root has no tsconfig.json, so tsc printed its help text, nothing matched the
 * error regex and the hook returned {} on every TS edit (RED probe:
 * .claude/cache/e2e/2026-11-05-post-edit-diagnostics-ts-silent.txt).
 *
 * Failure modes, one test each:
 *  1. The nearest tsconfig above the edited file is not found (or the walk escapes the project).
 *  2. A solution-style tsconfig (files: [] + references) is checked and reports a false green.
 *  3. Real tsc output lines (TS 5.9 and TS 7 share the shape) are not parsed.
 *  4. Edited-file errors are hidden behind errors in other files, or the output is unbounded.
 *  5. .mts/.cts or an upper-case extension is not routed to the TS path.
 *  6. End to end: the built hook stays silent on a real type error in a nested project.
 *  7. End to end: a TS edit with no tsconfig, or a broken compiler, returns {} instead of a note.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import {
  findNearestTsconfig,
  isSolutionStyleTsconfig,
  parseTscOutput,
  formatTsDiagnostics,
  classifyExtension,
} from '../shared/ts-diagnostics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const HOOKS_DIR = resolve(__dirname, '..', '..');
const HOOK_PATH = resolve(HOOKS_DIR, 'dist', 'post-edit-diagnostics.mjs');
const HOOKS_TSC = resolve(HOOKS_DIR, 'node_modules', 'typescript', 'bin', 'tsc');

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ped-ts-')); });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('1. findNearestTsconfig', () => {
  it('finds the tsconfig in a parent folder of the edited file', () => {
    const proj = join(tmp, 'proj');
    mkdirSync(join(proj, 'pkg', 'src', 'deep'), { recursive: true });
    writeFileSync(join(proj, 'pkg', 'tsconfig.json'), '{}');
    expect(findNearestTsconfig(join(proj, 'pkg', 'src', 'deep', 'a.ts'), proj))
      .toBe(join(proj, 'pkg', 'tsconfig.json'));
  });

  it('returns null when no tsconfig exists up to the project root', () => {
    const proj = join(tmp, 'proj');
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'tsconfig.json'), '{}'); // above the project: must not be used
    expect(findNearestTsconfig(join(proj, 'src', 'a.ts'), proj)).toBeNull();
  });
});

describe('2. isSolutionStyleTsconfig', () => {
  it('flags files: [] with references, and accepts a normal config', () => {
    const sol = join(tmp, 'tsconfig.json');
    writeFileSync(sol, '{\n  // solution\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }]\n}');
    expect(isSolutionStyleTsconfig(sol)).toBe(true);
    const normal = join(tmp, 'tsconfig.normal.json');
    writeFileSync(normal, '{ "include": ["src/**/*.ts"] }');
    expect(isSolutionStyleTsconfig(normal)).toBe(false);
  });
});

describe('3. parseTscOutput on real tsc lines', () => {
  it('parses error lines and skips continuation lines', () => {
    const out = [
      ".claude/hooks/src/__tests__/msys-crash-capture.test.ts(17,8): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean '../msys-crash-capture.js'?",
      "  The last overload gave the following error.",
      "src/a.ts(3,1): error TS2322: Type 'number' is not assignable to type 'string'.",
    ].join('\r\n');
    const d = parseTscOutput(out);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ file: '.claude/hooks/src/__tests__/msys-crash-capture.test.ts', line: 17, column: 8, code: 2835, severity: 'error' });
    expect(d[1].message).toBe("Type 'number' is not assignable to type 'string'.");
  });
});

describe('4. formatTsDiagnostics', () => {
  const base = 'C:/proj/pkg';
  const mk = (file: string, n: number) => ({ file, line: n, column: 1, severity: 'error' as const, code: 2322, message: `bad ${n}` });

  it('puts edited-file errors first, caps them at 10 and groups the rest by file', () => {
    const others = Array.from({ length: 30 }, (_, i) => mk(`src/other${i % 3}.ts`, i + 1));
    const edited = Array.from({ length: 12 }, (_, i) => mk('src/edited.ts', i + 1));
    const text = formatTsDiagnostics([...others, ...edited], 'C:/proj/pkg/src/edited.ts', base, 'tsconfig.json');
    const lines = text.split('\n');
    expect(lines[0]).toContain('12 in the edited file');
    expect(lines[0]).toContain('30 in 3 other files');
    expect(lines[1]).toContain('src/edited.ts:1:1');
    expect(lines.filter((l) => l.includes('src/edited.ts:')).length).toBe(10);
    expect(text).toContain('2 more in the edited file');
    expect(text).toMatch(/src\/other0\.ts: 10 errors/);
    expect(text.indexOf('edited.ts:1:1')).toBeLessThan(text.indexOf('other0.ts'));
  });

  it('stays under 10,000 characters with a huge cascade', () => {
    const many = Array.from({ length: 20000 }, (_, i) => mk(`src/f${i}.ts`, 1));
    const text = formatTsDiagnostics(many, 'C:/proj/pkg/src/edited.ts', base, 'tsconfig.json');
    expect(text.length).toBeLessThan(10000);
    expect(text).toContain('20000 in 20000 other files');
  });
});

describe('5. classifyExtension', () => {
  it('routes .mts, .cts and upper-case extensions to ts', () => {
    expect(classifyExtension('a.mts')).toBe('ts');
    expect(classifyExtension('a.cts')).toBe('ts');
    expect(classifyExtension('C:/X/Widget.TSX')).toBe('ts');
    expect(classifyExtension('a.mjs')).toBe('js');
    expect(classifyExtension('a.PY')).toBe('python');
    expect(classifyExtension('a.md')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End to end through the built hook.
// ---------------------------------------------------------------------------
function runHook(projectDir: string, filePath: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITEST')) env[k] = v;
  Object.assign(env, { CLAUDE_PROJECT_DIR: projectDir, COORDINATION_SESSION_ID: 'ped-ts-sess', CCV3_BUS_OFF: '1', CCV3_DAEMON_NO_AUTOSTART: '1' }, extraEnv);
  const r = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
    encoding: 'utf-8', timeout: 60000, env,
  });
  return { code: r.status, out: JSON.parse((r.stdout || '{}').trim() || '{}') };
}

describe('6-7. built hook, end to end', () => {
  beforeAll(() => {
    if (!existsSync(HOOK_PATH)) throw new Error(`Built hook not found at ${HOOK_PATH}. Run 'npm run build' first.`);
  });

  it('reports the edited file error from a nested tsconfig (project root has none)', () => {
    const proj = join(tmp, 'proj');
    const pkg = join(proj, 'pkg');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(pkg, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['src/**/*.ts'] }));
    writeFileSync(join(pkg, 'src', 'bad.ts'), "export const n: string = 42;\n");
    const r = runHook(proj, join(pkg, 'src', 'bad.ts'), { CCV3_TSC: HOOKS_TSC });
    expect(r.code).toBe(0);
    const ctx = r.out.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('1 in the edited file');
    expect(ctx).toMatch(/bad\.ts:1:14/);
  }, 70000);

  it('gives a visible note for a TS file with no tsconfig, and for a broken compiler path', () => {
    const proj = join(tmp, 'proj');
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'a.ts'), 'export {};\n');
    const none = runHook(proj, join(proj, 'src', 'a.ts'), { CCV3_TSC: HOOKS_TSC });
    expect(none.out.hookSpecificOutput?.additionalContext ?? '').toMatch(/skipped: no tsconfig\.json/i);

    writeFileSync(join(proj, 'tsconfig.json'), '{}');
    const broken = runHook(proj, join(proj, 'src', 'a.ts'), { CCV3_TSC: join(tmp, 'missing', 'tsc') });
    expect(broken.out.hookSpecificOutput?.additionalContext ?? '').toMatch(/did not run/i);
  }, 70000);
});
