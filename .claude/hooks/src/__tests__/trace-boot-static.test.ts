/**
 * Static check, in the style of scripts/hooks/hook-contract-guard.mjs: the tracer cannot die silently.
 *
 * How it can fail, one test each:
 *   the --inject flag leaves scripts.build (a rebuild then drops the tracer from all 79 bundles)
 *   a hot program's dist has no marker (built before the flag, or the bundle moved)
 *   the count of marked dists is zero or below the hot count (a vacuous pass)
 *   a dist has the marker string but not the injected boot call (the marker alone does not prove the tracer runs)
 * Run it after `npm run build`. It reads the repo dist, which the forward sync copies to ~/.claude.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { HOT_PROGRAMS, TRACE_MARKER } from '../lib/trace-boot.js';

const HOOKS_ROOT = join(__dirname, '..', '..');
const DIST = join(HOOKS_ROOT, 'dist');
// A string only the injected boot call carries: the argument of the module-level bootTrace(...) statement in src/lib/trace-boot.ts.
const BOOT_CALL_TOKEN = '__CCV3_HOOK_TRACE_BOOT_V1__';
const bootCallRe = new RegExp(`["']${BOOT_CALL_TOKEN}["']`);
const CHECKER = join(HOOKS_ROOT, '..', '..', 'scripts', 'hooks', 'trace-marker-check.mjs');

describe('trace marker in the built dist', () => {
  it('the build line that runs esbuild (scripts.build, or build:raw behind the run-lock wrapper) carries --inject:src/lib/trace-boot.ts', async () => {
    const pkg = JSON.parse(readFileSync(join(HOOKS_ROOT, 'package.json'), 'utf8'));
    const { buildLineThatRuns } = await import(pathToFileURL(CHECKER).href);
    expect(buildLineThatRuns(pkg.scripts)).toContain('--inject:src/lib/trace-boot.ts');
  });

  it('every hot program has a dist that carries the marker', () => {
    expect(HOT_PROGRAMS.length).toBeGreaterThan(20);
    const missing = HOT_PROGRAMS.filter((name) => !existsSync(join(DIST, `${name}.mjs`)));
    expect(missing, `hot programs with no dist/<name>.mjs: ${missing.join(', ')}`).toEqual([]);
    const unmarked = HOT_PROGRAMS.filter((name) => !readFileSync(join(DIST, `${name}.mjs`), 'utf8').includes(TRACE_MARKER));
    expect(unmarked, `hot dists without ${TRACE_MARKER}: ${unmarked.join(', ')}`).toEqual([]);
  });

  it('the count of marked dists is at least the hot count (a count of zero is a failure, not a pass)', () => {
    const marked = readdirSync(DIST).filter((f) => f.endsWith('.mjs') && readFileSync(join(DIST, f), 'utf8').includes(TRACE_MARKER));
    expect(marked.length).toBeGreaterThanOrEqual(HOT_PROGRAMS.length);
  });

  it('every hot dist carries the boot call, not only the marker string', () => {
    const noCall = HOT_PROGRAMS.filter((name) => !bootCallRe.test(readFileSync(join(DIST, `${name}.mjs`), 'utf8')));
    expect(noCall, `hot dists without the boot call: ${noCall.join(', ')}`).toEqual([]);
  });

  it('the boot call sits in the module-level statement of src/lib/trace-boot.ts', () => {
    const src = readFileSync(join(HOOKS_ROOT, 'src', 'lib', 'trace-boot.ts'), 'utf8');
    const statement = `if (!Object.hasOwn(process.env, 'VITEST')) bootTrace(process.env, '${BOOT_CALL_TOKEN}');`;
    expect(src.split(/\r?\n/)).toContain(statement);
  });

  it('the shared checker fails a dist that has the marker but not the boot call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-static-'));
    try {
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'esbuild --inject:src/lib/trace-boot.ts' } }));
      writeFileSync(join(dir, 'dist', 'a.mjs'), `var m = "${TRACE_MARKER}";
bootTrace(process.env, "${BOOT_CALL_TOKEN}");
`);
      writeFileSync(join(dir, 'dist', 'b.mjs'), `var m = "${TRACE_MARKER}";
function appendTraceRow() {}
`);
      const { traceMarkerFindings } = await import(pathToFileURL(CHECKER).href);
      const found = traceMarkerFindings({ hooksDir: dir, names: ['a', 'b'], minCount: 1 }) as Array<{ kind: string; detail: string }>;
      expect(found.map((f) => f.kind)).toEqual(['trace-boot-call-missing']);
      expect(found[0].detail).toContain('b');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
